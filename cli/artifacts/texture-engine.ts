/** 版本断言只读精确历史 operator；版本不符返回未满足要求，绝不重新贴图。 */
import type { Job } from '../../studio/contracts/types.ts';
import type { Gateway } from '../../studio/api/gateway.ts';
import type { JobStore } from '../storage/jobs.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import { readTextureModel, hasTextureModelProof, textureProofKey } from '../core/texture-version-policy.ts';

export async function verifyTextureModel(
  job: Job,
  jobs: JobStore,
  gateway: Gateway,
): Promise<string | undefined> {
  const expected = readTextureModel(jobs, job);
  if (!expected) return;
  if (hasTextureModelProof(jobs, job)) return expected;
  if (
    job.operation !== 'texture' ||
    job.input.action !== 'generate' ||
    !gateway.modelVersion ||
    !job.remote_ids.operator_id ||
    !job.remote_ids.project_id
  )
    throw new TripoError(
      'NATIVE_OUTPUT_REQUIREMENT_FAILED',
      'The original texture operator has no available engine verification.',
      'read',
    );
  const actual = await gateway.modelVersion(job);
  if (actual !== expected)
    throw new TripoError(
      'NATIVE_OUTPUT_REQUIREMENT_FAILED',
      'The website texture engine did not match the requested version. No replacement task was submitted.',
      'read',
      { expected, actual },
    );
  jobs.bindRequestPolicy(job.account_ref, textureProofKey(job), {
    operator_id: job.remote_ids.operator_id,
    model: actual,
  });
  return actual;
}
