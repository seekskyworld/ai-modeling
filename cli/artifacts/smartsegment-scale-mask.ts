/** PNG交付用原回执冻结缓存和已登记文件节点；恢复不重新分割、不补登记未知旧目录。 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Artifact, Job } from '../../studio/contracts/types.ts';
import type { JobStore } from '../storage/jobs.ts';
import type { Gateway } from '../../studio/api/gateway.ts';
import { text, TripoError } from '../../studio/contracts/errors.ts';
import { outputTarget } from '../../studio/files.ts';
import { localTarget, publishLocal } from '../local/files.ts';
import { registeredFrontendTarget } from '../core/frontend-delivery.ts';
import { smartSegmentImportIdentity } from '../core/smartsegment-transform-policy.ts';
import { assertAffineDelivery } from '../core/smartsegment-affine-policy.ts';
import {
  assertScaleMaskSnapshot,
  scaleMaskContext,
  scaleMaskKey,
  scaleMaskProof,
} from '../core/smartsegment-scale-mask-policy.ts';
import { downloadedContent } from './content-validation.ts';
import { downloadArtifactBytes } from './download.ts';
import { verifiedArtifactBytes } from './recover-download.ts';
import { readVerifiedOutputCache, saveVerifiedOutputCache } from './verified-output-cache.ts';

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
export function assertScaleMaskBytes(jobs: JobStore, job: Job, artifact: Artifact, bytes: Buffer): void {
  const proof = scaleMaskProof(jobs, job, artifact);
  if (!proof || proof.sha256 !== sha(bytes) || proof.bytes !== bytes.length)
    throw new TripoError(
      'SMARTSEGMENT_SCALE_OUTPUT_CHANGED',
      'PNG bytes differ from the original frozen segmentation mask.',
      'read',
    );
}
export async function downloadSmartSegmentScaleMask(
  jobs: JobStore,
  job: Job,
  artifact: Artifact,
  destination: { root: string; relative: string },
  dataDir: string,
  gateway: Gateway,
  assertAccount: () => void,
): Promise<Record<string, unknown>> {
  const guard = (): void => {
    assertAccount();
    assertScaleMaskSnapshot(jobs, job, artifact);
    scaleMaskProof(jobs, job, artifact);
    assertAffineDelivery(jobs, job);
    assertAccount();
  };
  guard();
  let proof = scaleMaskProof(jobs, job, artifact);
  let bytes = proof
    ? await readVerifiedOutputCache(
        job.account_ref,
        { sha256: text(proof.sha256), bytes: Number(proof.bytes) },
        text(proof.cache_data_dir),
      )
    : undefined;
  guard();
  bytes ??= await verifiedArtifactBytes(artifact);
  guard();
  if (!bytes) {
    const url = await gateway.artifactUrl(job, artifact);
    guard();
    bytes = await downloadArtifactBytes(url, 'png');
    guard();
  }
  if (downloadedContent(bytes, 'png').format !== 'png')
    throw new TripoError(
      'ARTIFACT_FORMAT_MISMATCH',
      'The original segmentation mask must be PNG bytes.',
      'read',
    );
  const digest = sha(bytes);
  if (
    (artifact.sha256 !== undefined && artifact.sha256 !== digest) ||
    (artifact.bytes !== undefined && artifact.bytes !== bytes.length)
  )
    throw new TripoError(
      'SMARTSEGMENT_SCALE_OUTPUT_CHANGED',
      'PNG bytes differ from the original artifact receipt.',
      'read',
    );
  if (proof) {
    assertScaleMaskBytes(jobs, job, artifact, bytes);
    await saveVerifiedOutputCache(
      job,
      artifact,
      { sha256: digest, bytes: bytes.length },
      bytes,
      text(proof.cache_data_dir),
    );
    guard();
  } else {
    const { modelProof } = scaleMaskContext(jobs, job, artifact);
    await saveVerifiedOutputCache(job, artifact, { sha256: digest, bytes: bytes.length }, bytes, dataDir);
    guard();
    jobs.bindArtifactPolicy(job, artifact, scaleMaskKey(job, artifact), {
      version: 1,
      identity: smartSegmentImportIdentity(job, artifact),
      model_identity: modelProof.identity,
      source_sha256: modelProof.source_sha256,
      sha256: digest,
      bytes: bytes.length,
      cache_data_dir: dataDir,
    });
    proof = scaleMaskProof(jobs, job, artifact)!;
  }
  const target = await outputTarget(destination.root, destination.relative);
  guard();
  if (path.extname(target).toLowerCase() !== '.png')
    throw new TripoError('OUTPUT_EXTENSION', 'Use a .png destination.');
  const current = jobs.get(job.job_id).artifacts.find((a) => a.artifact_id === artifact.artifact_id)!;
  if (registeredFrontendTarget(current, target, text(proof.identity)))
    return {
      local_path: target,
      sha256: proof.sha256,
      bytes: proof.bytes,
      format: 'png',
      restored_from_cache: true,
    };
  await localTarget(destination.root, destination.relative, 'png');
  guard();
  return { ...(await publishLocal(target, bytes, 'png', guard)), restored_from_cache: true };
}
