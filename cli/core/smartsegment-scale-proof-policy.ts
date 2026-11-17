/** 原件证明内容也必须完整：身份摘要不能代替矩阵、全量面、误差和不改写声明。 */
import { object } from '../../studio/contracts/errors.ts';
import { checkedMetadataTransform } from '../artifacts/smartsegment-transform-matrix.ts';
import { fingerprint } from './fingerprint.ts';

const finiteVector = (value: unknown, size: number): value is number[] =>
  Array.isArray(value) &&
  value.length === size &&
  value.every((v) => typeof v === 'number' && Number.isFinite(v));
const count = (value: unknown, maximum: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum;
function finiteBounds(value: unknown): boolean {
  const bounds = object(value);
  return (
    finiteVector(bounds.min, 3) &&
    finiteVector(bounds.max, 3) &&
    bounds.min.every((v, i) => v <= (bounds.max as number[])[i]!)
  );
}
function completeParts(value: unknown, faces: number): boolean {
  if (!Array.isArray(value) || !value.length || value.length > 64) return false;
  let totalFaces = 0,
    totalVertices = 0;
  for (const valuePart of value) {
    const part = object(valuePart),
      matrix = part.world_matrix;
    if (
      typeof part.name !== 'string' ||
      !count(part.faces, 25000) ||
      !count(part.vertices, 100000) ||
      !finiteVector(matrix, 16) ||
      matrix[3] !== 0 ||
      matrix[7] !== 0 ||
      matrix[11] !== 0 ||
      matrix[15] !== 1 ||
      !finiteBounds(part.bounds)
    )
      return false;
    totalFaces += part.faces;
    totalVertices += part.vertices;
  }
  return totalFaces === faces && totalVertices <= 100000;
}
export function completeScaleOutputProof(
  proof: Record<string, unknown>,
  source: Record<string, unknown>,
  intent: Record<string, unknown>,
): boolean {
  const { matrix, tolerance } = checkedMetadataTransform(intent.matrix),
    faces = object(source.inspection).faces,
    maximum = proof.maximum_position_error;
  return (
    proof.version === 1 &&
    proof.source_bytes === source.bytes &&
    /^[0-9a-f]{64}$/.test(String(proof.sha256)) &&
    count(proof.bytes, 300 * 1024 * 1024) &&
    count(faces, 25000) &&
    proof.matched_oriented_faces === faces &&
    fingerprint(proof.transform_matrix) === fingerprint(matrix) &&
    fingerprint(proof.tolerance) === fingerprint({ position: tolerance }) &&
    typeof maximum === 'number' &&
    Number.isFinite(maximum) &&
    maximum >= 0 &&
    maximum <= tolerance &&
    proof.uses_geometry_fit === false &&
    proof.native_result_modified === false &&
    typeof proof.native_attribute_scope === 'string' &&
    Boolean(proof.native_attribute_scope) &&
    finiteBounds(proof.bounds) &&
    finiteBounds(proof.expected_bounds) &&
    completeParts(proof.parts, faces)
  );
}
