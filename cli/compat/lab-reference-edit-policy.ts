/** 纯持久策略：框外保留义务不能被普通 Lab/下载/历史入口绕过，也不能追补给旧任务。 */
import { createHash } from 'node:crypto';
import type { JobStore } from '../storage/jobs.ts';
import type { Artifact, Job, Operation } from '../../studio/contracts/types.ts';
import { object, text, TripoError } from '../../studio/contracts/errors.ts';
import { fingerprint } from '../core/fingerprint.ts';
import type { LabReferenceEditIntent } from './lab-reference-edit-plan.ts';

export const labReferenceKey = (parent: string, part: string): string =>
  `lab-reference-edit:${parent}:${part}`;
export const labReferenceJobKey = (request: string): string => `lab-reference-edit-job:${request}`;
export const labReferenceProofKey = (job: Job): string => `lab-reference-edit-proof:${job.job_id}`;
export interface LabReferenceFile {
  sha256: string;
  bytes: number;
  format: string;
  cache_path: string;
  cache_data_dir: string;
  provenance: Record<string, unknown>;
}
export interface LabReferenceSource {
  version: 1;
  intent: string;
  model: LabReferenceFile;
  image: LabReferenceFile;
  geometry: Record<string, unknown>;
}
export interface LabReferencePolicy {
  version: 1;
  parent: string;
  intent: LabReferenceEditIntent;
  source: LabReferenceSource;
  parameters: Record<string, unknown>;
}
export const labReferenceFailure = (message: string): never => {
  throw new TripoError('LAB_REFERENCE_REQUIREMENT_UNVERIFIED', message, 'read');
};

function checkedFile(value: unknown): value is LabReferenceFile {
  const x = object(value);
  return (
    /^[a-f0-9]{64}$/.test(text(x.sha256)) &&
    Number.isSafeInteger(x.bytes) &&
    Number(x.bytes) > 0 &&
    Boolean(text(x.cache_path) && text(x.cache_data_dir))
  );
}
function assertPreparation(
  jobs: JobStore,
  account: string,
  parent: string,
  source: Record<string, unknown>,
  parameters: Record<string, unknown>,
): void {
  const graph = jobs.requestPolicy(account, labReferenceKey(parent, 'graph'));
  const registered = jobs.requestPolicy(account, labReferenceKey(parent, 'registered'));
  if (
    !graph ||
    graph.version !== 1 ||
    !registered ||
    registered.version !== 1 ||
    registered.graph !== fingerprint(graph) ||
    registered.model_sha256 !== object(source.model).sha256 ||
    registered.image_sha256 !== object(source.image).sha256 ||
    parameters.node_id !== graph.lab_node_id ||
    fingerprint(parameters.asset_ids) !== fingerprint([graph.model_asset_id, graph.image_asset_id])
  )
    return labReferenceFailure(
      'The Lab job has no matching saved graph and exact registered attachment-byte proof.',
    );
  for (const stage of ['create', 'upload-model', 'upload-image', 'save']) {
    const start = jobs.requestPolicy(account, labReferenceKey(parent, `${stage}:start`));
    const receipt = jobs.requestPolicy(account, labReferenceKey(parent, `${stage}:receipt`));
    if (
      !start ||
      !text(start.attempt) ||
      !receipt ||
      receipt.attempt !== start.attempt ||
      receipt.input !== start.input ||
      start.input !== fingerprint(start.parameters)
    )
      return labReferenceFailure(
        'A Lab graph preparation receipt is missing or differs from its unique write attempt.',
      );
  }
}
export function labReferencePolicyForRequest(
  jobs: JobStore,
  account: string,
  request: string,
): LabReferencePolicy | undefined {
  const saved = jobs.requestPolicy(account, labReferenceJobKey(request));
  if (!saved) return;
  const parent = text(saved.parent),
    intent = jobs.requestPolicy(account, labReferenceKey(parent, 'intent'));
  const source = jobs.requestPolicy(account, labReferenceKey(parent, 'source'));
  if (
    saved.version !== 1 ||
    !parent ||
    !intent ||
    intent.version !== 1 ||
    !source ||
    source.version !== 1 ||
    saved.intent !== fingerprint(intent) ||
    source.intent !== fingerprint(intent) ||
    !checkedFile(source.model) ||
    !checkedFile(source.image) ||
    fingerprint(saved.source) !== fingerprint(source) ||
    request !== `${parent}-0`
  )
    return labReferenceFailure('The original Lab parent, source or child intent is absent or inconsistent.');
  const parameters = object(saved.parameters);
  if (
    parameters.accept_variable_cost !== true ||
    !text(parameters.node_id) ||
    !text(parameters.prompt) ||
    !Array.isArray(parameters.asset_ids) ||
    parameters.asset_ids.length !== 2
  )
    return labReferenceFailure('The frozen Lab input binding is incomplete.');
  assertPreparation(jobs, account, parent, source, parameters);
  return {
    version: 1,
    parent,
    intent: intent as unknown as LabReferenceEditIntent,
    source: source as unknown as LabReferenceSource,
    parameters,
  };
}
export function assertLabReferenceSubmission(
  jobs: JobStore,
  account: string,
  request: string,
  operation: Operation,
  input: Record<string, unknown>,
): void {
  const policy = labReferencePolicyForRequest(jobs, account, request);
  if (!policy) return;
  if (operation !== 'canvas_lab' || fingerprint(input) !== fingerprint(policy.parameters))
    throw new TripoError(
      'IDEMPOTENCY_CONFLICT',
      'The original reference-guided Lab request cannot change backend, prompt or attached assets.',
      'not_submitted',
    );
}
export function labReferenceEditPolicy(jobs: JobStore, job: Job): LabReferencePolicy | undefined {
  const policy = labReferencePolicyForRequest(jobs, job.account_ref, job.request_id);
  if (!policy) return;
  const input = Object.fromEntries(
    Object.entries(job.input).filter(([key]) => !['_canvas_quotes', '_canvas_action'].includes(key)),
  );
  assertLabReferenceSubmission(jobs, job.account_ref, job.request_id, job.operation, input);
  return policy;
}
export function labReferenceIdentity(job: Job, artifact: Artifact): string {
  return fingerprint({
    account: job.account_ref,
    job_id: job.job_id,
    request_id: job.request_id,
    operation: job.operation,
    input: job.input,
    remote_ids: job.remote_ids,
    artifact_id: artifact.artifact_id,
    kind: artifact.kind,
    format: artifact.format,
    index: artifact.index,
  });
}
function assertValidationKind(policy: LabReferencePolicy, validation: Record<string, unknown>): void {
  if (policy.intent.kind === 'projected_segment') {
    if (
      validation.native_v2_engine !== false ||
      validation.wrong_group_faces !== 0 ||
      validation.matched_original_faces !== policy.source.geometry.faces ||
      fingerprint(validation.projection) !== fingerprint(policy.intent.projection) ||
      validation.reference_sha256 !== policy.source.image.sha256
    )
      return labReferenceFailure('The original projected mask, camera or full-face partition proof changed.');
    return;
  }
  if (
    fingerprint(validation.bbox) !== fingerprint(policy.intent.bbox) ||
    validation.native_v2_engine !== undefined
  )
    return labReferenceFailure('The original Lab region proof cannot acquire a different task kind or box.');
}
export function labReferenceOutputProof(
  jobs: JobStore,
  job: Job,
  artifact: Artifact,
): Record<string, unknown> {
  const policy = labReferenceEditPolicy(jobs, job);
  const proof = jobs.requestPolicy(job.account_ref, labReferenceProofKey(job));
  if (
    !policy ||
    job.state !== 'succeeded' ||
    artifact.kind !== 'model' ||
    artifact.format !== 'glb' ||
    !proof ||
    proof.version !== 1 ||
    proof.identity !== labReferenceIdentity(job, artifact) ||
    proof.parent !== policy.parent ||
    proof.source_sha256 !== policy.source.model.sha256 ||
    proof.reference_sha256 !== policy.source.image.sha256 ||
    !/^[a-f0-9]{64}$/.test(text(proof.sha256)) ||
    !Number.isSafeInteger(proof.bytes) ||
    Number(proof.bytes) <= 0 ||
    object(proof.validation).status !== 'verified' ||
    !text(proof.cache_data_dir)
  )
    return labReferenceFailure(
      'The original Lab model lacks a complete source-bound geometry proof. Read the original task to verify it; do not submit another job.',
    );
  assertValidationKind(policy, object(proof.validation));
  if (
    (artifact.sha256 && artifact.sha256 !== proof.sha256) ||
    (artifact.bytes && artifact.bytes !== proof.bytes)
  )
    return labReferenceFailure('The Lab artifact byte identity differs from its frozen proof.');
  return proof;
}
export function assertLabReferenceSnapshot(jobs: JobStore, job: Job, artifact: Artifact): void {
  if (!labReferenceEditPolicy(jobs, job)) return;
  const current = jobs.get(job.job_id),
    found = current.artifacts.find((a) => a.artifact_id === artifact.artifact_id);
  if (!found || labReferenceIdentity(current, found) !== labReferenceIdentity(job, artifact))
    return labReferenceFailure('The original Lab receipt or artifact identity changed.');
  labReferenceOutputProof(jobs, current, found);
}
export function assertLabReferenceBytes(jobs: JobStore, job: Job, artifact: Artifact, bytes: Buffer): void {
  if (!labReferenceEditPolicy(jobs, job)) return;
  assertLabReferenceSnapshot(jobs, job, artifact);
  const proof = labReferenceOutputProof(jobs, job, artifact);
  if (bytes.length !== proof.bytes || createHash('sha256').update(bytes).digest('hex') !== proof.sha256)
    return labReferenceFailure('Downloaded Lab bytes differ from the original verified result.');
}
