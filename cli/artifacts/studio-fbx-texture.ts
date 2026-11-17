/** FBX 的嵌入底色贴图只取原 R 属性；磁盘路径仅作来源标签，绝不读取外部依赖。 */
import sharp from '../runtime/sharp.ts';
import { crc32 } from 'node:zlib';
import { TripoError } from '../../studio/contracts/errors.ts';
import { singleNode, type FbxNode, type FbxValue } from '../../studio/fbx/structure.ts';
import { frontendFail as fail } from './studio-assimp-normalize.ts';
import { studioAssimpHash } from './studio-assimp-assets.ts';
import type { StaticFbxMaterial } from './studio-fbx-material.ts';

export interface StaticFbxTexture {
  bytes: Buffer;
  sha256: string;
  mime_type: 'image/jpeg' | 'image/png';
  name: string;
  opaque_alpha_alias?: true;
}
const textureDefaults: Record<string, FbxValue[]> = {
  TextureTypeUse: [0],
  AlphaSource: [2],
  'Texture alpha': [1],
  PremultiplyAlpha: [1],
  CurrentTextureBlendMode: [1],
  CurrentMappingType: [0],
  UVSet: ['default'],
  WrapModeU: [0],
  WrapModeV: [0],
  UVSwap: [0],
  Translation: [0, 0, 0],
  Rotation: [0, 0, 0],
  Scaling: [1, 1, 1],
  TextureRotationPivot: [0, 0, 0],
  TextureScalingPivot: [0, 0, 0],
  UseMaterial: [0],
  UseMipMap: [0],
};
const videoDefaults: Record<string, FbxValue[]> = Object.fromEntries(
  [
    'Width',
    'Height',
    'AccessMode',
    'StartFrame',
    'StopFrame',
    'Offset',
    'PlaySpeed',
    'FreeRunning',
    'Loop',
    'InterlaceMode',
    'ImageSequence',
    'ImageSequenceOffset',
    'FrameRate',
    'LastFrame',
  ].map((name) => [name, [0]]),
);
export function fbxTextureProperties(
  node: FbxNode | undefined,
  kind: 'Texture' | 'Video',
): Map<string, FbxValue[]> {
  const result = new Map<string, FbxValue[]>();
  for (const property of singleNode(node?.children ?? [], 'Properties70')?.children ?? []) {
    const [name, , , flags] = property.properties,
      values = property.properties.slice(4);
    if (
      property.name !== 'P' ||
      typeof name !== 'string' ||
      property.children.length ||
      result.has(name) ||
      (typeof flags === 'string' && flags.includes('U'))
    )
      return fail('FBX texture/video property is repeated or custom.');
    validateTexturePropertyValue(kind, name, values);
    result.set(name, values);
  }
  return result;
}
function validateTexturePropertyValue(kind: 'Texture' | 'Video', name: string, values: FbxValue[]): void {
  const expected = (kind === 'Texture' ? textureDefaults : videoDefaults)[name];
  if (kind === 'Video' && name === 'Path') {
    if (values.length !== 1 || typeof values[0] !== 'string' || values[0].length > 4096)
      return fail('FBX embedded image path label is invalid.');
  } else if (
    !(kind === 'Texture' && name === 'UseMaterial' && values.length === 1 && values[0] === 1) &&
    (!expected ||
      values.length !== expected.length ||
      values.some((value, index) => value !== expected[index]))
  )
    return fail(
      'FBX texture transforms, sampling or image sequence fields are outside the verified defaults.',
    );
}
function descriptiveStrings(node: FbxNode, names: string[]): void {
  for (const name of names) {
    const field = singleNode(node.children, name);
    if (
      field &&
      (field.children.length ||
        field.properties.length !== 1 ||
        typeof field.properties[0] !== 'string' ||
        field.properties[0].length > 4096)
    )
      return fail('FBX embedded texture label is ambiguous.');
  }
}
export function attachFbxBaseColorTexture(
  material: StaticFbxMaterial,
  materialId: number,
  entries: Map<number, FbxNode>,
  parents: Map<number, number>,
): void {
  const assigned = [...entries].filter(
    ([id, node]) => node.name === 'Texture' && parents.get(id) === materialId,
  );
  if (!assigned.length) return;
  if (assigned.length !== 1) return fail('FBX material requires one exact embedded base-color texture.');
  const [id, texture] = assigned[0]!;
  validateFbxEmbeddedTexture(texture);
  const videos = [...entries].filter(([child, node]) => node.name === 'Video' && parents.get(child) === id);
  if (videos.length !== 1) return fail('FBX texture must reference one complete embedded Video.');
  const video = videos[0]![1],
    bytes = fbxEmbeddedVideoBytes(video);
  if (
    material.color.slice(0, 3).some((value) => Math.abs(value - 0.8) > 1e-7) ||
    material.color[3] !== 1 ||
    material.emissive.some((value) => value !== 0)
  )
    return fail('Textured FBX scalar tint, opacity or emissive mapping requires a separate webpage proof.');
  // 已测原网页导出在这个标准 FBX 底色设置下使用白色纹理乘数；原0.8仍记录在 source_properties。
  material.color = [1, 1, 1, 1];
  material.texture = {
    bytes,
    sha256: studioAssimpHash(bytes),
    mime_type: fbxEmbeddedImageMime(bytes),
    name: String(video.properties[1]),
  };
}
export function validateFbxEmbeddedTexture(texture: FbxNode): void {
  if (
    texture.children.some(
      (node) =>
        !['Type', 'Version', 'TextureName', 'Properties70', 'Media', 'FileName', 'RelativeFilename'].includes(
          node.name,
        ),
    ) ||
    singleNode(texture.children, 'Type')?.properties[0] !== 'TextureVideoClip'
  )
    return fail('FBX texture is outside the observed embedded image structure.');
  descriptiveStrings(texture, ['TextureName', 'Media', 'FileName', 'RelativeFilename']);
  fbxTextureProperties(texture, 'Texture');
}
export function fbxEmbeddedVideoBytes(video: FbxNode): Buffer {
  const content = singleNode(video.children, 'Content');
  if (
    video.properties[2] !== 'Clip' ||
    video.children.some(
      (node) =>
        !['Type', 'Properties70', 'UseMipMap', 'Filename', 'RelativeFilename', 'Content'].includes(node.name),
    ) ||
    singleNode(video.children, 'Type')?.properties[0] !== 'Clip' ||
    (singleNode(video.children, 'UseMipMap') &&
      singleNode(video.children, 'UseMipMap')!.properties[0] !== 0) ||
    !content ||
    content.children.length ||
    content.properties.length !== 1 ||
    content.properties[0] !== null ||
    Object.keys(content.rawProperties ?? {}).length !== 1 ||
    !content.rawProperties?.[0]
  )
    return fail('FBX image is missing complete embedded bytes; external paths are never resolved.');
  descriptiveStrings(video, ['Filename', 'RelativeFilename']);
  fbxTextureProperties(video, 'Video');
  const bytes = Buffer.from(content.rawProperties[0]);
  fbxEmbeddedImageMime(bytes);
  return bytes;
}
export function fbxEmbeddedImageMime(bytes: Buffer): 'image/jpeg' | 'image/png' {
  if (bytes.length < 4 || bytes.length > 32 * 1024 * 1024)
    return fail('Embedded FBX image exceeds its complete original image byte budget.');
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  return fail('Embedded FBX base-color requires an original JPEG or verified opaque PNG.');
}

function pngChunk(bytes: Buffer, offset: number): { type: string; size: number; end: number } {
  const size = bytes.readUInt32BE(offset),
    type = bytes.toString('ascii', offset + 4, offset + 8),
    end = offset + 12 + size;
  if (end > bytes.length || !['IHDR', 'pHYs', 'IDAT', 'IEND'].includes(type))
    return fail('Opaque FBX PNG requires complete nonanimated true-color chunks.');
  if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4))
    return fail('Embedded FBX PNG chunk checksum is invalid.');
  return { size, type, end };
}
function pngHeader(bytes: Buffer, offset: number, size: number): void {
  if (
    size !== 13 ||
    bytes.readUInt32BE(offset + 8) < 1 ||
    bytes.readUInt32BE(offset + 12) < 1 ||
    bytes.readUInt32BE(offset + 8) > 8192 ||
    bytes.readUInt32BE(offset + 12) > 8192 ||
    bytes[offset + 16] !== 8 ||
    ![2, 6].includes(bytes[offset + 17]!) ||
    bytes.subarray(offset + 18, offset + 21).some((v) => v !== 0)
  )
    return fail('Opaque FBX PNG requires bounded 8-bit noninterlaced RGB or RGBA.');
}
function verifyOpaquePngStructure(bytes: Buffer): void {
  let offset = 8,
    chunks = 0,
    images = 0,
    physical = false,
    ended = false;
  while (offset + 12 <= bytes.length && !ended) {
    const { size, type, end } = pngChunk(bytes, offset);
    if (++chunks > 10000) return fail('Embedded FBX PNG exceeds its chunk budget.');
    if (chunks === 1 ? type !== 'IHDR' || size !== 13 : type === 'IHDR')
      return fail('Embedded FBX PNG requires one leading IHDR.');
    if (type === 'IHDR') pngHeader(bytes, offset, size);
    if (type === 'pHYs') {
      if (physical || images || size !== 9 || bytes[offset + 16]! > 1)
        return fail('Embedded FBX PNG physical dimensions are ambiguous or misplaced.');
      physical = true;
    }
    if (type === 'IDAT') images++;
    if (type === 'IEND') {
      if (size !== 0) return fail('Embedded PNG IEND must be empty.');
      ended = true;
    }
    offset = end;
  }
  if (!ended || !images || offset !== bytes.length)
    fail('Embedded FBX PNG is truncated or has trailing data.');
}

async function verifyOpaquePng(bytes: Buffer, expectedPixels: number): Promise<void> {
  verifyOpaquePngStructure(bytes);
  const { data, info } = await sharp(bytes, { failOn: 'warning', limitInputPixels: 8192 * 8192 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 4 || info.width * info.height !== expectedPixels)
    return fail('Embedded opaque PNG did not decode to one complete RGBA image.');
  for (let index = 3; index < data.length; index += 4)
    if (data[index] !== 255)
      return fail('FBX PNG base-color and alpha aliases require every pixel fully opaque.');
}
export async function verifyFbxTextureDecoding(materials: StaticFbxMaterial[]): Promise<void> {
  const seen = new Set<string>();
  let pixels = 0;
  for (const material of materials) {
    const texture = material.texture;
    if (!texture || seen.has(texture.sha256)) continue;
    seen.add(texture.sha256);
    if (seen.size > 64) return fail('FBX embedded image count exceeds its bounded decode budget.');
    try {
      const image = sharp(texture.bytes, { failOn: 'warning', limitInputPixels: 8192 * 8192 }),
        metadata = await image.metadata();
      pixels += (metadata.width ?? 0) * (metadata.height ?? 0);
      if (
        metadata.format !== (texture.mime_type === 'image/png' ? 'png' : 'jpeg') ||
        !metadata.width ||
        !metadata.height ||
        metadata.width > 8192 ||
        metadata.height > 8192 ||
        (texture.mime_type === 'image/jpeg' && metadata.hasAlpha) ||
        pixels > 100_000_000
      )
        return fail('FBX base-color image exceeds its verified shape or total decode budget.');
      if (texture.mime_type === 'image/png')
        await verifyOpaquePng(texture.bytes, metadata.width * metadata.height);
      else await image.stats();
    } catch (error) {
      if (error instanceof TripoError && error.code === 'IMAGE_RUNTIME_UNAVAILABLE') throw error;
      return fail('FBX embedded image did not decode completely as its verified opaque format.');
    }
  }
}
