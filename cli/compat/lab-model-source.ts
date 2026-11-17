/** 先证明并缓存两份真实字节，再冻结下游来源；恢复只复用原绑定，不重新解释网页当前资产。 */
import type { JobStore } from '../storage/jobs.ts';
import type { Job } from '../../studio/contracts/types.ts';
import type { StudioClient, Fetcher } from '../../studio/api/client.ts';
import { assertLabModelTargetCurrent, resolveLabModelSource } from '../../studio/api/lab-model-source.ts';
import { readVerifiedOutputCache, saveVerifiedOutputCache } from '../artifacts/verified-output-cache.ts';
import { downloadArtifactBytes } from '../artifacts/download.ts';
import { fingerprint } from '../core/fingerprint.ts';
import { text, TripoError } from '../../studio/contracts/errors.ts';
import { verifyLabModelGeometry } from './lab-model-geometry.ts';
import { verifyLabModelPartitionGeometry } from './lab-model-partition-geometry.ts';
import {
  assertLabModelMetadata,
  labModelOriginal,
  labModelSourceFail,
  labModelSourceKey,
  labModelSourceProof,
  type LabModelRepresentation,
  type LabModelSourceProof,
} from './lab-model-source-policy.ts';
export {
  bindLabModelSource,
  labModelSourceDisclosure,
  labModelSourceProof,
  labModelSourceKey,
} from './lab-model-source-policy.ts';
export type { LabModelRepresentation, LabModelSourceProof } from './lab-model-source-policy.ts';
export {
  freezeLabModelSourceSelection,
  bindLabModelSourceDelivery,
  labModelSourceSummary,
  assertLabModelSourceSubmission,
  redoLabModelSourceSelection,
} from './lab-model-source-selection.ts';
export { freezeLabModelIsolationLayout, prepareLabModelIsolationCopy } from './lab-model-isolation.ts';

export interface LabModelSourceContext {
  jobs: JobStore;
  client: StudioClient;
  dataDir: string;
  accountRef(): string;
  fetcher?: Fetcher;
  /** 新下游请求须核同一 operator 的可变 metadata；已提交请求恢复可只读原缓存。 */
  checkTargetCurrent?: boolean;
}
export async function prepareLabModelSource(
  context: LabModelSourceContext,
  job: Job,
  representation: LabModelRepresentation,
): Promise<LabModelSourceProof> {
  if (representation !== 'studio_normalized')
    return labModelSourceFail('Explicit source_representation=studio_normalized is required.');
  const { jobs, dataDir } = context,
    account = context.accountRef();
  if (account !== job.account_ref)
    throw new TripoError('ACCOUNT_MISMATCH', 'The Lab source belongs to another account.');
  const original = labModelOriginal(jobs, job),
    output = { sha256: text(original.proof.sha256), bytes: Number(original.proof.bytes) };
  const check = () => {
    if (context.accountRef() !== account)
      throw new TripoError('ACCOUNT_MISMATCH', 'The account changed during Lab source verification.');
    const current = labModelOriginal(jobs, jobs.get(job.job_id));
    if (current.identity !== original.identity || fingerprint(current.proof) !== fingerprint(original.proof))
      labModelSourceFail('The original Lab source changed during representation verification.');
  };
  if (original.proof.cache_data_dir !== dataDir)
    return labModelSourceFail('The original Lab delivery cache belongs to another data directory.');
  const bytes = await readVerifiedOutputCache(account, output, dataDir);
  check();
  if (!bytes)
    return labModelSourceFail(
      'Restore the original verified Lab output cache; its Studio representation cannot replace the original delivery.',
    );
  const prior = labModelSourceProof(jobs, job);
  if (prior) {
    if (prior.cache_data_dir !== dataDir)
      return labModelSourceFail(
        'The original Studio representation cache belongs to another data directory.',
      );
    const cached = await readVerifiedOutputCache(account, prior.geometry.studio, dataDir);
    check();
    if (!cached)
      return labModelSourceFail(
        'The frozen Studio representation cache is missing. Recover the exact original bytes; do not reselect a later node result.',
      );
    const verified = original.partition
      ? await verifyLabModelPartitionGeometry(bytes, cached, original.partition)
      : await verifyLabModelGeometry(bytes, cached);
    check();
    if (fingerprint(verified) !== fingerprint(prior.geometry))
      return labModelSourceFail('The cached representation differs from its frozen geometry proof.');
    if (context.checkTargetCurrent !== false) {
      await assertLabModelTargetCurrent(context.client, account, prior.target);
      check();
    }
    return prior;
  }
  const resolved = await resolveLabModelSource(context.client, job, { ...original.artifact, ...output });
  check();
  assertLabModelMetadata(resolved.target);
  const studioBytes = await downloadArtifactBytes(resolved.url, 'glb', context.fetcher);
  check();
  const geometry = original.partition
    ? await verifyLabModelPartitionGeometry(bytes, studioBytes, original.partition)
    : await verifyLabModelGeometry(bytes, studioBytes);
  check();
  await assertLabModelTargetCurrent(context.client, account, resolved.target);
  check();
  await saveVerifiedOutputCache(
    job,
    { artifact_id: 'lab-studio-representation', kind: 'model', format: 'glb', index: 0 },
    geometry.studio,
    studioBytes,
    dataDir,
  );
  check();
  const proof: LabModelSourceProof = {
    version: original.partition ? 2 : 1,
    representation,
    task_type: original.task_type,
    job_id: job.job_id,
    account_ref: account,
    request_id: job.request_id,
    input_hash: job.input_hash,
    lab_output_identity: original.identity,
    lab_output_proof: fingerprint(original.proof),
    target: resolved.target,
    geometry,
    cache_data_dir: dataDir,
  };
  jobs.bindRequestPolicy(account, labModelSourceKey(job), { ...proof });
  return labModelSourceProof(jobs, jobs.get(job.job_id))!;
}
