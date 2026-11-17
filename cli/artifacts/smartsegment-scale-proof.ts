/** metadata→segment 的最终几何证明；只读原件，不拟合、不归一化、不修写网页产物。 */
import { createHash } from 'node:crypto';
import type { Primitive } from '@gltf-transform/core';
import { modelIO } from '../local/gltf.ts';
import { validateGlb } from '../../studio/files.ts';
import { array, object, TripoError } from '../../studio/contracts/errors.ts';
import { inspectSmartSegmentTransformSource } from './smartsegment-transform-proof.ts';
import { checkedMetadataTransform } from './smartsegment-transform-matrix.ts';
import {
  scaleReferenceAppearance,
  scaleReferenceWorld,
  validateScaleReferenceShape,
} from './smartsegment-scale-reference.ts';

type Point = [number, number, number];
type Face = [Point, Point, Point];
type Bounds = { min: Point; max: Point };
type Part = { name: string; vertices: number; faces: number; world_matrix: number[]; bounds: Bounds };
type Geometry = { faces: Face[]; parts: Part[]; bounds: Bounds };
const maxFaces = 25000;
const maxVertices = 100000;
const fail = (message: string): never => {
  throw new TripoError('SMARTSEGMENT_TRANSFORM_UNVERIFIED', message, 'not_submitted');
};
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const subtract = (a: Point, b: Point): Point => a.map((v, i) => v - b[i]!) as Point;
const dot = (a: Point, b: Point): number => a.reduce((sum, v, i) => sum + v * b[i]!, 0);
const distance = (a: Point, b: Point): number => Math.hypot(...subtract(a, b));
const point = (p: number[], m: number[]): Point =>
  [0, 1, 2].map((i) => m[i]! * p[0]! + m[4 + i]! * p[1]! + m[8 + i]! * p[2]! + m[12 + i]!) as Point;
const center = (f: Face): Point => [0, 1, 2].map((i) => f.reduce((sum, p) => sum + p[i]!, 0) / 3) as Point;

function faceArea(face: Face): Point {
  const a = subtract(face[1], face[0]),
    b = subtract(face[2], face[0]);
  const area: Point = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  // 只排除真实/数值退化，不用固定面积阈值误杀网页原有的极小合法面。
  const edgeSquared = Math.max(
    dot(a, a),
    dot(b, b),
    dot(subtract(face[2], face[1]), subtract(face[2], face[1])),
  );
  if (
    !Number.isFinite(edgeSquared) ||
    dot(area, area) <= edgeSquared * edgeSquared * Number.EPSILON ** 2 * 64
  )
    return fail('Transformed segmentation requires nondegenerate oriented triangles in both original files.');
  return area;
}

function bounds(points: Point[]): Bounds {
  const min: Point = [Infinity, Infinity, Infinity],
    max: Point = [-Infinity, -Infinity, -Infinity];
  for (const p of points)
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i]!, p[i]!);
      max[i] = Math.max(max[i]!, p[i]!);
    }
  return { min, max };
}

function validateOutputScene(json: Record<string, unknown>): void {
  const nodes = array(json.nodes).map(object),
    meshes = array(json.meshes).map(object),
    scenes = array(json.scenes).map(object);
  const roots = array(scenes[0]?.nodes);
  if (
    scenes.length !== 1 ||
    (json.scene ?? 0) !== 0 ||
    !nodes.length ||
    nodes.length > 64 ||
    roots.length !== nodes.length ||
    new Set(roots).size !== nodes.length ||
    roots.some((id) => !Number.isSafeInteger(id) || Number(id) < 0 || Number(id) >= nodes.length)
  )
    return fail('Native scale output must contain one complete scene with at most 64 independent roots.');
  const referenced = new Set<number>();
  for (const node of nodes) {
    referenced.add(validateNode(node, meshes.length));
  }
  if (referenced.size !== meshes.length || array(json.skins).length || array(json.animations).length)
    fail(
      'Native scale output must contain only the rendered static meshes, without unused meshes or animation.',
    );
}

function validateNode(node: Record<string, unknown>, meshCount: number): number {
  if (
    !Number.isSafeInteger(node.mesh) ||
    Number(node.mesh) < 0 ||
    Number(node.mesh) >= meshCount ||
    array(node.children).length ||
    node.skin !== undefined ||
    node.weights !== undefined ||
    node.camera !== undefined ||
    node.extensions !== undefined
  )
    return fail('Native scale output cannot contain hierarchy, skin, camera, morph or node extensions.');
  validateNodeTransform(node);
  return Number(node.mesh);
}

function finiteVector(value: unknown, length: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((v) => typeof v === 'number' && Number.isFinite(v))
  );
}

function affineMatrix(value: unknown): void {
  if (!finiteVector(value, 16) || value[3] !== 0 || value[7] !== 0 || value[11] !== 0 || value[15] !== 1)
    fail('Source and native node matrices must be finite affine matrices with last row [0,0,0,1].');
}

function validateNodeTransform(node: Record<string, unknown>): void {
  if (node.matrix !== undefined) {
    // glTF 库可能将 matrix 分解为 TRS，先检查原 JSON，避免丢弃投影行后得到假证明。
    affineMatrix(node.matrix);
    if (['translation', 'rotation', 'scale'].some((key) => node[key] !== undefined))
      fail('A static glTF node cannot combine a matrix with separate TRS properties.');
  }
  for (const [key, length] of [
    ['translation', 3],
    ['rotation', 4],
    ['scale', 3],
  ] as const)
    if (node[key] !== undefined && !finiteVector(node[key], length))
      fail('Source and native TRS properties must be complete finite vectors.');
}

function primitiveCounts(
  primitive: Record<string, unknown>,
  accessors: Record<string, unknown>[],
  allowMissingUv: boolean,
): { faces: number; vertices: number } {
  const attributes = object(primitive.attributes),
    position = accessors[Number(attributes.POSITION)],
    count = Number(position?.count),
    indices = primitive.indices === undefined ? count : Number(accessors[Number(primitive.indices)]?.count);
  if (
    (primitive.mode ?? 4) !== 4 ||
    array(primitive.targets).length ||
    primitive.extensions !== undefined ||
    !['NORMAL,POSITION,TEXCOORD_0', ...(allowMissingUv ? ['NORMAL,POSITION'] : [])].includes(
      Object.keys(attributes).sort().join(','),
    ) ||
    !Number.isSafeInteger(count) ||
    count < 3 ||
    !Number.isSafeInteger(indices) ||
    indices < 3 ||
    indices % 3
  )
    return fail('Native scale output requires complete static triangles, normals and one UV set.');
  return { faces: indices / 3, vertices: count };
}

function validateOutputGeometry(json: Record<string, unknown>, allowMissingUv = false): void {
  const allowed = new Set(['KHR_mesh_quantization', 'EXT_meshopt_compression']);
  if ([...array(json.extensionsUsed), ...array(json.extensionsRequired)].some((v) => !allowed.has(String(v))))
    fail('Native scale output contains an extension outside the verified static geometry contract.');
  const accessors = array(json.accessors).map(object);
  let faces = 0,
    vertices = 0,
    primitives = 0;
  for (const [index, mesh] of array(json.meshes).map(object).entries()) {
    const instances = array(json.nodes).filter((node) => object(node).mesh === index).length;
    if (mesh.weights !== undefined || mesh.extensions !== undefined || !array(mesh.primitives).length)
      fail('Native scale output contains an empty, morphed or extended mesh.');
    for (const primitive of array(mesh.primitives).map(object)) {
      const count = primitiveCounts(primitive, accessors, allowMissingUv);
      faces += count.faces * instances;
      vertices += count.vertices * instances;
      primitives += instances;
    }
  }
  if (faces > maxFaces || vertices > maxVertices || primitives > 64)
    fail('Native scale verification is bounded to 25000 triangles, 100000 vertices and 64 primitives.');
}

function primitiveFaces(primitive: Primitive, world: number[]): { faces: Face[]; vertices: number } {
  const positions = primitive.getAttribute('POSITION')!,
    normals = primitive.getAttribute('NORMAL')!,
    uv = primitive.getAttribute('TEXCOORD_0');
  if (
    positions.getType() !== 'VEC3' ||
    normals.getType() !== 'VEC3' ||
    (uv && uv.getType() !== 'VEC2') ||
    normals.getCount() !== positions.getCount() ||
    (uv && uv.getCount() !== positions.getCount())
  )
    return fail('Native scale output has incomplete position, normal or UV accessors.');
  const points = Array.from({ length: positions.getCount() }, (_, i) => {
    const p = point(positions.getElement(i, []), world),
      n = normals.getElement(i, []),
      t = uv?.getElement(i, []) ?? [];
    if ([...p, ...n, ...t].some((v) => !Number.isFinite(v)) || Math.hypot(...n) < 1e-8)
      return fail('Native scale output has nonfinite positions/attributes or zero normals.');
    return p;
  });
  const indices =
      primitive.getIndices()?.getArray() ?? Array.from({ length: positions.getCount() }, (_, i) => i),
    faces: Face[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const ids = Array.from(indices.slice(i, i + 3));
    if (ids.length !== 3 || ids.some((id) => !Number.isSafeInteger(id) || id < 0 || id >= points.length))
      return fail('Native scale output contains invalid triangle indices.');
    const face = ids.map((id) => points[id]!) as Face;
    faceArea(face);
    faces.push(face);
  }
  return { faces, vertices: positions.getCount() };
}

async function geometry(bytes: Buffer, allowMissingUv = false): Promise<Geometry> {
  const json = validateGlb(bytes);
  validateOutputScene(json);
  validateOutputGeometry(json, allowMissingUv);
  const root = (await (await modelIO()).readBinary(bytes)).getRoot(),
    faces: Face[] = [],
    parts: Part[] = [];
  for (const node of root.listNodes())
    for (const primitive of node.getMesh()!.listPrimitives()) {
      const world = node.getWorldMatrix();
      affineMatrix(world);
      const data = primitiveFaces(primitive, world);
      faces.push(...data.faces);
      parts.push({
        name: node.getName(),
        vertices: data.vertices,
        faces: data.faces.length,
        world_matrix: world,
        bounds: bounds(data.faces.flat()),
      });
    }
  if (
    faces.length > maxFaces ||
    parts.reduce((sum, p) => sum + p.vertices, 0) > maxVertices ||
    parts.length > 64
  )
    return fail('Instanced output exceeds the bounded geometry verification contract.');
  return { faces, parts, bounds: bounds(faces.flat()) };
}

export async function inspectSmartSegmentScaleSource(bytes: Buffer): Promise<Record<string, unknown>> {
  const original = sha256(bytes),
    inspected = await inspectSmartSegmentTransformSource(bytes),
    root = (await (await modelIO()).readBinary(bytes)).getRoot(),
    node = root.listNodes()[0]!,
    material = node.getMesh()!.listPrimitives()[0]!.getMaterial();
  if (!node.getName().trim()) return fail('Metadata scaling requires a nonempty original mesh node name.');
  await geometry(bytes);
  if (sha256(bytes) !== original || inspected.sha256 !== original)
    return fail('The original scale source changed during verification.');
  return {
    ...inspected,
    node_name: node.getName(),
    material_factors: {
      metallic: material?.getMetallicFactor() ?? 1,
      roughness: material?.getRoughnessFactor() ?? 1,
    },
  };
}

export async function inspectSmartSegmentScaleReference(bytes: Buffer): Promise<Record<string, unknown>> {
  const original = sha256(bytes),
    json = validateGlb(bytes);
  // 已持久的单根来源必须保留完整旧 inspection 形状和指纹。
  if (array(json.nodes).length === 1) return inspectSmartSegmentScaleSource(bytes);
  validateOutputScene(json);
  validateOutputGeometry(json);
  validateScaleReferenceShape(json);
  const data = await geometry(bytes),
    root = (await (await modelIO()).readBinary(bytes)).getRoot(),
    rawNodes = array(json.nodes).map(object),
    center = data.bounds.min.map((v, i) => (v + data.bounds.max[i]!) / 2),
    extent = Math.max(...data.bounds.max.map((v, i) => v - data.bounds.min[i]!));
  if (Math.abs(extent - 1) > 0.00004 || center.some((value) => Math.abs(value) > 0.00004))
    return fail('Multiple-root metadata references currently require centered unit world bounds.');
  const roots = root.listNodes().map((node, index) => ({
    node_name: node.getName(),
    world_matrix: scaleReferenceWorld(node, rawNodes[index]!),
    faces: data.parts[index]!.faces,
    vertices: data.parts[index]!.vertices,
    appearance: scaleReferenceAppearance(node.getMesh()!.listPrimitives()[0]!),
  }));
  // 在提交前拒绝无法唯一对应的源表面，不靠输出顺序拆解重叠 root。
  correspondence(data.faces, data.faces, 0.00004);
  if (sha256(bytes) !== original) return fail('The metadata reference changed during verification.');
  return {
    version: 2,
    sha256: original,
    bytes: bytes.length,
    faces: data.faces.length,
    vertices: data.parts.reduce((sum, part) => sum + part.vertices, 0),
    bounds: data.bounds,
    center,
    extent,
    roots,
  };
}

type Match = { index: number; error: number };
function faceMatch(face: Face, expected: Face): number {
  let best = Infinity;
  for (let rotation = 0; rotation < 3; rotation++) {
    const error = Math.max(...face.map((p, i) => distance(p, expected[(i + rotation) % 3]!)));
    if (error < best) best = error;
  }
  return best;
}

function correspondence(
  expected: Face[],
  output: Face[],
  tolerance: number,
): { matched: number; maximum: number } {
  if (expected.length !== output.length)
    return fail('Native segmentation changed the transformed triangle count.');
  const size = tolerance * 3,
    bucket = (p: Point): Point => p.map((v) => Math.floor(v / size)) as Point,
    buckets = new Map<string, number[]>();
  expected.forEach((face, index) => {
    const key = bucket(center(face)).join(','),
      values = buckets.get(key) ?? [];
    values.push(index);
    buckets.set(key, values);
  });
  const used = new Set<number>();
  let attempts = 0,
    maximum = 0;
  for (const face of output) {
    const cell = bucket(center(face)),
      matches: Match[] = [];
    for (let x = -1; x <= 1; x++)
      for (let y = -1; y <= 1; y++)
        for (let z = -1; z <= 1; z++)
          for (const index of buckets.get([cell[0] + x, cell[1] + y, cell[2] + z].join(',')) ?? []) {
            if (++attempts > 2000000) return fail('Too many nearby faces for bounded scale verification.');
            const candidate = expected[index]!,
              error = faceMatch(face, candidate);
            if (error <= tolerance && dot(faceArea(face), faceArea(candidate)) > 0)
              matches.push({ index, error });
          }
    // 已匹配面也参与歧义检查；不能靠输出顺序消除重合/近邻面或重复使用原面。
    if (matches.length !== 1 || used.has(matches[0]!.index))
      return fail(
        'Native segmentation did not uniquely preserve every requested oriented triangle; normalization, flips, omissions and duplicates are not accepted.',
      );
    used.add(matches[0]!.index);
    maximum = Math.max(maximum, matches[0]!.error);
  }
  return { matched: used.size, maximum };
}

export async function verifySmartSegmentScaleOutput(
  sourceBytes: Buffer,
  matrix: number[],
  nativeBytes: Buffer,
  sourceMode?: 'reference',
): Promise<Record<string, unknown>> {
  const { matrix: selectedMatrix, tolerance } = checkedMetadataTransform(matrix),
    sourceHash = sha256(sourceBytes),
    nativeHash = sha256(nativeBytes);
  if (sourceMode === 'reference') await inspectSmartSegmentScaleReference(sourceBytes);
  else await inspectSmartSegmentScaleSource(sourceBytes);
  const source = await geometry(sourceBytes),
    native = await geometry(nativeBytes, sourceMode === 'reference'),
    expected = source.faces.map((face) => face.map((p) => point(p, selectedMatrix)) as Face);
  for (const face of expected) faceArea(face);
  const matched = correspondence(expected, native.faces, tolerance);
  if (sha256(sourceBytes) !== sourceHash || sha256(nativeBytes) !== nativeHash)
    return fail('The scale source or native output changed during verification.');
  return {
    version: 1,
    source_sha256: sourceHash,
    source_bytes: sourceBytes.length,
    sha256: nativeHash,
    bytes: nativeBytes.length,
    transform_matrix: selectedMatrix,
    matched_oriented_faces: matched.matched,
    maximum_position_error: matched.maximum,
    tolerance: { position: tolerance },
    parts: native.parts,
    bounds: native.bounds,
    expected_bounds: bounds(expected.flat()),
    uses_geometry_fit: false,
    native_result_modified: false,
    native_attribute_scope:
      sourceMode === 'reference'
        ? 'Native segmentation may recalculate normals, repack or omit UVs, and re-encode or omit materials/textures. This proof verifies complete finite positions/normals, valid optional UVs and all transformed oriented geometry, not source-attribute or pixel equivalence.'
        : 'Native segmentation may recalculate vertex normals, repack UVs and re-encode textures. This proof verifies complete finite attributes and transformed oriented geometry, not source-attribute or pixel equivalence.',
  };
}

// 组合原生变换复用同一有界只读几何算法；各调用方仍须独立检查请求族与固定效果门槛。
export {
  geometry as readSmartSegmentGeometry,
  correspondence as matchSmartSegmentGeometry,
  point as smartSegmentGeometryPoint,
  bounds as smartSegmentGeometryBounds,
  type Face as SmartSegmentFace,
  type Geometry as SmartSegmentGeometry,
  type Point as SmartSegmentPoint,
};
