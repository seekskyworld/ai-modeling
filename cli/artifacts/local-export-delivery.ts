/** 普通本地转换只恢复原处理字节；目录身份绑定完整任务及原生来源，不回填丢失历史。 */
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Artifact, Job } from '../../studio/contracts/types.ts';
import type { JobStore } from '../storage/jobs.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import { needsExportTransform, transformedExportFormat } from '../../studio/contracts/export-options.ts';
import { outputTarget } from '../../studio/files.ts';
import { fingerprint } from '../core/fingerprint.ts';
import { registeredFrontendTarget, retainFrontendDeliveries } from '../core/frontend-delivery.ts';
import { verifiedArtifactBytes } from './recover-download.ts';
import { localTarget, publishLocal } from '../local/files.ts';

export const LOCAL_EXPORT_PROCESSING =
  'Studio GLB export followed by local part selection, texture encoding and Blender conversion';
const formats = ['glb', 'fbx', 'stl', 'usdz', '3mf', 'zip'] as const;
const sha = (value: unknown): boolean => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function changed(): never {
  throw new TripoError(
    'LOCAL_EXPORT_IDENTITY_CHANGED',
    'The original local export task, native source or verified delivery bytes changed.',
    'read',
  );
}
function taskIdentity(job: Job): Record<string, unknown> {
  return {
    job_id: job.job_id,
    account_ref: job.account_ref,
    request_id: job.request_id,
    operation: job.operation,
    input_hash: job.input_hash,
    input: job.input,
    remote_ids: job.remote_ids,
  };
}
/** 保持专业交付分支优先；这里只认本地转换器自己写出的标记。 */
export function localExportTask(job: Job, artifact: Pick<Artifact, 'kind'>): boolean {
  return job.operation === 'export' && artifact.kind === 'model' && needsExportTransform(job.input);
}
export function localExportDeliveryRequested(
  job: Job,
  artifact: Pick<Artifact, 'kind' | 'processing'>,
): boolean {
  return localExportTask(job, artifact) && artifact.processing === LOCAL_EXPORT_PROCESSING;
}
/** 登记源已在专用分支逐个尝试；通用SHA缓存不得重新接纳失效inode，保留原失败。 */
export function rejectUnregisteredLocalExportRecovery(job: Job, artifact: Artifact, error: unknown): void {
  if (localExportDeliveryRequested(job, artifact)) throw error;
}
function content(artifact: Pick<Artifact, 'format' | 'sha256' | 'bytes' | 'processing' | 'source_sha256'>) {
  return {
    format: artifact.format,
    sha256: artifact.sha256,
    bytes: artifact.bytes,
    processing: artifact.processing,
    source_sha256: artifact.source_sha256,
  };
}
function identity(job: Job, artifact: Artifact): string {
  if (
    !localExportDeliveryRequested(job, artifact) ||
    !sha(artifact.sha256) ||
    !sha(artifact.source_sha256) ||
    !Number.isSafeInteger(artifact.bytes) ||
    Number(artifact.bytes) <= 0 ||
    artifact.format !== transformedExportFormat(job.input) ||
    !formats.includes(artifact.format as (typeof formats)[number])
  )
    changed();
  return fingerprint({
    version: 1,
    job: taskIdentity(job),
    artifact_id: artifact.artifact_id,
    kind: artifact.kind,
    index: artifact.index,
    ...content(artifact),
  });
}
function snapshot(jobs: JobStore, job: Job, artifact: Artifact): { job: Job; artifact: Artifact } {
  const current = jobs.get(job.job_id),
    next = current.artifacts.find((item) => item.artifact_id === artifact.artifact_id);
  if (
    current.state !== 'succeeded' ||
    !isDeepStrictEqual(taskIdentity(current), taskIdentity(job)) ||
    !next ||
    next.kind !== artifact.kind ||
    next.index !== artifact.index
  )
    return changed();
  if (localExportDeliveryRequested(job, artifact) && !isDeepStrictEqual(content(next), content(artifact)))
    return changed();
  if (next.frontend_deliveries !== undefined) {
    const proof = identity(current, next);
    // 校验登记的身份和摘要；此处不把文件缺失当成另一个路径的授权。
    registeredFrontendTarget(next, '', proof, formats);
  }
  return { job: current, artifact: next };
}
export function assertLocalExportSnapshot(jobs: JobStore, job: Job, artifact: Artifact): void {
  snapshot(jobs, job, artifact);
}
/** 新结果发布前及最终保存事务均校验：已有转换不能因重下载换掉原字节或原生来源。 */
export function assertLocalExportProduced(
  jobs: JobStore,
  job: Job,
  artifact: Artifact,
  produced: Pick<Artifact, 'format' | 'sha256' | 'bytes' | 'processing' | 'source_sha256'>,
): void {
  const current = snapshot(jobs, job, artifact);
  identity(current.job, { ...current.artifact, ...produced });
  if (
    localExportDeliveryRequested(current.job, current.artifact) &&
    !isDeepStrictEqual(content(current.artifact), content(produced))
  )
    changed();
}
/** 仅最终数据库事务调用；任何调用方提供的路径历史都被丢弃。 */
export function retainLocalExportDeliveries(
  jobs: JobStore,
  job: Job,
  current: Artifact | undefined,
  next: Artifact,
): Artifact | undefined {
  const existing = current && localExportDeliveryRequested(job, current),
    requested = localExportDeliveryRequested(job, next);
  if (!existing && !requested) return;
  if (!requested || !current) return changed();
  assertLocalExportProduced(jobs, job, current, next);
  return retainFrontendDeliveries(
    localExportDeliveryRequested(job, current) ? current : undefined,
    next,
    identity(job, next),
    formats,
  );
}
/** 只读本任务已经登记的转换输出；原生未处理local_path不会被收为交付。 */
export async function reusedLocalExportDelivery(
  jobs: JobStore,
  job: Job,
  artifact: Artifact,
  destination: { root: string; relative: string },
  assertAccount: () => void,
): Promise<Record<string, unknown> | undefined> {
  if (!localExportDeliveryRequested(job, artifact)) return;
  const check = () => {
    assertAccount();
    return snapshot(jobs, job, artifact);
  };
  const current = check(),
    proof = identity(current.job, current.artifact);
  const target = await outputTarget(destination.root, destination.relative);
  const latest = check().artifact;
  if (registeredFrontendTarget(latest, target, proof, formats))
    return { local_path: target, ...content(latest) };
  const output = await localTarget(
    destination.root,
    path.resolve(destination.root, destination.relative),
    latest.format,
  );
  check();
  const candidates = latest.frontend_deliveries?.map((entry) => entry.path) ?? [latest.local_path];
  for (const candidate of candidates) {
    if (!candidate || !registeredFrontendTarget(latest, candidate, proof, formats)) continue;
    const bytes = await verifiedArtifactBytes({ ...latest, local_path: candidate });
    check();
    if (!bytes || !registeredFrontendTarget(check().artifact, candidate, proof, formats)) continue;
    return {
      ...(await publishLocal(output, bytes, latest.format, () => {
        check();
      })),
      processing: latest.processing,
      source_sha256: latest.source_sha256,
    };
  }
}
