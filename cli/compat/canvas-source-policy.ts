/** 非封口 Canvas 模型先由原 run 与资产证明身份；后续恢复只验证持久冻结记录。 */
import type { JobStore } from '../storage/jobs.ts';
import type { Job } from '../../studio/contracts/types.ts';
import type { StudioClient } from '../../studio/api/client.ts';
import { canvasCapNodes } from '../../studio/contracts/canvas-result.ts';
import { validUncappedCanvasModelSource } from '../../studio/contracts/canvas-model-source.ts';
import { resolveUncappedCanvasModelSource } from '../../studio/api/canvas-model-source.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import { canvasModelSource, type CanvasModelSource } from './canvas-source.ts';

type SourceStore = Pick<JobStore, 'requestPolicy' | 'bindRequestPolicy' | 'get'>;
export const canvasModelSourcePolicyKey = (job: Pick<Job, 'job_id'>): string =>
  `canvas-model-source:${job.job_id}`;

export function canvasModelSourceProof(jobs: SourceStore, job?: Job): Record<string, unknown> | undefined {
  if (job?.operation !== 'canvas_run') return;
  return jobs.requestPolicy(job.account_ref, canvasModelSourcePolicyKey(job));
}

export async function prepareCanvasModelSource(
  context: { jobs: SourceStore; client: StudioClient; accountRef(): string },
  job: Job,
): Promise<CanvasModelSource | undefined> {
  if (job.operation !== 'canvas_run') return;
  const account = context.accountRef();
  if (job.account_ref !== account)
    throw new TripoError('ACCOUNT_MISMATCH', 'The Canvas source belongs to another Studio account.');
  const saved = canvasModelSourceProof(context.jobs, job);
  if (saved !== undefined || canvasCapNodes(job).length || job.state !== 'succeeded')
    return canvasModelSource(job, saved);
  const proof = await resolveUncappedCanvasModelSource(context.client, job);
  if (context.accountRef() !== account)
    throw new TripoError('ACCOUNT_MISMATCH', 'The Studio account changed during Canvas source verification.');
  const current = context.jobs.get(job.job_id);
  if (!validUncappedCanvasModelSource(current, proof))
    throw new TripoError(
      'CANVAS_MODEL_SOURCE_CONFLICT',
      'The Canvas source task changed before its model identity could be frozen.',
      'not_submitted',
    );
  // 原子绑定拒绝两个进程选中了不同模型；不能用后到结果覆盖已冻结来源。
  context.jobs.bindRequestPolicy(account, canvasModelSourcePolicyKey(job), { ...proof });
  return canvasModelSource(current, canvasModelSourceProof(context.jobs, current));
}
