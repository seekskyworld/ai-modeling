/** 原 Lab 表示证明与后处理来源链分开保存；旧 v1 直源回执保持原格式。 */
import { isDeepStrictEqual } from 'node:util';
import type { JobStore } from '../storage/jobs.ts';
import type { Job, Operation } from '../../studio/contracts/types.ts';
import { text } from '../../studio/contracts/errors.ts';
import { fingerprint } from '../core/fingerprint.ts';
import {
  labModelSourceProof,
  labModelSourceDisclosure,
  labModelSourceFail,
  type LabModelRepresentation,
  type LabModelSourceProof,
} from './lab-model-source-policy.ts';
import {
  labModelDeliveryKey,
  labModelConflict,
  labModelJobIdentity,
  labModelSourceParameters,
  bindLabModelProcessingTarget,
} from './lab-model-lineage-target.ts';
import {
  labModelIsolationProof,
  labModelIsolationDisclosure,
  assertLabModelIsolationGuards,
} from './lab-model-isolation-policy.ts';

interface ValidatedDelivery {
  marker: Record<string, unknown>;
  proof: LabModelSourceProof;
  lineage: Record<string, unknown>[];
}
function currentJob(jobs: JobStore, account: string, job: Job): Job {
  const saved = jobs.get(job.job_id);
  if (saved.account_ref !== account || job.account_ref !== account)
    return labModelSourceFail('The downstream Lab source belongs to another account.');
  if (!isDeepStrictEqual(labModelJobIdentity(saved), labModelJobIdentity(job)))
    return labModelConflict('The processing source changed after it was selected.');
  return saved;
}
function originalProof(
  jobs: JobStore,
  account: string,
  selected: Record<string, unknown>,
): LabModelSourceProof {
  const source = jobs.get(text(selected.source_job_id));
  if (source.account_ref !== account)
    return labModelSourceFail('The downstream Lab source belongs to another account.');
  const proof = labModelSourceProof(jobs, source);
  if (
    !proof ||
    selected.representation !== 'studio_normalized' ||
    selected.source_proof !== fingerprint(proof)
  )
    return labModelConflict('The frozen original Studio Lab representation changed.');
  return proof;
}
function assertDirect(
  selected: Record<string, unknown>,
  proof: LabModelSourceProof,
  operation: Operation,
  input: Record<string, unknown>,
): void {
  const expected = operation === 'copy' ? input.operator_id : input.expected_operator_id;
  if (
    selected.operation !== operation ||
    selected.project_id !== proof.target.project_id ||
    selected.operator_id !== proof.target.operator_id ||
    input.project_id !== proof.target.project_id ||
    expected !== proof.target.operator_id
  )
    return labModelConflict('The original downstream operation or Studio Lab representation changed.');
  for (const key of [
    'operator_id',
    'expected_operator_id',
    'current_operator_id',
    'source_operator_id',
    'candidate_operator_id',
  ])
    if (input[key] !== undefined && input[key] !== proof.target.operator_id)
      return labModelConflict(
        'A downstream source operator differs from the frozen Studio Lab representation.',
      );
}
function lineageStep(jobs: JobStore, job: Job, marker: Record<string, unknown>): Record<string, unknown> {
  const isolation = labModelIsolationDisclosure(jobs, job);
  return {
    job_id: job.job_id,
    request_id: job.request_id,
    operation: job.operation,
    input_hash: job.input_hash,
    source_job_id: marker.version === 1 ? marker.source_job_id : marker.upstream_job_id,
    source_parameters: labModelSourceParameters(job.input),
    ...(marker.version === 2 ? { source_target: marker.target } : {}),
    remote_ids: job.remote_ids,
    remote_ids_fingerprint: fingerprint(job.remote_ids),
    ...(isolation ? { source_isolation: isolation } : {}),
  };
}
function summaryFor(jobs: JobStore, job: Job, validated: ValidatedDelivery): Record<string, unknown> {
  const isolation = labModelIsolationDisclosure(jobs, job);
  return {
    source_representation: 'studio_normalized',
    lab_model_source:
      validated.marker.version === 1
        ? {
            ...labModelSourceDisclosure(validated.proof),
            ...(isolation ? { source_isolation: isolation } : {}),
          }
        : {
            ...labModelSourceDisclosure(validated.proof),
            processing_lineage: [...validated.lineage, lineageStep(jobs, job, validated.marker)],
          },
  };
}
function validatedUpstream(
  jobs: JobStore,
  account: string,
  source: Job,
  seen: Set<string>,
): { job: Job; validated: ValidatedDelivery; summary: Record<string, unknown> } {
  const job = currentJob(jobs, account, source);
  if (job.state !== 'succeeded')
    return labModelConflict('Wait for the verified preceding task before continuing its Lab source chain.');
  labModelIsolationProof(jobs, job);
  const validated = readDelivery(jobs, account, job.request_id, job.operation, job.input, seen);
  if (!validated) return labModelConflict('The preceding task has no persisted, verified Lab source marker.');
  return { job, validated, summary: summaryFor(jobs, job, validated) };
}
function readInherited(
  jobs: JobStore,
  account: string,
  selected: Record<string, unknown>,
  proof: LabModelSourceProof,
  operation: Operation,
  input: Record<string, unknown>,
  seen: Set<string>,
): ValidatedDelivery {
  const source = jobs.get(text(selected.upstream_job_id)),
    upstream = validatedUpstream(jobs, account, source, seen),
    bound = bindLabModelProcessingTarget(upstream.job, operation, input, false);
  if (
    selected.operation !== operation ||
    !isDeepStrictEqual(selected.upstream_identity, labModelJobIdentity(upstream.job)) ||
    selected.upstream_marker !== fingerprint(upstream.validated.marker) ||
    selected.upstream_summary !== fingerprint(upstream.summary) ||
    fingerprint(upstream.validated.proof) !== fingerprint(proof) ||
    !isDeepStrictEqual(selected.target, bound.target) ||
    !isDeepStrictEqual(selected.parameters, bound.parameters)
  )
    return labModelConflict(
      'The frozen processing source, receipt, summary or downstream model version changed.',
    );
  return {
    marker: selected,
    proof,
    lineage: [...upstream.validated.lineage, lineageStep(jobs, upstream.job, upstream.validated.marker)],
  };
}
function readDelivery(
  jobs: JobStore,
  account: string,
  request: string,
  operation: Operation,
  input: Record<string, unknown>,
  seen = new Set<string>(),
): ValidatedDelivery | undefined {
  const selected = jobs.requestPolicy(account, labModelDeliveryKey(request));
  if (!selected) return;
  if (seen.has(request) || seen.size >= 64)
    return labModelConflict(
      'The Lab processing lineage contains a cycle or exceeds the verified depth limit.',
    );
  const next = new Set(seen).add(request),
    proof = originalProof(jobs, account, selected);
  assertLabModelIsolationGuards(jobs, account, request, proof);
  if (selected.version === 1) {
    assertDirect(selected, proof, operation, input);
    return { marker: selected, proof, lineage: [] };
  }
  if (selected.version === 2) return readInherited(jobs, account, selected, proof, operation, input, next);
  return labModelConflict('The Lab processing lineage marker version is unsupported.');
}
function directMarker(
  jobs: JobStore,
  source: Job,
  operation: Operation,
  representation: LabModelRepresentation,
): Record<string, unknown> {
  const proof = labModelSourceProof(jobs, source);
  if (representation !== 'studio_normalized' || !proof)
    return labModelSourceFail('The downstream Lab representation has no frozen source proof.');
  return {
    version: 1,
    operation,
    representation,
    source_job_id: source.job_id,
    source_proof: fingerprint(proof),
    project_id: proof.target.project_id,
    operator_id: proof.target.operator_id,
  };
}
/** 第七参为实际提交参数；继承分支仅补缺省版本守卫，不替换调用方已选择的身份。 */
export function bindLabModelSourceDelivery(
  jobs: JobStore,
  account: string,
  downstreamRequest: string,
  operation: Operation,
  source: Job | undefined,
  representation?: LabModelRepresentation,
  params?: Record<string, unknown>,
): void {
  const existing = jobs.requestPolicy(account, labModelDeliveryKey(downstreamRequest)),
    inherited = source && jobs.requestPolicy(source.account_ref, labModelDeliveryKey(source.request_id));
  if (representation === undefined && !inherited) {
    if (existing) labModelConflict('The original downstream request selected a Studio Lab representation.');
    return;
  }
  if (!source) return labModelSourceFail('The selected downstream Lab source is missing.');
  source = currentJob(jobs, account, source);
  if (!existing && jobs.find(account, downstreamRequest))
    return labModelConflict('An existing downstream task cannot acquire a later Lab source proof.');
  if (representation !== undefined) {
    const marker = directMarker(jobs, source, operation, representation);
    assertLabModelIsolationGuards(jobs, account, downstreamRequest, originalProof(jobs, account, marker));
    if (params) assertDirect(marker, originalProof(jobs, account, marker), operation, params);
    jobs.bindRequestPolicy(account, labModelDeliveryKey(downstreamRequest), marker);
    return;
  }
  if (!params)
    return labModelConflict('Inherited Lab processing requires the exact resolved downstream parameters.');
  const upstream = validatedUpstream(jobs, account, source, new Set([downstreamRequest])),
    boundInput = { ...params },
    bound = bindLabModelProcessingTarget(upstream.job, operation, boundInput, true);
  const marker = {
    version: 2,
    operation,
    representation: 'studio_normalized',
    source_job_id: upstream.validated.proof.job_id,
    source_proof: fingerprint(upstream.validated.proof),
    upstream_job_id: upstream.job.job_id,
    upstream_identity: labModelJobIdentity(upstream.job),
    upstream_marker: fingerprint(upstream.validated.marker),
    upstream_summary: fingerprint(upstream.summary),
    target: bound.target,
    parameters: bound.parameters,
  };
  jobs.bindRequestPolicy(account, labModelDeliveryKey(downstreamRequest), marker);
  Object.assign(params, boundInput);
}
/** 提交四个检查点与 get/list 共用递归守卫，已提交链恢复只读取冻结本地事实。 */
export function assertLabModelSourceSubmission(
  jobs: JobStore,
  account: string,
  request: string,
  operation: Operation,
  input: Record<string, unknown>,
): void {
  readDelivery(jobs, account, request, operation, input);
}
export function labModelSourceSummary(jobs: JobStore, job: Job): Record<string, unknown> | undefined {
  const validated = readDelivery(jobs, job.account_ref, job.request_id, job.operation, job.input);
  return validated ? summaryFor(jobs, job, validated) : undefined;
}
/** redoPlan 已决定的贴图种子/来源仍是准绳；只恢复显式来源选择，不修改历史任务。 */
export function redoLabModelSourceSelection(
  jobs: JobStore,
  job: Job,
  input: Record<string, unknown>,
): { source: string; sourceRepresentation?: LabModelRepresentation } | undefined {
  const validated = readDelivery(jobs, job.account_ref, job.request_id, job.operation, job.input);
  if (!validated) return;
  currentJob(jobs, job.account_ref, job);
  const seededTexture = job.operation === 'texture' && job.input.action === 'generate';
  if (
    seededTexture &&
    input.expected_operator_id === job.remote_ids.operator_id &&
    text(job.remote_ids.operator_id)
  ) {
    if (job.state !== 'succeeded')
      return labModelConflict('Only a completed texture result can become the redo source.');
    bindLabModelProcessingTarget(job, job.operation, input, false);
    return { source: job.job_id };
  }
  const selected = validated.marker;
  if (selected.version === 1) {
    assertDirect(selected, validated.proof, job.operation, input);
    return { source: text(selected.source_job_id), sourceRepresentation: 'studio_normalized' };
  }
  const source = jobs.get(text(selected.upstream_job_id));
  bindLabModelProcessingTarget(source, job.operation, input, false);
  return { source: source.job_id };
}
