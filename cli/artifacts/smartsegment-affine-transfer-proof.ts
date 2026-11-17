/** 原字节纯旋转导入→B2 metadata→ordinary；最终独立证明原A(P)与B2(实际导入)。 */
import { mat4 } from 'gl-matrix';
import { fingerprint } from '../core/fingerprint.ts';
import { TripoError, text } from '../../studio/contracts/errors.ts';
import { createHash } from 'node:crypto';
import { inspectSegmentEntityCount } from './segment-entity-count.ts';
import { checkedMetadataTransform } from './smartsegment-transform-matrix.ts';
import { verifySmartSegmentTransformedImport } from './smartsegment-transform-proof.ts';
import {
  inspectSmartSegmentScaleSource,
  matchSmartSegmentGeometry,
  smartSegmentGeometryBounds,
} from './smartsegment-scale-proof.ts';
import {
  prepareSmartSegmentAffine,
  bindAffineBytes,
  nativeAffineGeometry,
  transformAffineGeometry,
  affineCornerHash,
  affineGeometryProof,
} from './smartsegment-affine-proof.ts';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const fail = (message: string): never => {
  throw new TripoError('SMARTSEGMENT_TRANSFER_UNVERIFIED', message, 'not_submitted');
};
const attributeScope =
  'The original pure-rotation import preserves every oriented face, source inverse-transpose normal within 0.01, UV within 4e-5 and complete embedded texture/material appearance. Native final segmentation may recalculate normals, repack or omit UVs, change scalar materials and re-encode textures. Final verification requires all original A(P) and B2(actual import) faces separately at fixed 4e-5, without accumulated tolerance, fitting or native-byte edits. It does not claim final source-attribute or semantic preservation.';
export interface TransferPreparation extends Record<string, unknown> {
  version: 1;
  kind: 'pure_rotation_import_affine';
  mechanism: 'pure_rotation_import';
  source_sha256: string;
  source_bytes: number;
  source_inspection: Record<string, unknown>;
  transform_matrix: number[];
  first_matrix: number[];
  second_matrix: number[];
  import_matrix: number[];
  import_normalization_matrix: number[];
}

/** 原node名必须仍是网页loader中的唯一对象名；这里只探测选择器，不删除任何对象。 */
async function loaderSelector(bytes: Buffer, nodeName: string): Promise<Record<string, unknown>> {
  const probe = await inspectSegmentEntityCount(bytes, [nodeName]);
  if (
    probe.before_deletions !== 1 ||
    probe.entity_count !== 0 ||
    probe.instances.length !== 1 ||
    probe.instances[0]!.name !== nodeName ||
    !probe.instances[0]!.deleted
  )
    return fail('The native metadata selector does not identify exactly one original loader entity.');
  return {
    version: 1,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    selector: nodeName,
    probe,
  };
}
async function optionalSourceSelector(bytes: Buffer, nodeName: string) {
  try {
    return await loaderSelector(bytes, nodeName);
  } catch (error) {
    if (error instanceof TripoError && error.code === 'SEGMENT_ENTITY_UNSUPPORTED') return;
    throw error;
  }
}
export async function prepareNativeAffineTransfer(
  original: Buffer,
  matrix: unknown,
): Promise<TransferPreparation> {
  const unchanged = bindAffineBytes(original),
    previous = await prepareSmartSegmentAffine(original, matrix),
    source = await nativeAffineGeometry(original),
    scales = checkedMetadataTransform(previous.first_matrix).scales,
    rotation = [...identity],
    source_loader_selector = await optionalSourceSelector(
      original,
      text(previous.source_inspection.node_name),
    );
  if (Math.max(...scales) - Math.min(...scales) > 1e-12)
    return fail('The first affine factor must have a positive uniform scale and proper rotation.');
  for (let row = 0; row < 3; row++)
    for (let column = 0; column < 3; column++)
      rotation[row + 4 * column] = previous.first_matrix[row + 4 * column]! / scales[0];
  if (checkedMetadataTransform(rotation).scales.some((scale) => Math.abs(scale - 1) > 1e-12))
    return fail('The native import input must be a pure proper rotation without scale or translation.');
  const rotated = transformAffineGeometry(source, rotation),
    rotatedBounds = smartSegmentGeometryBounds(rotated.flat()),
    extent = Math.max(...rotatedBounds.max.map((v, i) => v - rotatedBounds.min[i]!)),
    normalization = [...identity];
  if (!Number.isFinite(extent) || extent <= 0)
    return fail('The original rotated source has no finite extent.');
  for (let axis = 0; axis < 3; axis++) {
    normalization[axis * 5] = 1 / extent;
    normalization[12 + axis] = -(rotatedBounds.min[axis]! + rotatedBounds.max[axis]!) / (2 * extent);
  }
  const normalized = new Float64Array(16),
    reconstructed = new Float64Array(16);
  mat4.multiply(normalized, normalization, rotation);
  mat4.multiply(reconstructed, previous.second_matrix, normalized);
  if (
    normalized.some((v, i) => Math.abs(v - previous.first_matrix[i]!) > 1e-10) ||
    reconstructed.some((v, i) => Math.abs(v - previous.transform_matrix[i]!) > 1e-10)
  )
    return fail(
      'The source-derived pure-rotation normalization does not reconstruct the original affine target.',
    );
  unchanged();
  return {
    ...previous,
    source_loader_selector,
    kind: 'pure_rotation_import_affine',
    mechanism: 'pure_rotation_import',
    import_matrix: rotation,
    import_normalization_matrix: normalization,
    import_expected_corner_sha256: previous.first_expected_corner_sha256,
    import_expected_bounds: previous.first_expected_bounds,
    rotated_source_bounds: rotatedBounds,
    source_only_normalization: true,
    native_attribute_scope: attributeScope,
  };
}

async function checkedPreparation(
  original: Buffer,
  value: Record<string, unknown>,
): Promise<TransferPreparation> {
  const expected = await prepareNativeAffineTransfer(original, value.transform_matrix);
  if (fingerprint(expected) !== fingerprint(value))
    return fail('The original rotation import preparation or source-derived factors changed.');
  return expected;
}

export async function verifyTransferImport(
  original: Buffer,
  preparation: Record<string, unknown>,
  importedNative: Buffer,
): Promise<Record<string, unknown>> {
  const unchanged = bindAffineBytes(original, importedNative),
    prepared = await checkedPreparation(original, preparation),
    imported_inspection = await inspectSmartSegmentScaleSource(importedNative),
    imported_loader_selector = await loaderSelector(importedNative, text(imported_inspection.node_name)),
    source = await nativeAffineGeometry(original),
    imported = await nativeAffineGeometry(importedNative),
    attributes = await verifySmartSegmentTransformedImport(original, importedNative, prepared.first_matrix),
    proof = affineGeometryProof(source, prepared.first_matrix, imported),
    expected = transformAffineGeometry(source, prepared.transform_matrix),
    projected = transformAffineGeometry(imported, prepared.second_matrix),
    match = matchSmartSegmentGeometry(expected, projected, 4e-5);
  if (
    imported.parts.length !== 1 ||
    imported.parts[0]!.world_matrix.some((v, i) => Math.abs(v - identity[i]!) > 1e-7)
  )
    return fail(
      'The imported affine stage must be one centered unit primitive with an identity native node transform.',
    );
  unchanged();
  return {
    ...proof,
    stage: 'native_affine_transfer_import',
    preparation: fingerprint(prepared),
    imported_inspection,
    imported_loader_selector,
    import_matrix: prepared.import_matrix,
    import_attributes: attributes,
    projected_final_geometry: {
      version: 1,
      kind: 'projected_final_preflight',
      source_sha256: source.sha256,
      source_bytes: source.bytes,
      imported_sha256: imported.sha256,
      imported_bytes: imported.bytes,
      transform_matrix: prepared.transform_matrix,
      second_matrix: prepared.second_matrix,
      matched_oriented_faces: match.matched,
      maximum_position_error: match.maximum,
      tolerance: { position: 4e-5 },
      expected_corner_sha256: affineCornerHash(expected),
      projected_corner_sha256: affineCornerHash(projected),
      expected_bounds: smartSegmentGeometryBounds(expected.flat()),
      projected_bounds: smartSegmentGeometryBounds(projected.flat()),
      actual_final_output_verified: false,
      uses_geometry_fit: false,
      native_result_modified: false,
    },
    native_attribute_scope: attributeScope,
  };
}

export async function verifyTransferOutput(
  original: Buffer,
  preparation: Record<string, unknown>,
  importedNative: Buffer,
  finalNative: Buffer,
): Promise<Record<string, unknown>> {
  const unchanged = bindAffineBytes(original, importedNative, finalNative),
    prepared = await checkedPreparation(original, preparation),
    imported_geometry = await verifyTransferImport(original, prepared, importedNative),
    source = await nativeAffineGeometry(original),
    imported = await nativeAffineGeometry(importedNative),
    final = await nativeAffineGeometry(finalNative, true),
    proof = affineGeometryProof(source, prepared.transform_matrix, final),
    second_native_geometry = affineGeometryProof(imported, prepared.second_matrix, final);
  unchanged();
  return {
    ...proof,
    stage: 'native_affine_transfer_final',
    mechanism: 'pure_rotation_import',
    preparation: fingerprint(prepared),
    import_matrix: prepared.import_matrix,
    first_matrix: prepared.first_matrix,
    second_matrix: prepared.second_matrix,
    imported_sha256: imported.sha256,
    imported_bytes: imported.bytes,
    import_geometry: imported_geometry,
    second_native_geometry,
    accumulated_tolerance_used: false,
    actual_final_output_verified: true,
    native_attribute_scope: attributeScope,
  };
}
