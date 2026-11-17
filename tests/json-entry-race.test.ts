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
  ftruncateSync,
  linkSync,
  openSync,
  readFileSync,
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
import { protectPrivateWindowsPath } from '../studio/auth/windows-permissions.ts';
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
