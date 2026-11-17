/** 网页未返回 normalize_scale 时，只从原件固定规则与全部表面对应证明派生元数据。 */
import { TripoError } from '../../studio/contracts/errors.ts';
import { readStaticImportSurface, verifyStaticImportTransform } from './smartsegment-transform-proof.ts';

const fail = (message: string): never => {
  throw new TripoError('IMPORT_NORMALIZATION_UNVERIFIED', message, 'read');
};

export async function inspectImportNormalizationSource(bytes: Buffer): Promise<Record<string, unknown>> {
  try {
    const surface = await readStaticImportSurface(bytes);
    if (!Number.isFinite(surface.extent) || surface.extent < 1e-6 || surface.extent > 1e6)
      return fail('The source extent is outside the verified normalization range.');
    return {
      version: 1,
      source_sha256: surface.sha256,
      source_bytes: surface.bytes,
      source_bounds: { min: surface.min, max: surface.max },
      source_center: surface.center,
      source_extent: surface.extent,
      expected_scale: 1 / surface.extent,
      faces: surface.faces.length,
    };
  } catch (error) {
    if (error instanceof TripoError && error.code === 'IMPORT_NORMALIZATION_UNVERIFIED') throw error;
    return fail(
      'Scale metadata supports one static root triangle mesh with normals, one UV set and a scalar opaque material with at most one embedded base-color JPEG/PNG. This source could not be verified within that scope.',
    );
  }
}

/** 产物只验证预先由原件确定的中心化/单位缩放；不修改字节，不将包围盒比值直接当作证明。 */
export async function verifyImportNormalization(
  sourceBytes: Buffer,
  importedBytes: Buffer,
): Promise<Record<string, unknown>> {
  try {
    const source = await inspectImportNormalizationSource(sourceBytes),
      factor = Number(source.expected_scale),
      center = source.source_center as number[],
      transform = [
        factor,
        0,
        0,
        0,
        0,
        factor,
        0,
        0,
        0,
        0,
        factor,
        0,
        -center[0]! * factor,
        -center[1]! * factor,
        -center[2]! * factor,
        1,
      ],
      proof = await verifyStaticImportTransform(sourceBytes, importedBytes, transform);
    return {
      ...proof,
      normalize_scale: factor,
      provenance: 'derived_from_verified_studio_import',
      source_bounds: source.source_bounds,
      source_center: center,
      source_extent: source.source_extent,
      expected_transform: transform,
      model_bytes_modified: false,
      native_response_field: false,
    };
  } catch (error) {
    if (error instanceof TripoError && error.code === 'IMPORT_NORMALIZATION_UNVERIFIED') throw error;
    return fail(
      'The native import did not uniquely preserve every oriented face, normal, UV, material and texture under the fixed normalization derived from the original source.',
    );
  }
}
