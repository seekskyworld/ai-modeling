/** All files and subprocesses use the isolated runner's synthetic OS user or explicit temporary roots. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { JsonEntry, jsonEntryLimit } from '../studio/auth/json-entry.ts';
import { JsonStore, type Session } from '../studio/auth/credentials.ts';
import { JsonLinks } from '../studio/auth/artifact-links.ts';
import { saveUpload, loadUpload, type SavedUpload } from '../studio/auth/uploads.ts';
import { privateAuthDirectory, ensurePrivateAuthDirectory } from '../studio/auth/control-directory.ts';
import { withCredentialLock } from '../studio/auth/credential-lock.ts';
import {
  checkWindowsPermissions,
  verifyPrivateWindowsPath,
  windowsPermissionTimeoutMs,
} from '../studio/auth/windows-permissions.ts';
import { errorResult } from '../studio/contracts/errors.ts';

const session = (deviceId = 'synthetic-device'): Session => ({
  deviceId,
  importedAt: '2026-01-01T00:00:00Z',
  cookie: 'synthetic-cookie-value',
  accountRef: 'synthetic-account',
});
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const entryFile = (root: string, service: string, account: string) =>
  path.join(root, 'credentials', digest(service), `${digest(account)}.json`);
const unavailable = { code: 'CREDENTIAL_STORE_UNAVAILABLE' };
async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-json-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory: path.join(directory, 'auth'), parent: directory };
}

test('private JSON persists across instances, isolates profiles and uses hashed service/account filenames', async (t) => {
  const options = await fixture(t);
  const first = new JsonStore('profile-a', options);
  const second = new JsonStore('profile-b', options);
  assert.equal(first.load(), undefined);
  first.save(session('first'));
  second.save(session('second'));
  assert.deepEqual(new JsonStore('profile-a', options).load(), session('first'));
  assert.deepEqual(second.load(), session('second'));
  const file = entryFile(options.directory, 'ai-modeling', 'profile-a');
  const envelope = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(envelope.schema_version, 1);
  assert.equal(envelope.service, 'ai-modeling');
  assert.equal(envelope.account, 'profile-a');
  assert.deepEqual(JSON.parse(envelope.value), session('first'));
  if (process.platform !== 'win32') {
    assert.equal(lstatSync(file).mode & 0o7777, 0o600);
    assert.equal(lstatSync(path.dirname(file)).mode & 0o7777, 0o700);
    assert.equal(lstatSync(options.directory).mode & 0o7777, 0o700);
  }
  first.clear();
  assert.equal(new JsonStore('profile-a', options).load(), undefined);
  assert.deepEqual(second.load(), session('second'));
  assert.deepEqual(
    readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp')),
    [],
  );
});

test('session CAS, save and clear share the same profile lock and reject stale snapshots', async (t) => {
  const options = await fixture(t);
  const store = new JsonStore('cas', options);
  withCredentialLock(
    'cas',
    () => {
      for (const action of [
        () => store.save(session()),
        () => store.clear(),
        () => store.saveIfUnchanged(undefined, session()),
      ])
        assert.throws(action, { code: 'CREDENTIAL_STORE_BUSY' });
    },
    options.directory,
  );
  assert.equal(store.saveIfUnchanged(undefined, session('first')), true);
  assert.equal(store.saveIfUnchanged(undefined, session('late')), false);
  const before = store.load();
  assert.equal(store.saveIfUnchanged(before, session('refreshed')), true);
  assert.equal(store.saveIfUnchanged(before, session('late-refresh')), false);
  assert.deepEqual(store.load(), session('refreshed'));
});

test('two processes sharing an explicit auth root admit only one empty-snapshot CAS winner', async (t) => {
  const options = await fixture(t);
  const moduleUrl = new URL('../studio/auth/credentials.ts', import.meta.url).href;
  const barrier = path.join(options.parent, 'start');
  const run = async (name: string) => {
    const source = `import {existsSync} from 'node:fs';
import {setTimeout} from 'node:timers/promises';
import {JsonStore} from ${JSON.stringify(moduleUrl)};
const store=new JsonStore('race',${JSON.stringify(options)});
process.stdout.write('ready\\n');
while(!existsSync(${JSON.stringify(barrier)})) await setTimeout(10);
for(let i=0;i<300;i++) {try {process.stdout.write(JSON.stringify({saved:store.saveIfUnchanged(undefined,${JSON.stringify(session(name))})})+'\\n');break;}catch(error){if(error.code!=='CREDENTIAL_STORE_BUSY')throw error;await setTimeout(20);}}`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let errors = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    t.after(() => child.kill());
    const done = once(child, 'close');
    await once(child.stdout, 'data');
    return {
      child,
      done,
      result: () => {
        assert.equal(errors, '');
        return JSON.parse(output.trim().split('\n').at(-1)!);
      },
    };
  };
  const children = await Promise.all([run('child-a'), run('child-b')]);
  writeFileSync(barrier, 'go', { mode: 0o600 });
  for (const child of children) assert.equal((await child.done)[0], 0);
  assert.deepEqual(children.map((child) => child.result().saved).sort(), [false, true]);
  assert.ok(['child-a', 'child-b'].includes(new JsonStore('race', options).load()!.deviceId));
});

test('the OS-user root remains shared when child dataDir and TMPDIR change', async (t) => {
  const options = await fixture(t);
  const profile = `scope-${randomUUID()}`;
  const store = new JsonStore(profile);
  t.after(() => store.clear());
  store.save(session());
  const code = `import {JsonStore} from ${JSON.stringify(new URL('../studio/auth/credentials.ts', import.meta.url).href)};console.log(JSON.stringify(new JsonStore(${JSON.stringify(profile)}).load()));`;
  const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], {
    env: {
      ...process.env,
      TMPDIR: options.parent,
      AI_MODELING_DATA_DIR: path.join(options.parent, 'unrelated-data'),
    },
    timeout: 60000,
  });
  assert.deepEqual(JSON.parse(child.stdout), session());
  assert.equal(privateAuthDirectory(), path.join(userInfo().homedir, '.ai-modeling-auth'));
  assert.equal(existsSync(path.join(options.parent, 'unrelated-data')), false);
});

test('malformed, oversized, wrong-identity and invalid UTF-8 records fail closed without leaking data', async (t) => {
  const options = await fixture(t);
  const entry = new JsonEntry('synthetic', 'record', options);
  entry.setPassword('synthetic-private-value');
  const file = entryFile(options.directory, 'synthetic', 'record');
  const original = readFileSync(file);
  const envelope = JSON.parse(original.toString());
  const bad = [
    'not-json-synthetic-private-value',
    '[]',
    '{}',
    JSON.stringify({ ...envelope, account: 'wrong' }),
    JSON.stringify({ ...envelope, value: {} }),
    JSON.stringify({ ...envelope, extra: true }),
    'x'.repeat(jsonEntryLimit + 1),
    Buffer.from([0xff]),
  ];
  for (const content of bad) {
    writeFileSync(file, content);
    assert.throws(
      () => entry.getPassword(),
      (error: unknown) => {
        assert.equal(errorResult(error).code, unavailable.code);
        assert.equal(JSON.stringify(errorResult(error)).includes('synthetic-private-value'), false);
        return true;
      },
    );
    assert.throws(() => entry.setPassword('replacement'), unavailable);
  }
  writeFileSync(file, original);
  assert.equal(entry.getPassword(), 'synthetic-private-value');
  assert.throws(() => entry.setPassword('x'.repeat(jsonEntryLimit)), unavailable);
  assert.equal(entry.getPassword(), 'synthetic-private-value');
  writeFileSync(file, 'invalid-but-owned');
  entry.deleteCredential();
  assert.equal(entry.getPassword(), null);
});

test('session and upload payloads validate their structure and preserve account binding', async (t) => {
  const options = await fixture(t);
  const store = new JsonStore('schema', options);
  for (const invalid of [
    {},
    { ...session(), importedAt: 'now' },
    { ...session(), cookie: 4 },
    { ...session(), unknown: true },
  ])
    assert.throws(() => store.save(invalid as Session), unavailable);
  new JsonEntry('ai-modeling', 'schema', options).setPassword('{"deviceId":"missing-date"}');
  assert.throws(() => store.load(), unavailable);
  const saved: SavedUpload = {
    account: 'synthetic-account',
    path: 'synthetic-input.png',
    sha256: 'a'.repeat(64),
    format: 'png',
    reference: { bucket: 'synthetic', key: 'synthetic', image_audit_result: 'pass', image_source: 'upload' },
  };
  const token = saveUpload(saved, 'image', options);
  assert.deepEqual(loadUpload(token, 'synthetic-account', options), saved);
  assert.throws(() => loadUpload(token, 'different-account', options), { code: 'ACCOUNT_MISMATCH' });
  new JsonEntry('ai-modeling-upload', token, options).setPassword(
    JSON.stringify({ ...saved, reference: { bucket: 'only-one-field' } }),
  );
  assert.throws(() => loadUpload(token, undefined, options), unavailable);
});

test('artifact and LLM entries share JSON protection without ambiguous profile/job identities', async (t) => {
  const options = await fixture(t);
  const first = new JsonLinks('a:b', options);
  const second = new JsonLinks('a', options);
  first.set('c', 'https://example.invalid/one?synthetic=one');
  second.set('b:c', 'https://example.invalid/two?synthetic=two');
  assert.equal(first.get('c'), 'https://example.invalid/one?synthetic=one');
  assert.equal(second.get('b:c'), 'https://example.invalid/two?synthetic=two');
  assert.throws(() => first.set('bad', 'file:///synthetic'), unavailable);
  const llm = new JsonEntry('ai-modeling-llm', 'default', options);
  llm.setPassword('synthetic-planning-key');
  assert.equal(new JsonEntry('ai-modeling-llm', 'default', options).getPassword(), 'synthetic-planning-key');
  llm.deleteCredential();
  assert.equal(llm.getPassword(), null);
});

test('symlink and hardlink credential leaves are rejected without modifying their targets', async (t) => {
  const options = await fixture(t);
  const entry = new JsonEntry('synthetic', 'links', options);
  entry.setPassword('original');
  const file = entryFile(options.directory, 'synthetic', 'links');
  const target = path.join(options.parent, 'target');
  writeFileSync(target, 'unrelated-private-target', { mode: 0o600 });
  unlinkSync(file);
  try {
    symlinkSync(target, file, 'file');
  } catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM')
      return t.skip('Windows account lacks symbolic-link creation privilege.');
    throw error;
  }
  for (const action of [
    () => entry.getPassword(),
    () => entry.setPassword('changed'),
    () => entry.deleteCredential(),
  ])
    assert.throws(action, unavailable);
  assert.equal(readFileSync(target, 'utf8'), 'unrelated-private-target');
  unlinkSync(file);
  linkSync(target, file);
  assert.throws(() => entry.getPassword(), unavailable);
  assert.throws(() => entry.deleteCredential(), unavailable);
  assert.equal(readFileSync(target, 'utf8'), 'unrelated-private-target');
});

test('a record replaced during a locked callback cannot be deleted or overwritten', async (t) => {
  const options = await fixture(t);
  const entry = new JsonEntry('synthetic', 'changed', options);
  entry.setPassword('original');
  const file = entryFile(options.directory, 'synthetic', 'changed');
  const replacement = readFileSync(file, 'utf8').replace('original', 'newer-record');
  const displaced = path.join(options.parent, 'displaced');
  assert.throws(
    () =>
      entry.update(() => {
        renameSync(file, displaced);
        writeFileSync(file, replacement, { mode: 0o600 });
        return null;
      }),
    unavailable,
  );
  assert.equal(readFileSync(file, 'utf8'), replacement);
});

test(
  'POSIX unsafe file modes and permissions changed mid-update fail closed',
  { skip: process.platform === 'win32' },
  async (t) => {
    const options = await fixture(t);
    const entry = new JsonEntry('synthetic', 'mode', options);
    entry.setPassword('original');
    const file = entryFile(options.directory, 'synthetic', 'mode');
    chmodSync(file, 0o644);
    assert.throws(() => entry.getPassword(), unavailable);
    chmodSync(file, 0o600);
    assert.throws(
      () =>
        entry.update(() => {
          chmodSync(path.dirname(file), 0o755);
          return 'changed';
        }),
      unavailable,
    );
    chmodSync(path.dirname(file), 0o700);
    assert.equal(entry.getPassword(), 'original');
  },
);

test('Windows ACL helper uses a bounded system executable and rejects malformed or failed checks', () => {
  const location = 'C:\\synthetic\\private-auth';
  let calls = 0;
  checkWindowsPermissions([{ path: location, kind: 'directory' }], (executable, args, options) => {
    calls++;
    assert.ok(path.win32.isAbsolute(executable));
    assert.match(executable, /WindowsPowerShell\\v1\.0\\powershell\.exe$/);
    assert.ok(args.includes('-NoProfile'));
    assert.equal(JSON.stringify(args).includes(location), false);
    assert.equal(options.timeout, windowsPermissionTimeoutMs);
    assert.deepEqual(JSON.parse(String(options.input)), [{ path: location, kind: 'directory' }]);
    assert.equal(options.env?.NODE_OPTIONS, undefined);
    return { status: 0, signal: null, stdout: '{"ok":true}' };
  });
  assert.equal(calls, 1);
  for (const result of [
    { status: 0, signal: null, stdout: '{}' },
    { status: 1, signal: null, stdout: '{"ok":false}' },
    { status: null, signal: 'SIGKILL' as const, stdout: '' },
  ])
    assert.throws(
      () => checkWindowsPermissions([{ path: location, kind: 'directory' }], () => result),
      unavailable,
    );
  assert.throws(
    () =>
      checkWindowsPermissions([{ path: 'relative', kind: 'file' }], () =>
        assert.fail('Invalid input spawned a process'),
      ),
    unavailable,
  );
});

test('Windows ACL helper isolates system modules from caller module paths and credentials', () => {
  const overrides = {
    PSModulePath: 'C:\\synthetic\\untrusted-modules',
    PSHOME: 'C:\\synthetic\\untrusted-powershell',
    AI_MODELING_TOKEN: 'synthetic-token-do-not-forward',
    AI_MODELING_COOKIE: 'synthetic-cookie-do-not-forward',
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((name) => [name, process.env[name]]));
  Object.assign(process.env, overrides);
  try {
    checkWindowsPermissions(
      [{ path: 'C:\\synthetic\\私有 auth\\凭据.json', kind: 'file' }],
      (executable, args, options) => {
        const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
        const powerShellDirectory = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0');
        assert.equal(executable, path.win32.join(powerShellDirectory, 'powershell.exe'));
        assert.deepEqual(options.env, {
          SystemRoot: systemRoot,
          WINDIR: systemRoot,
          PSModulePath: path.win32.join(powerShellDirectory, 'Modules'),
        });
        const script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1]!, 'base64').toString('utf16le');
        assert.ok(
          script.includes(
            "[IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Utility.psd1')",
          ),
        );
        assert.ok(script.includes('Import-Module -Name $utilityModule -ErrorAction Stop'));
        assert.ok(script.includes('Microsoft.PowerShell.Utility\\ConvertFrom-Json'));
        const forwarded = JSON.stringify({ executable, args, options, script });
        for (const value of Object.values(overrides)) assert.equal(forwarded.includes(value), false);
        return { status: 0, signal: null, stdout: '{"ok":true}' };
      },
    );
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test(
  'native Windows DACL validation rejects an extra Everyone access rule',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const options = await fixture(t);
    ensurePrivateAuthDirectory(options.directory);
    verifyPrivateWindowsPath(options.directory, 'directory');
    const executable = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');
    const result = spawnSync(executable, [options.directory, '/grant', '*S-1-1-0:(R)'], {
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, 0);
    assert.throws(() => verifyPrivateWindowsPath(options.directory, 'directory'), unavailable);
    const marker = path.join(options.directory, 'keep-control-state');
    writeFileSync(marker, 'synthetic-revocation-marker');
    ensurePrivateAuthDirectory(options.directory);
    verifyPrivateWindowsPath(options.directory, 'directory');
    assert.equal(readFileSync(marker, 'utf8'), 'synthetic-revocation-marker');
  },
);
