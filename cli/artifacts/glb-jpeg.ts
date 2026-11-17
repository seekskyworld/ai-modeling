/** GLB 只重编码嵌入图：追加图片，不经过模型导入/重导出，原网格、蒙皮及动作字节保持不变。 */
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { array, object, TripoError } from '../../studio/contracts/errors.ts';
import { verifyNativeMeshopt } from './native-meshopt.ts';
import {
  inspectJpegTextureLayout,
  applyJpegTextureLayout,
  type JpegTextureRewrite,
} from './jpeg-texture-policy.ts';

const MAX_BYTES = 300 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

export interface GlbJpegInspection {
  version: 1;
  source_sha256: string;
  source_bytes: number;
  binary_sha256: string;
  binary_bytes: number;
  images: Array<{
    index: number;
    mime: string;
    width: number;
    height: number;
    bytes: number;
    sha256: string;
  }>;
}
interface ParsedGlb {
  json: Record<string, unknown>;
  binary: Buffer;
  images: Record<string, unknown>[];
  views: Record<string, unknown>[];
  textureRewrites: JpegTextureRewrite[];
}
function unsupported(message: string): never {
  throw new TripoError('TEXTURE_ENCODING_UNSUPPORTED', message, 'read');
}
function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function chunkLayout(bytes: Buffer): number {
  if (
    bytes.length < 28 ||
    bytes.length > MAX_BYTES ||
    bytes.toString('ascii', 0, 4) !== 'glTF' ||
    bytes.readUInt32LE(4) !== 2 ||
    bytes.readUInt32LE(8) !== bytes.length ||
    bytes.readUInt32LE(16) !== 0x4e4f534a
  )
    return unsupported('JPEG texture-only conversion requires a valid bounded GLB 2.0.');
  const size = bytes.readUInt32LE(12),
    next = 20 + size;
  if (
    size > 16 * 1024 * 1024 ||
    size % 4 !== 0 ||
    next + 8 > bytes.length ||
    bytes.readUInt32LE(next + 4) !== 0x004e4942 ||
    bytes.readUInt32LE(next) % 4 !== 0 ||
    next + 8 + bytes.readUInt32LE(next) !== bytes.length
  )
    return unsupported('JPEG texture-only conversion requires one JSON and one embedded binary chunk.');
  return next;
}
function parse(bytes: Buffer): ParsedGlb {
  const next = chunkLayout(bytes);
  let json: Record<string, unknown>;
  try {
    json = object(JSON.parse(bytes.toString('utf8', 20, next)));
  } catch {
    return unsupported('The GLB JSON cannot be read.');
  }
  const buffers = array(json.buffers).map(object),
    length = buffers[0]?.byteLength;
  if (
    object(json.asset).version !== '2.0' ||
    ![1, 2].includes(buffers.length) ||
    buffers[0]?.uri !== undefined ||
    !integer(length) ||
    length > bytes.readUInt32LE(next) ||
    bytes.readUInt32LE(next) - length > 3
  )
    return unsupported('JPEG texture-only conversion requires one self-contained GLB binary buffer.');
  if (
    buffers.length === 2 &&
    (buffers[1]!.uri !== undefined ||
      !integer(buffers[1]!.byteLength) ||
      object(object(buffers[1]!.extensions).EXT_meshopt_compression).fallback !== true ||
      Object.keys(object(buffers[1]!.extensions)).length !== 1 ||
      !array(json.extensionsRequired).includes('EXT_meshopt_compression'))
  )
    return unsupported('An additional buffer is only supported as the verified native Meshopt fallback.');
  const binary = bytes.subarray(next + 8, next + 8 + length),
    images = array(json.images).map(object),
    views = array(json.bufferViews).map(object);
  if (images.length > 64) unsupported('JPEG texture-only conversion supports at most 64 images.');
  return { json, binary, images, views, textureRewrites: inspectJpegTextureLayout(json, images) };
}
function imageBytes(parsed: ParsedGlb, image: Record<string, unknown>): Buffer {
  const index = image.bufferView;
  if (!integer(index) || !MIME.has(String(image.mimeType)))
    return unsupported('JPEG texture-only conversion requires embedded PNG, JPEG or WebP images.');
  const view = parsed.views[index],
    offset = view?.byteOffset ?? 0,
    length = view?.byteLength;
  if (
    !view ||
    view.buffer !== 0 ||
    view.extensions !== undefined ||
    view.byteStride !== undefined ||
    !integer(offset) ||
    !integer(length) ||
    length === 0 ||
    offset + length > parsed.binary.length
  )
    return unsupported('An embedded image has an unsupported or invalid bufferView.');
  return parsed.binary.subarray(offset, offset + length);
}
async function decodedImage(bytes: Buffer, mime: string) {
  try {
    const metadata = await sharp(bytes, { failOn: 'error', limitInputPixels: MAX_PIXELS }).metadata();
    if (
      `image/${metadata.format}` !== mime ||
      (metadata.pages ?? 1) !== 1 ||
      (metadata.orientation ?? 1) !== 1 ||
      metadata.depth !== 'uchar'
    )
      return unsupported('JPEG texture-only conversion requires a single 8-bit image without EXIF rotation.');
    // 不旋转/改尺寸，不静默去透明；整个图像解码也拒绝仅文件头正确的损坏输入。
    const decoded = await sharp(bytes, { failOn: 'error', limitInputPixels: MAX_PIXELS })
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    for (let i = 3; i < decoded.data.length; i += 4)
      if (decoded.data[i] !== 255)
        return unsupported('JPEG texture-only conversion does not discard non-opaque image pixels.');
    return decoded;
  } catch (error) {
    if (error instanceof TripoError) throw error;
    return unsupported('An embedded texture could not be completely decoded within the image limits.');
  }
}
async function inspect(bytes: Buffer, parsed: ParsedGlb): Promise<GlbJpegInspection> {
  if (array(parsed.json.extensionsUsed).includes('EXT_meshopt_compression')) await verifyNativeMeshopt(bytes);
  const images: GlbJpegInspection['images'] = [];
  const pixelsByImage = new Map<number, { width: number; height: number; sha256: string }>();
  let pixels = 0;
  for (const [index, image] of parsed.images.entries()) {
    const data = imageBytes(parsed, image),
      decoded = await decodedImage(data, String(image.mimeType)),
      { width, height } = decoded.info;
    pixels += width * height;
    if (pixels > MAX_PIXELS) return unsupported('Embedded textures exceed the total JPEG pixel limit.');
    if (parsed.textureRewrites.some((rewrite) => rewrite.source === index || rewrite.fallback === index))
      pixelsByImage.set(index, { width, height, sha256: hash(decoded.data) });
    images.push({
      index,
      mime: String(image.mimeType),
      width,
      height,
      bytes: data.length,
      sha256: hash(data),
    });
  }
  for (const rewrite of parsed.textureRewrites) {
    if (rewrite.fallback === undefined) continue;
    const primary = pixelsByImage.get(rewrite.source)!,
      fallback = pixelsByImage.get(rewrite.fallback)!;
    if (
      primary.width !== fallback.width ||
      primary.height !== fallback.height ||
      primary.sha256 !== fallback.sha256
    )
      return unsupported(
        'WebP and its fallback decode to different pixels; JPEG conversion cannot select an equivalent image.',
      );
  }
  return {
    version: 1,
    source_sha256: hash(bytes),
    source_bytes: bytes.length,
    binary_sha256: hash(parsed.binary),
    binary_bytes: parsed.binary.length,
    images,
  };
}

/** 提交前检查精确来源；最终原生导出仍必须独立再次检查，不能用来源标记代替结果实物。 */
export async function inspectGlbJpeg(bytes: Buffer): Promise<GlbJpegInspection> {
  return await inspect(bytes, parse(bytes));
}

export async function encodeGlbJpeg(bytes: Buffer): Promise<{
  bytes: Buffer;
  inspection: GlbJpegInspection;
  processing: string;
}> {
  const parsed = parse(bytes),
    inspection = await inspect(bytes, parsed);
  const changes = inspection.images.filter((image) => image.mime !== 'image/jpeg');
  if (!changes.length)
    return {
      bytes,
      inspection,
      processing: 'Verified native GLB JPEG textures; original model bytes retained',
    };
  const buffers = [parsed.binary];
  let length = parsed.binary.length;
  for (const image of changes) {
    const source = parsed.images[image.index]!,
      original = imageBytes(parsed, source),
      encoded = await sharp(original, { failOn: 'error', limitInputPixels: MAX_PIXELS })
        .toColourspace('srgb')
        .removeAlpha()
        .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
        .toBuffer();
    const padding = (4 - (length % 4)) % 4;
    if (padding) buffers.push(Buffer.alloc(padding));
    length += padding;
    source.bufferView = parsed.views.length;
    source.mimeType = 'image/jpeg';
    parsed.views.push({ buffer: 0, byteOffset: length, byteLength: encoded.length });
    buffers.push(encoded);
    length += encoded.length;
    if (length > MAX_BYTES) return unsupported('The encoded GLB exceeds the output byte limit.');
  }
  parsed.json.images = parsed.images;
  parsed.json.bufferViews = parsed.views;
  applyJpegTextureLayout(parsed.json, parsed.textureRewrites);
  array(parsed.json.buffers).map(object)[0]!.byteLength = length;
  const rawJson = Buffer.from(JSON.stringify(parsed.json)),
    jsonPadding = (4 - (rawJson.length % 4)) % 4,
    binaryPadding = (4 - (length % 4)) % 4,
    total = 28 + rawJson.length + jsonPadding + length + binaryPadding;
  if (total > MAX_BYTES) return unsupported('The encoded GLB exceeds the output byte limit.');
  const header = Buffer.alloc(20),
    binaryHeader = Buffer.alloc(8);
  header.write('glTF');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  header.writeUInt32LE(rawJson.length + jsonPadding, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  binaryHeader.writeUInt32LE(length + binaryPadding);
  binaryHeader.writeUInt32LE(0x004e4942, 4);
  return {
    bytes: Buffer.concat([
      header,
      rawJson,
      Buffer.alloc(jsonPadding, 0x20),
      binaryHeader,
      ...buffers,
      Buffer.alloc(binaryPadding),
    ]),
    inspection,
    processing:
      'Native Studio GLB followed by local opaque JPEG texture encoding; original geometry, skins and animation bytes retained',
  };
}
