/** 原生产物约束与远端请求分开冻结；CLI 和任务服务共用相同身份，恢复不增加收费步骤。 */
import { TripoError } from '../../studio/contracts/errors.ts';
import type { Job } from '../../studio/contracts/types.ts';
import type { JobStore } from '../storage/jobs.ts';

export const nativeOutputPolicyKey = (request: string): string => `native-output:${request}`;

/** 仅列入已有原生字节实测的操作；每次新产物仍须独立解码，不把样本当上游保证。 */
export function supportsNativeMeshopt(operation: string): boolean {
  return ['model', 'texture', 'local_edit'].includes(operation);
}

export function nativeMeshoptRequested(jobs: JobStore, job: Job): boolean {
  return jobs.requestPolicy(job.account_ref, nativeOutputPolicyKey(job.request_id))?.meshopt === true;
}

export function freezeNativeOutputPolicy(
  jobs: JobStore,
  account: string,
  request: string,
  meshopt: boolean,
): void {
  const key = nativeOutputPolicyKey(request);
  if (meshopt && !jobs.requestPolicy(account, key) && jobs.find(account, request))
    throw new TripoError(
      'IDEMPOTENCY_CONFLICT',
      'This existing task did not freeze a native compression requirement. Recover its original result; use a new request for compress=geometry.',
      'not_submitted',
    );
  jobs.bindRequestPolicy(account, key, { meshopt });
}
