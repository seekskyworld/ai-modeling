/** USDZ/3MF 本身就是 ZIP；依据中央目录识别容器，不能要求用户把有效模型改名成 .zip。 */
import { TripoError } from './contracts/errors.ts';

export function zipFormat(bytes: Buffer): string {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > bytes.length)
    throw new TripoError('INVALID_ARTIFACT', 'ZIP central directory is missing.');
  const directory = zipDirectory(bytes, end);
  const count = directory.count;
  let offset = directory.offset;
  const entries: { name: string; compression: number }[] = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50)
      throw new TripoError('INVALID_ARTIFACT', 'ZIP central directory is truncated.');
    const length = bytes.readUInt16LE(offset + 28);
    const next = offset + 46 + length + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
    if (next > end) throw new TripoError('INVALID_ARTIFACT', 'ZIP entry is truncated.');
    entries.push({
      name: bytes.toString('utf8', offset + 46, offset + 46 + length),
      compression: bytes.readUInt16LE(offset + 10),
    });
    offset = next;
  }
  const names = new Set(entries.map((e) => e.name));
  if (names.has('[Content_Types].xml') && names.has('3D/3dmodel.model')) return '3mf';
  if (/\.(usd|usda|usdc)$/i.test(entries[0]?.name ?? '') && entries.every((e) => e.compression === 0))
    return 'usdz';
  return 'zip';
}

/** Studio 的 3MF 即使很小也可能使用 ZIP64，不能把 0xffffffff 当作真实目录偏移。 */
function zipDirectory(bytes: Buffer, end: number): { count: number; offset: number } {
  const count = bytes.readUInt16LE(end + 10);
  const offset = bytes.readUInt32LE(end + 16);
  if (count !== 0xffff && offset !== 0xffffffff) return { count, offset };
  const locator = end - 20;
  if (locator < 0 || bytes.readUInt32LE(locator) !== 0x07064b50)
    throw new TripoError('INVALID_ARTIFACT', 'ZIP64 locator is missing.');
  const position = Number(bytes.readBigUInt64LE(locator + 8));
  if (position < 0 || position + 56 > locator || bytes.readUInt32LE(position) !== 0x06064b50)
    throw new TripoError('INVALID_ARTIFACT', 'ZIP64 central directory is invalid.');
  const total = Number(bytes.readBigUInt64LE(position + 32));
  const start = Number(bytes.readBigUInt64LE(position + 48));
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(start) || total > 65535 || start > position)
    throw new TripoError('INVALID_ARTIFACT', 'ZIP64 directory exceeds supported bounds.');
  return { count: total, offset: start };
}
