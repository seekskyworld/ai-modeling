/** 固定引擎文件小于3MiB；同步FD读写让网络等待后的目录换链不能越过缓存边界。 */
import {
  constants,
  lstatSync,
  realpathSync,
  mkdirSync,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  writeFileSync,
  fsyncSync,
  linkSync,
  unlinkSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { inside } from '../../studio/files.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import { studioAssimpFiles, verifyRuntime, type RuntimeKind } from './manifest.ts';

interface Directory {
  path: string;
  dev: number;
  ino: number;
}
const denied = (): TripoError =>
  new TripoError('FRONTEND_RUNTIME_PATH', 'Runtime directory changed or contains a symbolic link.');
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

function directory(file: string): Directory {
  const stat = lstatSync(file);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(file) !== file) throw denied();
  return { path: file, dev: stat.dev, ino: stat.ino };
}
function check(dirs: Directory[]): void {
  try {
    for (const expected of dirs) {
      const current = directory(expected.path);
      if (current.dev !== expected.dev || current.ino !== expected.ino) throw denied();
    }
  } catch {
    throw denied();
  }
}

export interface RuntimeDirectory {
  path: string;
  check: () => void;
  read: (kind: RuntimeKind) => Buffer | undefined;
  publish: (kind: RuntimeKind, bytes: Buffer) => boolean;
}

function guardedDirectory(dirs: Directory[], writable: boolean): RuntimeDirectory {
  const last = dirs.at(-1)!;
  const read = (kind: RuntimeKind): Buffer | undefined => {
    check(dirs);
    const pinned = studioAssimpFiles[kind],
      file = path.join(last.path, pinned.name);
    let handle: number | undefined;
    try {
      // 不先realpath最终文件，避免把有相同摘要的符号链接当作可信缓存。
      const entry = lstatSync(file);
      if (entry.isSymbolicLink()) throw denied();
      if (!entry.isFile())
        throw new TripoError('FRONTEND_RUNTIME_INTEGRITY', `Runtime ${pinned.name} is not a regular file.`);
      // 预检后被换成FIFO时O_NONBLOCK也不会等待写端；随后FD stat再次限制常规文件。
      handle = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      check(dirs);
      const stat = fstatSync(handle);
      if (!stat.isFile() || stat.size !== pinned.bytes)
        throw new TripoError('FRONTEND_RUNTIME_INTEGRITY', `Runtime ${pinned.name} has the wrong size.`);
      const bytes = Buffer.alloc(pinned.bytes + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(handle, bytes, length, bytes.length - length, null);
        if (!count) break;
        length += count;
      }
      check(dirs);
      return verifyRuntime(bytes.subarray(0, length), kind);
    } catch (error) {
      check(dirs);
      if (missing(error)) return;
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw denied();
      throw error;
    } finally {
      if (handle !== undefined) closeSync(handle);
    }
  };
  return {
    path: last.path,
    check: () => check(dirs),
    read,
    publish: (kind, bytes) => {
      if (!writable) throw denied();
      verifyRuntime(bytes, kind);
      check(dirs);
      if (read(kind)) return false;
      const target = path.join(last.path, studioAssimpFiles[kind].name),
        temporary = path.join(last.path, `.runtime-${randomUUID()}.part`);
      let handle: number | undefined;
      try {
        handle = openSync(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        check(dirs);
        writeFileSync(handle, bytes);
        fsyncSync(handle);
        check(dirs);
        try {
          // link提供不覆盖发布；并发安装的胜出者也必须重新通过固定摘要。
          linkSync(temporary, target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          if (!read(kind)) throw denied();
          return false;
        }
        check(dirs);
        if (!read(kind)) throw denied();
        return true;
      } finally {
        if (handle !== undefined) closeSync(handle);
        try {
          check(dirs);
          unlinkSync(temporary);
        } catch {
          /* 已换目录时不追随新路径清理；保留原始失败。 */
        }
      }
    },
  };
}

export const runtimeCachePath = (dataDir: string): string =>
  path.join(path.resolve(dataDir), 'studio-frontend', studioAssimpFiles.wasm.sha256);

export function runtimeCache(dataDir: string, create: boolean): RuntimeDirectory | undefined {
  let root: Directory;
  try {
    root = directory(realpathSync(dataDir));
  } catch (error) {
    if (!missing(error)) throw error;
    if (!create) return;
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    root = directory(realpathSync(dataDir));
  }
  const dirs = [root];
  for (const name of ['studio-frontend', studioAssimpFiles.wasm.sha256]) {
    const file = path.join(dirs.at(-1)!.path, name);
    check(dirs);
    try {
      dirs.push(directory(file));
    } catch (error) {
      if (!missing(error)) throw error;
      if (!create) return;
      check(dirs);
      try {
        mkdirSync(file, { mode: 0o700 });
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure;
      }
      dirs.push(directory(file));
    }
  }
  check(dirs);
  return guardedDirectory(dirs, true);
}

export function runtimeSource(sourceDir: string, inputRoots: string[] = []): RuntimeDirectory {
  let actual: string;
  try {
    actual = realpathSync(sourceDir);
  } catch (error) {
    if (!missing(error)) throw error;
    throw new TripoError('FRONTEND_RUNTIME_MISSING', 'The supplied runtime source directory does not exist.');
  }
  if (inputRoots.length && !inputRoots.some((root) => inside(realpathSync(root), actual)))
    throw new TripoError('INPUT_PATH_DENIED', 'Runtime source directory is outside AI_MODELING_INPUT_ROOTS.');
  // 用户显式根目录允许操作系统别名；目录内部最终文件仍必须是常规文件。
  return guardedDirectory([directory(actual)], false);
}
