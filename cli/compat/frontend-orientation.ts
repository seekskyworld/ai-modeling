/** 同源真实四向产物表明网页 worker 的 ±X 枚举与原生导出相反；仅新兼容意图采用映射。 */
import { object } from '../../studio/contracts/errors.ts';

export type ConvertOrientation = '+x' | '-x' | '+y' | '-y';
export interface FrontendOrientationMapping {
  version: 1;
  reference: 'studio_native_export';
  export_orientation: ConvertOrientation;
  forward_axis: ConvertOrientation;
}

export function frontendOrientationMapping(axis: ConvertOrientation): FrontendOrientationMapping {
  return {
    version: 1,
    reference: 'studio_native_export',
    export_orientation: axis,
    forward_axis: axis === '+x' ? '-x' : axis === '-x' ? '+x' : axis,
  };
}

/** 严格冻结版本和两端枚举，避免后来读取时把旧证明静默解释为新方向。 */
export function isFrontendOrientationMapping(
  value: unknown,
  axis: unknown,
): value is FrontendOrientationMapping {
  if (typeof axis !== 'string' || !['+x', '-x', '+y', '-y'].includes(axis)) return false;
  const mapping = object(value),
    expected = frontendOrientationMapping(axis as ConvertOrientation);
  return (
    Object.keys(mapping).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, entry]) => mapping[key] === entry)
  );
}

/** 输入意图、实际引擎元数据和新映射必须同时吻合；历史证明完全不经过此新分支。 */
export function frontendOrientationProofMatches(
  proof: Record<string, unknown>,
  mapping: FrontendOrientationMapping,
): boolean {
  return (
    isFrontendOrientationMapping(mapping, mapping.export_orientation) &&
    proof.version === 2 &&
    object(proof.input).forward_axis === mapping.forward_axis &&
    object(object(proof.conversion).metadata).forward_axis === mapping.forward_axis
  );
}
