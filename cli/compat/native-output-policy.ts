/** 官方压缩意图由网页原生产物满足；独立冻结约束，不能静默丢字段或事后替旧任务加保证。 */
import { TripoError } from '../../studio/contracts/errors.ts';
import { supportsNativeMeshopt } from '../core/native-output-policy.ts';
export { nativeMeshoptRequested, freezeNativeOutputPolicy } from '../core/native-output-policy.ts';

/** 此处只约束单步原生产物；UV压缩使用独立的导入组合与表面证明，Quad和再次导出不据此放行。 */
export function takeNativeMeshopt(input: Record<string, unknown>, operation: string): boolean {
  if (input.compress === undefined) return false;
  if (input.compress !== 'geometry')
    throw new TripoError('INVALID_INPUT', 'compress must be geometry.', 'not_submitted');
  if (!supportsNativeMeshopt(operation) || input.quad === true)
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      'Native Meshopt compression is verified only for non-quad model generation, texture and P2 local edit GLB results. No local compression fallback is used.',
      'not_submitted',
    );
  delete input.compress;
  return true;
}

export const nativeMeshoptWarning =
  'compress=geometry requires the native Studio GLB geometry to use Meshopt. Results are checked before success, including an internal artifact read with --no-download; no local compression is applied.';
