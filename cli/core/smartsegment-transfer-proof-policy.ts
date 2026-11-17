/** 校验持久证明的全部几何义务；签名或末段成功不能替代原A(P)。 */
import { array, object, text } from '../../studio/contracts/errors.ts';
import { fingerprint } from './fingerprint.ts';
import { transferFail } from './smartsegment-transfer-contract.ts';
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const equal = (a: unknown, b: unknown): boolean => fingerprint(a) === fingerprint(b);
const bounded = (value: unknown, limit: number): boolean =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= limit;
export function completeTransferSelector(
  value: unknown,
  source: Record<string, unknown>,
  nodeName: unknown,
): boolean {
  const proof = object(value),
    probe = object(proof.probe),
    instances = array(probe.instances),
    item = object(instances[0]);
  return (
    proof.version === 1 &&
    proof.sha256 === source.sha256 &&
    proof.bytes === source.bytes &&
    typeof nodeName === 'string' &&
    nodeName.length > 0 &&
    proof.selector === nodeName &&
    probe.version === 1 &&
    probe.scene === 0 &&
    probe.before_deletions === 1 &&
    probe.entity_count === 0 &&
    instances.length === 1 &&
    item.node === 0 &&
    item.mesh === 0 &&
    item.primitive === 0 &&
    item.name === nodeName &&
    item.deleted === true
  );
}
export function completeTransferGeometry(
  value: unknown,
  source: Record<string, unknown>,
  output: Record<string, unknown>,
  matrix: unknown,
  faces: number,
): boolean {
  const p = object(value);
  return (
    p.version === 1 &&
    p.source_sha256 === source.sha256 &&
    p.source_bytes === source.bytes &&
    p.sha256 === output.sha256 &&
    p.bytes === output.bytes &&
    /^[a-f0-9]{64}$/.test(text(p.sha256)) &&
    Number.isSafeInteger(p.bytes) &&
    Number(p.bytes) > 0 &&
    equal(p.transform_matrix, matrix) &&
    p.matched_oriented_faces === faces &&
    bounded(p.maximum_position_error, 4e-5) &&
    equal(p.tolerance, { position: 4e-5 }) &&
    p.uses_geometry_fit === false &&
    p.native_result_modified === false &&
    array(p.parts).length > 0 &&
    array(p.parts).reduce<number>((sum, part) => sum + Number(object(part).faces), 0) === faces
  );
}
function completeImportAttributes(
  p: Record<string, unknown>,
  source: Record<string, unknown>,
  faces: number,
): boolean {
  const a = object(p.import_attributes);
  return (
    a.version === 1 &&
    a.source_sha256 === source.sha256 &&
    a.source_bytes === source.bytes &&
    a.imported_sha256 === p.sha256 &&
    a.imported_bytes === p.bytes &&
    a.matched_oriented_faces === faces &&
    bounded(a.maximum_position_error, 4e-5) &&
    bounded(a.maximum_normal_error, 0.01) &&
    bounded(a.maximum_uv_error, 4e-5) &&
    a.unchanged_material_and_texture === true &&
    equal(a.tolerance, { position: 4e-5, normal: 0.01, uv: 4e-5, normalization: 4e-5 })
  );
}
function completeProjection(
  p: Record<string, unknown>,
  source: Record<string, unknown>,
  prep: Record<string, unknown>,
  faces: number,
): boolean {
  const q = object(p.projected_final_geometry);
  return (
    q.version === 1 &&
    q.kind === 'projected_final_preflight' &&
    q.source_sha256 === source.sha256 &&
    q.source_bytes === source.bytes &&
    q.imported_sha256 === p.sha256 &&
    q.imported_bytes === p.bytes &&
    equal(q.transform_matrix, prep.transform_matrix) &&
    equal(q.second_matrix, prep.second_matrix) &&
    q.matched_oriented_faces === faces &&
    bounded(q.maximum_position_error, 4e-5) &&
    equal(q.tolerance, { position: 4e-5 }) &&
    q.expected_corner_sha256 === prep.final_expected_corner_sha256 &&
    equal(q.expected_bounds, prep.final_expected_bounds) &&
    /^[a-f0-9]{64}$/.test(text(q.projected_corner_sha256)) &&
    q.actual_final_output_verified === false &&
    q.uses_geometry_fit === false &&
    q.native_result_modified === false
  );
}
function completeInspection(
  p: Record<string, unknown>,
  source: Record<string, unknown>,
  faces: number,
): boolean {
  const inspection = object(p.imported_inspection),
    part = object(array(p.parts)[0]);
  return (
    inspection.sha256 === p.sha256 &&
    inspection.bytes === p.bytes &&
    inspection.faces === faces &&
    typeof inspection.node_name === 'string' &&
    inspection.node_name.length > 0 &&
    array(p.parts).length === 1 &&
    part.name === inspection.node_name &&
    part.faces === faces &&
    array(part.world_matrix).length === 16 &&
    array(part.world_matrix).every((v, i) => typeof v === 'number' && Math.abs(v - identity[i]!) <= 1e-7) &&
    bounded(Math.abs(Number(inspection.extent) - 1), 4e-5) &&
    array(inspection.center).length === 3 &&
    array(inspection.center).every((v) => typeof v === 'number' && bounded(Math.abs(v), 4e-5)) &&
    equal(inspection.appearance, object(object(source.preparation).source_inspection).appearance)
  );
}
export function assertTransferImportProof(
  p: Record<string, unknown>,
  source: Record<string, unknown>,
  prep: Record<string, unknown>,
): void {
  const faces = Number(object(prep.source_inspection).faces);
  if (
    !Number.isSafeInteger(faces) ||
    faces <= 0 ||
    p.stage !== 'native_affine_transfer_import' ||
    p.preparation !== fingerprint(prep) ||
    !equal(p.import_matrix, prep.import_matrix) ||
    !completeTransferGeometry(p, source, p, prep.first_matrix, faces) ||
    p.expected_corner_sha256 !== prep.import_expected_corner_sha256 ||
    !equal(p.expected_bounds, prep.import_expected_bounds) ||
    !completeImportAttributes(p, source, faces) ||
    !completeProjection(p, source, prep, faces) ||
    !completeInspection(p, source, faces) ||
    !completeTransferSelector(p.imported_loader_selector, p, object(p.imported_inspection).node_name)
  )
    return transferFail('The complete original rotation-import proof is missing or changed.');
}
export function assertTransferFinalProof(
  p: Record<string, unknown>,
  source: Record<string, unknown>,
  prep: Record<string, unknown>,
  imported: Record<string, unknown>,
  importGeometry: Record<string, unknown>,
): void {
  const faces = Number(object(prep.source_inspection).faces);
  assertTransferImportProof(importGeometry, source, prep);
  if (
    p.stage !== 'native_affine_transfer_final' ||
    p.mechanism !== 'pure_rotation_import' ||
    p.preparation !== fingerprint(prep) ||
    p.imported_sha256 !== imported.sha256 ||
    p.imported_bytes !== imported.bytes ||
    !equal(p.import_matrix, prep.import_matrix) ||
    !equal(p.first_matrix, prep.first_matrix) ||
    !equal(p.second_matrix, prep.second_matrix) ||
    !equal(p.import_geometry, importGeometry) ||
    !completeTransferGeometry(p, source, p, prep.transform_matrix, faces) ||
    !completeTransferGeometry(p.second_native_geometry, imported, p, prep.second_matrix, faces) ||
    p.expected_corner_sha256 !== prep.final_expected_corner_sha256 ||
    !equal(p.expected_bounds, prep.final_expected_bounds) ||
    p.accumulated_tolerance_used !== false ||
    p.actual_final_output_verified !== true
  )
    return transferFail(
      'The original A(P), actual B2(import) or complete rotation-import obligations changed.',
    );
}
