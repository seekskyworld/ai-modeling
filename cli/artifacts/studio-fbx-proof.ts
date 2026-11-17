/** 独立证明原 FBX 多边形与原网页引擎 GLB 的实际表面；不靠引擎成功或面数相同放行。 */
import type { Material, Node, Primitive, Root } from '@gltf-transform/core';
import type { IOR, Specular } from '@gltf-transform/extensions';
import { mat3, mat4, vec3 } from 'gl-matrix';
import { frontendFail as fail, readFrontendDocument } from './studio-assimp-normalize.ts';
import { studioAssimpHash } from './studio-assimp-assets.ts';
import { validateFrontendMetadata, type StudioFrontendMetadata } from './studio-assimp-proof.ts';
import {
  readStaticFrontendFbx,
  type FbxPoint,
  type StaticFbxCorner,
  type StaticFbxSource,
  type StaticFbxMesh,
} from './studio-fbx-source.ts';
import type { StaticFbxMaterial } from './studio-fbx-material.ts';
import { verifyFbxTextureDecoding } from './studio-fbx-texture.ts';
import { fbxMatrixError, fbxWebpageWeights, type FbxSourceSkin, type FbxWeights } from './studio-fbx-skin.ts';

const difference = (a: readonly number[], b: readonly number[]): number =>
  a.length === b.length ? Math.hypot(...a.map((value, i) => value - b[i]!)) : Infinity;
const subtract = (a: readonly number[], b: readonly number[]): FbxPoint => [
  a[0]! - b[0]!,
  a[1]! - b[1]!,
  a[2]! - b[2]!,
];
const dot = (a: readonly number[], b: readonly number[]): number =>
  a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cross = (a: readonly number[], b: readonly number[]): FbxPoint => [
  a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!,
];
function unit(value: readonly number[]): FbxPoint {
  const length = Math.hypot(...value);
  if (!Number.isFinite(length) || length < 1e-12)
    return fail('A zero or non-finite FBX surface normal cannot be verified.');
  return value.map((v) => v / length) as FbxPoint;
}

function polygonProof(polygon: StaticFbxCorner[]): {
  normal: FbxPoint;
  nonplanar: boolean;
  degenerate: boolean;
} {
  // FBX n边形的曲面由网页导出三角化决定；不假设原顶点平面、平坦法线或仿射UV。
  const origin = polygon[0]!.position,
    scale = Math.max(1, ...polygon.map((corner) => difference(corner.position, origin))),
    summed: FbxPoint = [0, 0, 0];
  for (let i = 0; i < polygon.length; i++) {
    for (let j = i + 1; j < polygon.length; j++)
      if (difference(polygon[i]!.position, polygon[j]!.position) <= scale * 1e-10)
        return fail('FBX polygon has ambiguous repeated or collapsed corners.');
    const area = cross(
      subtract(polygon[i]!.position, origin),
      subtract(polygon[(i + 1) % polygon.length]!.position, origin),
    );
    for (let axis = 0; axis < 3; axis++) summed[axis]! += area[axis]!;
  }
  const length = Math.hypot(...summed),
    degenerate = length < scale ** 2 * 1e-12,
    normal: FbxPoint = degenerate ? [0, 0, 0] : (summed.map((value) => value / length) as FbxPoint);
  return {
    normal,
    degenerate,
    nonplanar:
      !degenerate &&
      polygon.some((corner) => Math.abs(dot(subtract(corner.position, origin), normal)) > scale * 1e-8),
  };
}
interface PolygonEdge {
  a: number;
  b: number;
  count: number;
  winding: number;
}
function verifyTriangulation(triangles: number[][], count: number): void {
  const edges = new Map<string, PolygonEdge>(),
    faces = new Set<string>();
  for (const triangle of triangles) {
    const face = [...triangle].sort((a, b) => a - b).join(':');
    if (faces.has(face) || new Set(triangle).size !== 3)
      return fail('FBX output repeats a polygon triangle or corner.');
    faces.add(face);
    for (let i = 0; i < 3; i++) {
      const a = triangle[i]!,
        b = triangle[(i + 1) % 3]!,
        key = a < b ? `${a}:${b}` : `${b}:${a}`,
        value = edges.get(key) ?? { a: Math.min(a, b), b: Math.max(a, b), count: 0, winding: 0 };
      value.count++;
      value.winding += a < b ? 1 : -1;
      edges.set(key, value);
    }
  }
  const diagonals = verifyPolygonEdges(edges, count);
  verifyNoncrossingDiagonals(diagonals);
}
function verifyPolygonEdges(edges: Map<string, PolygonEdge>, count: number) {
  const diagonals: { a: number; b: number }[] = [];
  for (const value of edges.values()) {
    const boundary = value.b - value.a === 1 || (value.a === 0 && value.b === count - 1);
    if (
      boundary
        ? value.count !== 1 || value.winding !== (value.b - value.a === 1 ? 1 : -1)
        : value.count !== 2 || value.winding !== 0
    )
      return fail('FBX output triangle edges do not form the original oriented polygon disk.');
    if (!boundary) diagonals.push(value);
  }
  if (edges.size !== 2 * count - 3 || diagonals.length !== count - 3)
    return fail('FBX polygon triangulation has missing boundary or diagonal edges.');
  return diagonals;
}
function verifyNoncrossingDiagonals(diagonals: { a: number; b: number }[]): void {
  for (const [index, left] of diagonals.entries())
    for (const right of diagonals.slice(index + 1)) {
      if (left.a === right.a || left.a === right.b || left.b === right.a || left.b === right.b) continue;
      if ((left.a < right.a && right.a < left.b) !== (left.a < right.b && right.b < left.b))
        return fail('FBX output uses crossing diagonals in the original polygon corner order.');
    }
}
function transformCorner(corner: StaticFbxCorner, matrix: mat4): StaticFbxCorner {
  const normalMatrix = mat3.normalFromMat4(mat3.create(), matrix);
  if (!normalMatrix) return fail('FBX surface transform is singular.');
  return {
    position: Array.from(vec3.transformMat4(vec3.create(), corner.position, matrix)) as FbxPoint,
    normal: unit(Array.from(vec3.transformMat3(vec3.create(), corner.normal, normalMatrix))),
    ...(corner.uv ? { uv: corner.uv } : {}),
    ...(corner.weights ? { weights: corner.weights } : {}),
  };
}
function verifyMaterial(material: Material | null, expected: StaticFbxMaterial): void {
  if (
    !material ||
    material.getName() !== expected.name ||
    difference(material.getBaseColorFactor(), expected.color) > 1e-6 ||
    material.getMetallicFactor() !== 0 ||
    Math.abs(material.getRoughnessFactor() - expected.roughness) > 1e-6 ||
    difference(material.getEmissiveFactor(), expected.emissive) > 1e-6 ||
    material.getAlphaMode() !== (expected.color[3] < 1 ? 'BLEND' : 'OPAQUE') ||
    material.getAlphaCutoff() !== 0.5 ||
    material.getDoubleSided() ||
    material.getNormalScale() !== 1 ||
    material.getOcclusionStrength() !== 1 ||
    Boolean(material.getBaseColorTexture()) !== Boolean(expected.texture) ||
    material.getMetallicRoughnessTexture() ||
    material.getNormalTexture() ||
    material.getOcclusionTexture() ||
    material.getEmissiveTexture()
  )
    return fail('The FBX output differs from the verified webpage Lambert/Phong scalar mapping.');
  verifyMaterialExtensions(material, expected);
  verifyMaterialTexture(material, expected);
}
function verifyMaterialExtensions(material: Material, expected: StaticFbxMaterial): void {
  const values = expected.extensions ?? {},
    names = material.listExtensions().map((extension) => extension.extensionName);
  if (names.length !== Object.keys(values).length || names.some((name) => !Object.hasOwn(values, name)))
    return fail('FBX output changed the exact webpage scalar specular/IOR extensions.');
  const specular = material.getExtension<Specular>('KHR_materials_specular'),
    ior = material.getExtension<IOR>('KHR_materials_ior');
  if (
    (specular &&
      Math.abs(specular.getSpecularFactor() - values.KHR_materials_specular!.specularFactor) > 1e-6) ||
    (ior && Math.abs(ior.getIOR() - values.KHR_materials_ior!.ior) > 1e-6)
  )
    return fail('FBX output differs from the verified webpage specular-factor/IOR mapping.');
}
function verifyMaterialTexture(material: Material, expected: StaticFbxMaterial): void {
  if (expected.texture) {
    const texture = material.getBaseColorTexture()!,
      image = texture.getImage(),
      info = material.getBaseColorTextureInfo()!;
    if (
      !image ||
      !Buffer.from(image).equals(expected.texture.bytes) ||
      texture.getMimeType() !== expected.texture.mime_type ||
      texture.listExtensions().length ||
      info.listExtensions().length ||
      info.getTexCoord() !== 0 ||
      info.getWrapS() !== 10497 ||
      info.getWrapT() !== 10497 ||
      info.getMagFilter() !== null ||
      info.getMinFilter() !== null
    )
      return fail('FBX output changed the embedded base-color bytes, UV set or default sampler.');
  }
}
function outputCorners(
  node: Node,
  hasUv: boolean,
  material: StaticFbxMaterial,
  sourceSkin?: FbxSourceSkin,
): { corners: StaticFbxCorner[]; indices: Uint32Array } {
  const primitives = node.getMesh()?.listPrimitives();
  if (!primitives || primitives.length !== 1 || Boolean(node.getSkin()) !== Boolean(sourceSkin))
    return fail('FBX output requires one primitive and the exact source skin presence per model.');
  const primitive = primitives[0]!,
    positions = primitive.getAttribute('POSITION'),
    normals = primitive.getAttribute('NORMAL'),
    uv = primitive.getAttribute('TEXCOORD_0');
  if (
    !positions ||
    !normals ||
    Boolean(uv) !== hasUv ||
    primitive.getMode() !== 4 ||
    primitive.listTargets().length ||
    primitive
      .listSemantics()
      .some(
        (value) =>
          ![
            'POSITION',
            'NORMAL',
            ...(hasUv ? ['TEXCOORD_0'] : []),
            ...(sourceSkin ? ['JOINTS_0', 'WEIGHTS_0'] : []),
          ].includes(value),
      ) ||
    primitive.listAttributes().some((accessor) => accessor.getCount() !== positions.getCount()) ||
    positions.getCount() > 200000 ||
    positions.getType() !== 'VEC3' ||
    normals.getType() !== 'VEC3' ||
    (uv && uv.getType() !== 'VEC2')
  )
    return fail('Static FBX output changed the verified source vertex attributes.');
  verifyMaterial(primitive.getMaterial(), material);
  const indices = outputIndices(primitive, positions.getCount());
  const matrix = node.getWorldMatrix(),
    corners = Array.from({ length: positions.getCount() }, (_, i) =>
      transformCorner(
        {
          position: positions.getElement(i, [0, 0, 0]) as FbxPoint,
          normal: normals.getElement(i, [0, 0, 0]) as FbxPoint,
          ...(uv ? { uv: uv.getElement(i, [0, 0]) as [number, number] } : {}),
          ...(sourceSkin ? { weights: outputWeights(node, primitive, i) } : {}),
        },
        matrix,
      ),
    );
  return { corners, indices };
}
function outputWeights(node: Node, primitive: Primitive, vertex: number): FbxWeights {
  const joints = primitive.getAttribute('JOINTS_0'),
    weights = primitive.getAttribute('WEIGHTS_0'),
    bones = node.getSkin()!.listJoints();
  if (
    !joints ||
    !weights ||
    joints.getType() !== 'VEC4' ||
    weights.getType() !== 'VEC4' ||
    weights.getComponentType() !== 5126
  )
    return fail('FBX output skin requires four explicit floating weights and exact joint indices.');
  const ids = joints.getElement(vertex, []),
    values = weights.getElement(vertex, []),
    result: FbxWeights = [];
  for (let i = 0; i < 4; i++) {
    const id = ids[i]!,
      value = values[i]!;
    if (!Number.isSafeInteger(id) || id < 0 || id >= bones.length || value < 0 || value > 1)
      return fail('FBX output skin weight or joint index is invalid.');
    if (value > 0) result.push([bones[id]!.getName(), value]);
  }
  if (
    new Set(result.map(([name]) => name)).size !== result.length ||
    Math.abs(result.reduce((sum, [, value]) => sum + value, 0) - 1) > 1e-6
  )
    return fail('FBX output skin weights are repeated or incomplete.');
  return result.sort(([a], [b]) => a.localeCompare(b));
}
function weightsError(left: FbxWeights | undefined, right: FbxWeights | undefined): number {
  if (!left || !right) return left === right ? 0 : Infinity;
  left = fbxWebpageWeights(left);
  if (left.length !== right.length || left.some(([name], index) => name !== right[index]![0]))
    return Infinity;
  return Math.max(0, ...left.map(([, value], index) => Math.abs(value - right[index]![1])));
}
function outputIndices(primitive: Primitive, count: number): Uint32Array {
  const raw = primitive.getIndices()?.getArray() ?? Uint32Array.from({ length: count }, (_, i) => i);
  if (
    !raw.length ||
    raw.length % 3 ||
    raw.length > 300000 ||
    raw.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= count)
  )
    return fail('Static FBX output triangle indices are invalid.');
  if (new Set(raw).size !== count) return fail('Static FBX output contains unused vertices.');
  return Uint32Array.from(raw);
}
function edge(edges: Map<string, number>, a: number, b: number): void {
  const key = a < b ? `${a}:${b}` : `${b}:${a}`;
  const count = (edges.get(key) ?? 0) + (a < b ? 1 : -1);
  if (count) edges.set(key, count);
  else edges.delete(key);
}

export async function verifyStaticFrontendFbx(
  sourceBytes: Buffer,
  outputBytes: Buffer,
  metadata: StudioFrontendMetadata,
): Promise<Record<string, unknown>> {
  validateFrontendMetadata(metadata);
  // FBX 的原 Phong→PBR 和蒙皮证明保持原已验组合；不能借 GLB 新 metadata 放行未证 FBX 分支。
  if (
    metadata.forward_axis !== '-y' ||
    metadata.pivot_to_center_bottom !== true ||
    metadata.material_factor !== undefined ||
    metadata.transform_matrix !== undefined ||
    metadata.children_transform_matrix !== undefined ||
    metadata.children_deleted !== undefined ||
    metadata.children_rename !== undefined
  )
    return fail(
      'FBX frontend verification currently requires -y, bottom-center pivot and no PBR editor override.',
    );
  const source = readStaticFrontendFbx(sourceBytes),
    target = (await readFrontendDocument(outputBytes, true, 'static-fbx-output')).getRoot(),
    transform = mat4.create(),
    tolerance = Math.max(1, source.extent) * 1e-6;
  await verifyFbxTextureDecoding(source.meshes.map((mesh) => mesh.material));
  mat4.rotateY(transform, transform, -Math.PI / 2);
  mat4.translate(
    transform,
    transform,
    source.pivot.map((value) => -value),
  );
  const named = outputNodes(target, source),
    surfaces = source.meshes.map((mesh) => verifyMesh(mesh, named.get(mesh.name)!, transform, tolerance));
  return {
    version: 1,
    source_format: 'fbx',
    source_sha256: studioAssimpHash(sourceBytes),
    output_sha256: studioAssimpHash(outputBytes),
    metadata,
    pivot_from_world_mesh_bounds: source.pivot,
    expected_global_matrix: Array.from(transform),
    transform_representation: source.meshes.some((mesh) => mesh.skin)
      ? 'verified_fbx_bound_rest_surface'
      : 'verified_static_fbx_world_surface_bake',
    source_nodes_preserved: source.names.length,
    faces: surfaces.reduce((sum, surface) => sum + surface.faces, 0),
    surfaces,
    clips: [],
    triangulation_basis:
      'Exact original webpage engine output; source polygons/attributes are independently checked. Nonplanar polygons retain the engine-selected legal diagonals and can differ from the Three preview surface.',
    claim:
      'Verified FBX polygon corners, oriented boundary coverage, world positions, explicit normals, flipped-V UVs, the webpage Lambert/Phong mapping and bounded embedded base-color JPEG bytes/default samplers. Original static skin hierarchy, explicit source per-vertex weights and their disclosed webpage pruning/normalization mapping, inverse binds and rest surfaces are verified when present; no animation/curve input is accepted. Static RSrs hierarchy may be baked. Original polygons follow the webpage export triangulation with independently verified noncrossing corner diagonals and oriented disk topology. Source-collinear triangle triplets and triangles opposed to the source polygon area vector are disclosed as original webpage triangulation behavior; newly collapsed output triangles are rejected. This does not claim equality to another loader triangulation or source Phong lighting.' +
      (source.meshes.some((mesh) => mesh.material.texture?.mime_type === 'image/png')
        ? ' Embedded 8-bit RGB/RGBA PNG is additionally verified with complete bytes and fully opaque decoded pixels. A TransparencyFactor texture alias is interpreted only when it references the same Video with identical default sampling and every alpha equals 255; the output remains OPAQUE. This proof starts at the actual native FBX and does not claim upload-to-native normal preservation.'
        : ''),
  };
}
function outputNodes(target: Root, source: StaticFbxSource): Map<string, Node> {
  if (
    target.listSkins().length !== source.meshes.filter((mesh) => mesh.skin).length ||
    target.listAnimations().length ||
    target.listTextures().length !== source.meshes.filter((mesh) => mesh.material.texture).length ||
    target.listCameras().length ||
    target.listMaterials().length !== new Set(source.meshes.map((mesh) => mesh.material.name)).size ||
    target.listMeshes().length !== source.meshes.length
  )
    return fail('Static FBX output contains additional geometry, material, texture or animation objects.');
  const visible = new Set<Node>(),
    pending = [...target.listScenes()[0]!.listChildren()],
    named = new Map<string, Node>();
  while (pending.length) {
    const node = pending.pop()!;
    if (visible.has(node)) return fail('Static FBX output graph is cyclic or multiply instanced.');
    visible.add(node);
    pending.push(...node.listChildren());
    const name = node.getName();
    if (named.has(name)) return fail('Static FBX output has ambiguous model names.');
    named.set(name, node);
    validateOutputNode(node, source);
  }
  if (
    target.listNodes().some((node) => !visible.has(node)) ||
    target.listMeshes().some((mesh) => ![...visible].some((node) => node.getMesh() === mesh)) ||
    target
      .listMaterials()
      .some(
        (material) =>
          !target
            .listMeshes()
            .some((mesh) => mesh.listPrimitives().some((primitive) => primitive.getMaterial() === material)),
      ) ||
    target
      .listTextures()
      .some(
        (texture) => !target.listMaterials().some((material) => material.getBaseColorTexture() === texture),
      ) ||
    target.listSkins().some((skin) => ![...visible].some((node) => node.getSkin() === skin)) ||
    source.names.some((name) => !named.has(name)) ||
    source.names.some(
      (name) => !source.meshes.some((mesh) => mesh.name === name) && named.get(name)!.getMesh(),
    )
  )
    return fail('Static FBX output lost a source model or detached a visible object.');
  return named;
}
function validateOutputNode(node: Node, source: StaticFbxSource): void {
  const name = node.getName(),
    bone = source.meshes.some((mesh) => mesh.skin?.bones.some((bone) => bone.name === name));
  if (
    Object.keys(node.getExtras()).length &&
    (node.getExtras().IsNull !== !(bone || source.meshes.some((mesh) => mesh.name === name)) ||
      !source.names.includes(name))
  )
    return fail('FBX output helper/mesh metadata does not match the exact source model.');
  if (
    !source.names.includes(name) &&
    (node.getMesh() ||
      node.getSkin() ||
      node.getCamera() ||
      !['', 'RootNode', ...(source.meshes.some((mesh) => mesh.skin) ? ['node_0'] : [])].includes(name))
  )
    return fail('Static FBX output added an unverified model.');
}
interface SkinContext {
  proof: Record<string, number | string>;
  source: Map<string, mat4>;
  output: Map<string, mat4>;
}
function verifySkin(
  mesh: StaticFbxMesh,
  node: Node,
  transform: mat4,
  tolerance: number,
): SkinContext | undefined {
  if (!mesh.skin) return undefined;
  const skin = node.getSkin()!,
    joints = skin.listJoints(),
    inverse = skin.getInverseBindMatrices(),
    source = new Map<string, mat4>(),
    output = new Map<string, mat4>();
  if (
    !inverse ||
    inverse.getType() !== 'MAT4' ||
    inverse.getCount() !== joints.length ||
    joints.length !== mesh.skin.bones.length ||
    new Set(joints.map((joint) => joint.getName())).size !== joints.length
  )
    return fail('FBX output skin lost or duplicated source joints/inverse bindings.');
  let worldError = 0,
    inverseError = 0;
  for (const bone of mesh.skin.bones) {
    const index = joints.findIndex((joint) => joint.getName() === bone.name),
      joint = joints[index];
    if (!joint || (bone.parent && joint.getParentNode()?.getName() !== bone.parent))
      return fail('FBX output changed the source bone hierarchy.');
    const actualWorld = joint.getWorldMatrix(),
      actualInverse = inverse.getElement(index, []) as mat4,
      expectedWorld = mat4.multiply(mat4.create(), transform, bone.world);
    worldError = Math.max(worldError, fbxMatrixError(actualWorld, expectedWorld));
    inverseError = Math.max(inverseError, fbxMatrixError(actualInverse, bone.inverse_bind));
    source.set(bone.name, mat4.multiply(mat4.create(), expectedWorld, bone.inverse_bind));
    output.set(bone.name, mat4.multiply(mat4.create(), actualWorld, actualInverse));
  }
  // 原网页 Assimp 的骨矩阵以 Float32 逐层合成；单独披露该误差，实际蒙皮表面仍用更严格的位置阈值。
  if (worldError > Math.max(tolerance, 1e-5) || inverseError > 2e-6)
    return fail('FBX output bone rest transforms or inverse binds differ from the exact source.');
  const sourceWeights = [...mesh.skin.weights.values()],
    removed = sourceWeights.map((values) =>
      values.filter(([, value]) => Math.fround(value) <= Math.fround(1e-6)),
    );
  return {
    source,
    output,
    proof: {
      joints: joints.length,
      weighted_source_vertices: mesh.skin.weights.size,
      maximum_source_bind_error: mesh.skin.maximum_source_bind_error,
      maximum_source_weight_sum_error: mesh.skin.maximum_source_weight_sum_error,
      maximum_bone_world_error: worldError,
      maximum_inverse_bind_error: inverseError,
      source_vertices_with_pruned_weights: removed.filter((values) => values.length).length,
      source_weight_entries_pruned: removed.reduce((sum, values) => sum + values.length, 0),
      maximum_pruned_source_weight: Math.max(
        0,
        ...removed.flatMap((values) => values.map(([, value]) => value)),
      ),
      maximum_pruned_weight_sum_per_vertex: Math.max(
        0,
        ...removed.map((values) => values.reduce((sum, [, value]) => sum + value, 0)),
      ),
      weight_mapping:
        'Original webpage Assimp converts weights to Float32, removes weights <=1e-6 and normalizes retained weights. This is explicitly lossy relative to original source weights; no output bytes are repaired.',
      world_matrix_mapping:
        'Original webpage hierarchy composition; world-matrix component error is bounded by 1e-5 and separately reported, while the complete skinned rest surface is still checked at the original geometric tolerance.',
    },
  };
}
function skinPosition(position: FbxPoint, weights: FbxWeights, matrices: Map<string, mat4>): FbxPoint {
  const result: FbxPoint = [0, 0, 0];
  for (const [name, weight] of weights) {
    const matrix = matrices.get(name);
    if (!matrix) return fail('FBX rest vertex references a missing exact source joint.');
    const point = vec3.transformMat4(vec3.create(), position, matrix);
    for (let axis = 0; axis < 3; axis++) result[axis]! += point[axis]! * weight;
  }
  return result;
}
function verifyRestCorner(
  context: SkinContext,
  node: Node,
  vertex: number,
  source: StaticFbxCorner,
  weights: FbxWeights,
  tolerance: number,
): number {
  const position = node
      .getMesh()!
      .listPrimitives()[0]!
      .getAttribute('POSITION')!
      .getElement(vertex, [0, 0, 0]) as FbxPoint,
    error = difference(
      skinPosition(source.position, source.weights!, context.source),
      skinPosition(position, weights, context.output),
    );
  if (error > tolerance)
    return fail('FBX output actual skinned rest surface differs from the source binding and weights.');
  return error;
}
function triangleSurfaceDiagnostics(
  polygon: StaticFbxCorner[],
  matched: number[],
  frame: ReturnType<typeof polygonProof>,
  outputPoints: FbxPoint[],
): { opposed: number; sourceDegenerate: number } {
  const triangleNormal = cross(
    subtract(polygon[matched[1]!]!.position, polygon[matched[0]!]!.position),
    subtract(polygon[matched[2]!]!.position, polygon[matched[0]!]!.position),
  );
  if (new Set(matched).size !== 3) return fail('FBX output repeated an original polygon corner.');
  const opposed =
    !frame.degenerate && Math.hypot(...triangleNormal) >= 1e-12 && dot(triangleNormal, frame.normal) <= 0;
  const sourceDegenerate = Math.hypot(...triangleNormal) < 1e-12;
  if (
    !sourceDegenerate &&
    Math.hypot(
      ...cross(subtract(outputPoints[1]!, outputPoints[0]!), subtract(outputPoints[2]!, outputPoints[0]!)),
    ) < 1e-12
  )
    return fail(
      'FBX output introduced a degenerate triangle that was not present in the source corner geometry.',
    );
  return { opposed: Number(opposed), sourceDegenerate: Number(sourceDegenerate) };
}
function verifyMesh(mesh: StaticFbxMesh, node: Node, transform: mat4, tolerance: number) {
  const output = outputCorners(node, Boolean(mesh.polygons[0]![0]!.uv), mesh.material, mesh.skin),
    matrix = mat4.multiply(mat4.create(), transform, mesh.matrix),
    errors = [0, 0, 0, 0],
    skinProof = verifySkin(mesh, node, transform, tolerance);
  let restError = 0;
  let offset = 0,
    nonplanarQuads = 0,
    nonplanarPolygons = 0,
    sourceDegenerateTriangles = 0,
    opposedTriangles = 0;
  for (const polygon of mesh.polygons) {
    const frame = polygonProof(polygon),
      expected = polygon.map((corner) => transformCorner(corner, matrix)),
      boundary = new Map<string, number>(),
      triangles: number[][] = [];
    if (frame.nonplanar) {
      nonplanarPolygons++;
      if (polygon.length === 4) nonplanarQuads++;
    }
    for (let triangle = 0; triangle < polygon.length - 2; triangle++) {
      const matched: number[] = [];
      for (let corner = 0; corner < 3; corner++) {
        const index = output.indices[offset++],
          actual = index === undefined ? undefined : output.corners[index];
        if (!actual) return fail('FBX output has fewer triangles than the source polygons.');
        const candidates = expected
          .map((value, i) => ({
            i,
            errors: [
              difference(value.position, actual.position),
              difference(value.normal, actual.normal),
              value.uv && actual.uv ? difference(value.uv, actual.uv) : value.uv === actual.uv ? 0 : Infinity,
              weightsError(value.weights, actual.weights),
            ],
          }))
          .filter((entry) => entry.errors.every((value, i) => value <= [tolerance, 2e-6, 1e-6, 1e-6][i]!));
        if (candidates.length !== 1)
          return fail('FBX output changed a polygon corner, normal, UV or source polygon order.');
        const found = candidates[0]!;
        matched.push(found.i);
        if (skinProof)
          restError = Math.max(
            restError,
            verifyRestCorner(skinProof, node, index!, polygon[found.i]!, actual.weights!, tolerance),
          );
        found.errors.forEach((value, i) => {
          errors[i] = Math.max(errors[i]!, value);
        });
      }
      const diagnostic = triangleSurfaceDiagnostics(
        polygon,
        matched,
        frame,
        Array.from(output.indices.subarray(offset - 3, offset), (index) => output.corners[index]!.position),
      );
      opposedTriangles += diagnostic.opposed;
      sourceDegenerateTriangles += diagnostic.sourceDegenerate;
      triangles.push(matched);
      for (let i = 0; i < 3; i++) edge(boundary, matched[i]!, matched[(i + 1) % 3]!);
    }
    verifyTriangulation(triangles, polygon.length);
    // 三角边界抵消后必须恰好是原多边形边界；重复面、洞、错误对角线和反面不能通过。
    for (let i = 0; i < polygon.length; i++) edge(boundary, (i + 1) % polygon.length, i);
    if (boundary.size) return fail('FBX output triangles do not cover the exact oriented source polygon.');
  }
  if (offset !== output.indices.length) return fail('FBX output contains extra triangles.');
  return {
    node: mesh.name,
    source_polygons: mesh.polygons.length,
    faces: offset / 3,
    maximum_position_error: errors[0],
    maximum_normal_error: errors[1],
    maximum_uv_error: errors[2],
    ...(mesh.skin
      ? {
          maximum_mapped_named_weight_error: errors[3],
          skin: { ...skinProof!.proof, maximum_rest_position_error: restError },
        }
      : {}),
    nonplanar_quadrilaterals: nonplanarQuads,
    nonplanar_polygons: nonplanarPolygons,
    source_collinear_triangle_triplets_retained: sourceDegenerateTriangles,
    webpage_triangles_opposed_to_source_polygon_area_vector: opposedTriangles,
    material: {
      ...mesh.material,
      ...(mesh.material.texture
        ? {
            texture: {
              source_name: mesh.material.texture.name,
              bytes: mesh.material.texture.bytes.length,
              sha256: mesh.material.texture.sha256,
              mime_type: mesh.material.texture.mime_type,
              ...(mesh.material.texture.mime_type === 'image/png'
                ? {
                    decoded_alpha: 'all_pixels_255',
                    ...(mesh.material.texture.opaque_alpha_alias
                      ? { opaque_alpha_alias: 'same_video_identical_default_sampling' }
                      : {}),
                  }
                : {}),
              mapping:
                mesh.material.texture.mime_type === 'image/png'
                  ? 'Original embedded opaque PNG bytes, UV0 and default repeat sampler; every decoded alpha is 255, output is OPAQUE and standard source diffuse 0.8 maps to the webpage export white texture multiplier.'
                  : 'Original embedded base-color JPEG bytes, UV0 and default repeat sampler; standard source diffuse 0.8 maps to the webpage export white texture multiplier.',
            },
          }
        : {}),
    },
    material_mapping:
      'Original webpage export: diffuse/factor, emissive/factor, opacity, metallic=0, Phong roughness=1-sqrt(shininess)/10. Phong SpecularColor RGB is ignored by the original engine; Float32 SpecularFactor (default 0.25) maps to specularFactor=4f below 0.25, default material at 0.25, or IOR from F0=0.16*min(f,0.5) above it. Saturation and loss of source specular hue are intentional webpage export behavior, not lossless lighting preservation. Ambient lighting is not baked.',
  };
}
