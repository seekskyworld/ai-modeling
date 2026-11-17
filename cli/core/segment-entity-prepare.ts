/** 当前GLB实体判据的只读准备；超出已证loader范围保旧行为，坏数据不降级。 */
import type { JobStore } from '../storage/jobs.ts';
import type { Gateway } from '../../studio/api/gateway.ts';
import type { Operation } from '../../studio/contracts/types.ts';
import type { SegmentEntitySnapshot } from '../../studio/api/segment-entity-snapshot.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import { fingerprint } from './fingerprint.ts';
import { scaleStepKey } from './smartsegment-scale-policy.ts';
import { transferChild, assertTransferStep } from './smartsegment-affine-transfer-policy.ts';
import { prepareSegmentEntitySource, assertSegmentEntitySource } from '../artifacts/segment-entity-source.ts';
import { scaleUrlBytes } from '../artifacts/smartsegment-scale-io.ts';
import { readVerifiedOutputCache, saveVerifiedOutputCache } from '../artifacts/verified-output-cache.ts';
import {
  applicableEntitySegment,
  entityPolicyFailure,
  segmentEntityPolicyKey,
  segmentEntityIntent,
  storedSegmentEntityPolicy,
  withSegmentEntityMarker,
  type SegmentEntityPolicy,
  segmentEntityMarker,
  assertSegmentEntityJob,
} from './segment-entity-policy.ts';

interface EntityGateway extends Gateway {
  segmentEntitySource?(account: string, input: Record<string, unknown>): Promise<SegmentEntitySnapshot>;
}
interface Preparation {
  jobs: JobStore;
  gateway: EntityGateway;
  account: string;
  request: string;
  operation: Operation;
  input: Record<string, unknown>;
  dataDir: string;
  checkAccount(): void;
}
/** Gateway 可跨 await；冻结调用方意图并检查外部输入和内部副本均未被异步改写。 */
function guardedPreparation(original: Preparation): Preparation {
  const input = structuredClone(original.input),
    intent = fingerprint(input);
  return {
    ...original,
    input,
    checkAccount: () => {
      original.checkAccount();
      if (fingerprint(original.input) !== intent || fingerprint(input) !== intent)
        entityPolicyFailure('The segment input changed during source preparation.');
    },
  };
}
function assertSnapshot(policy: SegmentEntityPolicy, current: SegmentEntitySnapshot): void {
  assertSegmentEntitySource(policy.proof, current, current.metadata);
  if (current.format !== 'glb' || current.resource_fingerprint !== policy.resource_fingerprint)
    entityPolicyFailure('The exact segment source resource changed during preparation.');
}
async function restorePreparation(
  x: Preparation,
  policy: SegmentEntityPolicy,
): Promise<Record<string, unknown>> {
  const bytes = await readVerifiedOutputCache(x.account, policy.proof, policy.cache_data_dir);
  x.checkAccount();
  if (!bytes) return entityPolicyFailure('The original prepared segment source cache is missing.');
  const current = await x.gateway.segmentEntitySource!(x.account, x.input);
  x.checkAccount();
  assertSnapshot(policy, current);
  const computed = await prepareSegmentEntitySource(bytes, current, current.metadata);
  x.checkAccount();
  if (fingerprint(computed) !== fingerprint(policy.proof))
    return entityPolicyFailure('The original segment entity derivation no longer matches its source.');
  if (fingerprint(storedSegmentEntityPolicy(x.jobs, x.account, x.request, x.input)) !== fingerprint(policy))
    return entityPolicyFailure('The prepared segment policy changed across a read.');
  return withSegmentEntityMarker(x.input, policy);
}
export async function prepareEntitySegmentInput(x: Preparation): Promise<Record<string, unknown>> {
  if (!applicableEntitySegment(x.operation, x.input)) return x.input;
  const existing = x.jobs.find(x.account, x.request);
  if (existing && existing.input[segmentEntityMarker] === undefined) {
    assertSegmentEntityJob(x.jobs, existing);
    return x.input;
  }
  x = guardedPreparation(x);
  // 变换链已有专属普通路线及逐面证明，不能被通用实体策略覆盖。
  if (x.jobs.requestPolicy(x.account, scaleStepKey(x.request))) return x.input;
  if (transferChild(x.request)) {
    assertTransferStep(x.jobs, x.account, x.request, x.operation, x.input);
    return x.input;
  }
  const prior = storedSegmentEntityPolicy(x.jobs, x.account, x.request, x.input);
  if (!x.gateway.segmentEntitySource) {
    if (prior) return entityPolicyFailure('This gateway cannot recover the original segment source proof.');
    return x.input;
  }
  if (prior) return await restorePreparation(x, prior);
  const source = structuredClone(await x.gateway.segmentEntitySource(x.account, x.input));
  x.checkAccount();
  if (source.format !== 'glb') return x.input;
  const bytes = await scaleUrlBytes(source.url, x.dataDir);
  x.checkAccount();
  let proof;
  try {
    proof = await prepareSegmentEntitySource(bytes, source, source.metadata);
  } catch (error) {
    x.checkAccount();
    if (error instanceof TripoError && error.code === 'SEGMENT_ENTITY_UNSUPPORTED') return x.input;
    throw error;
  }
  x.checkAccount();
  const policy: SegmentEntityPolicy = {
    version: 1,
    account_ref: x.account,
    request_id: x.request,
    intent: segmentEntityIntent(x.input),
    proof,
    resource_fingerprint: source.resource_fingerprint,
    cache_data_dir: x.dataDir,
  };
  const after = await x.gateway.segmentEntitySource(x.account, x.input);
  x.checkAccount();
  assertSnapshot(policy, after);
  await saveVerifiedOutputCache(
    { account_ref: x.account },
    { artifact_id: 'segment-source', kind: 'model', format: 'glb', index: 0 },
    proof,
    bytes,
    x.dataDir,
  );
  x.checkAccount();
  x.jobs.bindRequestPolicy(
    x.account,
    segmentEntityPolicyKey(x.request),
    policy as unknown as Record<string, unknown>,
  );
  const persisted = storedSegmentEntityPolicy(x.jobs, x.account, x.request, x.input);
  if (fingerprint(persisted) !== fingerprint(policy))
    return entityPolicyFailure('A different segment preparation won the original request.');
  return withSegmentEntityMarker(x.input, policy);
}
