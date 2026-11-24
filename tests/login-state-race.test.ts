/** Real files and process barriers exercise legal replacement without weakening private-state checks. */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, chmod, link, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loginStateFile, withLoginLock, writeState } from '../cli/auth/state.ts';
import type { LoginState } from '../cli/auth/types.ts';
import type { Config } from '../cli/core/config.ts';

type Phase = 'during_lstat' | 'before_open' | 'after_open' | 'before_read' | 'continuous';
async function race(
  t: TestContext,
  phase: Phase,
  change?: (file: string, state: LoginState, config: Config) => Promise<void>,
) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-state-race-'));
  const config = {
    dataDir: directory,
    credentialProfile: path.basename(directory),
    inputRoots: [],
    outputDir: '',
  };
  const initial: LoginState = {
    version: 1,
    profile: config.credentialProfile,
    login_id: randomUUID(),
    status: 'verifying',
    started_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60000).toISOString(),
    pid: process.pid,
    nonce: 'a'.repeat(64),
    control: 'c'.repeat(64),
  };
  const replacement: LoginState = { ...initial, status: 'cancelled', nonce: 'b'.repeat(64) };
  await withLoginLock(config, () => writeState(config, initial));
  const file = await loginStateFile(config);
  const source = `
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {readState,writeState} from ${JSON.stringify(new URL('../cli/auth/state.ts', import.meta.url).href)};
const config=${JSON.stringify(config)},file=${JSON.stringify(file)},replacement=${JSON.stringify(replacement)},phase=${JSON.stringify(phase)};
const originalOpen=fs.open,originalLstat=fs.lstat;
let gated=false,opens=0,closes=0,maxReadBuffer=0,readBytes=0,lstatNlink;
async function gate(where){
  if(gated||where!==phase)return;
  gated=true;process.stdout.write('BARRIER\\n');
  await new Promise(resolve=>process.stdin.once('data',()=>{process.stdin.pause();resolve()}));
}
fs.lstat=async function(filename,...args){
  if(String(filename)!==file||phase!=='during_lstat'||gated)return originalLstat.call(this,filename,...args);
  // Hold the real looked-up inode across replacement and collect its actual metadata.
  // This places a deterministic barrier at lstat's lookup/metadata boundary.
  const inspected=await originalOpen.call(fs,filename,'r');
  try{await gate('during_lstat');const info=await inspected.stat();lstatNlink=info.nlink;return info}
  finally{await inspected.close()}
};
fs.open=async function(filename,...args){
  if(String(filename)!==file)return originalOpen.call(this,filename,...args);
  opens++;
  if(phase==='continuous')await writeState(config,replacement);
  await gate('before_open');
  const handle=await originalOpen.call(this,filename,...args);
  const originalClose=handle.close.bind(handle),originalRead=handle.read.bind(handle);
  handle.close=async()=>{closes++;return originalClose()};
  handle.read=async(...readArgs)=>{
    maxReadBuffer=Math.max(maxReadBuffer,readArgs[0]?.length??0);
    await gate('before_read');
    const result=await originalRead(...readArgs);readBytes+=result.bytesRead;return result;
  };
  await gate('after_open');
  return handle;
};
syncBuiltinESMExports();
let result;
try{const state=await readState(config);result={status:state?.status,nonce:state?.nonce}}
catch(error){result={error:error.code,message:error.message}}
process.stdout.write(JSON.stringify({...result,opens,closes,maxReadBuffer,readBytes,lstatNlink})+'\\n');
`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(child, 'close');
  let output = '',
    errors = '';
  const paused = new Promise<void>((resolve) => {
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('BARRIER\n')) resolve();
    });
  });
  child.stderr.on('data', (chunk) => {
    errors += chunk;
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited.catch(() => undefined);
    await rm(file, { force: true });
    await rm(directory, { recursive: true, force: true });
  });
  if (phase !== 'continuous') {
    await Promise.race([
      paused,
      exited.then(([code]) => {
        throw new Error(`Reader exited before barrier (${code}): ${output} ${errors}`);
      }),
    ]);
    if (change) await change(file, replacement, config);
    else await withLoginLock(config, () => writeState(config, replacement));
    child.stdin.end('continue');
  } else child.stdin.end();
  const [code] = await exited;
  assert.equal(code, 0, errors);
  const result = JSON.parse(output.trim().split('\n').at(-1)!);
  return { result, replacement };
}

for (const phase of ['during_lstat', 'before_open', 'after_open'] as const) {
  test(`login state retries a valid atomic replacement ${phase}`, { timeout: 60000 }, async (t) => {
    const { result, replacement } = await race(t, phase);
    assert.equal(result.error, undefined, result.message);
    assert.equal(result.status, replacement.status);
    assert.equal(result.nonce, replacement.nonce);
    const initialUnlink = phase === 'during_lstat' && result.lstatNlink === 0;
    assert.equal(result.opens, initialUnlink ? 1 : 2);
    if (phase === 'during_lstat' && process.platform !== 'win32') assert.equal(result.lstatNlink, 0);
    assert.equal(result.closes, result.opens, 'every attempt must close its file handle');
  });
}

test(
  'an unlinked inode with unsafe permissions is rejected during the initial stat',
  { timeout: 60000 },
  async (t) => {
    if (process.platform === 'win32') return t.skip('POSIX mode check');
    const { result } = await race(t, 'during_lstat', async (file, state, config) => {
      await chmod(file, 0o644);
      await withLoginLock(config, () => writeState(config, state));
    });
    assert.equal(result.lstatNlink, 0);
    assert.equal(result.error, 'LOGIN_STATE_INVALID');
    assert.equal(result.opens, 0, 'unsafe initial metadata must not trigger a second attempt');
    assert.equal(result.readBytes, 0);
  },
);

test(
  'continuous state replacement returns bounded contention without reading stale data',
  { timeout: 60000 },
  async (t) => {
    const { result } = await race(t, 'continuous');
    assert.equal(result.error, 'CREDENTIAL_STORE_BUSY');
    assert.ok(result.opens > 1 && result.opens <= 5);
    assert.equal(result.closes, result.opens);
    assert.equal(result.readBytes, 0);
  },
);

for (const kind of ['symlink', 'hardlink', 'permissions', 'oversized'] as const) {
  test(
    `replacement with ${kind} remains rejected before state data is read`,
    { timeout: 60000 },
    async (t) => {
      if (kind === 'permissions' && process.platform === 'win32') return t.skip('POSIX mode check');
      const { result } = await race(t, 'before_open', async (file, state) => {
        const other = file + '.unsafe-test';
        t.after(() => rm(other, { force: true }));
        const bytes = JSON.stringify({
          ...state,
          ...(kind === 'oversized' ? { extra: 'x'.repeat(16384) } : {}),
        });
        await writeFile(other, bytes, { mode: 0o600 });
        if (kind === 'permissions') await chmod(other, 0o644);
        await rm(file);
        if (kind === 'symlink') await symlink(other, file);
        else if (kind === 'hardlink') await link(other, file);
        else {
          const { rename } = await import('node:fs/promises');
          await rename(other, file);
        }
      });
      assert.equal(result.error, 'LOGIN_STATE_INVALID');
      assert.equal(result.opens, 1, 'unsafe replacements must not be treated as retryable contention');
      assert.equal(result.readBytes, 0);
    },
  );
}

test('state growth after the size check is bounded and rejected', { timeout: 60000 }, async (t) => {
  const { result } = await race(t, 'before_read', async (file) => {
    await appendFile(file, 'x'.repeat(32768));
  });
  assert.equal(result.error, 'LOGIN_STATE_INVALID');
  assert.ok(result.maxReadBuffer <= 16385);
  assert.ok(result.readBytes <= 16385);
  assert.equal(result.closes, result.opens);
});
