/** UV→网页原生导入压缩：只还原可验证的包围盒归一化，不用本地编码器冒充网页 Meshopt。 */
import { mat4, vec3 } from 'gl-matrix';
import { array, TripoError } from '../../studio/contracts/errors.ts';
import { verifyNativeMeshopt } from './native-meshopt.ts';
import { restoreUvPrimitiveGroups, writeUvGlb } from './uv-import-layout.ts';
import {
  boundsProof,
  readUvSurface,
  uvFail as fail,
  uvHash as hash,
  type Triple,
  type UvFace,
  type UvPart,
  type UvSurface,
  type UvImportSource,
} from './uv-import-surface.ts';
export { inspectUvCompressionInput, inspectUvImportSource } from './uv-import-surface.ts';
export type { UvImportSource } from './uv-import-surface.ts';

const centroid = (face: UvFace): Triple =>
  [0, 1, 2].map((axis) => face.reduce((sum, c) => sum + c.p[axis]!, 0) / 3) as Triple;
const cell = (point: Triple, size: number): Triple =>
  point.map((value) => Math.floor(value / size)) as Triple;
type Comparison = {
  maximum_position_error: number;
  maximum_uv_error: number;
  maximum_normal_error: number;
  matched_faces: number;
};
type MatchContext = { extent: number; position: number; uv: number; normal: number; attempts: number };
function sourceBuckets(faces: UvFace[], size: number): Map<string, number[]> {
  const buckets = new Map<string, number[]>();
  faces.forEach((face, index) => {
    const key = cell(centroid(face), size).join(','),
      list = buckets.get(key) ?? [];
    list.push(index);
    buckets.set(key, list);
  });
  return buckets;
}
function candidates(face: UvFace, buckets: Map<string, number[]>, size: number): number[] {
  const center = cell(centroid(face), size),
    result: number[] = [];
  for (let x = -1; x <= 1; x++)
    for (let y = -1; y <= 1; y++)
      for (let z = -1; z <= 1; z++)
        result.push(...(buckets.get([center[0] + x, center[1] + y, center[2] + z].join(',')) ?? []));
  return result;
}
function matchFace(face: UvFace, source: UvFace, context: MatchContext): Comparison | undefined {
  for (let shift = 0; shift < 3; shift++) {
    if (++context.attempts > 1_000_000)
      return fail('UV surface correspondence exceeds the verification work limit.');
    const errors = face.map((corner, i) => {
      const expected = source[(i + shift) % 3]!;
      return {
        p: vec3.distance(corner.p, expected.p),
        uv: Math.hypot(corner.uv[0] - expected.uv[0], corner.uv[1] - expected.uv[1]),
        n: vec3.distance(corner.n, expected.n),
      };
    });
    if (errors.every((e) => e.p <= context.position && e.uv <= context.uv && e.n <= context.normal))
      return {
        maximum_position_error: Math.max(...errors.map((e) => e.p)),
        maximum_uv_error: Math.max(...errors.map((e) => e.uv)),
        maximum_normal_error: Math.max(...errors.map((e) => e.n)),
        matched_faces: 1,
      };
  }
}
const emptyComparison = (): Comparison => ({
  maximum_position_error: 0,
  maximum_uv_error: 0,
  maximum_normal_error: 0,
  matched_faces: 0,
});
function addComparison(total: Comparison, next: Comparison): void {
  total.maximum_position_error = Math.max(total.maximum_position_error, next.maximum_position_error);
  total.maximum_uv_error = Math.max(total.maximum_uv_error, next.maximum_uv_error);
  total.maximum_normal_error = Math.max(total.maximum_normal_error, next.maximum_normal_error);
  total.matched_faces += next.matched_faces;
}
function comparePart(source: UvPart, faces: UvFace[], context: MatchContext): Comparison | undefined {
  const size = context.position * 2,
    buckets = sourceBuckets(source.faces, size),
    used = new Set<number>(),
    total = emptyComparison();
  for (const face of faces) {
    let found = false;
    for (const index of candidates(face, buckets, size)) {
      if (used.has(index)) continue;
      const match = matchFace(face, source.faces[index]!, context);
      if (!match) continue;
      addComparison(total, match);
      used.add(index);
      found = true;
      break;
    }
    if (!found) return;
  }
  if (used.size === source.faces.length) return total;
}
/** 按完整有向表面建立唯一部件对应；不能靠近似名称、顺序或单个面的匹配恢复多个mesh。 */
function compareParts(source: UvSurface, imported: UvSurface, proof: UvImportSource) {
  if (source.parts.length !== imported.parts.length)
    return fail('The native import changed the number of UV triangle primitives.');
  const context: MatchContext = {
      extent: proof.normalization_extent,
      position: proof.normalization_extent * 1e-4,
      uv: 0.00025,
      normal: 0.01,
      attempts: 0,
    },
    total = emptyComparison(),
    used = new Set<number>(),
    mapping: Array<{ source: number; imported: number }> = [];
  for (const [targetIndex, target] of imported.parts.entries()) {
    const faces = target.faces.map(
        (face) =>
          face.map((corner) => ({
            ...corner,
            p: corner.p.map(
              (value, axis) => value * proof.normalization_extent + proof.normalization_center[axis]!,
            ) as Triple,
          })) as UvFace,
      ),
      matches: Array<{ source: number; comparison: Comparison }> = [];
    for (const [sourceIndex, part] of source.parts.entries()) {
      if (part.material !== target.material || part.faces.length !== target.faces.length) continue;
      const comparison = comparePart(part, faces, context);
      if (comparison) matches.push({ source: sourceIndex, comparison });
    }
    const match = matches[0];
    if (!match)
      return fail('The imported compressed result changed an oriented geometry/UV/normal/material surface.');
    if (matches.length !== 1 || used.has(match.source))
      return fail(
        'Independent UV meshes need unique complete surface correspondence; ambiguous or merged parts cannot restore names.',
      );
    used.add(match.source);
    mapping.push({ source: match.source, imported: targetIndex });
    addComparison(total, match.comparison);
  }
  return {
    comparison: {
      position_tolerance: context.position,
      uv_tolerance: context.uv,
      normal_tolerance: context.normal,
      ...total,
    },
    mapping,
  };
}
/** 仅按来源包围盒的固定逆归一化还原坐标；所有有向面必须独立匹配，不能对输出拟合变换。 */
export async function verifyUvImport(
  sourceBytes: Buffer,
  importedBytes: Buffer,
): Promise<{ bytes: Buffer; proof: Record<string, unknown> }> {
  try {
    const source = await readUvSurface(sourceBytes),
      imported = await readUvSurface(importedBytes),
      sourceState = boundsProof(sourceBytes, source.bounds, source.triangles, source.vertices),
      meshopt = await verifyNativeMeshopt(importedBytes);
    const importedExtent = Math.max(...imported.bounds.max.map((v, i) => v - imported.bounds.min[i]!));
    if (
      Math.abs(importedExtent - 1) > 1e-4 ||
      imported.bounds.min.some((v, i) => Math.abs(v + imported.bounds.max[i]!) > 1e-4)
    )
      return fail('The native importer did not produce the verified centered unit normalization.');
    const { comparison, mapping } = compareParts(source, imported, sourceState),
      delta = mat4.fromScaling(mat4.create(), [
        sourceState.normalization_extent,
        sourceState.normalization_extent,
        sourceState.normalization_extent,
      ]);
    delta[12] = sourceState.normalization_center[0];
    delta[13] = sourceState.normalization_center[1];
    delta[14] = sourceState.normalization_center[2];
    for (const entry of mapping) {
      const target = imported.parts[entry.imported]!,
        original = source.parts[entry.source]!;
      target.node.matrix = Array.from(mat4.multiply(mat4.create(), delta, target.nodeMatrix));
      for (const key of ['translation', 'rotation', 'scale']) delete target.node[key];
      for (const [destination, input] of [
        [target.node, original.node],
        [target.mesh, original.mesh],
      ]) {
        if (input!.name === undefined) delete destination!.name;
        else destination!.name = input!.name;
      }
    }
    const regrouped =
      source.parts.length !== array(source.json.nodes).length ||
      imported.parts.length !== array(imported.json.nodes).length;
    if (regrouped) restoreUvPrimitiveGroups(source, imported, mapping, delta);
    const bytes = writeUvGlb(imported.json, imported.binary);
    await verifyNativeMeshopt(bytes);
    return {
      bytes,
      proof: {
        version: 1,
        source: sourceState,
        imported_sha256: hash(importedBytes),
        imported_bytes: importedBytes.length,
        sha256: hash(bytes),
        bytes: bytes.length,
        imported_binary_sha256: hash(imported.binary),
        original_compressed_binary_preserved: true,
        delta: Array.from(delta),
        meshopt,
        ...comparison,
        ...(mapping.length > 1
          ? { independent_meshes: array(source.json.nodes).length, part_correspondence: mapping }
          : {}),
        ...(regrouped
          ? { restored_primitive_groups: true, source_meshes: array(source.json.meshes).length }
          : {}),
        processing:
          'Native Studio UV and import compression followed by verified local root-transform, name and primitive-group restoration; no local geometry encoding',
      },
    };
  } catch (error) {
    throw new TripoError(
      'UV_COMPRESSION_REQUIREMENT_FAILED',
      error instanceof TripoError ? error.message : 'The original imported UV output could not be verified.',
      'read',
    );
  }
}
