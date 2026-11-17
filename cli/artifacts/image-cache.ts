/** 图片私有缓存的目录身份是边界；网络/编码的await不能允许目录被替换后继续读写。 */
import {
  constants,
  lstatSync,
  mkdirSync,
  realpathSync,
  mkdtempSync,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  writeFileSync,
  fsyncSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { TripoError } from '../../studio/contracts/errors.ts';

type CacheName = 'image-size-cache' | 'image-output-cache' | 'image-background-cache' | 'lab-reference-cache';
interface Directory {
  path: string;
  dev: number;
  ino: number;
}
const denied = (): TripoError =>
  new TripoError(
    'IMAGE_CACHE_PATH_DENIED',
    'The private image cache directory changed or is a symbolic link.',
    'read',
  );

function directory(file: string): Directory {
  const stat = lstatSync(file);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(file) !== file) throw denied();
  return { path: file, dev: stat.dev, ino: stat.ino };
}
function check(dirs: Directory[]): void {
  try {
    for (const expected of dirs) {
      const actual = directory(expected.path);
      if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw denied();
    }
  } catch {
    throw denied();
  }
}
function roots(dataDir: string, name: CacheName, create: boolean): Directory[] | undefined {
  const root = directory(realpathSync(dataDir)),
    file = path.join(root.path, name);
  let cache: Directory;
  try {
    cache = directory(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (!create) return;
    check([root]);
    try {
      mkdirSync(file, { mode: 0o700 });
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure;
    }
    cache = directory(file);
  }
  check([root, cache]);
  return [root, cache];
}

export interface ImageCacheDirectory {
  path: string;
  check: () => void;
  write: (name: string, bytes: Buffer) => string;
  cleanup: () => void;
}
export function createImageCache(dataDir: string, name: CacheName): ImageCacheDirectory {
  const dirs = roots(dataDir, name, true)!;
  const file = mkdtempSync(path.join(dirs[1]!.path, name === 'image-size-cache' ? 'verify-' : 'encode-'));
  dirs.push(directory(file));
  check(dirs);
  return {
    path: file,
    check: () => check(dirs),
    write: (name, bytes) => {
      if (!/^[a-z]+\.(png|jpeg|webp)$/.test(name)) throw denied();
      const target = path.join(file, name);
      let handle: number | undefined;
      check(dirs);
      try {
        // 校验、打开和写入之间不经过await；FD固定后仍重核父目录身份。
        handle = openSync(
          target,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        check(dirs);
        writeFileSync(handle, bytes);
        fsyncSync(handle);
        check(dirs);
        return target;
      } finally {
        if (handle !== undefined) closeSync(handle);
      }
    },
    cleanup: () => {
      // 目录已替换时保留原失败，不跟随新路径递归清理。
      try {
        check(dirs);
        rmSync(file, { recursive: true, force: true });
      } catch {
        /* preserve primary failure */
      }
    },
  };
}

export function readImageCache(
  dataDir: string,
  name: CacheName,
  file: string,
  proof: { sha256: string; bytes: number },
): Buffer | undefined {
  let handle: number | undefined;
  try {
    const dirs = roots(dataDir, name, false);
    if (!dirs) return;
    // 接受操作系统dataDir别名，但缓存内部每一级均不得是符号链接。
    const raw = path.resolve(file),
      configured = path.join(path.resolve(dataDir), name);
    const relative = raw.startsWith(configured + path.sep)
      ? path.relative(configured, raw)
      : path.relative(dirs[1]!.path, raw);
    const parts = relative.split(path.sep);
    if (parts.length !== 2 || parts.some((part) => !part || part === '.' || part === '..')) throw denied();
    const target = path.join(dirs[1]!.path, relative);
    dirs.push(directory(path.dirname(target)));
    check(dirs);
    const before = lstatSync(target);
    if (!before.isFile() || before.isSymbolicLink()) return;
    // 预检后也可能被换成FIFO；非阻塞打开再fstat，不能让私有缓存读永久占住主进程。
    handle = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    check(dirs);
    const stat = fstatSync(handle);
    if (
      !stat.isFile() ||
      stat.dev !== before.dev ||
      stat.ino !== before.ino ||
      stat.size !== proof.bytes ||
      proof.bytes <= 0 ||
      proof.bytes > 300 * 1024 * 1024
    )
      return;
    const bytes = readFileSync(handle);
    check(dirs);
    return createHash('sha256').update(bytes).digest('hex') === proof.sha256 ? bytes : undefined;
  } catch (error) {
    if (['ENOENT', 'ELOOP', 'EACCES'].includes(String((error as NodeJS.ErrnoException).code))) return;
    throw error;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}
