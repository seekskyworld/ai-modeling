/** Private, bounded JSON records. One service/account per file prevents unrelated updates colliding. */
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { TripoError } from '../contracts/errors.ts';
import {
  authRootDirectory,
  ensurePrivateAuthDirectories,
  type AuthStorageOptions,
} from './control-directory.ts';
import { withJsonEntryLock } from './credential-lock.ts';
import { protectPrivateWindowsPath, verifyPrivateWindowsPaths } from './windows-permissions.ts';

export const jsonEntryLimit = 1024 * 1024;
const jsonEntryReadAttempts = 5;
class JsonEntryReplaced extends Error {}
export const jsonStorageRecoveryMessage =
  'Private local JSON storage could not be accessed safely. Check its ownership, permissions, available disk space and JSON integrity, then retry the original action.';

export function jsonStorageUnavailable(certainty: TripoError['certainty'] = 'read'): TripoError {
  return new TripoError('CREDENTIAL_STORE_UNAVAILABLE', jsonStorageRecoveryMessage, certainty);
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function privateFile(info: Stats, retryReplacement = false): void {
  const uid = process.getuid?.();
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (info.nlink !== 1 && !(retryReplacement && info.nlink === 0)) ||
    (uid !== undefined && info.uid !== uid) ||
    (process.platform !== 'win32' && (info.mode & 0o7777) !== 0o600)
  )
    throw jsonStorageUnavailable();
  if (retryReplacement && info.size > jsonEntryLimit) throw jsonStorageUnavailable();
  // A legal rename/clear can unlink a safe inode while another process reads it.
  // Reject unsafe metadata above before treating that inode as retryable contention.
  if (retryReplacement && info.nlink === 0) throw new JsonEntryReplaced();
}
function existingFile(location: string, retryReplacement = false): Stats | undefined {
  try {
    const info = lstatSync(location);
    privateFile(info, retryReplacement);
    return info;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
function replaced(retryReplacement: boolean): never {
  if (retryReplacement) throw new JsonEntryReplaced();
  throw jsonStorageUnavailable();
}
function currentFile(location: string, expected: Stats, retryReplacement: boolean): Stats {
  const current = existingFile(location, retryReplacement);
  if (!current || !sameFile(current, expected)) replaced(retryReplacement);
  return current;
}
function synchronizeDirectory(file: string): void {
  if (process.platform === 'win32') return;
  const directory = openSync(
    path.dirname(file),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
  );
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

export class JsonEntry {
  private service: string;
  private account: string;
  private options: AuthStorageOptions;
  constructor(service: string, account: string, options: AuthStorageOptions = {}) {
    if (
      typeof service !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(service) ||
      typeof account !== 'string' ||
      !account ||
      account.length > 4096 ||
      [...account].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    )
      throw jsonStorageUnavailable('not_submitted');
    this.service = service;
    this.account = account;
    this.options = options;
  }
  private location(retryReplacement = false): {
    file: string;
    directories: string[];
    snapshots: Stats[];
    existing?: Stats;
  } {
    const root = authRootDirectory(this.options.directory);
    const directories = [
      root,
      path.join(root, 'credentials'),
      path.join(root, 'credentials', hash(this.service)),
    ];
    const file = path.join(directories[2]!, `${hash(this.account)}.json`);
    const existing = existingFile(file, retryReplacement);
    try {
      ensurePrivateAuthDirectories(directories, existing ? [file] : []);
    } catch (error) {
      // Windows checks ACLs by path: a clear during that check can report a missing leaf.
      // Revalidate directories independently before classifying a changed leaf as contention.
      if (retryReplacement && existing && process.platform === 'win32') {
        ensurePrivateAuthDirectories(directories);
        currentFile(file, existing, true);
      }
      throw error;
    }
    return { file, directories, snapshots: directories.map((directory) => lstatSync(directory)), existing };
  }
  private unchangedDirectories(location: ReturnType<JsonEntry['location']>): void {
    for (const [index, directory] of location.directories.entries()) {
      const current = lstatSync(directory);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        !sameFile(current, location.snapshots[index]!) ||
        (process.getuid && current.uid !== process.getuid()) ||
        (process.platform !== 'win32' && (current.mode & 0o7777) !== 0o700)
      )
        throw jsonStorageUnavailable();
    }
  }
  private unchangedFile(location: ReturnType<JsonEntry['location']>): void {
    const current = existingFile(location.file);
    if (
      Boolean(current) !== Boolean(location.existing) ||
      (current && location.existing && !sameFile(current, location.existing))
    )
      throw jsonStorageUnavailable('unknown');
  }
  private verifyRead(
    location: ReturnType<JsonEntry['location']>,
    after: Stats,
    retryReplacement: boolean,
  ): void {
    this.unchangedDirectories(location);
    const directories = location.directories.map((directory) => ({
      path: directory,
      kind: 'directory' as const,
    }));
    try {
      verifyPrivateWindowsPaths([...directories, { path: location.file, kind: 'file' }]);
    } catch (error) {
      if (retryReplacement && process.platform === 'win32') {
        this.unchangedDirectories(location);
        verifyPrivateWindowsPaths(directories);
        currentFile(location.file, after, true);
      }
      throw error;
    }
    const current = currentFile(location.file, after, retryReplacement);
    if (current.size !== after.size || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs)
      throw jsonStorageUnavailable();
  }
  private decoded(bytes: Uint8Array): string {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw jsonStorageUnavailable();
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(',') !== 'account,schema_version,service,value' ||
      record.schema_version !== 1 ||
      record.service !== this.service ||
      record.account !== this.account ||
      typeof record.value !== 'string'
    )
      throw jsonStorageUnavailable();
    return record.value;
  }
  private read(location: ReturnType<JsonEntry['location']>, retryReplacement = false): string | null {
    if (!location.existing) return null;
    if (location.existing.size > jsonEntryLimit) throw jsonStorageUnavailable();
    let descriptor: number;
    try {
      descriptor = openSync(
        location.file,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
    } catch (error) {
      if (retryReplacement && (error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new JsonEntryReplaced();
      throw error;
    }
    try {
      const opened = fstatSync(descriptor);
      privateFile(opened, retryReplacement);
      if (!sameFile(opened, location.existing)) replaced(retryReplacement);
      const bytes = Buffer.alloc(jsonEntryLimit + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(descriptor, bytes, length, bytes.length - length, null);
        if (!count) break;
        length += count;
      }
      if (length > jsonEntryLimit) throw jsonStorageUnavailable();
      const after = fstatSync(descriptor);
      privateFile(after, retryReplacement);
      if (after.size !== length || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs)
        throw jsonStorageUnavailable();
      this.verifyRead(location, after, retryReplacement);
      return this.decoded(bytes.subarray(0, length));
    } finally {
      closeSync(descriptor);
    }
  }
  getPassword(): string | null {
    // Read retries never run a mutation callback or restore an earlier value.
    // A completed clear is observed as null; CAS/save/delete retain their existing lock.
    for (let attempt = 0; attempt < jsonEntryReadAttempts; attempt++) {
      try {
        return this.read(this.location(true), true);
      } catch (error) {
        if (error instanceof JsonEntryReplaced) continue;
        if (error instanceof TripoError) throw error;
        throw jsonStorageUnavailable();
      }
    }
    throw new TripoError(
      'CREDENTIAL_STORE_BUSY',
      'The private JSON record is being updated by another process. Retry the original action.',
      'read',
    );
  }
  private encoded(value: string): string {
    if (typeof value !== 'string') throw jsonStorageUnavailable('not_submitted');
    const encoded =
      JSON.stringify({ schema_version: 1, service: this.service, account: this.account, value }) + '\n';
    if (Buffer.byteLength(encoded) > jsonEntryLimit) throw jsonStorageUnavailable('not_submitted');
    return encoded;
  }
  private commit(location: ReturnType<JsonEntry['location']>, value: string): void {
    const encoded = this.encoded(value);
    const temporary = path.join(path.dirname(location.file), `.${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    let failure: unknown;
    try {
      this.unchangedDirectories(location);
      descriptor = openSync(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      protectPrivateWindowsPath(temporary, 'file');
      privateFile(fstatSync(descriptor));
      writeFileSync(descriptor, encoded, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      this.unchangedDirectories(location);
      this.unchangedFile(location);
      renameSync(temporary, location.file);
      synchronizeDirectory(location.file);
    } catch (error) {
      failure = error;
    } finally {
      try {
        if (descriptor !== undefined) closeSync(descriptor);
      } catch (error) {
        failure ??= error;
      }
      try {
        unlinkSync(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failure ??= error;
      }
    }
    if (failure !== undefined)
      throw failure instanceof TripoError ? failure : jsonStorageUnavailable('unknown');
  }
  /** The callback sees the latest record while holding the same lock used by all mutations. */
  update(change: (current: string | null) => string | null): void {
    withJsonEntryLock(
      this.service,
      this.account,
      () => {
        try {
          const location = this.location();
          const current = this.read(location);
          const next = change(current);
          if (next === current) return;
          if (next === null) {
            if (location.existing) {
              this.unchangedDirectories(location);
              this.unchangedFile(location);
              unlinkSync(location.file);
              synchronizeDirectory(location.file);
            }
          } else this.commit(location, next);
        } catch (error) {
          if (error instanceof TripoError) throw error;
          throw jsonStorageUnavailable('unknown');
        }
      },
      this.options.directory,
    );
  }
  setPassword(value: string): void {
    this.encoded(value);
    this.update(() => value);
  }
  deleteCredential(): void {
    withJsonEntryLock(
      this.service,
      this.account,
      () => {
        try {
          const location = this.location();
          if (location.existing) {
            this.unchangedDirectories(location);
            this.unchangedFile(location);
            unlinkSync(location.file);
            synchronizeDirectory(location.file);
          }
        } catch (error) {
          if (error instanceof TripoError) throw error;
          throw jsonStorageUnavailable('unknown');
        }
      },
      this.options.directory,
    );
  }
}
