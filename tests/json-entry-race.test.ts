/** Real credential saves and clears overlap a separate process's synchronous JSON read. */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { JsonEntry, jsonEntryLimit } from '../studio/auth/json-entry.ts';
import { JsonStore, type Session } from '../studio/auth/credentials.ts';
import {
  checkWindowsPermissions,
  protectPrivateWindowsPath,
  replacePrivateWindowsFile,
  verifyPrivateWindowsPath,
} from '../studio/auth/windows-permissions.ts';
import type { JsonRacePhase, JsonRaceResult } from './json-entry-race-fixture.ts';

const session = (deviceId: string): Session => ({
  deviceId,
  importedAt: '2026-01-01T00:00:00Z',
  cookie: 'synthetic-cookie-value',
  accountRef: 'synthetic-account',
});
const original = session('original');
const replacement = session('replacement');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const fixture = fileURLToPath(new URL('./json-entry-race-fixture.ts', import.meta.url));

function replaceBytes(file: string, bytes: string | Buffer): void {
  const temporary = file + '.replacement';
  writeFileSync(temporary, bytes, { mode: 0o600 });
  protectPrivateWindowsPath(temporary, 'file');
  renameSync(temporary, file);
}

async function race(
  t: TestContext,
  phase: JsonRacePhase,
  change?: (file: string, store: JsonStore) => void | Promise<void>,
  operation = 'read',
) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'ai-modeling-json-entry-race-'));
  const options = { directory: path.join(temporary, 'auth') };
  const entry = new JsonEntry('ai-modeling', 'race', options);
  const store = new JsonStore('race', options);
  const file = path.join(options.directory, 'credentials', digest('ai-modeling'), `${digest('race')}.json`);
  const cleanup: { stopChild?: () => Promise<void> } = {};
  t.after(async () => {
    await cleanup.stopChild?.();
    await rm(temporary, { recursive: true, force: true });
  });
  store.save(original);
  const child = spawn(process.execPath, [fixture, phase, options.directory, file, operation], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(child, 'close');
  let errors = '';
  child.stderr.on('data', (chunk) => {
    errors += chunk;
  });
  cleanup.stopChild = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited.catch(() => undefined);
  };
  let barriers = 0;
  let result: JsonRaceResult | undefined;
  for await (const line of createInterface({ input: child.stdout })) {
    if (line === 'BARRIER') {
      barriers++;
      assert.ok(barriers <= 5, 'read attempts must be bounded');
      if (change) await change(file, store);
      else store.save({ ...replacement, ...(phase === 'continuous' ? { deviceId: `new-${barriers}` } : {}) });
      // Exactly one byte prevents a later barrier from consuming a leftover newline.
      child.stdin.write('x');
    } else result = JSON.parse(line) as JsonRaceResult;
  }
  child.stdin.end();
  const [code] = await exited;
  assert.equal(code, 0, errors);
  assert.ok(result, `Reader returned no result: ${errors}`);
  assert.equal(barriers, phase === 'continuous' ? 5 : 1);
  assert.equal(result.closes, result.handles, 'every opened record descriptor must be closed');
  assert.equal(result.inspectionCloses, result.inspectionHandles);
  return { result, file, entry, store };
}

test('Windows atomic replacement is restricted to private siblings and never retried after failure', () => {
  const source = 'C:\\synthetic\\私有 auth\\source.tmp';
  const target = 'C:\\synthetic\\私有 auth\\record.json';
  let calls = 0;
  assert.throws(
    () =>
      replacePrivateWindowsFile(source, target, (_executable, args, options) => {
        calls++;
        assert.deepEqual(JSON.parse(String(options.input)), [
          { path: path.win32.dirname(target), kind: 'directory' },
          { path: source, kind: 'file' },
          { path: target, kind: 'file' },
        ]);
        const script = Buffer.from(args.at(-1)!, 'base64').toString('utf16le');
        assert.equal(script.match(/\[IO\.File\]::Replace/g)?.length, 1);
        assert.ok(
          script.includes(
            '[IO.File]::Replace([string]$requests[1].path, [string]$requests[2].path, [NullString]::Value)',
          ),
        );
        assert.equal(script.includes('[IO.File]::Delete'), false);
        assert.equal(script.includes('[IO.File]::Copy'), false);
        assert.equal(options.timeout, 10000);
        return { status: 1, signal: null, stdout: '{"ok":false}' };
      }),
    { code: 'CREDENTIAL_STORE_UNAVAILABLE', certainty: 'unknown' },
  );
  assert.equal(calls, 1);
  for (const invalid of [source, 'C:\\another\\record.json', 'relative'])
    assert.throws(
      () => replacePrivateWindowsFile(source, invalid, () => assert.fail('Unsafe replacement was attempted')),
      { code: 'CREDENTIAL_STORE_UNAVAILABLE' },
    );
});

test(
  'native Windows replacement exposes only bounded synthetic failure diagnostics',
  { skip: process.platform !== 'win32', timeout: 60000 },
  async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-replace-diagnostic-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const source = path.join(directory, '新 source.tmp');
    const target = path.join(directory, '旧 target.json');
    writeFileSync(source, 'synthetic-new', { mode: 0o600 });
    writeFileSync(target, 'synthetic-old', { mode: 0o600 });
    checkWindowsPermissions([
      { path: directory, kind: 'directory', protect: true },
      { path: source, kind: 'file', protect: true },
      { path: target, kind: 'file', protect: true },
    ]);
    const old = openSync(target, 'r');
    let observed = false;
    try {
      replacePrivateWindowsFile(source, target, (command, args, options) => {
        let script = Buffer.from(args.at(-1)!, 'base64').toString('utf16le');
        const checkpoints = [
          ["$ErrorActionPreference = 'Stop'", 'start'],
          ['Import-Module -Name $utilityModule -ErrorAction Stop', 'import'],
          ['$requests = @(', 'json'],
          ['foreach ($request in $requests) {', 'validate'],
          ['[IO.File]::Replace(', 'replace'],
          ['$location = [string]$requests[2].path', 'verify'],
        ];
        for (const [checkpoint, stage] of checkpoints) {
          assert.ok(script.includes(checkpoint!));
          script = script.replace(checkpoint!, `$diagnosticStage = '${stage}'\n  ${checkpoint}`);
        }
        const originalCatch = `} catch {\n  [Console]::Out.Write('{"ok":false}')\n  exit 1\n}`;
        assert.ok(script.includes(originalCatch));
        script = script.replace(
          originalCatch,
          `} catch {
  $exception = $_.Exception
  $hresult = 0
  $native = 'null'
  $exceptionType = ''
  $depth = 0
  while ($null -ne $exception -and $depth -lt 8) {
    $hresult = [int]$exception.HResult
    $exceptionType = $exception.GetType().FullName
    if ($exception -is [ComponentModel.Win32Exception]) { $native = [string]$exception.NativeErrorCode }
    $exception = $exception.InnerException
    $depth++
  }
  [Console]::Out.Write('{"ok":false,"stage":"' + $diagnosticStage + '","hresult":' + $hresult + ',"native_error_code":' + $native + ',"exception_type":"' + $exceptionType + '"}')
  exit 1
}`,
        );
        const started = performance.now();
        const result = spawnSync(
          command,
          [...args.slice(0, -1), Buffer.from(script, 'utf16le').toString('base64')],
          options,
        );
        const payload: Record<string, unknown> = (() => {
          try {
            return JSON.parse(result.stdout) as Record<string, unknown>;
          } catch {
            return {};
          }
        })();
        const allowedTypes = new Set([
          'System.ArgumentException',
          'System.ArgumentNullException',
          'System.IO.IOException',
          'System.UnauthorizedAccessException',
          'System.ComponentModel.Win32Exception',
          'System.Management.Automation.MethodInvocationException',
        ]);
        t.diagnostic(
          JSON.stringify({
            probe: 'native_replace_failure_stage',
            status: result.status,
            signal: result.signal,
            error_code: (result.error as NodeJS.ErrnoException | undefined)?.code ?? null,
            elapsed_ms: Math.round(performance.now() - started),
            stage: checkpoints.some(([, stage]) => stage === payload.stage) ? payload.stage : null,
            hresult: Number.isSafeInteger(payload.hresult) ? payload.hresult : null,
            native_error_code: Number.isSafeInteger(payload.native_error_code)
              ? payload.native_error_code
              : null,
            exception_type:
              typeof payload.exception_type === 'string' && allowedTypes.has(payload.exception_type)
                ? payload.exception_type
                : null,
            ok: payload.ok === true,
          }),
        );
        observed = true;
        return result;
      });
    } catch {
      // The separate success regression retains its hard assertion; this probe records only safe evidence.
    } finally {
      closeSync(old);
    }
    assert.equal(observed, true, 'The real replacement subprocess must produce diagnostic metadata.');
  },
);

test(
  'native Windows replacement preserves old reader bytes and private new-file identity',
  { skip: process.platform !== 'win32', timeout: 60000 },
  async (t) => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'ai-modeling-native-replace-'));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const options = { directory: path.join(temporary, '私有 auth') };
    const entry = new JsonEntry('ai-modeling', 'native-replace', options);
    const file = path.join(
      options.directory,
      'credentials',
      digest('ai-modeling'),
      `${digest('native-replace')}.json`,
    );
    entry.setPassword('original bytes');
    const originalBytes = readFileSync(file);
    const old = openSync(file, 'r');
    try {
      const before = fstatSync(old);
      entry.setPassword('replacement bytes');
      const current = lstatSync(file);
      assert.notEqual(current.ino, before.ino);
      assert.equal(fstatSync(old).ino, before.ino);
      assert.deepEqual(readFileSync(old), originalBytes);
      assert.equal(entry.getPassword(), 'replacement bytes');
      verifyPrivateWindowsPath(file, 'file');
      assert.deepEqual(
        readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp')),
        [],
      );
      t.diagnostic(
        JSON.stringify({
          probe: 'native_replace_open_target',
          old_handle_nlink: fstatSync(old).nlink,
          identity_changed: true,
          old_bytes_preserved: true,
          new_bytes_verified: true,
          private_acl: true,
        }),
      );
    } finally {
      closeSync(old);
    }
  },
);

test(
  'a failed native Windows replacement preserves the private temporary record without replay',
  { skip: process.platform !== 'win32', timeout: 90000 },
  async (t) => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'ai-modeling-replace-failure-'));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const options = { directory: path.join(temporary, 'auth') };
    const entry = new JsonEntry('ai-modeling', 'failed-replace', options);
    entry.setPassword('original bytes');
    const directory = path.join(options.directory, 'credentials', digest('ai-modeling'));
    const file = path.join(directory, `${digest('failed-replace')}.json`);
    const source = `
import fs from 'node:fs';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {JsonEntry} from ${JSON.stringify(new URL('../studio/auth/json-entry.ts', import.meta.url).href)};
const originalSpawn=childProcess.spawnSync,handle=fs.openSync(${JSON.stringify(file)},'r');
let calls=0,result;
childProcess.spawnSync=function(command,args,options){
  const script=Buffer.from(args.at(-1),'base64').toString('utf16le');
  if(script.includes('[IO.File]::Replace(')){
    calls++;
    return {status:1,signal:null,stdout:'{"ok":false}'};
  }
  return originalSpawn(command,args,options);
};
syncBuiltinESMExports();
try{new JsonEntry('ai-modeling','failed-replace',${JSON.stringify(options)}).setPassword('pending bytes')}
catch(error){result={error:error.code,certainty:error.certainty}}
finally{fs.closeSync(handle)}
process.stdout.write(JSON.stringify({...result,calls}));
`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      encoding: 'utf8',
      timeout: 60000,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {
      error: 'CREDENTIAL_STORE_UNAVAILABLE',
      certainty: 'unknown',
      calls: 1,
    });
    assert.equal(entry.getPassword(), 'original bytes');
    const pending = readdirSync(directory).filter((name) => name.endsWith('.tmp'));
    assert.equal(pending.length, 1);
    const preserved = path.join(directory, pending[0]!);
    verifyPrivateWindowsPath(preserved, 'file');
    assert.equal(JSON.parse(readFileSync(preserved, 'utf8')).value, 'pending bytes');
  },
);

for (const phase of [
  'during_lstat',
  'before_open',
  'after_open',
  'before_read',
  'after_read',
  'before_current_path',
] as const) {
  test(`private JSON retries a legal atomic replacement ${phase}`, { timeout: 90000 }, async (t) => {
    const { result, store } = await race(t, phase);
    assert.equal(result.error, undefined, result.message);
    assert.equal(result.value, JSON.stringify(replacement));
    const initialUnlink = phase === 'during_lstat' && result.lstatNlink === 0;
    assert.equal(result.opens, initialUnlink ? 1 : 2);
    if (phase === 'during_lstat' && process.platform !== 'win32') assert.equal(result.lstatNlink, 0);
    assert.equal(store.saveIfUnchanged(original, session('late-refresh')), false);
    assert.deepEqual(store.load(), replacement);
  });
}

for (const phase of ['before_open', 'after_read', 'before_current_path'] as const) {
  test(`a clear ${phase} is observed without restoring stale credentials`, { timeout: 90000 }, async (t) => {
    const { result, file, store } = await race(t, phase, (_file, current) => current.clear());
    assert.equal(result.error, undefined, result.message);
    assert.equal(result.value, null);
    assert.equal(result.opens, 1);
    assert.equal(store.saveIfUnchanged(original, session('late-login')), false);
    assert.equal(store.load(), undefined);
    assert.equal(existsSync(file), false);
  });
}

test(
  'continuous atomic replacement returns bounded contention without stale bytes',
  { timeout: 90000 },
  async (t) => {
    const { result } = await race(t, 'continuous');
    assert.equal(result.error, 'CREDENTIAL_STORE_BUSY');
    assert.equal(result.opens, 5);
    assert.equal(result.readBytes, 0);
    assert.equal(result.value, undefined);
  },
);

for (const kind of ['symlink', 'hardlink', 'permissions', 'oversized'] as const) {
  test(`an unsafe ${kind} replacement is rejected before bytes are read`, { timeout: 90000 }, async (t) => {
    if (kind === 'permissions' && process.platform === 'win32') return t.skip('POSIX mode check');
    let probe: Awaited<ReturnType<typeof race>>;
    try {
      probe = await race(t, 'before_open', (file) => {
        const other = file + '.unsafe';
        writeFileSync(other, kind === 'oversized' ? 'x'.repeat(jsonEntryLimit + 1) : readFileSync(file), {
          mode: 0o600,
        });
        protectPrivateWindowsPath(other, 'file');
        if (kind === 'permissions') chmodSync(other, 0o644);
        unlinkSync(file);
        if (kind === 'symlink') symlinkSync(other, file, 'file');
        else if (kind === 'hardlink') linkSync(other, file);
        else renameSync(other, file);
      });
    } catch (error) {
      if (
        kind === 'symlink' &&
        process.platform === 'win32' &&
        (error as NodeJS.ErrnoException).code === 'EPERM'
      )
        return t.skip('Windows account lacks symbolic-link creation privilege.');
      throw error;
    }
    assert.equal(probe.result.error, 'CREDENTIAL_STORE_UNAVAILABLE');
    assert.equal(probe.result.opens, 1);
    assert.equal(probe.result.readBytes, 0);
  });
}

for (const bytes of ['invalid-json', '[]', '{"schema_version":1}', Buffer.from([0xff])]) {
  test(
    `a replacement with invalid JSON or schema (${String(bytes)}) fails after retry`,
    { timeout: 90000 },
    async (t) => {
      const { result } = await race(t, 'before_open', (file) => replaceBytes(file, bytes));
      assert.equal(result.error, 'CREDENTIAL_STORE_UNAVAILABLE');
      assert.equal(result.opens, 2);
      assert.equal(result.value, undefined);
    },
  );
}

for (const kind of ['permissions', 'oversized'] as const) {
  test(`an already unlinked inode with unsafe ${kind} is not retryable`, { timeout: 90000 }, async (t) => {
    if (kind === 'permissions' && process.platform === 'win32') return t.skip('POSIX mode check');
    const { result } = await race(t, 'during_lstat', (file, store) => {
      const old = openSync(file, 'r+');
      try {
        store.save(replacement);
        if (kind === 'permissions') fchmodSync(old, 0o644);
        else ftruncateSync(old, jsonEntryLimit + 1);
      } finally {
        closeSync(old);
      }
    });
    assert.equal(result.error, 'CREDENTIAL_STORE_UNAVAILABLE');
    assert.equal(result.opens, 0);
    assert.equal(result.readBytes, 0);
    if (process.platform !== 'win32') assert.equal(result.lstatNlink, 0);
  });
}

test('same-inode growth after opening stays bounded and fails closed', { timeout: 90000 }, async (t) => {
  const { result } = await race(t, 'before_read', (file) =>
    appendFileSync(file, 'x'.repeat(jsonEntryLimit + 1)),
  );
  assert.equal(result.error, 'CREDENTIAL_STORE_UNAVAILABLE');
  assert.equal(result.opens, 1);
  assert.equal(result.maxReadBuffer, jsonEntryLimit + 1);
  assert.equal(result.readBytes, jsonEntryLimit + 1);
});

test('a FIFO replacement cannot block the reader before file validation', { timeout: 90000 }, async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX FIFO check');
  const { result } = await race(t, 'before_open', (file) => {
    unlinkSync(file);
    const created = spawnSync('mkfifo', ['-m', '600', file], { encoding: 'utf8', timeout: 10000 });
    assert.equal(created.status, 0, created.stderr);
  });
  assert.equal(result.error, 'CREDENTIAL_STORE_UNAVAILABLE');
  assert.equal(result.opens, 1);
  assert.equal(result.readBytes, 0);
});

test(
  'same-inode content changes after the fd snapshot cannot be returned or retried',
  { timeout: 90000 },
  async (t) => {
    const { result } = await race(t, 'before_current_path', (file) => {
      const bytes = readFileSync(file, 'utf8');
      writeFileSync(file, bytes.replace('original', 'modified'));
      utimesSync(file, new Date('2030-01-01T00:00:00Z'), new Date('2030-01-01T00:00:00Z'));
    });
    assert.equal(result.error, 'CREDENTIAL_STORE_UNAVAILABLE');
    assert.equal(result.opens, 1);
    assert.equal(result.value, undefined);
  },
);

test('a replaced locked read fails before invoking a mutation callback', { timeout: 90000 }, async (t) => {
  const { result } = await race(t, 'before_open', (file) => replaceBytes(file, readFileSync(file)), 'update');
  assert.equal(result.error, 'CREDENTIAL_STORE_UNAVAILABLE');
  assert.equal(result.opens, 1);
  assert.equal(result.readBytes, 0);
  assert.equal(result.callbacks, 0);
});

for (const phase of ['before_initial_acl', 'before_final_acl'] as const) {
  for (const action of ['clear', 'replace'] as const)
    test(`a ${action} during the native Windows ${phase} is recovered`, { timeout: 90000 }, async (t) => {
      if (process.platform !== 'win32') return t.skip('Native Windows ACL check');
      const { result, file } = await race(
        t,
        phase,
        action === 'clear' ? (_file, store) => store.clear() : undefined,
      );
      assert.equal(result.error, undefined, result.message);
      assert.equal(result.value, action === 'clear' ? null : JSON.stringify(replacement));
      assert.equal(existsSync(file), action === 'replace');
    });
}
