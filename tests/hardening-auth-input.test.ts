/** 仅合成私有文件与显式冲突；不读取真实凭据库或登录状态目录。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  writeFile,
  mkdir,
  chmod,
  open,
  appendFile,
  rm,
  symlink,
  utimes,
  type FileHandle,
} from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readCredentialFile } from '../cli/auth/credential-file.ts';
import { resolveLoginBrowserOptions } from '../cli/auth/browser-options.ts';
import { beginLogin, ensureLogin } from '../cli/auth/coordinator.ts';
import { protectPrivateWindowsPath } from '../studio/auth/windows-permissions.ts';

test('explicit browser modes override the opposite environment default without mutating it', () => {
  const env = {
    AI_MODELING_BROWSER_EXECUTABLE: '/synthetic/chrome',
    AI_MODELING_BROWSER_CDP_ENDPOINT: 'http://127.0.0.1:9222',
  };
  assert.deepEqual(resolveLoginBrowserOptions({ cdpEndpoint: 'http://127.0.0.1:9333' }, env), {
    cdpEndpoint: 'http://127.0.0.1:9333',
  });
  assert.deepEqual(resolveLoginBrowserOptions({ executablePath: '/explicit/chrome' }, env), {
    executablePath: '/explicit/chrome',
  });
  assert.deepEqual(env, {
    AI_MODELING_BROWSER_EXECUTABLE: '/synthetic/chrome',
    AI_MODELING_BROWSER_CDP_ENDPOINT: 'http://127.0.0.1:9222',
  });
  assert.throws(() => resolveLoginBrowserOptions({}, env), { code: 'INVALID_INPUT' });
  assert.deepEqual(resolveLoginBrowserOptions({}, { AI_MODELING_BROWSER_EXECUTABLE: '' }), {});
  assert.deepEqual(resolveLoginBrowserOptions({}, { AI_MODELING_BROWSER_EXECUTABLE: '   ' }), {});
  assert.deepEqual(resolveLoginBrowserOptions({}, { AI_MODELING_BROWSER_EXECUTABLE: '/synthetic/chrome' }), {
    executablePath: '/synthetic/chrome',
  });
  assert.deepEqual(
    resolveLoginBrowserOptions({}, { AI_MODELING_BROWSER_CDP_ENDPOINT: 'http://127.0.0.1:9222' }),
    { cdpEndpoint: 'http://127.0.0.1:9222' },
  );
});

test('explicit browser conflicts and empty values fail before configuration, credentials or flow access', async () => {
  for (const options of [
    { executablePath: '/synthetic/chrome', cdpEndpoint: 'http://127.0.0.1:9222' },
    { executablePath: '' },
    { cdpEndpoint: '   ' },
  ]) {
    assert.throws(() => resolveLoginBrowserOptions(options, {}), { code: 'INVALID_INPUT' });
    await assert.rejects(beginLogin(options), { code: 'INVALID_INPUT' });
    await assert.rejects(ensureLogin(options), { code: 'INVALID_INPUT' });
  }
});

test('credential files require a private bounded regular file and never expose raw filesystem errors', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-credential-security-'));
  const file = path.join(directory, 'SYNTHETIC_PRIVATE_PATH');
  try {
    const synthetic = JSON.stringify({ cookie: 'synthetic-cookie-not-real' });
    await writeFile(file, synthetic, { mode: 0o600 });
    if (process.platform === 'win32') protectPrivateWindowsPath(file, 'file');
    assert.equal(await readCredentialFile(file), synthetic);
    assert.equal(await readCredentialFile(path.relative(process.cwd(), file)), synthetic);
    await writeFile(file, Buffer.alloc(131072, 65));
    assert.equal((await readCredentialFile(file)).length, 131072);
    await writeFile(file, Buffer.alloc(131073, 65));
    await assert.rejects(readCredentialFile(file), { code: 'INVALID_CREDENTIAL' });
    await writeFile(file, synthetic);
    await symlink(file, path.join(directory, 'link'));
    await assert.rejects(readCredentialFile(path.join(directory, 'link')), { code: 'INVALID_CREDENTIAL' });
    await mkdir(path.join(directory, 'folder'));
    await assert.rejects(readCredentialFile(path.join(directory, 'folder')), { code: 'INVALID_CREDENTIAL' });
    if (process.platform !== 'win32') {
      await chmod(file, 0o644);
      await assert.rejects(readCredentialFile(file), { code: 'CREDENTIAL_FILE_PERMISSIONS' });
      execFileSync('mkfifo', [path.join(directory, 'fifo')]);
      await assert.rejects(readCredentialFile(path.join(directory, 'fifo')), { code: 'INVALID_CREDENTIAL' });
    }
    await assert.rejects(readCredentialFile(file + '-missing'), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(directory), false);
      assert.equal(error.message.includes('SYNTHETIC_PRIVATE_PATH'), false);
      return true;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const change of ['growth', 'same-size', 'permissions'] as const) {
  test(`credential ${change} during the same-descriptor read is rejected with bounded consumption`, async (t) => {
    if (change === 'permissions' && process.platform === 'win32') return t.skip('Unix mode check');
    const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-credential-mutation-'));
    const file = path.join(directory, 'synthetic-private-file');
    try {
      await writeFile(file, Buffer.alloc(8192, 65), { mode: 0o600 });
      if (process.platform === 'win32') protectPrivateWindowsPath(file, 'file');
      const handle = await open(file, 'r'),
        prototype = Object.getPrototypeOf(handle),
        original = handle.read;
      await handle.close();
      let modified = false,
        consumed = 0;
      t.mock.method(prototype, 'read', async function (this: FileHandle, ...args: unknown[]) {
        const result = await Reflect.apply(original, this, args);
        consumed += result.bytesRead;
        if (!modified) {
          modified = true;
          if (change === 'growth') await appendFile(file, Buffer.alloc(1024 * 1024, 66));
          else if (change === 'permissions') await chmod(file, 0o644);
          else {
            await writeFile(file, Buffer.alloc(8192, 66));
            await utimes(file, new Date(), new Date(Date.now() + 60000));
          }
        }
        return result;
      });
      await assert.rejects(readCredentialFile(file), {
        code:
          change === 'growth'
            ? 'INVALID_CREDENTIAL'
            : change === 'permissions'
              ? 'CREDENTIAL_FILE_PERMISSIONS'
              : 'CREDENTIAL_FILE_CHANGED',
      });
      assert.ok(consumed <= 131073);
      assert.equal(modified, true);
    } finally {
      t.mock.restoreAll();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
