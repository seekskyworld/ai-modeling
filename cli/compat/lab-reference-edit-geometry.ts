/** 只验原始远端字节，不修补模型；参考图语义仍由调用者评估，几何守卫不能冒充语义模型。 */
import { createHash } from 'node:crypto';
import type { Primitive, Root, Node } from '@gltf-transform/core';
import { mat3 } from 'gl-matrix';
import { modelIO } from '../local/gltf.ts';
import { validateGlb } from '../../studio/files.ts';
import { array, object, TripoError } from '../../studio/contracts/errors.ts';
import type { LabReferenceBbox } from './lab-reference-edit-plan.ts';

type Point = [number, number, number];
export interface LabReferenceFace {
  points: Point[];
  normals: Point[];
  material: string;
  centroid: Point;
  nodeName?: string;
}
type Face = LabReferenceFace;
export interface LabReferenceGeometry {
  sha256: string;
  bytes: number;
  faces: Face[];
  bounds: { min: Point; max: Point };
}
const tolerance = 0.00004;
const normalTolerance = 0.002;
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const fail = (message: string): never => {
  throw new TripoError('LAB_REFERENCE_GEOMETRY_UNVERIFIED', message, 'read');
};
const inside = (p: Point, box: LabReferenceBbox, epsilon = 0): boolean =>
  p.every((v, i) => v >= box[0][i]! - epsilon && v <= box[1][i]! + epsilon);

function material(primitive: Primitive): string {
  const m = primitive.getMaterial();
  if (!m) return 'default';
  if (
    ['BaseColor', 'MetallicRoughness', 'Normal', 'Occlusion', 'Emissive'].some((name) => {
      const getter = `get${name}Texture` as 'getBaseColorTexture';
      return Boolean(m[getter]());
    }) ||
    m.listExtensions().length
  )
    fail('Textured or extended Lab output materials have no verified preservation route.');
  const value = {
    base: m.getBaseColorFactor(),
    metallic: m.getMetallicFactor(),
    roughness: m.getRoughnessFactor(),
    emissive: m.getEmissiveFactor(),
    alpha: m.getAlphaMode(),
    cutoff: m.getAlphaCutoff(),
    double: m.getDoubleSided(),
  };
  return JSON.stringify(value) ===
    JSON.stringify({
      base: [1, 1, 1, 1],
      metallic: 1,
      roughness: 1,
      emissive: [0, 0, 0],
      alpha: 'OPAQUE',
      cutoff: 0.5,
      double: false,
    })
    ? 'default'
    : JSON.stringify(value);
}

function checkedNodes(root: Root, source: boolean): Set<Node> {
  if (
    root.listScenes().length !== 1 ||
    root.listTextures().length ||
    root.listSkins().length ||
    root.listAnimations().length
  )
    fail('Lab geometry requires one static scene without textures, skins or animation.');
  if (
    source &&
    (root.listNodes().length !== 1 ||
      root.listMeshes().length !== 1 ||
      root.listMeshes()[0]!.listPrimitives().length !== 1)
  )
    fail('This Lab route currently requires one source node, mesh and primitive.');
  const nodes = new Set<Node>();
  root.listScenes()[0]!.traverse((node) => nodes.add(node));
  if (nodes.size !== root.listNodes().length)
    fail('Unreferenced model nodes cannot establish an exact Lab source.');
  return nodes;
}
function worldVertices(primitive: Primitive, m: readonly number[], nm: mat3) {
  if (
    primitive.getMode() !== 4 ||
    primitive.listTargets().length ||
    primitive.listSemantics().some((s) => !['POSITION', 'NORMAL'].includes(s))
  )
    fail('Lab geometry must contain static triangles with POSITION and NORMAL only.');
  const p = primitive.getAttribute('POSITION'),
    n = primitive.getAttribute('NORMAL');
  if (!p || !n || p.getCount() !== n.getCount()) fail('Lab source requires complete vertex normals.');
  const count = p!.getCount();
  if (count > 600000) fail('Lab vertex count exceeds the verified range.');
  const points: Point[] = [],
    normals: Point[] = [];
  for (let i = 0; i < count; i++) {
    const value = p!.getElement(i, []),
      normal = n!.getElement(i, []);
    const point = [0, 1, 2].map(
      (j) => m[j]! * value[0]! + m[j + 4]! * value[1]! + m[j + 8]! * value[2]! + m[j + 12]!,
    ) as Point;
    const transformed = [0, 1, 2].map(
      (j) => nm[j]! * normal[0]! + nm[j + 3]! * normal[1]! + nm[j + 6]! * normal[2]!,
    ) as Point;
    const length = Math.hypot(...transformed);
    if (
      !point.every((v) => Number.isFinite(v) && Math.abs(v) <= 10000) ||
      !Number.isFinite(length) ||
      length < 1e-10
    )
      fail('Lab geometry contains invalid positions or zero-length normals.');
    points.push(point);
    normals.push(transformed.map((v) => v / length) as Point);
  }
  return { points, normals };
}
function primitiveFaces(primitive: Primitive, m: readonly number[], nm: mat3, source: boolean): Face[] {
  const { points, normals } = worldVertices(primitive, m, nm),
    count = points.length;
  const ids = primitive.getIndices()?.getArray() ?? Array.from({ length: count }, (_, i) => i);
  if (ids.length % 3) fail('Incomplete triangle indices.');
  if (ids.length / 3 > (source ? 25000 : 200000))
    fail('Lab triangle count exceeds the verified input/output limits.');
  const materialId = material(primitive);
  if (source && materialId !== 'default')
    fail('Only the original default untextured material is currently verified for Lab reference input.');
  const faces: Face[] = [];
  for (let i = 0; i < ids.length; i += 3) {
    const indices = [...ids.slice(i, i + 3)];
    if (indices.some((v) => !Number.isInteger(v) || v < 0 || v >= count)) fail('Invalid triangle index.');
    const ps = indices.map((j) => points[j]!);
    faces.push({
      points: ps,
      normals: indices.map((j) => normals[j]!),
      material: materialId,
      centroid: [0, 1, 2].map((j) => ps.reduce((sum, v) => sum + v[j]!, 0) / 3) as Point,
    });
  }
  return faces;
}
function nodeFaces(node: Node, source: boolean): Face[] {
  if (node.getSkin() || node.listExtensions().length)
    fail('Skinned or extended nodes are outside the verified Lab scope.');
  const m = node.getWorldMatrix(),
    nm = mat3.normalFromMat4(mat3.create(), m);
  if (
    !nm ||
    m.some((x) => !Number.isFinite(x)) ||
    Math.abs(m[3]!) + Math.abs(m[7]!) + Math.abs(m[11]!) > 1e-10 ||
    m[15] !== 1
  )
    return fail('Lab source needs finite, nonsingular affine model coordinates.');
  return (node.getMesh()?.listPrimitives() ?? []).flatMap((primitive) =>
    primitiveFaces(primitive, m, nm, source).map((face) => ({ ...face, nodeName: node.getName() })),
  );
}
export async function inspectLabReferenceGeometry(
  bytes: Buffer,
  source = true,
): Promise<LabReferenceGeometry> {
  if (bytes.length > 50 * 1024 * 1024) fail('Lab reference geometry exceeds the verified 50 MiB range.');
  const json = validateGlb(bytes, true);
  if (
    array(json.buffers).some((b) => object(b).uri !== undefined) ||
    array(json.images).length ||
    array(json.skins).length ||
    array(json.animations).length
  )
    fail(
      'Lab reference editing requires a self-contained, untextured static GLB without skins or animations.',
    );
  const root = (await (await modelIO()).readBinary(bytes)).getRoot();
  const faces: Face[] = [],
    min: Point = [Infinity, Infinity, Infinity],
    max: Point = [-Infinity, -Infinity, -Infinity];
  for (const node of checkedNodes(root, source)) {
    for (const face of nodeFaces(node, source)) faces.push(face);
    if (faces.length > (source ? 25000 : 200000))
      fail('Lab triangle count exceeds the verified input/output limits.');
  }
  if (!faces.length) fail('Lab source has no visible triangle geometry.');
  for (const face of faces)
    for (const point of face.points)
      for (let j = 0; j < 3; j++) {
        min[j] = Math.min(min[j]!, point[j]!);
        max[j] = Math.max(max[j]!, point[j]!);
      }
  return { sha256: sha(bytes), bytes: bytes.length, faces, bounds: { min, max } };
}

export function matchLabReferenceFaces(original: Face[], output: Face[]) {
  const size = tolerance * 3,
    cell = (p: Point) => p.map((v) => Math.floor(v / size));
  const buckets = new Map<string, number[]>();
  output.forEach((f, i) => {
    const k = cell(f.centroid).join(',');
    buckets.set(k, [...(buckets.get(k) ?? []), i]);
  });
  const used = new Set<number>();
  const pairs: { source: number; output: number }[] = [];
  let missing = 0,
    ambiguous = 0,
    normalFailures = 0,
    materialFailures = 0,
    maxVertex = 0,
    maxNormal = 0;
  for (const [sourceIndex, f] of original.entries()) {
    const k = cell(f.centroid),
      candidates: { index: number; rotation: number; error: number }[] = [];
    for (let a = -1; a <= 1; a++)
      for (let b = -1; b <= 1; b++)
        for (let c = -1; c <= 1; c++) {
          for (const index of buckets.get([k[0]! + a, k[1]! + b, k[2]! + c].join(',')) ?? []) {
            if (used.has(index)) continue;
            const candidate = output[index]!;
            for (let rotation = 0; rotation < 3; rotation++) {
              const error = Math.max(
                ...f.points.map((p, i) =>
                  Math.hypot(...p.map((v, j) => v - candidate.points[(i + rotation) % 3]![j]!)),
                ),
              );
              if (error <= tolerance) candidates.push({ index, rotation, error });
            }
          }
        }
    if (!candidates.length) {
      missing++;
      continue;
    }
    if (candidates.length !== 1) ambiguous++;
    candidates.sort((a, b) => a.error - b.error || a.index - b.index);
    const chosen = candidates[0]!,
      other = output[chosen.index]!;
    used.add(chosen.index);
    pairs.push({ source: sourceIndex, output: chosen.index });
    maxVertex = Math.max(maxVertex, chosen.error);
    const angle = Math.max(
      ...f.normals.map((n, i) =>
        Math.acos(
          Math.max(
            -1,
            Math.min(
              1,
              n.reduce((sum, v, j) => sum + v * other.normals[(i + chosen.rotation) % 3]![j]!, 0),
            ),
          ),
        ),
      ),
    );
    maxNormal = Math.max(maxNormal, angle);
    if (angle > normalTolerance) normalFailures++;
    if (f.material !== other.material) materialFailures++;
  }
  return { used, pairs, missing, ambiguous, normalFailures, materialFailures, maxVertex, maxNormal };
}

export function labReferenceSourceSummary(
  source: LabReferenceGeometry,
  bbox: LabReferenceBbox,
): Record<string, unknown> {
  const selected = source.faces.filter((f) => f.points.every((p) => inside(p, bbox)));
  if (!selected.length || selected.length === source.faces.length)
    fail('bbox must enclose at least one whole triangle and leave at least one original triangle protected.');
  return {
    sha256: source.sha256,
    bytes: source.bytes,
    faces: source.faces.length,
    selected_faces: selected.length,
    protected_faces: source.faces.length - selected.length,
    bounds: source.bounds,
  };
}

export async function verifyLabReferenceGeometry(
  sourceBytes: Buffer,
  outputBytes: Buffer,
  bbox: LabReferenceBbox,
): Promise<Record<string, unknown>> {
  const [source, output] = await Promise.all([
    inspectLabReferenceGeometry(sourceBytes),
    inspectLabReferenceGeometry(outputBytes, false),
  ]);
  const sourceSummary = labReferenceSourceSummary(source, bbox);
  const protectedFaces = source.faces.filter((f) => !f.points.every((p) => inside(p, bbox)));
  const selected = source.faces.filter((f) => f.points.every((p) => inside(p, bbox)));
  const proof = matchLabReferenceFaces(protectedFaces, output.faces);
  const remainder = output.faces.filter((_, i) => !proof.used.has(i));
  const outside = remainder.filter((f) => !f.points.every((p) => inside(p, bbox, tolerance))).length;
  const selectedMatch = matchLabReferenceFaces(selected, remainder);
  const changed = selectedMatch.missing > 0 || remainder.length !== selected.length;
  if (
    proof.missing ||
    proof.ambiguous ||
    proof.normalFailures ||
    proof.materialFailures ||
    outside ||
    !changed ||
    !remainder.length
  )
    fail(
      'The original Lab artifact did not preserve every protected oriented triangle/normal/material, added outside geometry, or did not change the selected region. Keep the original job; do not regenerate.',
    );
  return {
    version: 1,
    status: 'verified',
    source: sourceSummary,
    output: { sha256: output.sha256, bytes: output.bytes, faces: output.faces.length, bounds: output.bounds },
    bbox,
    protected_faces: protectedFaces.length,
    matched_protected_faces: proof.used.size,
    max_vertex_error: proof.maxVertex,
    max_normal_angle_radians: proof.maxNormal,
    vertex_tolerance: tolerance,
    normal_tolerance_radians: normalTolerance,
    new_outside_faces: outside,
    selected_original_missing: selectedMatch.missing,
    selected_output_faces: remainder.length,
    selected_region_changed: changed,
    semantic_fidelity: 'not_automatically_verified',
    backend: 'studio_lab',
    official_p2_engine: false,
  };
}
