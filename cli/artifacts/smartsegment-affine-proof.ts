/** 两段原生TRS和原生merge的只读证明；最终始终与原始A(P)比较，不累加误差额度。 */
import { createHash } from 'node:crypto';
import { validateGlb } from '../../studio/files.ts';
import { array, object, TripoError } from '../../studio/contracts/errors.ts';
import { modelIO } from '../local/gltf.ts';
import { fingerprint } from '../core/fingerprint.ts';
import {
  checkedSmartSegmentAffine,
  decomposeSmartSegmentAffine,
  smartSegmentAffineTolerance,
} from './smartsegment-affine-decomposition.ts';
import {
  inspectSmartSegmentScaleReference,
  inspectSmartSegmentScaleSource,
  readSmartSegmentGeometry,
  matchSmartSegmentGeometry,
  smartSegmentGeometryPoint,
  smartSegmentGeometryBounds,
  type SmartSegmentFace,
  type SmartSegmentGeometry,
} from './smartsegment-scale-proof.ts';
import {
  scaleReferenceAppearance,
  scaleReferenceWorld,
  validateScaleReferenceShape,
} from './smartsegment-scale-reference.ts';

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const fail = (message: string): never => {
  throw new TripoError('SMARTSEGMENT_TRANSFORM_UNVERIFIED', message, 'not_submitted');
};
// 冻结每次异步验证开始时的全部原件；不能在中途接受调用方替换的另一份有效模型。
function bindOriginals(...buffers: Buffer[]): () => void {
  const hashes = buffers.map(sha256);
  return () => {
    if (buffers.some((bytes, index) => sha256(bytes) !== hashes[index]))
      fail('An original native affine model changed during verification.');
  };
}
const attributeScope =
  'The native two-TRS/merge chain can recalculate normals, repack or omit UVs, change scalar materials and re-encode textures. This proof verifies every original transformed oriented triangle within the original fixed 4e-5 bound, with finite normals and valid optional UVs. It does not claim source appearance or attribute preservation, does not accumulate stage tolerances, and does not edit native model bytes.';
function transformed(data: SmartSegmentGeometry, matrix: number[]): SmartSegmentFace[] {
  return data.faces.map(
    (face) => face.map((point) => smartSegmentGeometryPoint(point, matrix)) as SmartSegmentFace,
  );
}
function corners(faces: SmartSegmentFace[]): string {
  const bytes = Buffer.alloc(faces.length * 72);
  let at = 0;
  for (const face of faces)
    for (const point of face)
      for (const value of point) {
        bytes.writeDoubleLE(value, at);
        at += 8;
      }
  return sha256(bytes);
}
async function nativeGeometry(bytes: Buffer, allowMissingUv = false) {
  const digest = sha256(bytes),
    json = validateGlb(bytes);
  validateScaleReferenceShape(json);
  const data = await readSmartSegmentGeometry(bytes, allowMissingUv),
    root = (await (await modelIO()).readBinary(bytes)).getRoot(),
    nodes = array(json.nodes).map(object),
    appearance = root.listNodes().map((node, index) => {
      scaleReferenceWorld(node, nodes[index]!);
      return { node_name: node.getName(), ...scaleReferenceAppearance(node.getMesh()!.listPrimitives()[0]!) };
    });
  if (sha256(bytes) !== digest) return fail('Native affine model bytes changed while being inspected.');
  return { ...data, sha256: digest, bytes: bytes.length, appearance };
}
interface AffinePreparation extends Record<string, unknown> {
  version: 1;
  source_sha256: string;
  source_bytes: number;
  source_inspection: Record<string, unknown>;
  transform_matrix: number[];
  first_matrix: number[];
  second_matrix: number[];
}
export async function prepareSmartSegmentAffine(
  original: Buffer,
  matrix: unknown,
): Promise<AffinePreparation> {
  const selectedMatrix = checkedSmartSegmentAffine(matrix).matrix,
    digest = sha256(original),
    source_inspection = await inspectSmartSegmentScaleSource(original),
    source = await nativeGeometry(original),
    factors = decomposeSmartSegmentAffine(selectedMatrix, source.faces.flat()),
    first = transformed(source, factors.first_matrix),
    final = transformed(source, factors.matrix);
  // 提交前排除原源或预定坐标中无法逐面唯一对应的重叠/极近面。
  for (const faces of [source.faces, first, final])
    matchSmartSegmentGeometry(faces, faces, smartSegmentAffineTolerance);
  if (sha256(original) !== digest)
    return fail('The original affine source changed before preparation completed.');
  return {
    version: 1,
    kind:
      factors.family === 'general'
        ? 'general_affine_two_native_trs'
        : factors.family
          ? 'axis_shear_two_native_trs'
          : 'xy_shear_two_native_trs',
    ...(factors.family ? { family: factors.family } : {}),
    source_sha256: digest,
    source_bytes: original.length,
    source_inspection,
    transform_matrix: factors.matrix,
    ...(factors.family === 'general' ? {} : { k: factors.k }),
    first_matrix: factors.first_matrix,
    second_matrix: factors.second_matrix,
    tolerance: { position: smartSegmentAffineTolerance },
    source_corner_sha256: corners(source.faces),
    first_expected_corner_sha256: corners(first),
    final_expected_corner_sha256: corners(final),
    first_expected_bounds: smartSegmentGeometryBounds(first.flat()),
    final_expected_bounds: smartSegmentGeometryBounds(final.flat()),
    uses_geometry_fit: false,
    intermediate_normalization:
      'Only the original source determines the first centered unit representation; the second frozen TRS cancels it algebraically. No output normalization or fitting is permitted.',
    native_attribute_scope: attributeScope,
  };
}
async function checkedPreparation(
  original: Buffer,
  value: Record<string, unknown>,
): Promise<AffinePreparation> {
  const expected = await prepareSmartSegmentAffine(original, value.transform_matrix);
  if (fingerprint(expected) !== fingerprint(value))
    return fail('The original affine preparation, factorization or fixed geometry contract changed.');
  return expected;
}
function geometryProof(
  source: Awaited<ReturnType<typeof nativeGeometry>>,
  matrix: number[],
  output: Awaited<ReturnType<typeof nativeGeometry>>,
): Record<string, unknown> {
  const expected = transformed(source, matrix),
    match = matchSmartSegmentGeometry(expected, output.faces, smartSegmentAffineTolerance);
  return {
    version: 1,
    source_sha256: source.sha256,
    source_bytes: source.bytes,
    sha256: output.sha256,
    bytes: output.bytes,
    transform_matrix: matrix,
    matched_oriented_faces: match.matched,
    maximum_position_error: match.maximum,
    tolerance: { position: smartSegmentAffineTolerance },
    parts: output.parts,
    bounds: output.bounds,
    expected_bounds: smartSegmentGeometryBounds(expected.flat()),
    expected_corner_sha256: corners(expected),
    appearance: output.appearance,
    uses_geometry_fit: false,
    native_result_modified: false,
    native_attribute_scope: attributeScope,
  };
}
function projectedFinalPreflight(
  source: Awaited<ReturnType<typeof nativeGeometry>>,
  prepared: AffinePreparation,
  merged: Awaited<ReturnType<typeof nativeGeometry>>,
): Record<string, unknown> {
  const expected = transformed(source, prepared.transform_matrix),
    projected = transformed(merged, prepared.second_matrix),
    match = matchSmartSegmentGeometry(expected, projected, smartSegmentAffineTolerance);
  return {
    version: 1,
    kind: 'projected_final_preflight',
    source_sha256: source.sha256,
    source_bytes: source.bytes,
    merged_sha256: merged.sha256,
    merged_bytes: merged.bytes,
    transform_matrix: prepared.transform_matrix,
    second_matrix: prepared.second_matrix,
    matched_oriented_faces: match.matched,
    maximum_position_error: match.maximum,
    tolerance: { position: smartSegmentAffineTolerance },
    expected_bounds: smartSegmentGeometryBounds(expected.flat()),
    projected_bounds: smartSegmentGeometryBounds(projected.flat()),
    expected_corner_sha256: corners(expected),
    projected_corner_sha256: corners(projected),
    actual_final_output_verified: false,
    uses_geometry_fit: false,
    native_result_modified: false,
    obligation:
      'Only a preflight of the frozen second TRS on the exact merged native coordinates against original A(P), in final-coordinate units. No final native result is represented. The actual final bytes must still independently pass original A(P) and M2(merged) at the unchanged fixed 4e-5 bound.',
  };
}
function mergeName(source: Record<string, unknown>, first: SmartSegmentGeometry): string {
  const used = new Set([String(source.node_name), ...first.parts.map((part) => part.name)]),
    prefix = 'ai_modeling_affine_stage1';
  if (!used.has(prefix)) return prefix;
  for (let i = 0; i <= 64; i++) {
    const name = `${prefix}_${String(source.sha256).slice(0, 12)}_${i}`;
    if (!used.has(name)) return name;
  }
  return fail('No unique original mesh name is available for the native affine merge.');
}
export async function prepareSmartSegmentAffineMerge(
  original: Buffer,
  preparation: Record<string, unknown>,
  firstNative: Buffer,
): Promise<Record<string, unknown>> {
  const unchanged = bindOriginals(original, firstNative),
    prepared = await checkedPreparation(original, preparation),
    first_inspection = await inspectSmartSegmentScaleReference(firstNative),
    source = await nativeGeometry(original),
    first = await nativeGeometry(firstNative),
    proof = geometryProof(source, prepared.first_matrix, first),
    name = mergeName(prepared.source_inspection, first);
  unchanged();
  return {
    version: 1,
    preparation: fingerprint(prepared),
    source_sha256: source.sha256,
    source_bytes: source.bytes,
    first_sha256: first.sha256,
    first_bytes: first.bytes,
    first_inspection,
    first_geometry: proof,
    merge_name: name,
    part_indices: Object.fromEntries(
      first.parts.map((part) => [part.name, Array<number>(part.faces).fill(0)]),
    ),
    part_indices_name: { '0': name },
    metadata_name_check:
      'Before submitting, also reject a merge name already present in the exact current metadata keys; never clear or rename existing metadata implicitly.',
  };
}
export async function verifySmartSegmentAffineMerge(
  original: Buffer,
  preparation: Record<string, unknown>,
  firstNative: Buffer,
  mergedNative: Buffer,
): Promise<Record<string, unknown>> {
  const unchanged = bindOriginals(original, firstNative, mergedNative),
    prepared = await checkedPreparation(original, preparation),
    merge = await prepareSmartSegmentAffineMerge(original, prepared, firstNative),
    merged_inspection = await inspectSmartSegmentScaleSource(mergedNative),
    source = await nativeGeometry(original),
    first = await nativeGeometry(firstNative),
    merged = await nativeGeometry(mergedNative);
  if (merged.parts.length !== 1 || merged.parts[0]!.name !== merge.merge_name)
    return fail(
      'The native affine merge must keep one complete centered unit primitive under its fresh original name.',
    );
  const first_native_preserved = geometryProof(first, identity, merged),
    proof =
      prepared.family === 'general'
        ? {
            version: 1,
            kind: 'general_affine_merge_projected_preflight',
            source_sha256: source.sha256,
            source_bytes: source.bytes,
            sha256: merged.sha256,
            bytes: merged.bytes,
            parts: merged.parts,
            bounds: merged.bounds,
            appearance: merged.appearance,
            uses_geometry_fit: false,
            native_result_modified: false,
            native_attribute_scope: attributeScope,
            projected_final_geometry: projectedFinalPreflight(source, prepared, merged),
          }
        : geometryProof(source, prepared.first_matrix, merged);
  unchanged();
  return {
    ...proof,
    stage: 'native_affine_merge',
    preparation: fingerprint(prepared),
    first_sha256: first.sha256,
    first_bytes: first.bytes,
    first_geometry: merge.first_geometry,
    merged_sha256: merged.sha256,
    merged_bytes: merged.bytes,
    merged_inspection,
    merge_name: merge.merge_name,
    first_native_preserved,
  };
}
export async function verifySmartSegmentAffineOutput(
  original: Buffer,
  matrix: unknown,
  firstNative: Buffer,
  mergedNative: Buffer,
  finalNative: Buffer,
): Promise<Record<string, unknown>> {
  const unchanged = bindOriginals(original, firstNative, mergedNative, finalNative),
    prepared = await prepareSmartSegmentAffine(original, matrix),
    merge = await verifySmartSegmentAffineMerge(original, prepared, firstNative, mergedNative),
    source = await nativeGeometry(original),
    merged = await nativeGeometry(mergedNative),
    final = await nativeGeometry(finalNative, true),
    proof = geometryProof(source, prepared.transform_matrix, final),
    second_native_geometry = geometryProof(merged, prepared.second_matrix, final);
  // 每次交付绑定全部原生中间件；旧第二段M2证明不能替代原始A(P)义务。
  if (sha256(firstNative) !== merge.first_sha256 || sha256(mergedNative) !== merge.merged_sha256)
    return fail('The original native affine intermediates changed during final verification.');
  unchanged();
  return {
    ...proof,
    stage: 'native_affine_final',
    preparation: fingerprint(prepared),
    first_matrix: prepared.first_matrix,
    second_matrix: prepared.second_matrix,
    first_sha256: merge.first_sha256,
    first_bytes: merge.first_bytes,
    merged_sha256: merge.merged_sha256,
    merged_bytes: merge.merged_bytes,
    merge_name: merge.merge_name,
    first_geometry: merge.first_geometry,
    merge_geometry: merge,
    second_native_geometry,
    accumulated_tolerance_used: false,
  };
}

// 新原生路线共享同一固定几何原语；旧七步准备和证明对象保持原形状。
export {
  bindOriginals as bindAffineBytes,
  nativeGeometry as nativeAffineGeometry,
  transformed as transformAffineGeometry,
  corners as affineCornerHash,
  geometryProof as affineGeometryProof,
};
