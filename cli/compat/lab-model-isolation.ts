/** 复制成功后先独立读取原文件并验SHA/大小；验证失败只保留原copy回执，绝不再复制。 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Job } from '../../studio/contracts/types.ts';
import type { LabModelSourceContext } from './lab-model-source.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import { fingerprint } from '../core/fingerprint.ts';
import { readVerifiedOutputCache, saveVerifiedOutputCache } from '../artifacts/verified-output-cache.ts';
import { downloadArtifactBytes } from '../artifacts/download.ts';
import { readLabModelCopySource } from '../../studio/api/lab-model-copy-source.ts';
import { labModelJobIdentity } from './lab-model-lineage-target.ts';
import {
  labModelIsolationOrigin,
  labModelIsolationProof,
  labModelIsolationProofKey,
  labModelIsolationFail,
  type LabModelIsolationProof,
} from './lab-model-isolation-policy.ts';
export { freezeLabModelIsolationLayout } from './lab-model-isolation-layout.ts';
export { labModelIsolationProof, labModelIsolationDisclosure } from './lab-model-isolation-policy.ts';

export async function prepareLabModelIsolationCopy(
  context: LabModelSourceContext,
  copy: Job,
): Promise<LabModelIsolationProof | undefined> {
  const { jobs, dataDir } = context,
    original = labModelIsolationOrigin(jobs, copy);
  if (!original) return;
  const before = labModelJobIdentity(copy);
  const check = () => {
    if (context.accountRef() !== copy.account_ref)
      throw new TripoError('ACCOUNT_MISMATCH', 'The account changed during isolated Lab copy verification.');
    const current = jobs.get(copy.job_id),
      source = labModelIsolationOrigin(jobs, current);
    if (
      current.state !== 'succeeded' ||
      !isDeepStrictEqual(before, labModelJobIdentity(current)) ||
      fingerprint(source) !== fingerprint(original)
    )
      labModelIsolationFail('The isolated Lab copy or its original source changed during verification.');
  };
  check();
  if (copy.remote_ids.project_id === original.proof.target.project_id || !copy.remote_ids.operator_id)
    return labModelIsolationFail('The isolated copy must have its own exact Studio project and operator.');
  if (original.proof.cache_data_dir !== dataDir)
    return labModelIsolationFail(
      'The original Studio representation cache belongs to another data directory.',
    );
  const reference = await readVerifiedOutputCache(copy.account_ref, original.proof.geometry.studio, dataDir);
  check();
  if (!reference)
    return labModelIsolationFail('Restore the exact verified Studio source bytes before checking its copy.');
  const prior = labModelIsolationProof(jobs, copy, true);
  if (prior) {
    if (
      prior.cache_data_dir !== dataDir ||
      !(await readVerifiedOutputCache(copy.account_ref, prior, dataDir))
    )
      return labModelIsolationFail('The original verified isolated-copy cache is unavailable.');
    check();
    if (context.checkTargetCurrent !== false) {
      const resolved = await readLabModelCopySource(context.client, copy);
      check();
      if (!isDeepStrictEqual(prior.target, resolved.target))
        return labModelIsolationFail('The isolated copy metadata or exact storage object changed.');
    }
    return prior;
  }
  const resolved = await readLabModelCopySource(context.client, copy);
  check();
  const bytes = await downloadArtifactBytes(resolved.url, 'glb', context.fetcher);
  check();
  const sha256 = createHash('sha256').update(bytes).digest('hex'),
    expected = original.proof.geometry.studio;
  if (bytes.length !== expected.bytes || sha256 !== expected.sha256 || !bytes.equals(reference))
    return labModelIsolationFail(
      'The isolated copy does not preserve the exact frozen Studio GLB bytes. Its receipt is retained; do not repeat the copy.',
    );
  const after = await readLabModelCopySource(context.client, copy);
  check();
  if (!isDeepStrictEqual(resolved.target, after.target))
    return labModelIsolationFail('The isolated copy changed while its original bytes were verified.');
  await saveVerifiedOutputCache(
    copy,
    { artifact_id: 'lab-isolated-copy', kind: 'model', format: 'glb', index: 0 },
    expected,
    bytes,
    dataDir,
  );
  check();
  const proof: LabModelIsolationProof = {
    version: 1,
    source_job_id: original.proof.job_id,
    source_proof: fingerprint(original.proof),
    copy_identity: before,
    intent: original.intent,
    sha256,
    bytes: bytes.length,
    target: resolved.target,
    original_metadata: original.proof.target.metadata,
    metadata_preserved: isDeepStrictEqual(resolved.target.metadata, original.proof.target.metadata),
    cache_data_dir: dataDir,
  };
  jobs.bindRequestPolicy(copy.account_ref, labModelIsolationProofKey(copy), { ...proof });
  return labModelIsolationProof(jobs, jobs.get(copy.job_id));
}
