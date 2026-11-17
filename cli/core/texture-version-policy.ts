/** 纹理版本由原网页 operator 回显验收，冻结用户意图，不把请求字段缺失当作效果不可映射。 */
import type { Job } from '../../studio/contracts/types.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import type { JobStore } from '../storage/jobs.ts';

export const verifiedTextureModel = 'v3.5-20260815';
const key = (request: string): string => `texture-model:${request}`;
export function readTextureModel(jobs: JobStore, job: Job): string | undefined {
  const model = jobs.requestPolicy(job.account_ref, key(job.request_id))?.model;
  return typeof model === 'string' ? model : undefined;
}
export function freezeTextureModel(
  jobs: JobStore,
  account: string,
  request: string,
  model: string | undefined,
): void {
  if (model && !jobs.requestPolicy(account, key(request)) && jobs.find(account, request))
    throw new TripoError(
      'IDEMPOTENCY_CONFLICT',
      'This existing task did not freeze its texture engine; use a new request for an explicit engine requirement.',
      'not_submitted',
    );
  jobs.bindRequestPolicy(account, key(request), model ? { model } : {});
}
export function textureProofKey(job: Job): string {
  return `texture-model-proof:${job.job_id}`;
}
export function hasTextureModelProof(jobs: JobStore, job: Job): boolean {
  const proof = jobs.requestPolicy(job.account_ref, textureProofKey(job));
  return Boolean(
    proof && proof.operator_id === job.remote_ids.operator_id && proof.model === readTextureModel(jobs, job),
  );
}
