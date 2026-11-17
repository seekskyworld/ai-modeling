/** metadata结果的PNG与已验GLB属于同一原回执；单独冻结字节，不凭陌生文件回填历史。 */
import type { Artifact, Job } from '../../studio/contracts/types.ts';
import type { JobStore } from '../storage/jobs.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import { smartSegmentImportIdentity } from './smartsegment-transform-policy.ts';
import { hasVerifiedOutputCache } from '../artifacts/verified-output-cache.ts';
import {
  assertScaleOutputSnapshot,
  scaleNativeOutput,
  scaleOutputProof,
  scaleOutputContext,
} from './smartsegment-scale-policy.ts';

export const scaleMaskKey = (job: Job, artifact: Artifact): string =>
  `smartsegment-scale-mask:${job.job_id}:${artifact.artifact_id}`;
const changed = (): never => {
  throw new TripoError(
    'SMARTSEGMENT_SCALE_OUTPUT_CHANGED',
    'The original metadata segmentation mask or its output proof changed.',
    'read',
  );
};
export function assertScaleMaskSnapshot(jobs: JobStore, job: Job, artifact: Artifact): Job {
  const current = assertScaleOutputSnapshot(jobs, job, scaleNativeOutput(job)),
    mask = current.artifacts.find((a) => a.artifact_id === 'semantic-mask');
  if (
    !mask ||
    mask.kind !== 'image' ||
    mask.format !== 'png' ||
    mask.processing ||
    artifact.artifact_id !== mask.artifact_id ||
    smartSegmentImportIdentity(current, mask) !== smartSegmentImportIdentity(job, artifact) ||
    (artifact.sha256 !== undefined && mask.sha256 !== artifact.sha256) ||
    (artifact.bytes !== undefined && mask.bytes !== artifact.bytes)
  )
    return changed();
  return current;
}
export function scaleMaskContext(jobs: JobStore, job: Job, artifact: Artifact) {
  const current = assertScaleMaskSnapshot(jobs, job, artifact),
    model = scaleNativeOutput(current),
    modelProof = scaleOutputProof(jobs, current, model);
  if (!modelProof) return changed();
  const { source } = scaleOutputContext(jobs, current);
  if (
    !hasVerifiedOutputCache(
      job.account_ref,
      { sha256: String(source.sha256), bytes: Number(source.bytes) },
      String(source.cache_data_dir),
    )
  )
    throw new TripoError(
      'SMARTSEGMENT_SCALE_SOURCE_MISSING',
      'The frozen original source cache disappeared or changed before PNG delivery.',
      'read',
    );
  return { current, modelProof };
}
export function scaleMaskProof(jobs: JobStore, job: Job, artifact: Artifact) {
  const { current, modelProof } = scaleMaskContext(jobs, job, artifact),
    proof = jobs.requestPolicy(job.account_ref, scaleMaskKey(job, artifact)),
    mask = current.artifacts.find((a) => a.artifact_id === artifact.artifact_id)!;
  if (!proof) return;
  if (
    proof.identity !== smartSegmentImportIdentity(current, mask) ||
    proof.model_identity !== modelProof.identity ||
    proof.source_sha256 !== modelProof.source_sha256 ||
    (mask.sha256 !== undefined && mask.sha256 !== proof.sha256) ||
    (mask.bytes !== undefined && mask.bytes !== proof.bytes)
  )
    return changed();
  return proof;
}
