/** Canvas Lab 允许视频附件；按网页格式/大小登记原字节，先核容器，绝不把任意文件伪装成视频。 */
import path from 'node:path';
import { readBoundedFile, readInput } from '../files.ts';
import { TripoError } from '../contracts/errors.ts';

const videoTypes: Record<string, string> = {
  '3gp': 'video/3gpp',
  avi: 'video/x-msvideo',
  flv: 'video/x-flv',
  m4v: 'video/x-m4v',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  rmvb: 'video/vnd.rn-realvideo',
  ts: 'video/mp2t',
  webm: 'video/webm',
  wmv: 'video/x-ms-wmv',
};

function isoMedia(bytes: Buffer): boolean {
  const atoms = new Set<string>();
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 8 > bytes.length) return false;
    const size32 = bytes.readUInt32BE(offset);
    const headerSize = size32 === 1 ? 16 : 8;
    if (offset + headerSize > bytes.length) return false;
    const size =
      size32 === 0
        ? bytes.length - offset
        : size32 === 1
          ? Number(bytes.readBigUInt64BE(offset + 8))
          : size32;
    if (!Number.isSafeInteger(size) || size < headerSize || size > bytes.length - offset) return false;
    atoms.add(bytes.toString('ascii', offset + 4, offset + 8));
    offset += size;
  }
  return atoms.has('moov') && atoms.has('mdat');
}

function windowsMedia(bytes: Buffer) {
  return (
    bytes.length >= 30 &&
    bytes.subarray(0, 16).equals(Buffer.from('3026b2758e66cf11a6d900aa0062ce6c', 'hex')) &&
    bytes.readBigUInt64LE(16) <= BigInt(bytes.length)
  );
}

function ebmlMedia(bytes: Buffer, format: string) {
  const header = bytes.subarray(0, Math.min(4096, bytes.length));
  return (
    bytes.readUInt32BE(0) === 0x1a45dfa3 &&
    header.includes(Buffer.from(format === 'webm' ? 'webm' : 'matroska')) &&
    bytes.includes(Buffer.from([0x18, 0x53, 0x80, 0x67]))
  );
}

function transportStream(bytes: Buffer) {
  return [188, 192].some((stride) => {
    const start = stride === 192 ? 4 : 0;
    return (
      bytes.length >= stride * 3 &&
      Array.from(
        { length: Math.min(8, Math.floor(bytes.length / stride)) },
        (_, i) => bytes[start + i * stride],
      ).every((byte) => byte === 0x47)
    );
  });
}

/** 只验证媒体容器结构，不声称验证全部编码、时长、视频内容或 Lab 的理解结果。 */
export function validateCanvasVideo(bytes: Buffer, format: string): void {
  if (bytes.length < 16) throw new TripoError('INPUT_FORMAT', 'Canvas video is truncated.');
  let valid = false;
  if (['mp4', 'm4v', 'mov', '3gp'].includes(format)) valid = isoMedia(bytes);
  else if (format === 'avi')
    valid =
      bytes.toString('ascii', 0, 4) === 'RIFF' &&
      bytes.toString('ascii', 8, 12) === 'AVI ' &&
      bytes.readUInt32LE(4) + 8 === bytes.length;
  else if (format === 'mkv' || format === 'webm') valid = ebmlMedia(bytes, format);
  else if (format === 'flv')
    valid =
      bytes.toString('ascii', 0, 3) === 'FLV' &&
      bytes[3] === 1 &&
      bytes.readUInt32BE(5) >= 9 &&
      bytes.readUInt32BE(5) <= bytes.length - 4;
  else if (format === 'rmvb')
    valid =
      bytes.toString('ascii', 0, 4) === '.RMF' &&
      bytes.readUInt32BE(4) <= bytes.length &&
      ['PROP', 'MDPR', 'DATA'].every((atom) => bytes.includes(Buffer.from(atom)));
  else if (format === 'wmv') valid = windowsMedia(bytes);
  else if (format === 'ts') valid = transportStream(bytes);
  if (!valid)
    throw new TripoError(
      'INPUT_FORMAT',
      'Canvas video bytes do not match the declared container or are truncated.',
    );
}

export async function readCanvasInput(filePath: string, roots: string[]) {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  const contentType = videoTypes[extension];
  if (contentType) {
    const file = await readBoundedFile(filePath, roots, 150 * 1024 * 1024);
    validateCanvasVideo(file.bytes, extension);
    return { ...file, format: extension, kind: 'ASSET_KIND_VIDEO', contentType };
  }
  const file = await readInput(filePath, roots, 100 * 1024 * 1024, [
    'png',
    'jpeg',
    'webp',
    'glb',
    'fbx',
    'obj',
    'stl',
    'gltf',
  ]);
  const image = ['png', 'jpeg', 'webp'].includes(file.format);
  if (image && file.bytes.length > 20 * 1024 * 1024)
    throw new TripoError('INPUT_SIZE', 'Canvas images must be at most 20 MiB.');
  return {
    ...file,
    kind: image ? 'ASSET_KIND_IMAGE' : 'ASSET_KIND_MODEL',
    contentType: image ? `image/${file.format}` : 'application/octet-stream',
  };
}
