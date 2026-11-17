/** Bind installation to the exact regular archive bytes inspected and hashed. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { productionLock, validateBundledPaths } from './dependency-lock.ts';
import {
  assertDistributionPath,
  assertPackageFile,
  assertUniquePaths,
  requiredPackageFiles,
} from './package-validation.ts';

const maximumArchiveBytes = 256 * 1024 * 1024;

export async function snapshotArchive(archive: string, directory: string) {
  const selected = path.resolve(archive);
  if (!selected.endsWith('.tgz')) throw new Error('--archive must name a .tgz file.');
  const before = await lstat(selected);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximumArchiveBytes)
    throw new Error('Use a regular, non-symlink TGZ no larger than 256 MiB.');
  const handle = await open(
    selected,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeMs !== before.mtimeMs
    )
      throw new Error('Archive changed before reading.');
    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || length !== opened.size)
      throw new Error('Archive changed while reading.');
    const bytes = buffer.subarray(0, length);
    const filename = path.join(directory, 'package.tgz');
    await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
    return { filename, sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally {
    await handle.close();
  }
}

function tarNumber(header: Buffer, start: number, length: number): number {
  const text = header
    .toString('ascii', start, start + length)
    .replace(/\0.*$/s, '')
    .trim();
  if (!/^[0-7]+$/.test(text)) throw new Error('Unsupported tar number encoding.');
  return Number.parseInt(text, 8);
}

function paxPath(bytes: Buffer): string | undefined {
  let offset = 0;
  let result: string | undefined;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    if (space < 0) throw new Error('Invalid tar extension.');
    const length = Number(bytes.toString('ascii', offset, space));
    if (!Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > bytes.length)
      throw new Error('Invalid tar extension length.');
    const record = bytes.toString('utf8', space + 1, offset + length);
    if (!record.endsWith('\n')) throw new Error('Invalid tar extension record.');
    const separator = record.indexOf('=');
    const key = record.slice(0, separator);
    if (key === 'path') result = record.slice(separator + 1, -1);
    else if (!['mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname'].includes(key))
      throw new Error(`Unsupported tar extension: ${key}`);
    offset += length;
  }
  return result;
}

/** Admit only portable regular package files; never follow archive links or special devices. */
export function archiveEntries(compressed: Buffer): { path: string; bytes: Buffer; mode: number }[] {
  const tar = gunzipSync(compressed, { maxOutputLength: maximumArchiveBytes });
  const entries: { path: string; bytes: Buffer; mode: number }[] = [];
  let offset = 0;
  let extendedPath: string | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (!tar.subarray(offset).every((byte) => byte === 0)) throw new Error('Unexpected trailing tar data.');
      break;
    }
    const expected = tarNumber(header, 148, 8);
    const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (actual !== expected) throw new Error('Tar header checksum mismatch.');
    const size = tarNumber(header, 124, 12);
    offset += 512;
    if (offset + size > tar.length) throw new Error('Truncated tar entry.');
    const bytes = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    const type = String.fromCharCode(header[156]!);
    if (type === 'x') {
      extendedPath = paxPath(bytes);
      continue;
    }
    if (!['0', '\0', '5'].includes(type)) throw new Error('Archive links and special files are not allowed.');
    const text = (start: number, length: number) =>
      header.toString('utf8', start, start + length).replace(/\0.*$/s, '');
    const prefix = text(345, 155);
    const filename = extendedPath ?? [prefix, text(0, 100)].filter(Boolean).join('/');
    extendedPath = undefined;
    if (type === '5' && (filename === 'package' || filename === 'package/')) continue;
    if (!filename.startsWith('package/')) throw new Error('Archive entries must be inside package/.');
    const relative = filename.slice('package/'.length).replace(/\/$/, '');
    assertDistributionPath(relative);
    if (type === '5') continue;
    assertPackageFile(relative);
    entries.push({ path: relative, bytes, mode: tarNumber(header, 100, 8) & 0o755 });
  }
  if (extendedPath || !entries.length || offset > tar.length) throw new Error('Incomplete package archive.');
  assertUniquePaths(entries.map((entry) => entry.path));
  if (entries.some((entry) => entry.path.startsWith('node_modules/'))) {
    const metadata = entries.find((entry) => entry.path === 'package.json');
    const reviewed = entries.find((entry) => entry.path === 'npm-shrinkwrap.json');
    if (!metadata || !reviewed) throw new Error('Bundled dependencies require package metadata and lock.');
    const lock = productionLock(JSON.parse(metadata.bytes.toString()), JSON.parse(reviewed.bytes.toString()));
    validateBundledPaths(
      lock,
      entries.map((entry) => entry.path),
    );
  }
  return entries;
}

export async function extractArchive(snapshot: string, directory: string) {
  const entries = archiveEntries(await readFile(snapshot));
  const names = new Set(entries.map((entry) => entry.path));
  for (const required of [...requiredPackageFiles, 'npm-shrinkwrap.json'])
    if (!names.has(required)) throw new Error(`Archive is missing ${required}.`);
  await mkdir(directory, { mode: 0o700 });
  for (const entry of entries) {
    const filename = path.join(directory, entry.path);
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await writeFile(filename, entry.bytes, { flag: 'wx', mode: entry.mode });
  }
}
