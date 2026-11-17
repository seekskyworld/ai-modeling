/** 凭据锁和登录撤销按 OS 用户+profile 共享，不能被业务 dataDir 或 TMPDIR 分裂。 */
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';
import { TripoError } from '../contracts/errors.ts';

/** 同步验证便于凭据库的同步 CAS 复用；测试可对独立临时目录验证同一检查。 */
export function ensurePrivateAuthDirectory(directory: string): string {
  try {
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const info = lstatSync(directory);
    const uid = process.getuid?.();
    if (!info.isDirectory() || info.isSymbolicLink() || (uid !== undefined && info.uid !== uid))
      throw new Error('Invalid auth directory.');
    if (process.platform === 'win32') {
      chmodSync(directory, 0o700);
    } else {
      // 不用路径 chmod 跟随检查后被替换的符号链接；锁目录必须一直是刚核验的本机目录。
      const descriptor = openSync(
        directory,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
      );
      try {
        const opened = fstatSync(descriptor);
        if (!opened.isDirectory() || opened.uid !== uid || opened.ino !== info.ino || opened.dev !== info.dev)
          throw new Error('Auth directory changed.');
        fchmodSync(descriptor, 0o700);
      } finally {
        closeSync(descriptor);
      }
    }
    return directory;
  } catch {
    throw new TripoError(
      'AUTH_DIRECTORY_INVALID',
      'Authentication control storage must be a private directory owned by the current OS user.',
      'not_submitted',
    );
  }
}

export function privateAuthDirectory(child?: 'credential-locks' | 'login-sessions'): string {
  // userInfo 读取 OS 账号记录，避免 HOME / TMPDIR / AI_MODELING_DATA_DIR 改变 profile 的撤销作用域。
  const root = ensurePrivateAuthDirectory(path.join(userInfo().homedir, '.ai-modeling-auth'));
  return child ? ensurePrivateAuthDirectory(path.join(root, child)) : root;
}
