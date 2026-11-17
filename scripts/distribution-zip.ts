/** Small ZIP writer using only Node's built-in compression; no platform zip command. */
import { crc32, deflateRawSync } from 'node:zlib';
import { assertUniquePaths } from './package-validation.ts';

export interface ZipEntry {
  path: string;
  bytes: Buffer;
  executable?: boolean;
}

export function createZip(entries: ZipEntry[]): Buffer {
  assertUniquePaths(entries.map((entry) => entry.path));
  if (!entries.length || entries.length >= 65535) throw new Error('ZIP file count exceeds supported limits.');
  const local: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  let total = 0;
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path, 'en'))) {
    total += entry.bytes.length;
    if (entry.bytes.length > 64 * 1024 * 1024 || total > 256 * 1024 * 1024)
      throw new Error('Skill archive exceeds supported size limits.');
    const name = Buffer.from(entry.path, 'utf8');
    if (name.length > 65535) throw new Error('ZIP filename exceeds supported limits.');
    const compressed = deflateRawSync(entry.bytes, { level: 9 });
    const checksum = crc32(entry.bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(33, 12); // 1980-01-01; stable archives without machine timestamps.
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(entry.bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // Unix, ZIP 2.0.
    header.copy(central, 6, 4, 30);
    central.writeUInt32LE(((entry.executable ? 0o100755 : 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    local.push(header, name, compressed);
    directory.push(central, name);
    offset += header.length + name.length + compressed.length;
  }
  const centralBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}
