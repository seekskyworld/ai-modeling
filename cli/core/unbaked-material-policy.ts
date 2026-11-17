/** bake=false 是已验原生导出的效果要求；不把未冻结来源的旧任务补记为已验。 */
import type { Artifact, Job } from '../../studio/contracts/types.ts';
import type { JobStore } from '../storage/jobs.ts';
import type { MaterialSnapshot } from '../artifacts/material-snapshot.ts';
import { sameMaterialSnapshot } from '../artifacts/material-snapshot.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import { fingerprint } from './fingerprint.ts';
import { nativeUnbakedPivot } from '../../studio/contracts/export-options.ts';

export interface UnbakedSourceProof extends Record<string, unknown> {
  identity: string;
  sha256: string;
  bytes: number;
  snapshot: MaterialSnapshot;
}
export interface UnbakedOutputProof extends UnbakedSourceProof {
  source_identity: string;
  source_sha256: string;
}
export const unbakedRequested = (job: Job): boolean => job.operation === 'export' && job.input.bake === false;
export const unbakedSourceKey = (job: Job): string => `unbaked-source:${job.job_id}`;
export const unbakedProofKey = (job: Job, artifact: Artifact): string =>
  `unbaked-result:${job.job_id}:${artifact.artifact_id}`;
export function unbakedSourceIdentity(job: Job): string {
  return fingerprint({
    account: job.account_ref,
    job: job.job_id,
    operation: job.operation,
    input: job.input,
  });
}
export function unbakedIdentity(job: Job, artifact: Artifact): string {
  return fingerprint({
    source: unbakedSourceIdentity(job),
    remote_ids: job.remote_ids,
    artifact: {
      id: artifact.artifact_id,
      kind: artifact.kind,
      format: artifact.format,
      index: artifact.index,
    },
  });
}
export function readUnbakedSource(jobs: JobStore, job: Job): UnbakedSourceProof {
  const source = jobs.requestPolicy(job.account_ref, unbakedSourceKey(job)) as UnbakedSourceProof | undefined;
  if (!source || source.identity !== unbakedSourceIdentity(job))
    throw new TripoError(
      'UNBAKED_SOURCE_UNVERIFIED',
      'The original material source was not frozen before submission; this receipt cannot be retroactively verified or resubmitted.',
      'read',
    );
  const projection = source.snapshot.source_projection;
  if (
    nativeUnbakedPivot(job.input)
      ? projection?.forward_axis !== '-y' ||
        projection.pivot_to_center_bottom !== true ||
        !Array.isArray(projection.pivot) ||
        projection.pivot.length !== 3 ||
        projection.pivot.some((value) => !Number.isFinite(value)) ||
        source.snapshot.surface_encoding !== 'oriented-corners-v2'
      : projection !== undefined
  )
    throw new TripoError(
      'UNBAKED_SOURCE_UNVERIFIED',
      'This native pivot request lacks its original source-derived placement proof.',
      'read',
    );
  return source;
}
export function assertUnbakedIdentity(
  jobs: JobStore,
  job: Job,
  artifact: Artifact,
): UnbakedOutputProof | undefined {
  const source = readUnbakedSource(jobs, job);
  const proof = jobs.requestPolicy(job.account_ref, unbakedProofKey(job, artifact)) as
    UnbakedOutputProof | undefined;
  if (!proof) return;
  if (
    proof.identity !== unbakedIdentity(job, artifact) ||
    proof.source_identity !== source.identity ||
    proof.source_sha256 !== source.sha256
  )
    throw new TripoError(
      'UNBAKED_OUTPUT_IDENTITY_CHANGED',
      'The verified export belongs to a different source or receipt; recover the original task.',
      'read',
    );
  if (
    !sameMaterialSnapshot(source.snapshot, proof.snapshot) ||
    (artifact.sha256 && artifact.sha256 !== proof.sha256) ||
    (artifact.bytes && artifact.bytes !== proof.bytes)
  )
    throw new TripoError(
      'UNBAKED_OUTPUT_CONTENT_CHANGED',
      'The export metadata differs from its frozen material proof.',
      'read',
    );
  return proof;
}
export function assertUnbakedSnapshot(jobs: JobStore, job: Job, artifact: Artifact): Artifact {
  const current = jobs.get(job.job_id);
  const latest = current.artifacts.find((item) => item.artifact_id === artifact.artifact_id);
  if (!latest || unbakedIdentity(current, latest) !== unbakedIdentity(job, artifact))
    throw new TripoError(
      'UNBAKED_OUTPUT_IDENTITY_CHANGED',
      'The export identity changed while reading its original bytes.',
      'read',
    );
  assertUnbakedIdentity(jobs, current, latest);
  return latest;
}
export function hasUnbakedProof(jobs: JobStore, job: Job): boolean {
  try {
    const models = job.artifacts.filter((item) => item.kind === 'model');
    return models.length > 0 && models.every((item) => Boolean(assertUnbakedIdentity(jobs, job, item)));
  } catch {
    return false;
  }
}
