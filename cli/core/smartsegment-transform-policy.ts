/** 官方矩阵意图属于整个导入→分割链；换入口或只复用末步ID也不能跳过原件验收。 */
import type { JobStore } from '../storage/jobs.ts';
import type { Artifact, Job, Operation } from '../../studio/contracts/types.ts';
import { object, text, TripoError } from '../../studio/contracts/errors.ts';
import { fingerprint } from './fingerprint.ts';

export const smartSegmentTransformIntentKey = (request: string): string =>
  `smartsegment-transform-intent:${request}`;
export const smartSegmentTransformSourceKey = (request: string): string =>
  `smartsegment-transform-source:${request}`;
export const smartSegmentTransformProofKey = (request: string): string =>
  `smartsegment-transform-proof:${request}`;
export const smartSegmentTransformStepKey = (request: string): string =>
  `smartsegment-transform-step:${request}`;

export function smartSegmentImportIdentity(job: Job, artifact: Artifact): string {
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

export function assertSmartSegmentTransformStep(
  jobs: JobStore,
  account: string,
  request: string,
  operation: Operation,
  input: Record<string, unknown>,
): void {
  const step = jobs.requestPolicy(account, smartSegmentTransformStepKey(request));
  if (!step) {
    const parent = /^(.*)-[01]$/.exec(request)?.[1];
    if (parent && jobs.requestPolicy(account, smartSegmentTransformIntentKey(parent)))
      throw new TripoError(
        'SMARTSEGMENT_TRANSFORM_UNVERIFIED',
        'The transformed smartsegment layout was interrupted before its component policies were frozen. Resume the original complete request.',
        'not_submitted',
      );
    return;
  }
  const parent = text(step.parent_request),
    intent = jobs.requestPolicy(account, smartSegmentTransformIntentKey(parent)),
    source = jobs.requestPolicy(account, smartSegmentTransformSourceKey(parent));
  const { _input_files, ...parameters } = input;
  if (step.version !== 1 || !intent || !source || source.intent !== fingerprint(intent))
    throw new TripoError(
      'SMARTSEGMENT_TRANSFORM_UNVERIFIED',
      'Recover the original transformed smartsegment request before submitting a component step.',
      'not_submitted',
    );
  if (step.index === 0) {
    if (
      operation !== 'import_model' ||
      fingerprint(parameters) !== source.import_input ||
      object(_input_files)[text(input.model_path)] !== source.sha256
    )
      throw new TripoError(
        'IDEMPOTENCY_CONFLICT',
        'The frozen transformed import input changed.',
        'not_submitted',
      );
    return;
  }
  const proof = jobs.requestPolicy(account, smartSegmentTransformProofKey(parent));
  if (!proof || proof.intent !== fingerprint(intent) || proof.source_sha256 !== source.sha256)
    throw new TripoError(
      'SMARTSEGMENT_TRANSFORM_UNVERIFIED',
      'The original native import has not passed the requested transform and attribute checks. Recover that import; segmentation was not submitted.',
      'not_submitted',
    );
  const job = verifiedImport(jobs, account, proof);
  const expected = {
    ...object(step.parameters),
    project_id: job.remote_ids.project_id,
    expected_operator_id: job.remote_ids.operator_id,
  };
  if (step.index !== 1 || operation !== 'segment' || fingerprint(parameters) !== fingerprint(expected))
    throw new TripoError(
      'IDEMPOTENCY_CONFLICT',
      'The frozen transformed segmentation intent changed.',
      'not_submitted',
    );
}

function verifiedImport(jobs: JobStore, account: string, proof: Record<string, unknown>): Job {
  const job = jobs.get(text(proof.import_job_id)),
    artifact = job.artifacts.find((item) => item.artifact_id === proof.artifact_id);
  if (
    job.account_ref !== account ||
    job.state !== 'succeeded' ||
    job.operation !== 'import_model' ||
    !artifact ||
    artifact.processing ||
    smartSegmentImportIdentity(job, artifact) !== proof.import_identity
  )
    throw new TripoError(
      'SMARTSEGMENT_TRANSFORM_SOURCE_CHANGED',
      'The verified original import changed.',
      'not_submitted',
    );
  return job;
}
