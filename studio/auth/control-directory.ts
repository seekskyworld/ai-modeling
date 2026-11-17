/** 凭据锁和登录撤销按 OS 用户+profile 共享，不能被业务 dataDir 或 TMPDIR 分裂。 */
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  type Stats,
} from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';
import { TripoError } from '../contracts/errors.ts';
import { applyPrivateWindowsPaths } from './windows-permissions.ts';

export interface AuthStorageOptions {
  /** Explicit dependency injection for isolated consumers; production uses the OS user directory. */
  directory?: string;
}

export function authRootDirectory(directory?: string): string {
  const root = directory ?? path.join(userInfo().homedir, '.ai-modeling-auth');
  if (!path.isAbsolute(root))
    throw new TripoError(
      'AUTH_DIRECTORY_INVALID',
      'Authentication storage requires an absolute private directory.',
    );
  return root;
}

/** 同步验证便于凭据库的同步 CAS 复用；测试可对独立临时目录验证同一检查。 */
export function ensurePrivateAuthDirectory(directory: string): string {
  ensurePrivateAuthDirectories([directory]);
  return directory;
}

function ownedDirectory(info: Stats, checkMode = false): boolean {
  const uid = process.getuid?.();
  return (
    info.isDirectory() &&
    !info.isSymbolicLink() &&
    (uid === undefined || info.uid === uid) &&
    (!checkMode || process.platform === 'win32' || (info.mode & 0o7777) === 0o700)
  );
}

/** Validate a whole path chain in one Windows ACL process; never cache access permissions. */
export function ensurePrivateAuthDirectories(directories: string[], files: string[] = []): void {
  try {
    const permissions: { path: string; kind: 'directory' | 'file'; protect?: boolean; repair?: boolean }[] =
      [];
    const snapshots = [];
    for (const directory of directories) {
      let created = false;
      try {
        mkdirSync(directory, { mode: 0o700 });
        created = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const info = lstatSync(directory);
      snapshots.push(info);
      if (!ownedDirectory(info)) throw new Error('Invalid auth directory.');
      if (process.platform === 'win32') {
        permissions.push({ path: directory, kind: 'directory', protect: created, repair: !created });
      } else {
        const descriptor = openSync(
          directory,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
        );
        try {
          const opened = fstatSync(descriptor);
          if (!ownedDirectory(opened) || opened.ino !== info.ino || opened.dev !== info.dev)
            throw new Error('Auth directory changed.');
          if ((opened.mode & 0o7777) !== 0o700) fchmodSync(descriptor, 0o700);
        } finally {
          closeSync(descriptor);
        }
      }
    }
    applyPrivateWindowsPaths([
      ...permissions,
      ...files.map((file) => ({ path: file, kind: 'file' as const })),
    ]);
    for (const [index, directory] of directories.entries()) {
      const current = lstatSync(directory);
      const original = snapshots[index]!;
      if (!ownedDirectory(current, true) || current.dev !== original.dev || current.ino !== original.ino)
        throw new Error('Auth directory changed.');
    }
  } catch {
    throw new TripoError(
      'AUTH_DIRECTORY_INVALID',
      'Authentication control storage must be a private directory owned by the current OS user.',
      'not_submitted',
    );
  }
}

export function privateAuthDirectory(
  child?: 'credential-locks' | 'login-sessions' | 'credentials',
  directory?: string,
): string {
  // userInfo 读取 OS 账号记录，避免 HOME / TMPDIR / AI_MODELING_DATA_DIR 改变 profile 的撤销作用域。
  const root = authRootDirectory(directory);
  const destination = child ? path.join(root, child) : root;
  ensurePrivateAuthDirectories(child ? [root, destination] : [root]);
  return destination;
}
