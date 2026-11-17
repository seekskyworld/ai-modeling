/** 实体分流为本地派生义务；input_hash、内部 marker 与独立策略互相绑定，不能退回旧判据。 */
import type { Job, Operation } from '../../studio/contracts/types.ts';
import type { SubmissionOptions } from '../../studio/api/segment-route.ts';
import { errorResult, object, text, TripoError } from '../../studio/contracts/errors.ts';
import type { JobStore } from '../storage/jobs.ts';
import { fingerprint } from './fingerprint.ts';
import { assertSegmentEntitySource, type SegmentEntitySource } from '../artifacts/segment-entity-source.ts';
import { hasVerifiedOutputCache } from '../artifacts/verified-output-cache.ts';

export const segmentEntityMarker = '_segment_entity_route';
export const segmentEntityPolicyKey = (request: string): string => `segment-entity-route:${request}`;
export const segmentEntityIntent = (input: Record<string, unknown>): string => {
  const plain = { ...input };
  delete plain[segmentEntityMarker];
  return fingerprint(plain);
};
export interface SegmentEntityPolicy {
  version: 1;
  account_ref: string;
  request_id: string;
  intent: string;
  proof: SegmentEntitySource;
  resource_fingerprint: string;
  cache_data_dir: string;
}
export const entityPolicyFailure = (message: string): never => {
  throw new TripoError('SEGMENT_ENTITY_POLICY_CHANGED', message, 'not_submitted');
};
export function storedSegmentEntityPolicy(
  jobs: JobStore,
  account: string,
  request: string,
  input: Record<string, unknown>,
): SegmentEntityPolicy | undefined {
  const raw = jobs.requestPolicy(account, segmentEntityPolicyKey(request));
  if (!raw) return;
  const policy = raw as unknown as SegmentEntityPolicy;
  if (
    policy.version !== 1 ||
    policy.account_ref !== account ||
    policy.request_id !== request ||
    policy.intent !== segmentEntityIntent(input) ||
    !/^[a-f0-9]{64}$/.test(policy.resource_fingerprint) ||
    !policy.cache_data_dir ||
    !policy.proof ||
    policy.proof.project_id !== input.project_id ||
    (input.expected_operator_id !== undefined && policy.proof.operator_id !== input.expected_operator_id)
  )
    return entityPolicyFailure('The original segment source or public request intent changed.');
  assertSegmentEntitySource(
    policy.proof,
    {
      account_ref: account,
      project_id: text(input.project_id),
      operator_id: policy.proof.operator_id,
    },
    policy.proof.metadata,
  );
  return policy;
}
export function withSegmentEntityMarker(
  input: Record<string, unknown>,
  policy: SegmentEntityPolicy,
): Record<string, unknown> {
  return { ...input, [segmentEntityMarker]: { version: 1, policy: fingerprint(policy) } };
}
export function assertSegmentEntityJob(
  jobs: JobStore,
  job: Pick<Job, 'account_ref' | 'request_id' | 'operation' | 'input' | 'input_hash'>,
  requireCache = false,
): SegmentEntityPolicy | undefined {
  const marker = object(job.input[segmentEntityMarker]);
  const raw = jobs.requestPolicy(job.account_ref, segmentEntityPolicyKey(job.request_id));
  // 旧请求无新 marker/策略仍按旧路线；原 input_hash 可识别新请求同时被删两项的损坏。
  if (
    job.operation === 'segment' &&
    fingerprint({ operation: job.operation, input: job.input }) !== job.input_hash
  )
    return entityPolicyFailure('The original segment task input hash changed.');
  if (!raw && job.input[segmentEntityMarker] === undefined) return;
  if (job.operation !== 'segment' || job.input.model_version !== 'v2.0-20260430' || marker.version !== 1)
    return entityPolicyFailure('The segment route marker is missing or belongs to another operation.');
  const policy = storedSegmentEntityPolicy(jobs, job.account_ref, job.request_id, job.input);
  if (!policy || marker.policy !== fingerprint(policy))
    return entityPolicyFailure('The original segment route proof is missing or changed.');
  if (requireCache && !hasVerifiedOutputCache(job.account_ref, policy.proof, policy.cache_data_dir))
    return entityPolicyFailure('The exact source bytes changed before segmentation.');
  return policy;
}
/** 异步下载后的记录不能换成另一个请求；原证明丢失时保留远端事实并拒绝交付。 */
export function assertSegmentEntitySnapshot(jobs: JobStore, expected: Job): void {
  const before = assertSegmentEntityJob(jobs, expected),
    current = jobs.get(expected.job_id),
    after = assertSegmentEntityJob(jobs, current);
  if (!before && !after) return;
  if (
    current.request_id !== expected.request_id ||
    current.account_ref !== expected.account_ref ||
    current.input_hash !== expected.input_hash ||
    fingerprint(current.input) !== fingerprint(expected.input) ||
    fingerprint(current.remote_ids) !== fingerprint(expected.remote_ids) ||
    fingerprint(before) !== fingerprint(after)
  )
    entityPolicyFailure('The original segment route or receipt changed during delivery.');
}
export function segmentEntityFailureView(jobs: JobStore, job: Job): Record<string, unknown> | undefined {
  try {
    assertSegmentEntityJob(jobs, job);
  } catch (error) {
    return {
      state: 'needs_attention',
      remote_state: job.state,
      error: errorResult(error),
      segment_route_validation: { status: 'unverified' },
      next_action: 'Restore the original segment route proof; do not create a new segmentation request.',
    };
  }
}
export function segmentEntitySubmissionOptions(jobs: JobStore, job: Job): SubmissionOptions | undefined {
  const policy = assertSegmentEntityJob(jobs, job, true);
  if (!policy) return;
  return {
    segmentRoute: {
      kind: 'verified_entities',
      strategy: policy.proof.strategy,
      project_id: policy.proof.project_id,
      expected_operator_id: policy.proof.operator_id,
      metadata: policy.proof.metadata,
      resource_fingerprint: policy.resource_fingerprint,
      entity_count: policy.proof.inspection.entity_count,
    },
  };
}
export function applicableEntitySegment(operation: Operation, input: Record<string, unknown>): boolean {
  return operation === 'segment' && input.model_version === 'v2.0-20260430';
}
