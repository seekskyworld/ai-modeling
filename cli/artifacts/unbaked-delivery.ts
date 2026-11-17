/** 原生不烘焙交付复用已登记原文件；同字节陌生路径不能据内容反推覆盖许可。 */
import type { Artifact, Job } from '../../studio/contracts/types.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import { outputTarget } from '../../studio/files.ts';
import type { JobStore } from '../storage/jobs.ts';
import { registeredFrontendTarget, retainFrontendDeliveries } from '../core/frontend-delivery.ts';
import {
  assertUnbakedIdentity,
  assertUnbakedSnapshot,
  unbakedRequested,
} from '../core/unbaked-material-policy.ts';

/** 仅由JobStore最终事务调用；历史登记来自当前数据库，调用方自带列表不作为授权。 */
export function retainUnbakedDeliveries(
  jobs: JobStore,
  job: Job,
  current: Artifact | undefined,
  next: Artifact,
): Artifact | undefined {
  if (!unbakedRequested(job) || next.kind !== 'model') return;
  const proof = current && assertUnbakedIdentity(jobs, job, current);
  if (!proof) return;
  if (next.processing || next.format !== 'glb' || next.sha256 !== proof.sha256 || next.bytes !== proof.bytes)
    throw new TripoError(
      'UNBAKED_OUTPUT_CONTENT_CHANGED',
      'Downloaded bytes differ from the original verified native material export.',
      'read',
    );
  return retainFrontendDeliveries(current, next, proof.identity);
}

/** 新目标继续既有下载及验收；只有同任务/原摘要/原inode与父目录全匹配才直接复用。 */
export async function reusedUnbakedDelivery(
  jobs: JobStore,
  job: Job,
  artifact: Artifact,
  destination: { root: string; relative: string },
  assertCurrent: () => void,
): Promise<Record<string, unknown> | undefined> {
  if (!unbakedRequested(job) || artifact.kind !== 'model') return;
  assertCurrent();
  const target = await outputTarget(destination.root, destination.relative);
  assertCurrent();
  const current = assertUnbakedSnapshot(jobs, job, artifact),
    proof = assertUnbakedIdentity(jobs, job, current);
  if (!proof || !registeredFrontendTarget(current, target, proof.identity)) return;
  assertCurrent();
  assertUnbakedSnapshot(jobs, job, current);
  return { local_path: target, bytes: proof.bytes, sha256: proof.sha256, format: 'glb' };
}
