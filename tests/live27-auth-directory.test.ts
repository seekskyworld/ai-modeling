/** 只验证目录与随机profile锁，不构造真实Keyring Entry。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { ensurePrivateAuthDirectory, privateAuthDirectory } from '../studio/auth/control-directory.ts';
import { withCredentialLock } from '../studio/auth/credential-lock.ts';

test('authentication control storage is based on the OS user home and repairs only owned directory permissions', async () => {
  assert.equal(privateAuthDirectory(), path.join(userInfo().homedir, '.ai-modeling-auth'));
  assert.equal(
    privateAuthDirectory('credential-locks'),
    path.join(privateAuthDirectory(), 'credential-locks'),
  );
  const temporary = await mkdtemp(path.join(tmpdir(), 'tripo-auth-directory-'));
  try {
    const directory = path.join(temporary, 'owned');
    assert.equal(ensurePrivateAuthDirectory(directory), directory);
    await chmod(directory, 0o755);
    ensurePrivateAuthDirectory(directory);
    if (process.platform !== 'win32') assert.equal((await lstat(directory)).mode & 0o777, 0o700);
    const regular = path.join(temporary, 'regular');
    await writeFile(regular, 'keep-original');
    assert.throws(() => ensurePrivateAuthDirectory(regular), { code: 'AUTH_DIRECTORY_INVALID' });
    const link = path.join(temporary, 'symlink');
    await symlink(directory, link, 'dir');
    assert.throws(() => ensurePrivateAuthDirectory(link), { code: 'AUTH_DIRECTORY_INVALID' });
    assert.equal((await lstat(link)).isSymbolicLink(), true);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('different TMPDIR values cannot split the same profile credential lock across processes', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'tripo-auth-tmpdir-'));
  const profile = `live27-control-lock-${randomUUID()}`;
  const moduleUrl = new URL('../studio/auth/credential-lock.ts', import.meta.url).href;
  const source = `import {withCredentialLock} from ${JSON.stringify(moduleUrl)};
withCredentialLock(${JSON.stringify(profile)},()=>{
  process.stdout.write('locked\\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500);
});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, TMPDIR: temporary },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'close');
  try {
    await once(child.stdout, 'data');
    assert.throws(
      () => withCredentialLock(profile, () => assert.fail('Entered an already held profile lock')),
      {
        code: 'CREDENTIAL_STORE_BUSY',
      },
    );
    assert.equal((await exited)[0], 0);
    assert.equal(
      withCredentialLock(profile, () => 'released'),
      'released',
    );
  } finally {
    child.kill();
    await rm(temporary, { recursive: true, force: true });
  }
});
