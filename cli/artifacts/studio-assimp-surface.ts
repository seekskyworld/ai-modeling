/** 原网页引擎可能重排顶点和清理零权重骨；按有向面、材质与具名骨权重核实。 */
import {
  Document,
  type Material,
  type Mesh,
  type Node,
  type Primitive,
  type Texture,
  type TextureInfo,
} from '@gltf-transform/core';
import { mat3, vec3, type mat4 } from 'gl-matrix';
import type { Anisotropy } from '@gltf-transform/extensions';
import { frontendFail as fail } from './studio-assimp-normalize.ts';
import { studioAssimpHash } from './studio-assimp-assets.ts';
import { frontendMaterialExtensions } from './studio-assimp-material.ts';
import type { FrontendMaterialFactor } from '../../studio/contracts/frontend-export.ts';

type Point = [number, number, number];
type Corner = { p: Point; n?: Point; uv?: number[]; weights: Array<[string, number]> };
type Face = [Corner, Corner, Corner];
type Surface = { faces: Face[]; material: string };
export type FrontendSurfaceProof = {
  faces: number;
  maximum_position_error: number;
  maximum_normal_error: number;
  maximum_uv_error: number;
  maximum_weight_error: number;
};
const round = (value: number): number => {
  if (!Number.isFinite(value)) return fail('Material values must be finite.');
  return Math.round(value * 1e6) / 1e6;
};
function texture(image: Texture | null, info: TextureInfo | null): unknown {
  if (!image || !info) return null;
  if (!image.getImage() || !['image/png', 'image/jpeg', 'image/webp'].includes(image.getMimeType()))
    return fail('Frontend export verifies only embedded PNG, JPEG and WEBP textures.');
  return {
    sha256: studioAssimpHash(image.getImage()!),
    mime: image.getMimeType(),
    uv: info.getTexCoord(),
    min: info.getMinFilter(),
    mag: info.getMagFilter(),
    wrap_s: info.getWrapS(),
    wrap_t: info.getWrapT(),
  };
}
// glTF未指定primitive.material等价于完整默认材质；原网页引擎会显式写出这个默认对象。
// 只读默认实例使两种表示逐字段比较；任何非默认值、贴图或扩展仍须精确相同。
const implicitMaterial = new Document().createMaterial();
function material(value: Material | null, factor?: FrontendMaterialFactor): string {
  value ??= implicitMaterial;
  return JSON.stringify({
    extensions: frontendMaterialExtensions(value, {
      specular: true,
      ior: true,
      emissiveStrength: true,
      anisotropy: true,
    }),
    color: value.getBaseColorFactor().map(round),
    metallic: round(factor?.metallic ?? value.getMetallicFactor()),
    roughness: round(factor?.roughness ?? value.getRoughnessFactor()),
    emissive: value.getEmissiveFactor().map(round),
    alpha: value.getAlphaMode(),
    cutoff: round(value.getAlphaCutoff()),
    double_sided: value.getDoubleSided(),
    normal_scale: round(value.getNormalScale()),
    occlusion_strength: round(value.getOcclusionStrength()),
    base: texture(value.getBaseColorTexture(), value.getBaseColorTextureInfo()),
    pbr: texture(value.getMetallicRoughnessTexture(), value.getMetallicRoughnessTextureInfo()),
    normal: texture(value.getNormalTexture(), value.getNormalTextureInfo()),
    occlusion: texture(value.getOcclusionTexture(), value.getOcclusionTextureInfo()),
    emissive_map: texture(value.getEmissiveTexture(), value.getEmissiveTextureInfo()),
  });
}
function weights(node: Node, primitive: Primitive, index: number): Array<[string, number]> {
  const joints = primitive.getAttribute('JOINTS_0'),
    values = primitive.getAttribute('WEIGHTS_0'),
    skin = node.getSkin();
  if (!joints && !values && !skin) return [];
  if (!joints || !values || !skin) return fail('Skin, joints and weights must be present together.');
  const named = new Map<string, number>(),
    js = joints.getElement(index, []),
    ws = values.getElement(index, []);
  for (let i = 0; i < ws.length; i++) {
    if (!Number.isInteger(js[i]) || !skin.listJoints()[js[i]!])
      return fail('Skin references an invalid joint.');
    if (ws[i]! < 0 || ws[i]! > 1) return fail('Skin weights must be normalized finite values.');
    if (!ws[i]) continue;
    const name = skin.listJoints()[js[i]!]!.getName();
    named.set(name, (named.get(name) ?? 0) + ws[i]!);
  }
  if (Math.abs([...named.values()].reduce((sum, v) => sum + v, 0) - 1) > 1e-4)
    return fail('Vertex weights must sum to one.');
  return [...named].sort(([a], [b]) => a.localeCompare(b));
}
function surface(
  node: Node,
  primitive: Primitive,
  transform?: mat4,
  factor?: FrontendMaterialFactor,
): Surface {
  const positions = primitive.getAttribute('POSITION');
  if (
    !positions ||
    primitive.getMode() !== 4 ||
    primitive.listTargets().length ||
    primitive
      .listSemantics()
      .some((x) => !['POSITION', 'NORMAL', 'TEXCOORD_0', 'JOINTS_0', 'WEIGHTS_0'].includes(x))
  )
    return fail(
      'Frontend proof requires triangle meshes without morph targets or unverified vertex attributes.',
    );
  if (primitive.listAttributes().some((x) => x.getCount() !== positions.getCount()))
    return fail('Vertex attribute counts differ.');
  const indices =
    primitive.getIndices()?.getArray() ?? Uint32Array.from({ length: positions.getCount() }, (_, i) => i);
  if (!indices.length || indices.length % 3 || indices.length > 300000 || positions.getCount() > 200000)
    return fail('Frontend proof supports nonempty meshes of at most 100000 triangles and 200000 vertices.');
  const corners = readCorners(node, primitive, transform),
    faces: Face[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const ids = [indices[i]!, indices[i + 1]!, indices[i + 2]!];
    if (ids.some((v) => !Number.isSafeInteger(v) || v < 0 || v >= corners.length))
      return fail('Triangle indices are invalid.');
    faces.push(ids.map((index) => corners[index]!) as Face);
  }
  verifyAnisotropyBasis(primitive, faces);
  return { faces, material: material(primitive.getMaterial(), factor) };
}
/** 无显式TANGENT时各向异性依赖几何/法线/UV切线基；不能仅保留两个材质字段就声称效果保真。 */
function verifyAnisotropyBasis(primitive: Primitive, faces: Face[]): void {
  const extension = primitive.getMaterial()?.getExtension<Anisotropy>('KHR_materials_anisotropy');
  if (!extension || extension.getAnisotropyStrength() === 0) return;
  for (const face of faces) {
    if (face.some((corner) => !corner.n || !corner.uv))
      return fail('Scalar anisotropy requires preserved normals and UV0 to derive its tangent basis.');
    const [a, b, c] = face.map((corner) => corner.uv!);
    const determinant = (b![0]! - a![0]!) * (c![1]! - a![1]!) - (b![1]! - a![1]!) * (c![0]! - a![0]!);
    const ab = vec3.subtract(vec3.create(), face[1].p, face[0].p),
      ac = vec3.subtract(vec3.create(), face[2].p, face[0].p),
      area = vec3.length(vec3.cross(vec3.create(), ab, ac));
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12 || area < 1e-12)
      return fail('Scalar anisotropy cannot be proved on degenerate UV or geometric triangles.');
  }
}
function readCorners(node: Node, primitive: Primitive, transform?: mat4): Corner[] {
  const positions = primitive.getAttribute('POSITION')!,
    normals = primitive.getAttribute('NORMAL'),
    uv = primitive.getAttribute('TEXCOORD_0'),
    corners: Corner[] = [];
  const normalMatrix = transform ? mat3.normalFromMat4(mat3.create(), transform) : undefined;
  if (transform && !normalMatrix) return fail('A singular mesh transform cannot be verified.');
  for (let i = 0; i < positions.getCount(); i++) {
    let normal: number[] | undefined = normals?.getElement(i, []);
    let point = positions.getElement(i, [0, 0, 0]) as Point;
    if (transform) point = Array.from(vec3.transformMat4(vec3.create(), point, transform)) as Point;
    if (normal && normalMatrix) normal = Array.from(vec3.transformMat3(vec3.create(), normal, normalMatrix));
    if (normal && Math.hypot(...normal) < 1e-12) return fail('A zero normal cannot be verified.');
    corners.push({
      p: point,
      n: normal ? (Array.from(vec3.normalize(vec3.create(), normal)) as Point) : undefined,
      uv: uv?.getElement(i, []),
      weights: weights(node, primitive, i),
    });
  }
  return corners;
}
const cell = (face: Face, size: number): Point =>
  [0, 1, 2].map((axis) =>
    Math.floor(face.reduce((sum, corner) => sum + corner.p[axis]!, 0) / (3 * size)),
  ) as Point;
function weightError(a: Corner, b: Corner): number {
  if (a.weights.length !== b.weights.length) return Infinity;
  let maximum = 0;
  for (let i = 0; i < a.weights.length; i++) {
    if (a.weights[i]![0] !== b.weights[i]![0]) return Infinity;
    maximum = Math.max(maximum, Math.abs(a.weights[i]![1] - b.weights[i]![1]));
  }
  return maximum;
}
function difference(a: Corner, b: Corner): number[] {
  return [
    vec3.distance(a.p, b.p),
    a.n && b.n ? vec3.distance(a.n, b.n) : a.n === b.n ? 0 : Infinity,
    a.uv && b.uv ? Math.hypot(a.uv[0]! - b.uv[0]!, a.uv[1]! - b.uv[1]!) : a.uv === b.uv ? 0 : Infinity,
    weightError(a, b),
  ];
}
function match(a: Face, b: Face, position: number): number[] | undefined {
  const limits = [position, 2e-6, 1e-6, 1e-6];
  for (let shift = 0; shift < 3; shift++) {
    const rows = a.map((corner, i) => difference(corner, b[(i + shift) % 3]!));
    if (rows.every((row) => row.every((value, i) => value <= limits[i]!)))
      return limits.map((_, i) => Math.max(...rows.map((row) => row[i]!)));
  }
}
function compare(a: Surface, b: Surface, tolerance: number): FrontendSurfaceProof {
  if (a.material !== b.material || a.faces.length !== b.faces.length)
    return fail('The frontend engine changed material properties, embedded textures or face counts.');
  const size = tolerance * 2,
    buckets = new Map<string, number[]>(),
    used = new Set<number>(),
    maxima = [0, 0, 0, 0];
  let attempts = 0;
  a.faces.forEach((face, index) => {
    const key = cell(face, size).join(','),
      list = buckets.get(key) ?? [];
    list.push(index);
    buckets.set(key, list);
  });
  for (const face of b.faces) {
    const center = cell(face, size),
      candidates: number[] = [];
    for (let x = -1; x <= 1; x++)
      for (let y = -1; y <= 1; y++)
        for (let z = -1; z <= 1; z++)
          candidates.push(...(buckets.get([center[0] + x, center[1] + y, center[2] + z].join(',')) ?? []));
    let found = false;
    for (const index of candidates) {
      if (used.has(index)) continue;
      if (++attempts > 1000000) return fail('Frontend surface matching exceeds its work limit.');
      const errors = match(face, a.faces[index]!, tolerance);
      if (!errors) continue;
      for (let i = 0; i < errors.length; i++) maxima[i] = Math.max(maxima[i]!, errors[i]!);
      used.add(index);
      found = true;
      break;
    }
    if (!found)
      return fail('The frontend engine changed an oriented geometry, UV, normal or weighted surface.');
  }
  return {
    faces: used.size,
    maximum_position_error: maxima[0]!,
    maximum_normal_error: maxima[1]!,
    maximum_uv_error: maxima[2]!,
    maximum_weight_error: maxima[3]!,
  };
}
export function verifyFrontendSurface(
  source: Node,
  target: Node,
  tolerance: number,
  sourceTransform?: mat4,
  targetTransform?: mat4,
  sourceMaterialFactor?: FrontendMaterialFactor,
): FrontendSurfaceProof[] {
  const a = source.getMesh()?.listPrimitives(),
    b = target.getMesh()?.listPrimitives();
  if (!a || !b || a.length !== b.length) return fail('The frontend engine changed a mesh primitive count.');
  return a.map((primitive, index) =>
    compare(
      surface(source, primitive, sourceTransform, sourceMaterialFactor),
      surface(target, b[index]!, targetTransform),
      tolerance,
    ),
  );
}

/** 网页删除节点后可能保留未引用mesh。这里只核原始局部表面，不能把它当可见节点或新几何。 */
export function verifyFrontendDetachedMesh(
  source: Node,
  target: Mesh,
  tolerance: number,
  sourceMaterialFactor?: FrontendMaterialFactor,
): FrontendSurfaceProof[] {
  const a = source.getMesh()?.listPrimitives(),
    b = target.listPrimitives();
  if (source.getSkin() || !a || a.length !== b.length)
    return fail('Detached deleted meshes require an exact static source primitive layout.');
  return a.map((primitive, index) =>
    compare(
      surface(source, primitive, undefined, sourceMaterialFactor),
      surface(source, b[index]!),
      tolerance,
    ),
  );
}
