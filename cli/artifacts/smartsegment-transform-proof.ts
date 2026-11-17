/** 逐文件证明原生导入实现所请求的Rz90；不拟合、不逆归一化、不修改原服务产物。 */
import { createHash } from 'node:crypto';
import { mat3, vec3 } from 'gl-matrix';
import { modelIO } from '../local/gltf.ts';
import { validateGlb } from '../../studio/files.ts';
import { array, object, TripoError } from '../../studio/contracts/errors.ts';
import { fingerprint } from '../core/fingerprint.ts';
import { smartSegmentRotationZ90 } from '../compat/smartsegment-transform-plan.ts';

type Point = [number, number, number];
type Corner = { p: Point; n: Point; uv: number[] };
type Face = [Corner, Corner, Corner];
const tolerance = { position: 0.00004, normal: 0.01, uv: 0.00004, normalization: 0.00004 };
const fail = (message: string): never => {
  throw new TripoError('SMARTSEGMENT_TRANSFORM_UNVERIFIED', message, 'not_submitted');
};
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const distance = (a: number[], b: number[]): number => Math.hypot(...a.map((v, i) => v - b[i]!));
const point = (p: number[], m: number[]): Point =>
  [0, 1, 2].map((i) => m[i]! * p[0]! + m[4 + i]! * p[1]! + m[8 + i]! * p[2]! + m[12 + i]!) as Point;

function shape(bytes: Buffer): void {
  const json = validateGlb(bytes);
  validateScene(json);
  validateGeometry(json);
  validateMaterial(json);
  validateCounts(json);
}
function validateScene(json: Record<string, unknown>): void {
  const nodes = array(json.nodes).map(object),
    meshes = array(json.meshes).map(object),
    scenes = array(json.scenes).map(object);
  if (
    nodes.length !== 1 ||
    meshes.length !== 1 ||
    scenes.length !== 1 ||
    fingerprint(scenes[0]?.nodes) !== fingerprint([0]) ||
    nodes[0]?.mesh !== 0 ||
    array(nodes[0]?.children).length ||
    nodes[0]?.skin !== undefined ||
    nodes[0]?.camera !== undefined ||
    nodes[0]?.weights !== undefined ||
    nodes[0]?.extensions !== undefined
  )
    fail('Transformed smartsegment requires one scene with one independent root mesh.');
}
function validateGeometry(json: Record<string, unknown>): void {
  const mesh = object(array(json.meshes)[0]),
    primitive = object(array(mesh.primitives)[0]),
    allowedExtensions = new Set(['KHR_mesh_quantization', 'EXT_meshopt_compression']);
  if (
    mesh.weights !== undefined ||
    mesh.extensions !== undefined ||
    array(mesh.primitives).length !== 1 ||
    (primitive.mode ?? 4) !== 4 ||
    array(primitive.targets).length ||
    primitive.extensions !== undefined ||
    Object.keys(object(primitive.attributes)).sort().join(',') !== 'NORMAL,POSITION,TEXCOORD_0' ||
    array(json.skins).length ||
    array(json.animations).length ||
    [...array(json.extensionsUsed), ...array(json.extensionsRequired)].some(
      (v) => !allowedExtensions.has(String(v)),
    )
  )
    fail(
      'Transformed smartsegment requires one static root triangle mesh with normals and one UV set; hierarchy, skins, animation, morphs and unverified extensions are unsupported.',
    );
}
function validateMaterial(json: Record<string, unknown>): void {
  const material = object(array(json.materials)[0]),
    pbr = object(material.pbrMetallicRoughness);
  if (
    array(json.materials).length > 1 ||
    array(json.textures).length > 1 ||
    array(json.images).length > 1 ||
    material.extensions !== undefined ||
    material.normalTexture !== undefined ||
    material.occlusionTexture !== undefined ||
    material.emissiveTexture !== undefined ||
    pbr.metallicRoughnessTexture !== undefined ||
    object(pbr.baseColorTexture).extensions !== undefined ||
    (object(pbr.baseColorTexture).texCoord ?? 0) !== 0 ||
    (material.alphaMode ?? 'OPAQUE') !== 'OPAQUE' ||
    array(json.images).some((image) => object(image).uri !== undefined)
  )
    fail(
      'Transformed smartsegment currently supports scalar opaque materials with at most one embedded base-color JPEG/PNG; other material channels are not substituted.',
    );
}
function validateCounts(json: Record<string, unknown>): void {
  const primitive = object(array(object(array(json.meshes)[0]).primitives)[0]);
  const accessors = array(json.accessors).map(object),
    attributes = object(primitive.attributes),
    positions = Number(accessors[Number(attributes.POSITION)]?.count),
    indices =
      primitive.indices === undefined ? positions : Number(accessors[Number(primitive.indices)]?.count);
  if (
    !Number.isSafeInteger(positions) ||
    positions < 3 ||
    positions > 100000 ||
    !Number.isSafeInteger(indices) ||
    indices < 3 ||
    indices % 3 ||
    indices > 75000
  )
    fail('Transformed smartsegment supports at most 25000 complete triangles and 100000 vertices.');
}

/** 受限静态表面只读解码；归一化元数据验证也使用同一完整属性合同，不修改原件。 */
export async function readStaticImportSurface(bytes: Buffer) {
  shape(bytes);
  const root = (await (await modelIO()).readBinary(bytes)).getRoot(),
    node = root.listNodes()[0]!,
    primitive = node.getMesh()!.listPrimitives()[0]!,
    positions = primitive.getAttribute('POSITION')!,
    normals = primitive.getAttribute('NORMAL')!,
    uvs = primitive.getAttribute('TEXCOORD_0')!,
    indices = primitive.getIndices()?.getArray() ?? Array.from({ length: positions.getCount() }, (_, i) => i),
    world = node.getWorldMatrix(),
    nm = mat3.normalFromMat4(mat3.create(), world);
  if (!nm || normals.getCount() !== positions.getCount() || uvs.getCount() !== positions.getCount())
    return fail('The transformed input has singular coordinates or incomplete attributes.');
  const corners = Array.from({ length: positions.getCount() }, (_, i): Corner => {
    const p = point(positions.getElement(i, []), world),
      uv = uvs.getElement(i, []),
      raw = vec3.transformMat3(vec3.create(), normals.getElement(i, []), nm),
      n = Array.from(vec3.normalize(vec3.create(), raw)) as Point;
    if ([...p, ...n, ...uv].some((v) => !Number.isFinite(v)) || vec3.length(raw) < 1e-8)
      return fail('The transformed input has nonfinite attributes or zero normals.');
    return { p, n, uv };
  });
  const faces: Face[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const ids = Array.from(indices.slice(i, i + 3));
    if (ids.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= corners.length))
      return fail('The transformed input has invalid triangle indices.');
    faces.push(ids.map((index) => corners[index]!) as Face);
  }
  const min = [0, 1, 2].map((axis) => Math.min(...corners.map((c) => c.p[axis]!))),
    max = [0, 1, 2].map((axis) => Math.max(...corners.map((c) => c.p[axis]!))),
    center = min.map((v, i) => (v + max[i]!) / 2),
    extent = Math.max(...max.map((v, i) => v - min[i]!)),
    mat = primitive.getMaterial(),
    info = mat?.getBaseColorTextureInfo(),
    texture = mat?.getBaseColorTexture();
  if (texture && (!texture.getImage() || !['image/jpeg', 'image/png'].includes(texture.getMimeType())))
    return fail('The transformed source base-color texture must be an embedded JPEG or PNG.');
  const appearance = {
    material: mat
      ? {
          base: mat.getBaseColorFactor(),
          metallic: mat.getMetallicFactor(),
          roughness: mat.getRoughnessFactor(),
          emissive: mat.getEmissiveFactor(),
          double_sided: mat.getDoubleSided(),
          alpha_mode: mat.getAlphaMode(),
          alpha_cutoff: mat.getAlphaCutoff(),
        }
      : null,
    texture: texture
      ? {
          sha256: sha256(texture.getImage()!),
          mime: texture.getMimeType(),
          bytes: texture.getImage()!.byteLength,
        }
      : null,
    sampler: info
      ? {
          uv: info.getTexCoord(),
          mag: info.getMagFilter(),
          min: info.getMinFilter(),
          s: info.getWrapS(),
          t: info.getWrapT(),
        }
      : null,
  };
  return {
    sha256: sha256(bytes),
    bytes: bytes.length,
    faces,
    vertices: corners.length,
    min,
    max,
    center,
    extent,
    appearance,
  };
}

export async function inspectSmartSegmentTransformSource(bytes: Buffer): Promise<Record<string, unknown>> {
  const data = await readStaticImportSurface(bytes);
  if (
    Math.abs(data.extent - 1) > tolerance.normalization ||
    data.center.some((v) => Math.abs(v) > tolerance.normalization)
  )
    return fail(
      'Native import normalizes noncentered or nonunit models. This transform path requires an already centered source with longest bounding-box extent 1; no import or segmentation was submitted.',
    );
  return {
    version: 1,
    sha256: data.sha256,
    bytes: data.bytes,
    faces: data.faces.length,
    vertices: data.vertices,
    bounds: { min: data.min, max: data.max },
    center: data.center,
    extent: data.extent,
    appearance: data.appearance,
  };
}

/** 有向面匹配仅允许循环换起点，不能反转面绕序；歧义面不以“最接近”强行匹配。 */
export async function verifySmartSegmentTransformedImport(
  sourceBytes: Buffer,
  importedBytes: Buffer,
  transform: number[] = smartSegmentRotationZ90,
): Promise<Record<string, unknown>> {
  await inspectSmartSegmentTransformSource(sourceBytes);
  return await verifyStaticImportTransform(sourceBytes, importedBytes, transform);
}

/** 校验调用方事先确定的变换；不从返回模型拟合矩阵、缩放或容差。 */
export async function verifyStaticImportTransform(
  sourceBytes: Buffer,
  importedBytes: Buffer,
  transform: number[],
): Promise<Record<string, unknown>> {
  const source = await readStaticImportSurface(sourceBytes),
    imported = await readStaticImportSurface(importedBytes);
  if (
    source.faces.length !== imported.faces.length ||
    fingerprint(source.appearance) !== fingerprint(imported.appearance)
  )
    return fail(
      'Native import changed the triangle count, material or embedded texture. Its original receipt is retained; segmentation was not submitted.',
    );
  const normalMatrix = mat3.normalFromMat4(mat3.create(), transform);
  if (!normalMatrix) return fail('The requested source transform is singular.');
  const expected = source.faces.map(
      (face) =>
        face.map((c) => ({
          p: point(c.p, transform),
          n: Array.from(
            vec3.normalize(vec3.create(), vec3.transformMat3(vec3.create(), c.n, normalMatrix)),
          ) as Point,
          uv: c.uv,
        })) as Face,
    ),
    size = tolerance.position * 3,
    bucket = (p: number[]) => p.map((v) => Math.floor(v / size)),
    center = (face: Face) => [0, 1, 2].map((axis) => face.reduce((sum, c) => sum + c.p[axis]!, 0) / 3),
    buckets = new Map<string, number[]>();
  expected.forEach((face, i) => {
    const key = bucket(center(face)).join(','),
      list = buckets.get(key) ?? [];
    list.push(i);
    buckets.set(key, list);
  });
  const used = new Set<number>();
  let maxPosition = 0,
    maxNormal = 0,
    maxUv = 0,
    attempts = 0;
  for (const face of imported.faces) {
    const cell = bucket(center(face)),
      matches: Array<{ index: number; position: number; normal: number; uv: number }> = [];
    for (let x = -1; x <= 1; x++)
      for (let y = -1; y <= 1; y++)
        for (let z = -1; z <= 1; z++)
          for (const index of buckets.get([cell[0]! + x, cell[1]! + y, cell[2]! + z].join(',')) ?? []) {
            if (used.has(index)) continue;
            for (let rotation = 0; rotation < 3; rotation++) {
              if (++attempts > 2000000)
                return fail(
                  'The source has too many ambiguous nearby faces for bounded transform verification.',
                );
              const a = expected[index]!,
                positions = face.map((c, i) => distance(c.p, a[(i + rotation) % 3]!.p)),
                normals = face.map((c, i) => distance(c.n, a[(i + rotation) % 3]!.n)),
                uv = face.map((c, i) => distance(c.uv, a[(i + rotation) % 3]!.uv));
              if (
                Math.max(...positions) <= tolerance.position &&
                Math.max(...normals) <= tolerance.normal &&
                Math.max(...uv) <= tolerance.uv
              )
                matches.push({
                  index,
                  position: Math.max(...positions),
                  normal: Math.max(...normals),
                  uv: Math.max(...uv),
                });
            }
          }
    if (matches.length !== 1)
      return fail(
        'Native import did not uniquely preserve every requested oriented face, normal and UV. The original import receipt is retained; segmentation was not submitted.',
      );
    const match = matches[0]!;
    used.add(match.index);
    maxPosition = Math.max(maxPosition, match.position);
    maxNormal = Math.max(maxNormal, match.normal);
    maxUv = Math.max(maxUv, match.uv);
  }
  return {
    version: 1,
    source_sha256: source.sha256,
    source_bytes: source.bytes,
    imported_sha256: imported.sha256,
    imported_bytes: imported.bytes,
    matched_oriented_faces: used.size,
    maximum_position_error: maxPosition,
    maximum_normal_error: maxNormal,
    maximum_uv_error: maxUv,
    tolerance,
    unchanged_material_and_texture: true,
  };
}
