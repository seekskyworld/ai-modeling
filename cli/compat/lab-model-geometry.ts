/** 只核网页实际保存的规范化表示；不修改原 Lab 字节，也不降低原件框外保留证明的精度。 */
import { inspectLabReferenceGeometry } from './lab-reference-edit-geometry.ts';
import { validateGlb } from '../../studio/files.ts';
import { array, object, TripoError } from '../../studio/contracts/errors.ts';

type Point = [number, number, number];
type Geometry = Awaited<ReturnType<typeof inspectLabReferenceGeometry>>;
type Face = Geometry['faces'][number];
/** 坐标阈值沿用原几何量级；法线单独按已观察的 int8 量化约束，不用于原 Lab 验收。 */
export const labModelPositionTolerance = 0.00004;
export const labModelNormalTolerance = 0.007;
export interface LabModelGeometryProof {
  version: 1;
  status: 'verified';
  representation: 'studio_normalized';
  original: { sha256: string; bytes: number; faces: number; nodes: string[]; primitives: number };
  studio: { sha256: string; bytes: number; faces: number; nodes: string[]; primitives: number };
  normalization: { center: Point; scale: number };
  matched_oriented_faces: number;
  maximum_vertex_error: number;
  maximum_normal_angle: number;
  vertex_tolerance: number;
  normal_tolerance: number;
  material_failures: 0;
  original_coordinates_preserved: false;
  original_normal_precision_preserved: false;
}
const fail = (message: string): never => {
  throw new TripoError('LAB_MODEL_GEOMETRY_UNVERIFIED', message, 'read');
};
function summary(bytes: Buffer, geometry: Geometry): LabModelGeometryProof['original'] {
  const json = validateGlb(bytes, true);
  return {
    sha256: geometry.sha256,
    bytes: geometry.bytes,
    faces: geometry.faces.length,
    nodes: array(json.nodes)
      .map(object)
      .map((node) => (typeof node.name === 'string' ? node.name : '')),
    primitives: array(json.meshes)
      .map(object)
      .reduce((count, mesh) => count + array(mesh.primitives).length, 0),
  };
}
export function normalizedLabModelGeometry(source: Geometry): {
  faces: Face[];
  center: Point;
  scale: number;
} {
  const center = source.bounds.min.map((v, i) => (v + source.bounds.max[i]!) / 2) as Point,
    extent = Math.max(...source.bounds.min.map((v, i) => source.bounds.max[i]! - v)),
    scale = 1 / extent;
  if (!Number.isFinite(scale) || extent <= 1e-8)
    fail('The Lab model cannot establish a finite unit-bounds representation.');
  return {
    center,
    scale,
    faces: source.faces.map((face) => ({
      ...face,
      points: face.points.map((p) => p.map((v, i) => (v - center[i]!) * scale) as Point),
      centroid: face.centroid.map((v, i) => (v - center[i]!) * scale) as Point,
    })),
  };
}
const angle = (a: Face, b: Face, rotation: number): number =>
  Math.max(
    ...a.normals.map((n, i) =>
      Math.acos(
        Math.max(
          -1,
          Math.min(
            1,
            n.reduce((sum, v, j) => sum + v * b.normals[(i + rotation) % 3]![j]!, 0),
          ),
        ),
      ),
    ),
  );
export function labModelCorrespondence(
  source: Face[],
  target: Face[],
): {
  maximumVertex: number;
  maximumNormal: number;
  pairs: { source: number; target: number }[];
} {
  const size = labModelPositionTolerance * 3,
    cell = (p: Point) => p.map((v) => Math.floor(v / size)),
    buckets = new Map<string, number[]>();
  target.forEach((face, index) => {
    const key = cell(face.centroid).join(',');
    buckets.set(key, [...(buckets.get(key) ?? []), index]);
  });
  const used = new Set<number>();
  const pairs: { source: number; target: number }[] = [];
  let maximumVertex = 0,
    maximumNormal = 0;
  for (const [sourceIndex, face] of source.entries()) {
    const key = cell(face.centroid),
      candidates: { index: number; error: number; normal: number }[] = [];
    for (let x = -1; x <= 1; x++)
      for (let y = -1; y <= 1; y++)
        for (let z = -1; z <= 1; z++) {
          for (const index of buckets.get([key[0]! + x, key[1]! + y, key[2]! + z].join(',')) ?? []) {
            if (used.has(index)) continue;
            const other = target[index]!;
            for (let rotation = 0; rotation < 3; rotation++) {
              const error = Math.max(
                ...face.points.map((p, i) =>
                  Math.hypot(...p.map((v, j) => v - other.points[(i + rotation) % 3]![j]!)),
                ),
              );
              if (error > labModelPositionTolerance) continue;
              const normal = angle(face, other, rotation);
              if (normal <= labModelNormalTolerance && face.material === other.material)
                candidates.push({ index, error, normal });
            }
          }
        }
    if (candidates.length !== 1)
      fail(
        'The Studio representation does not uniquely preserve every normalized oriented triangle, normal and material.',
      );
    const match = candidates[0]!;
    used.add(match.index);
    pairs.push({ source: sourceIndex, target: match.index });
    maximumVertex = Math.max(maximumVertex, match.error);
    maximumNormal = Math.max(maximumNormal, match.normal);
  }
  if (used.size !== target.length) fail('The Studio representation contains additional or missing faces.');
  return { maximumVertex, maximumNormal, pairs };
}
export async function verifyLabModelGeometry(
  originalBytes: Buffer,
  studioBytes: Buffer,
): Promise<LabModelGeometryProof> {
  const [original, studio] = await Promise.all([
    inspectLabReferenceGeometry(originalBytes, false),
    inspectLabReferenceGeometry(studioBytes, false),
  ]);
  if (original.faces.length !== studio.faces.length)
    fail('The Studio representation changed the original Lab triangle count.');
  const source = normalizedLabModelGeometry(original),
    match = labModelCorrespondence(source.faces, studio.faces);
  return {
    version: 1,
    status: 'verified',
    representation: 'studio_normalized',
    original: summary(originalBytes, original),
    studio: summary(studioBytes, studio),
    normalization: { center: source.center, scale: source.scale },
    matched_oriented_faces: original.faces.length,
    maximum_vertex_error: match.maximumVertex,
    maximum_normal_angle: match.maximumNormal,
    vertex_tolerance: labModelPositionTolerance,
    normal_tolerance: labModelNormalTolerance,
    material_failures: 0,
    original_coordinates_preserved: false,
    original_normal_precision_preserved: false,
  };
}
