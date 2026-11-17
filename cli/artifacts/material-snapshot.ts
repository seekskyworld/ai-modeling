/** 静态 GLB 的不烘焙证明：图片原字节、基础 PBR 参数及每面 UV 关联独立核对。 */
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { Material, Texture, TextureInfo, Primitive, Node } from '@gltf-transform/core';
import { modelIO } from '../local/gltf.ts';
import { fingerprint } from '../core/fingerprint.ts';
import { object, array, TripoError } from '../../studio/contracts/errors.ts';
import { frontendMaterialExtensions, validateFrontendMaterialExtensions } from './studio-assimp-material.ts';
import { unbakedMaterialPivot, type MaterialPivot } from './unbaked-material-pivot.ts';
import { sameOrientedMaterialSurfaces, type MaterialSurface } from './material-surface-match.ts';

export interface MaterialSnapshot {
  version: 1;
  signature: string;
  material_signature: string;
  surfaces: string;
  materials: number;
  primitives: number;
  triangles: number;
  textures: number;
  maximum_texture_size: number;
  source_projection?: { forward_axis: '-y'; pivot_to_center_bottom: true; pivot: MaterialPivot };
  surface_encoding?: 'oriented-corners-v2';
}
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const rounded = (value: number): number => {
  if (!Number.isFinite(value))
    throw new TripoError('UNBAKED_MATERIAL_UNSUPPORTED', 'Material and UV values must be finite.', 'read');
  return Math.round(value * 1e6) / 1e6;
};
function texture(texture: Texture | null, info: TextureInfo | null): unknown {
  if (!texture || !info) return null;
  const bytes = texture.getImage();
  if (!bytes || !['image/png', 'image/jpeg', 'image/webp'].includes(texture.getMimeType()))
    throw new TripoError(
      'UNBAKED_MATERIAL_UNSUPPORTED',
      'Only embedded PNG/JPEG/WEBP textures are verified.',
      'read',
    );
  return {
    sha256: hash(bytes),
    bytes: bytes.length,
    mime: texture.getMimeType(),
    uv: info.getTexCoord(),
    min: info.getMinFilter(),
    mag: info.getMagFilter(),
    wrap_s: info.getWrapS(),
    wrap_t: info.getWrapT(),
  };
}
function material(material: Material | null, factors: Record<string, unknown>): unknown {
  if (!material) return null;
  // 镜面扩展按独立扩展处理，可按核心默认省略；旧unlit/clearcoat及公共IOR签名保持原形状。
  const extensions = frontendMaterialExtensions(material, { specular: true });
  return {
    color: material.getBaseColorFactor().map(rounded),
    metallic: rounded(typeof factors.metallic === 'number' ? factors.metallic : material.getMetallicFactor()),
    roughness: rounded(
      typeof factors.roughness === 'number' ? factors.roughness : material.getRoughnessFactor(),
    ),
    emissive: material.getEmissiveFactor().map(rounded),
    normal_scale: rounded(material.getNormalScale()),
    occlusion: rounded(material.getOcclusionStrength()),
    alpha_mode: material.getAlphaMode(),
    alpha_cutoff: rounded(material.getAlphaCutoff()),
    double_sided: material.getDoubleSided(),
    base: texture(material.getBaseColorTexture(), material.getBaseColorTextureInfo()),
    pbr: texture(material.getMetallicRoughnessTexture(), material.getMetallicRoughnessTextureInfo()),
    normal: texture(material.getNormalTexture(), material.getNormalTextureInfo()),
    occlusion_map: texture(material.getOcclusionTexture(), material.getOcclusionTextureInfo()),
    emissive_map: texture(material.getEmissiveTexture(), material.getEmissiveTextureInfo()),
    // 无扩展的旧材质签名逐字保持；不能加空数组而使已持久化的基础PBR证明失效。
    ...(extensions.length ? { extensions } : {}),
  };
}

type Surface = MaterialSurface;
const compareNumbers = (a: number[], b: number[]): number => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
};
type Corner = { key: string; position: number[] };
/** 三角顶点允许循环移位，反射排序会丢失正反面朝向，不能用于材质保真证明。 */
function canonicalTriangle(corners: Corner[]): Corner[] {
  return [0, 1, 2]
    .map((offset) => [...corners.slice(offset), ...corners.slice(0, offset)])
    .sort((a, b) => {
      for (let i = 0; i < 3; i++) {
        const compare = a[i]!.key.localeCompare(b[i]!.key) || compareNumbers(a[i]!.position, b[i]!.position);
        if (compare) return compare;
      }
      return 0;
    })[0]!;
}
/** 浮点导出有约 4e-7 的误差；UV/材质须完全相同，几何对应允许 1e-5 模型单位误差。 */
export function sameMaterialSnapshot(source: MaterialSnapshot, output: MaterialSnapshot): boolean {
  if (source.material_signature !== output.material_signature) return false;
  const unpack = (snapshot: MaterialSnapshot): Surface[] =>
    JSON.parse(
      inflateSync(Buffer.from(snapshot.surfaces, 'base64'), { maxOutputLength: 32 * 1024 * 1024 }).toString(),
    );
  const a = unpack(source),
    b = unpack(output);
  if (source.surface_encoding || output.surface_encoding)
    return (
      source.surface_encoding === 'oriented-corners-v2' &&
      output.surface_encoding === 'oriented-corners-v2' &&
      sameOrientedMaterialSurfaces(a, b)
    );
  return (
    a.length === b.length &&
    a.every((face, index) => {
      const other = b[index]!;
      return (
        face[0] === other[0] &&
        face[1].length === other[1].length &&
        face[1].every((value, corner) => Math.abs(value - other[1][corner]!) <= 1e-5)
      );
    })
  );
}

function validateGlb(bytes: Buffer): void {
  if (
    bytes.length < 28 ||
    bytes.toString('ascii', 0, 4) !== 'glTF' ||
    bytes.readUInt32LE(4) !== 2 ||
    bytes.readUInt32LE(8) !== bytes.length
  )
    throw new TripoError(
      'UNBAKED_MATERIAL_UNSUPPORTED',
      'Material verification requires a self-contained GLB.',
      'read',
    );
  const json = object(JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString()));
  if (bytes.readUInt32LE(16) !== 0x4e4f534a || bytes.readUInt32LE(12) + 28 > bytes.length)
    throw new TripoError('UNBAKED_MATERIAL_UNSUPPORTED', 'The GLB chunk layout is invalid.', 'read');
  // 原生导出按各自实物验证；不自动继承前端引擎的其他扩展或扩展纹理准入。
  const allowed = new Set(['KHR_mesh_quantization', 'EXT_meshopt_compression']);
  const materialAllowed = new Set([
    'KHR_materials_unlit',
    'KHR_materials_clearcoat',
    'KHR_materials_specular',
  ]);
  let materialObjects: Set<object>;
  try {
    materialObjects = validateFrontendMaterialExtensions(json);
  } catch {
    throw new TripoError('UNBAKED_MATERIAL_UNSUPPORTED', 'Material extensions are not verified.', 'read');
  }
  const inspect = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(inspect);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (
        key === 'extensions' &&
        Object.keys(object(child)).some(
          (name) => !(materialObjects.has(value) ? materialAllowed : allowed).has(name),
        )
      )
        throw new TripoError(
          'UNBAKED_MATERIAL_UNSUPPORTED',
          'Unrecognized glTF extensions cannot be discarded during material verification.',
          'read',
        );
      inspect(child);
    }
  };
  inspect(json);
  if (
    [...array(json.extensionsUsed), ...array(json.extensionsRequired)].some(
      (name) => !allowed.has(String(name)) && !materialAllowed.has(String(name)),
    ) ||
    array(json.animations).length ||
    array(json.skins).length ||
    array(json.nodes).some((node) => object(node).skin !== undefined)
  )
    throw new TripoError(
      'UNBAKED_MATERIAL_UNSUPPORTED',
      'bake=false verifies static basic PBR, unlit, scalar clearcoat or scalar/color specular GLB without skins, animation clips or other advanced extensions.',
      'read',
    );
  if (
    array(json.images).some((image) => object(image).uri !== undefined) ||
    array(json.buffers).some((buffer) => object(buffer).uri !== undefined)
  )
    throw new TripoError(
      'UNBAKED_MATERIAL_UNSUPPORTED',
      'Material verification requires embedded source resources.',
      'read',
    );
}

export async function materialSnapshot(
  bytes: Buffer,
  factors: Record<string, unknown> = {},
  sourceOrientation = false,
  sourceBottomCenter = false,
  orientedCorrespondence = false,
): Promise<MaterialSnapshot> {
  validateGlb(bytes);
  const document = await (await modelIO()).readBinary(bytes);
  if (sourceBottomCenter && !sourceOrientation)
    throw new TripoError(
      'UNBAKED_MATERIAL_UNSUPPORTED',
      'Native pivot proof requires -y orientation.',
      'read',
    );
  const pivot = sourceBottomCenter ? unbakedMaterialPivot(document) : undefined;
  const precise =
    sourceBottomCenter ||
    orientedCorrespondence ||
    document
      .getRoot()
      .listMaterials()
      .some((value) => value.listExtensions().length > 0);
  const rows: string[] = [],
    materialHashes = new Set<string>(),
    surfaces: Surface[] = [];
  let triangles = 0;
  for (const node of document
    .getRoot()
    .listNodes()
    .filter((node) => node.getMesh())) {
    for (const primitive of node.getMesh()!.listPrimitives()) {
      const checked = snapshotPrimitive(node, primitive, factors, sourceOrientation, pivot, precise);
      rows.push(checked.row);
      materialHashes.add(checked.materialHash);
      surfaces.push(...checked.surfaces);
      triangles += checked.triangles;
      if (triangles > 100000)
        throw new TripoError(
          'UNBAKED_MATERIAL_UNSUPPORTED',
          'Material verification supports at most 100000 triangles.',
          'read',
        );
    }
  }
  if (!rows.length)
    throw new TripoError('UNBAKED_MATERIAL_UNSUPPORTED', 'The source has no mesh primitives.', 'read');
  const images = document.getRoot().listTextures();
  const sizes = images.map((image) => image.getSize());
  if (sizes.some((size) => !size))
    throw new TripoError(
      'UNBAKED_MATERIAL_UNSUPPORTED',
      'The source texture dimensions cannot be verified.',
      'read',
    );
  surfaces.sort((a, b) => a[0].localeCompare(b[0]) || compareNumbers(a[1], b[1]));
  const rawSurfaces = JSON.stringify(surfaces),
    materialSignature = fingerprint(rows.sort());
  if (Buffer.byteLength(rawSurfaces) > 32 * 1024 * 1024)
    throw new TripoError(
      'UNBAKED_MATERIAL_UNSUPPORTED',
      'Surface verification exceeds the persisted proof size boundary.',
      'read',
    );
  return {
    version: 1,
    signature: fingerprint({ materialSignature, surfaces }),
    material_signature: materialSignature,
    surfaces: deflateSync(rawSurfaces).toString('base64'),
    materials: materialHashes.size,
    primitives: rows.length,
    triangles,
    textures: images.length,
    maximum_texture_size: Math.max(0, ...sizes.flatMap((size) => size!)),
    ...(pivot
      ? { source_projection: { forward_axis: '-y' as const, pivot_to_center_bottom: true as const, pivot } }
      : {}),
    ...(precise ? { surface_encoding: 'oriented-corners-v2' as const } : {}),
  };
}

/** 每个角的纹理/颜色必须属于同一空间位置，不能用 UV 集合掩盖表面交换。 */
function snapshotPrimitive(
  node: Node,
  primitive: Primitive,
  factors: Record<string, unknown>,
  sourceOrientation: boolean,
  pivot?: MaterialPivot,
  precise = false,
): { materialHash: string; row: string; triangles: number; surfaces: Surface[] } {
  const surfaces: Surface[] = [];
  if (primitive.getMode() !== 4 || primitive.listTargets().length || !primitive.getAttribute('POSITION'))
    throw new TripoError(
      'UNBAKED_MATERIAL_UNSUPPORTED',
      'Material verification requires static triangle primitives.',
      'read',
    );
  const materialHash = fingerprint(material(primitive.getMaterial(), factors));
  const coordinates = primitive
    .listSemantics()
    .filter((name) => /^(TEXCOORD_|COLOR_)/.test(name))
    .sort();
  const vertices = primitive.getAttribute('POSITION')!.getCount();
  const indices = primitive.getIndices(),
    count = indices?.getCount() ?? vertices;
  if (
    !count ||
    count % 3 !== 0 ||
    count / 3 > 100000 ||
    coordinates.some((name) => primitive.getAttribute(name)!.getCount() !== vertices)
  )
    throw new TripoError(
      'UNBAKED_MATERIAL_UNSUPPORTED',
      'Triangle counts exceed the material verification boundary.',
      'read',
    );
  const faces: string[] = [];
  for (let start = 0; start < count; start += 3) {
    const corners: string[] = [];
    const association: Corner[] = [];
    for (let corner = 0; corner < 3; corner++) {
      const vertex = indices ? indices.getScalar(start + corner) : start + corner;
      if (!Number.isSafeInteger(vertex) || vertex < 0 || vertex >= vertices)
        throw new TripoError(
          'UNBAKED_MATERIAL_UNSUPPORTED',
          'Triangle indices reference missing vertex attributes.',
          'read',
        );
      const key = JSON.stringify(
        coordinates.map((name) => primitive.getAttribute(name)!.getElement(vertex, []).map(rounded)),
      );
      corners.push(key);
      association.push({
        key,
        position: projectedPosition(
          primitive.getAttribute('POSITION')!.getElement(vertex, []),
          node.getWorldMatrix(),
          sourceOrientation,
          pivot,
        ),
      });
    }
    // 原生导出会重排顶点/三角面；每面三角的 UV 关联必须保持，不能只比坐标集合。
    faces.push(corners.sort().join('|'));
    const oriented = canonicalTriangle(association);
    const face: Surface = [
      fingerprint({ material: materialHash, coordinates, corners: oriented.map((item) => item.key) }),
      oriented.flatMap((item) => item.position),
    ];
    if (precise) face.push(oriented.map((item) => item.key));
    surfaces.push(face);
  }
  faces.sort();
  return {
    materialHash,
    row: fingerprint({ material: materialHash, coordinates, faces }),
    triangles: count / 3,
    surfaces,
  };
}

function projectedPosition(
  point: number[],
  matrix: ArrayLike<number>,
  sourceOrientation: boolean,
  pivot?: MaterialPivot,
): number[] {
  const position = [0, 1, 2].map(
    (axis) =>
      matrix[axis]! * point[0]! +
      matrix[4 + axis]! * point[1]! +
      matrix[8 + axis]! * point[2]! +
      matrix[12 + axis]! -
      (pivot?.[axis] ?? 0),
  );
  if (position.some((value) => !Number.isFinite(value)))
    throw new TripoError('UNBAKED_MATERIAL_UNSUPPORTED', 'Surface positions must be finite.', 'read');
  return sourceOrientation ? [-position[2]!, position[1]!, position[0]!] : position;
}
