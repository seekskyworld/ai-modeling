/** UV 压缩由独立网页导入产生；冻结来源和交付要求，禁止把恢复改成新导入。 */
import type { Artifact, Job, Operation } from '../../studio/contracts/types.ts';
import type { JobStore } from '../storage/jobs.ts';
import { TripoError, text } from '../../studio/contracts/errors.ts';
import { fingerprint } from './fingerprint.ts';

export const uvImportPolicyKey = (request: string): string => `uv-import:${request}`;
export const uvInputPolicyKey = (request: string): string => `uv-compression-input:${request}`;
export function assertUvInputIntent(
  jobs: JobStore,
  account: string,
  request: string,
  operation: string,
  input: Record<string, unknown>,
): void {
  const policy = jobs.requestPolicy(account, uvInputPolicyKey(request));
  if (policy && (operation !== 'uv_generate' || policy.intent !== fingerprint(input)))
    throw new TripoError(
      'IDEMPOTENCY_CONFLICT',
      'The original UV preflight belongs to different inputs.',
      'not_submitted',
    );
}
export const uvImportProofKey = (job: Job, artifact: Artifact): string =>
  `uv-import-proof:${job.job_id}:${artifact.artifact_id}`;
export function uvArtifactIdentity(job: Job, artifact: Artifact): string {
  return fingerprint({
    account: job.account_ref,
    job: job.job_id,
    operation: job.operation,
    input: job.input,
    remote: job.remote_ids,
    artifact: artifact.artifact_id,
    kind: artifact.kind,
    format: artifact.format,
    index: artifact.index,
  });
}
export function uvImportPolicy(jobs: JobStore, job: Job): Record<string, unknown> | undefined {
  const policy = jobs.requestPolicy(job.account_ref, uvImportPolicyKey(job.request_id));
  if (!policy) return;
  assertUvImportIntent(jobs, job.account_ref, job.request_id, job.operation, job.input);
  return policy;
}
export function assertUvImportIntent(
  jobs: JobStore,
  account: string,
  request: string,
  operation: Operation,
  input: Record<string, unknown>,
): void {
  const policy = jobs.requestPolicy(account, uvImportPolicyKey(request));
  if (!policy) return;
  const { _input_files, ...intent } = input;
  if (operation !== 'import_model' || policy.version !== 1 || policy.input !== fingerprint(intent))
    throw new TripoError(
      'IDEMPOTENCY_CONFLICT',
      'The original UV compression import input changed.',
      'not_submitted',
    );
  if (
    _input_files &&
    (_input_files as Record<string, unknown>)[text(input.model_path)] !==
      (policy.import_sha256 ?? policy.source_sha256)
  )
    throw new TripoError(
      'INPUT_CHANGED',
      'The original UV compression source bytes changed.',
      'not_submitted',
    );
}
export function uvImportSource(
  jobs: JobStore,
  job: Job,
  policy: Record<string, unknown>,
): { job: Job; artifact: Artifact } {
  const source = jobs.get(text(policy.source_job_id)),
    artifact = source.artifacts.find((entry) => entry.artifact_id === policy.source_artifact_id);
  if (
    source.account_ref !== job.account_ref ||
    source.state !== 'succeeded' ||
    !artifact ||
    uvArtifactIdentity(source, artifact) !== policy.source_identity
  )
    throw new TripoError(
      'UV_COMPRESSION_SOURCE_CHANGED',
      'The frozen UV source task or artifact changed.',
      'read',
    );
  return { job: source, artifact };
}
export function rejectUvImportContinuation(jobs: JobStore, job?: Job): void {
  if (!job) return;
  const policy = uvImportPolicy(jobs, job);
  if (policy)
    throw new TripoError(
      'UV_COMPRESSION_CONTINUATION_UNVERIFIED',
      `This compressed UV delivery restores coordinates locally; its imported Studio project remains normalized. Continue web editing from the original UV task ${text(policy.source_job_id)}.`,
      'not_submitted',
    );
}

export const uvImportWarning =
  'compress=geometry adds a persistent Studio import after UV generation and application. It supports verified static, untextured GLB triangle surfaces with 1–64 independent root meshes, at most 64 total primitives and 25000 faces. Multiple primitives are temporarily split in JSON before native import, then uniquely matched by oriented geometry/UV/normal/material and regrouped only when their native coordinate bases are identical. Local processing restores fixed source-bounds transforms, names and primitive groups without encoding geometry. Hierarchies, instances, changed normals and ambiguous surface correspondence are rejected. UV and normals may be quantized. The imported Studio project stays normalized and split; continue web editing from the original UV task returned in uv_compression_validation.';
