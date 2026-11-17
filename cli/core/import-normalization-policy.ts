/** 导入缩放是可缺省的派生元数据；只认收费提交前冻结的原件与同一原生回执。 */
import type { Artifact, Job } from '../../studio/contracts/types.ts';
import type { JobStore } from '../storage/jobs.ts';
import { createHash } from 'node:crypto';
import { object, text, TripoError } from '../../studio/contracts/errors.ts';
import { fingerprint } from './fingerprint.ts';

export const importNormalizationSourceKey = (request: string): string =>
  `import-normalization-source:${request}`;
export const importNormalizationProofKey = (job: Job): string =>
  `import-normalization-proof:${job.request_id}`;
export const importNormalizationIdentity = (job: Job, artifact: Artifact): string =>
  fingerprint({
    account: job.account_ref,
    job: job.job_id,
    input: job.input,
    operation: job.operation,
    remote: job.remote_ids,
    artifact: artifact.artifact_id,
    kind: artifact.kind,
    format: artifact.format,
    index: artifact.index,
  });

export function normalizationUnavailable(reason: string, code?: string): Record<string, unknown> {
  return {
    normalize_scale_validation: {
      status: 'unverified',
      reason,
      ...(code ? { code } : {}),
      native_response_field: false,
    },
  };
}

function matchesSourceAndArtifact(
  source: Record<string, unknown>,
  job: Job,
  artifact: Artifact | undefined,
  count: number,
  proof: Record<string, unknown> | undefined,
): boolean {
  return Boolean(
    count === 1 &&
    artifact?.format === 'glb' &&
    !artifact.processing &&
    proof &&
    proof.version === 1 &&
    proof.identity === importNormalizationIdentity(job, artifact) &&
    proof.source_sha256 === source.source_sha256 &&
    proof.source_bytes === source.source_bytes &&
    (!artifact.sha256 || artifact.sha256 === proof.imported_sha256) &&
    (!artifact.bytes || artifact.bytes === proof.imported_bytes) &&
    Number.isFinite(proof.normalize_scale) &&
    Number(proof.normalize_scale) > 0 &&
    proof.normalize_scale === object(source.inspection).expected_scale,
  );
}

export function importNormalizationSummary(jobs: JobStore, job: Job): Record<string, unknown> {
  if (job.operation !== 'import_model') return {};
  const source = jobs.requestPolicy(job.account_ref, importNormalizationSourceKey(job.request_id));
  if (!source)
    return normalizationUnavailable('This import has no source snapshot frozen before submission.');
  if (source.input_hash !== fingerprint(job.input))
    return normalizationUnavailable('The import input differs from its frozen source snapshot.');
  if (source.status !== 'eligible') return normalizationUnavailable(text(source.reason), text(source.code));
  if (job.state !== 'succeeded')
    return normalizationUnavailable('The original import has not completed successfully.');
  const models = job.artifacts.filter((artifact) => artifact.kind === 'model'),
    artifact = models[0],
    proof = jobs.requestPolicy(job.account_ref, importNormalizationProofKey(job))!;
  if (!matchesSourceAndArtifact(source, job, artifact, models.length, proof))
    return normalizationUnavailable('The exact native import has no matching complete surface proof.');
  return {
    normalize_scale: proof.normalize_scale,
    normalize_scale_provenance: 'derived_from_verified_studio_import',
    normalize_scale_validation: {
      status: 'verified',
      source_job_id: job.job_id,
      source_sha256: proof.source_sha256,
      source_bytes: proof.source_bytes,
      imported_sha256: proof.imported_sha256,
      imported_bytes: proof.imported_bytes,
      matched_oriented_faces: proof.matched_oriented_faces,
      maximum_position_error: proof.maximum_position_error,
      maximum_normal_error: proof.maximum_normal_error,
      maximum_uv_error: proof.maximum_uv_error,
      tolerance: proof.tolerance,
      source_center: proof.source_center,
      source_extent: proof.source_extent,
      model_bytes_modified: false,
      native_response_field: false,
    },
  };
}

/** 已发布因子的后续下载必须交付同一原件；摘要本身不赋予另一个模型该因子。 */
export function importNormalizationDeliveryProof(jobs: JobStore, job: Job, artifact: Artifact) {
  if (importNormalizationSummary(jobs, job).normalize_scale === undefined || artifact.kind !== 'model')
    return;
  const proof = jobs.requestPolicy(job.account_ref, importNormalizationProofKey(job))!;
  if (proof.identity !== importNormalizationIdentity(job, artifact)) return;
  return { sha256: text(proof.imported_sha256), bytes: Number(proof.imported_bytes) };
}

export function assertImportNormalizationSnapshot(jobs: JobStore, job: Job, artifact: Artifact): void {
  const current = jobs.get(job.job_id),
    latest = current.artifacts.find((a) => a.artifact_id === artifact.artifact_id);
  if (
    !latest ||
    !importNormalizationDeliveryProof(jobs, current, latest) ||
    importNormalizationIdentity(current, latest) !== importNormalizationIdentity(job, artifact)
  )
    throw new TripoError('IMPORT_NORMALIZATION_IDENTITY_CHANGED', 'The verified import changed.', 'read');
}

export function assertImportNormalizationBytes(
  jobs: JobStore,
  job: Job,
  artifact: Artifact,
  bytes: Buffer,
): void {
  assertImportNormalizationSnapshot(jobs, job, artifact);
  const proof = importNormalizationDeliveryProof(jobs, job, artifact)!;
  if (bytes.length !== proof.bytes || createHash('sha256').update(bytes).digest('hex') !== proof.sha256)
    throw new TripoError(
      'IMPORT_NORMALIZATION_CONTENT_CHANGED',
      'The downloaded model differs from the original import whose scale was verified.',
      'read',
    );
}
