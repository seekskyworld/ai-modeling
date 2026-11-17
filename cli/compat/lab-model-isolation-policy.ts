/** 隔离复制证明独立于原Lab保真证明；只验证已冻结Studio表示的原文件字节。 */
import { isDeepStrictEqual } from 'node:util';
import type { JobStore } from '../storage/jobs.ts';
import type { Job } from '../../studio/contracts/types.ts';
import type { LabModelCopyTarget } from '../../studio/api/lab-model-copy-source.ts';
import { assertLabModelCopyMetadata } from '../../studio/api/lab-model-copy-source.ts';
import { array, object, text, TripoError } from '../../studio/contracts/errors.ts';
import { fingerprint } from '../core/fingerprint.ts';
import { labModelSourceProof, type LabModelSourceProof } from './lab-model-source-policy.ts';
import { labModelDeliveryKey, labModelJobIdentity } from './lab-model-lineage-target.ts';
import { labModelIsolationLayoutKey, labModelIsolationRequestKey } from './lab-model-isolation-layout.ts';

export const labModelIsolationProofKey = (job: Job): string => `lab-model-copy-proof:${job.job_id}`;
export const labModelIsolationFail = (message: string): never => {
  throw new TripoError('LAB_MODEL_ISOLATION_UNVERIFIED', message, 'not_submitted');
};
export interface LabModelIsolationProof {
  version: 1;
  source_job_id: string;
  source_proof: string;
  copy_identity: Record<string, unknown>;
  intent: string;
  sha256: string;
  bytes: number;
  target: LabModelCopyTarget;
  original_metadata: Record<string, unknown>;
  metadata_preserved: boolean;
  cache_data_dir: string;
}
/** 重写下游占位前保存的原版本限制仍须先通过，不能用隔离复制绕开调用方指定的另一版本。 */
export function assertLabModelIsolationGuards(
  jobs: JobStore,
  account: string,
  request: string,
  proof: LabModelSourceProof,
): void {
  const selected = jobs.requestPolicy(account, labModelIsolationRequestKey(request));
  if (!selected) return;
  const layout = jobs.requestPolicy(account, labModelIsolationLayoutKey(text(selected.parent)));
  if (
    !layout ||
    selected.version !== 1 ||
    layout.version !== 1 ||
    !['copy', 'existing_copy'].includes(text(layout.mode)) ||
    selected.layout !== fingerprint(layout) ||
    request !== `${text(selected.parent)}-0`
  )
    return labModelIsolationFail('The isolated copy source-guard layout changed.');
  const guards = array(layout.source_guards);
  if (!guards.length) return labModelIsolationFail('The original Lab source guards are missing.');
  for (const value of guards) {
    const guard = object(value),
      params = object(guard.parameters);
    if (!Number.isInteger(guard.index) || Number(guard.index) < 0 || !guard.parameters)
      return labModelIsolationFail('The original Lab source guard position is invalid.');
    for (const [key, expected] of Object.entries(params)) {
      if (
        ![
          'project_id',
          'operator_id',
          'expected_operator_id',
          'current_operator_id',
          'source_operator_id',
        ].includes(key)
      )
        return labModelIsolationFail('An unsupported original Lab source guard cannot be isolated.');
      if (
        expected !== 'upstream' &&
        expected !== (key === 'project_id' ? proof.target.project_id : proof.target.operator_id)
      )
        return labModelIsolationFail(
          'The requested original model version differs from the selected Lab representation.',
        );
    }
  }
}
export function labModelIsolationOrigin(
  jobs: JobStore,
  copy: Job,
): { proof: LabModelSourceProof; intent: string } | undefined {
  const selected = jobs.requestPolicy(copy.account_ref, labModelIsolationRequestKey(copy.request_id));
  if (!selected) return;
  const layout = jobs.requestPolicy(copy.account_ref, labModelIsolationLayoutKey(text(selected.parent))),
    delivery = jobs.requestPolicy(copy.account_ref, labModelDeliveryKey(copy.request_id));
  if (
    !layout ||
    layout.version !== 1 ||
    !['copy', 'existing_copy'].includes(text(layout.mode)) ||
    selected.version !== 1 ||
    selected.layout !== fingerprint(layout) ||
    copy.request_id !== `${text(selected.parent)}-0` ||
    copy.operation !== 'copy' ||
    !delivery ||
    delivery.version !== 1 ||
    delivery.operation !== 'copy' ||
    delivery.representation !== 'studio_normalized'
  )
    return labModelIsolationFail(
      'The isolated copy no longer matches its original layout and direct Lab selection.',
    );
  const source = jobs.get(text(delivery.source_job_id)),
    proof = labModelSourceProof(jobs, source);
  if (
    source.account_ref !== copy.account_ref ||
    !proof ||
    delivery.source_proof !== fingerprint(proof) ||
    delivery.project_id !== proof.target.project_id ||
    delivery.operator_id !== proof.target.operator_id ||
    copy.input.project_id !== proof.target.project_id ||
    copy.input.operator_id !== proof.target.operator_id
  )
    return labModelIsolationFail('The isolated copy source differs from its frozen Studio representation.');
  assertLabModelIsolationGuards(jobs, copy.account_ref, copy.request_id, proof);
  return { proof, intent: fingerprint(selected) };
}
/** allowPending只用于刚收到copy回执的公开状态；后继绑定必须使用缺省严格模式。 */
export function labModelIsolationProof(
  jobs: JobStore,
  copy: Job,
  allowPending = false,
): LabModelIsolationProof | undefined {
  const original = labModelIsolationOrigin(jobs, copy);
  if (!original) return;
  const saved = jobs.requestPolicy(copy.account_ref, labModelIsolationProofKey(copy));
  if (!saved && allowPending) return;
  if (!saved)
    return labModelIsolationFail('Verify the isolated copy bytes before continuing the Lab source chain.');
  const target = object(saved.target),
    geometry = original.proof.geometry.studio;
  if (
    copy.state !== 'succeeded' ||
    saved.version !== 1 ||
    saved.source_job_id !== original.proof.job_id ||
    saved.source_proof !== fingerprint(original.proof) ||
    saved.intent !== original.intent ||
    !isDeepStrictEqual(saved.copy_identity, labModelJobIdentity(copy)) ||
    saved.sha256 !== geometry.sha256 ||
    saved.bytes !== geometry.bytes ||
    !validIsolationTarget(saved, copy, original.proof) ||
    !text(saved.cache_data_dir)
  )
    return labModelIsolationFail('The isolated copy identity, source proof or verified bytes changed.');
  assertLabModelCopyMetadata(object(target.metadata));
  return saved as unknown as LabModelIsolationProof;
}
function validIsolationTarget(
  saved: Record<string, unknown>,
  copy: Job,
  original: LabModelSourceProof,
): boolean {
  const target = object(saved.target);
  return (
    target.project_id === copy.remote_ids.project_id &&
    target.operator_id === copy.remote_ids.operator_id &&
    target.project_id !== original.target.project_id &&
    target.is_pbr === false &&
    Boolean(target.metadata) &&
    typeof target.metadata === 'object' &&
    !Array.isArray(target.metadata) &&
    /^[a-f0-9]{64}$/.test(text(target.resource_identity)) &&
    isDeepStrictEqual(saved.original_metadata, original.target.metadata) &&
    saved.metadata_preserved === isDeepStrictEqual(target.metadata, original.target.metadata)
  );
}
export function labModelIsolationDisclosure(jobs: JobStore, copy: Job): Record<string, unknown> | undefined {
  if (!labModelIsolationOrigin(jobs, copy)) return;
  const proof = labModelIsolationProof(jobs, copy, true);
  if (!proof)
    return {
      status: 'pending',
      required: 'The exact copied GLB bytes must be verified before downstream processing.',
    };
  return {
    status: 'verified',
    copy_job_id: copy.job_id,
    project_id: proof.target.project_id,
    operator_id: proof.target.operator_id,
    sha256: proof.sha256,
    bytes: proof.bytes,
    original_metadata: proof.original_metadata,
    copied_metadata: proof.target.metadata,
    metadata_preserved: proof.metadata_preserved,
    note: 'The isolated historical copy preserves the exact Studio GLB bytes. Saved display/material metadata is reported separately and may differ; no original Lab coordinate or normal-precision preservation is claimed.',
  };
}
