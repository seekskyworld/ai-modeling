/** Exercise real disposable subprocesses; no test in this file accesses native credentials. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { KeyringStore, type Session } from '../studio/auth/credentials.ts';
import { withCredentialLock } from '../studio/auth/credential-lock.ts';
import { keyringMessageLimit, type KeyringRequest } from '../studio/auth/keyring-protocol.ts';
import { keyringTimeoutMs, runKeyring } from '../studio/auth/keyring-process.ts';
import { errorResult } from '../studio/contracts/errors.ts';

const request: KeyringRequest = {
  version: 1,
  service: 'synthetic-keyring-service',
  account: 'synthetic-keyring-account',
  secretService: true,
  operation: 'get',
};
const worker = fileURLToPath(new URL('../studio/auth/keyring-worker.ts', import.meta.url));
const unavailable = { code: 'CREDENTIAL_STORE_UNAVAILABLE' };

function isolatedEnvironment(options: SpawnSyncOptionsWithStringEncoding): NodeJS.ProcessEnv {
  assert.ok(process.env.MODELING_TEST_SANDBOX, 'Use the isolated test runner.');
  assert.match(process.env.NODE_OPTIONS ?? '', /isolation-hook/);
  return {
    ...options.env,
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    MODELING_TEST_SANDBOX: process.env.MODELING_TEST_SANDBOX,
    MODELING_TEST_WORKER: process.env.MODELING_TEST_WORKER,
  };
}

test('credential values only cross private pipes and the native helper environment excludes runtime injection', (t) => {
  const secret = 'synthetic-secret-from-private-pipe';
  const names = ['AI_MODELING_TOKEN', 'NPM_TOKEN', 'NODE_OPTIONS', 'NODE_V8_COVERAGE', 'DEBUG'];
  const originals = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const name of names) {
      if (originals[name] === undefined) delete process.env[name];
      else process.env[name] = originals[name];
    }
  });
  for (const name of names) process.env[name] = secret;
  const write: KeyringRequest = { ...request, operation: 'set', value: secret };
  let invoked = 0;
  assert.equal(
    runKeyring(write, (executable, args, options) => {
      invoked++;
      assert.equal(executable, process.execPath);
      assert.deepEqual(args, [worker]);
      assert.equal(JSON.stringify(args).includes(secret), false);
      assert.equal(JSON.stringify(options.env).includes(secret), false);
      for (const name of names) assert.equal(options.env?.[name], undefined);
      assert.equal(options.timeout, keyringTimeoutMs);
      assert.equal(options.killSignal, 'SIGKILL');
      assert.deepEqual(options.stdio, ['pipe', 'pipe', 'ignore']);
      assert.equal(options.maxBuffer, keyringMessageLimit);
      assert.deepEqual(JSON.parse(String(options.input)), write);
      return spawnSync(
        executable,
        [
          '--input-type=module',
          '-e',
          `
      let input=''; for await (const chunk of process.stdin) input += chunk;
      const request=JSON.parse(input);
      if (request.operation !== 'set' || !request.value) process.exit(2);
      process.stdout.write('{"ok":true}');
    `,
        ],
        options,
      );
    }),
    null,
  );
  assert.equal(invoked, 1);
});

test('the source helper supports get, set and delete with native credentials replaced by the test loader', () => {
  const runner: NonNullable<Parameters<typeof runKeyring>[1]> = (executable, args, options) => {
    assert.deepEqual(args, [worker]);
    return spawnSync(executable, args, { ...options, env: isolatedEnvironment(options) });
  };
  assert.equal(runKeyring(request, runner), null);
  assert.equal(runKeyring({ ...request, operation: 'set', value: 'synthetic-value' }, runner), null);
  assert.equal(runKeyring({ ...request, operation: 'delete' }, runner), null);
});

test('the helper rejects malformed or oversized inputs without exposing their contents', () => {
  for (const input of [
    'synthetic-invalid-secret',
    JSON.stringify({ ...request, operation: 'execute', value: 'synthetic-invalid-secret' }),
    'x'.repeat(keyringMessageLimit + 1),
  ]) {
    const options: SpawnSyncOptionsWithStringEncoding = {
      input,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 1024,
    };
    const result = spawnSync(process.execPath, [worker], {
      ...options,
      env: isolatedEnvironment(options),
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '{"ok":false}');
    assert.equal(result.stderr.includes('synthetic-invalid-secret'), false);
  }
});

test('invalid child responses, nonzero exits and output overflow fail closed without echoing secrets', () => {
  const programs = [
    'process.stdout.write("not-json")',
    'process.stdout.write("[]")',
    'process.stdout.write(JSON.stringify({ok:true}))',
    'process.stdout.write(JSON.stringify({ok:true,value:25}))',
    'process.stdout.write(JSON.stringify({ok:true,value:null,extra:true}))',
    'process.stdout.write(JSON.stringify({ok:false,error:"synthetic-private-error"}))',
    'process.stderr.write("synthetic-private-error"); process.exitCode=2',
    `process.stdout.write('x'.repeat(${keyringMessageLimit + 1}))`,
  ];
  for (const code of programs) {
    assert.throws(
      () =>
        runKeyring(request, (executable, _args, options) =>
          spawnSync(executable, ['--input-type=module', '-e', code], options),
        ),
      (error: unknown) => {
        const result = errorResult(error);
        assert.equal(result.code, unavailable.code);
        assert.equal(result.certainty, 'read');
        assert.match(String(result.message), /Unlock.*allow ai-modeling \(Node\.js\)/);
        assert.equal(JSON.stringify(result).includes('synthetic-private-error'), false);
        return true;
      },
    );
  }
});

test('a stuck native operation is forcibly terminated and returns a bounded credential error', () => {
  let pid = 0;
  const started = Date.now();
  assert.throws(
    () =>
      runKeyring({ ...request, operation: 'set', value: 'synthetic-value' }, (executable, _args, options) => {
        const child = spawnSync(
          executable,
          ['--input-type=module', '-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);'],
          { ...options, timeout: 150 },
        );
        pid = child.pid;
        assert.equal(child.signal, 'SIGKILL');
        return child;
      }),
    (error: unknown) => {
      const result = errorResult(error);
      assert.equal(result.code, unavailable.code);
      assert.equal(result.certainty, 'unknown');
      assert.match(String(result.message), /did not respond.*retry the original command/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 3000, 'Native waiting cannot indefinitely block the CLI.');
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('invalid requests are rejected before any native helper is started', () => {
  for (const input of [
    { ...request, service: 'invalid\nservice' },
    { ...request, account: '' },
    { ...request, operation: 'set', value: 'x'.repeat(keyringMessageLimit) },
  ]) {
    assert.throws(
      () =>
        runKeyring(input as KeyringRequest, () => {
          assert.fail('Invalid input must not start a process.');
        }),
      unavailable,
    );
  }
});

test('a timed-out credential write releases the profile lock and late CAS cannot overwrite its possible result', () => {
  const profile = `synthetic-keyring-timeout-${randomUUID()}`;
  const first: Session = { deviceId: 'synthetic-device', importedAt: '2026-01-01T00:00:00Z' };
  let saved: string | null = null;
  let writes = 0;
  const store = Object.create(KeyringStore.prototype) as KeyringStore;
  Object.assign(store, {
    profile,
    entry: {
      getPassword: () => saved,
      setPassword(value: string) {
        writes++;
        saved = value;
        assert.throws(() => withCredentialLock(profile, () => assert.fail('lock lost')), {
          code: 'CREDENTIAL_STORE_BUSY',
        });
        runKeyring({ ...request, operation: 'set', value }, (executable, _args, options) =>
          spawnSync(executable, ['--input-type=module', '-e', 'setInterval(()=>{},1000)'], {
            ...options,
            timeout: 150,
          }),
        );
      },
    },
  });
  assert.throws(() => store.saveIfUnchanged(undefined, first), unavailable);
  assert.equal(
    withCredentialLock(profile, () => 'released'),
    'released',
  );
  assert.deepEqual(store.load(), first);
  assert.equal(store.saveIfUnchanged(undefined, { ...first, deviceId: 'late-writer' }), false);
  assert.equal(writes, 1);
});
