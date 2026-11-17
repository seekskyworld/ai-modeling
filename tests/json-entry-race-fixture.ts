/** Child-only probe: all hooks delegate to real file operations across a parent/child barrier. */
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { JsonEntry } from '../studio/auth/json-entry.ts';

export type JsonRacePhase =
  | 'during_lstat'
  | 'before_open'
  | 'after_open'
  | 'before_read'
  | 'after_read'
  | 'before_current_path'
  | 'before_initial_acl'
  | 'before_final_acl'
  | 'continuous';
export interface JsonRaceResult {
  value?: string | null;
  error?: string;
  message?: string;
  opens: number;
  handles: number;
  closes: number;
  inspectionHandles: number;
  inspectionCloses: number;
  lstatNlink?: number;
  maxReadBuffer: number;
  readBytes: number;
  callbacks: number;
}

const [phase, directory, file, operation] = process.argv.slice(2);
if (!directory || !file) throw new Error('Synthetic auth root and record path are required.');
const originalOpen = fs.openSync;
const originalLstat = fs.lstatSync;
const originalRead = fs.readSync;
const originalClose = fs.closeSync;
const originalFstat = fs.fstatSync;
const originalWrite = fs.writeSync;
const originalSpawn = childProcess.spawnSync;
const descriptors = new Set<number>();
const pause = new Int32Array(new SharedArrayBuffer(4));
let gated = false;
let stats = 0;
let aclChecks = 0;
const result: JsonRaceResult = {
  opens: 0,
  handles: 0,
  closes: 0,
  inspectionHandles: 0,
  inspectionCloses: 0,
  maxReadBuffer: 0,
  readBytes: 0,
  callbacks: 0,
};

function gate(where: JsonRacePhase): void {
  if (where !== phase || (gated && phase !== 'continuous')) return;
  gated = true;
  originalWrite(1, 'BARRIER\n');
  const byte = Buffer.alloc(1);
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try {
      if (originalRead(0, byte, 0, 1, null) === 1) return;
      throw new Error('Parent closed the synchronization pipe.');
    } catch (error) {
      // Some platforms expose child stdin as a nonblocking pipe.
      if (!['EAGAIN', 'EWOULDBLOCK'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      Atomics.wait(pause, 0, 0, 10);
    }
  }
  throw new Error('Parent did not release the synchronization barrier.');
}

Object.defineProperty(fs, 'lstatSync', {
  value(filename: fs.PathLike, ...args: unknown[]) {
    if (String(filename) !== file) return Reflect.apply(originalLstat, fs, [filename, ...args]);
    stats++;
    if (stats === 2) gate('before_current_path');
    if (phase !== 'during_lstat' || gated) return Reflect.apply(originalLstat, fs, [filename, ...args]);
    // Hold the looked-up inode; report its actual metadata after the parent replaces it.
    const inspected = originalOpen(filename, 'r');
    result.inspectionHandles++;
    try {
      gate('during_lstat');
      const info = originalFstat(inspected);
      result.lstatNlink = info.nlink;
      return info;
    } finally {
      originalClose(inspected);
      result.inspectionCloses++;
    }
  },
});
Object.defineProperty(fs, 'openSync', {
  value(...args: Parameters<typeof fs.openSync>) {
    if (String(args[0]) !== file) return originalOpen(...args);
    result.opens++;
    gate('continuous');
    gate('before_open');
    const descriptor = originalOpen(...args);
    descriptors.add(descriptor);
    result.handles++;
    gate('after_open');
    return descriptor;
  },
});
Object.defineProperty(fs, 'readSync', {
  value(descriptor: number, ...args: unknown[]) {
    if (!descriptors.has(descriptor)) return Reflect.apply(originalRead, fs, [descriptor, ...args]);
    const buffer = args[0];
    if (ArrayBuffer.isView(buffer)) result.maxReadBuffer = Math.max(result.maxReadBuffer, buffer.byteLength);
    gate('before_read');
    const count: number = Reflect.apply(originalRead, fs, [descriptor, ...args]);
    result.readBytes += count;
    if (count) gate('after_read');
    return count;
  },
});
Object.defineProperty(fs, 'closeSync', {
  value(descriptor: number) {
    if (descriptors.delete(descriptor)) result.closes++;
    return originalClose(descriptor);
  },
});
Object.defineProperty(childProcess, 'spawnSync', {
  value(...args: unknown[]) {
    const options = args[2] as { input?: unknown } | undefined;
    if (typeof options?.input === 'string') {
      const requests: { path: string }[] = JSON.parse(options.input);
      if (requests.some((request) => request.path === file)) {
        aclChecks++;
        gate(aclChecks === 1 ? 'before_initial_acl' : 'before_final_acl');
      }
    }
    return Reflect.apply(originalSpawn, childProcess, args);
  },
});
syncBuiltinESMExports();

try {
  const entry = new JsonEntry('ai-modeling', 'race', { directory });
  if (operation === 'update')
    entry.update((current) => {
      result.callbacks++;
      return current;
    });
  else result.value = entry.getPassword();
} catch (error) {
  result.error = (error as NodeJS.ErrnoException).code;
  result.message = (error as Error).message;
}
originalWrite(1, JSON.stringify(result) + '\n');
