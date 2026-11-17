/** 同一最终义务绑定原生GLB与PNG；交付从已验证原字节恢复，不重提任何原生步骤。 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Artifact, Job } from '../../studio/contracts/types.ts';
import type { Gateway } from '../../studio/api/gateway.ts';
import type { JobStore } from '../storage/jobs.ts';
import { object, text, TripoError } from '../../studio/contracts/errors.ts';
import { outputTarget } from '../../studio/files.ts';
import { fingerprint } from '../core/fingerprint.ts';
import { smartSegmentImportIdentity } from '../core/smartsegment-transform-policy.ts';
import { registeredFrontendTarget } from '../core/frontend-delivery.ts';
import { localTarget, publishLocal } from '../local/files.ts';
import {
  transferFail,
  transferFinalParent,
  transferOutputContext,
  transferOutputKey,
  transferOutputAnchorKey,
  transferOutputProof,
  assertTransferDelivery,
  assertTransferSnapshot,
} from '../core/smartsegment-affine-transfer-policy.ts';
import {
  hasVerifiedOutputCache,
  readVerifiedOutputCache,
  saveVerifiedOutputCache,
} from './verified-output-cache.ts';
import { verifyTransferOutput } from './smartsegment-affine-transfer-proof.ts';
import { nativeScaleBytes } from './smartsegment-scale-io.ts';
import { verifiedArtifactBytes } from './recover-download.ts';
import { downloadArtifactBytes } from './download.ts';
import { downloadedContent } from './content-validation.ts';
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
function byteProof(value: Record<string, unknown>) {
  return { sha256: text(value.sha256), bytes: Number(value.bytes) };
}
function proofForArtifact(proof: Record<string, unknown>, artifact: Artifact): Record<string, unknown> {
  if (artifact.kind === 'model' && artifact.format === 'glb') return proof;
  if (artifact.artifact_id === 'semantic-mask' && artifact.format === 'png') return object(proof.mask);
  return transferFail('Only the original final GLB and PNG can be delivered by the affine transfer.');
}
function savedGeometry(proof: Record<string, unknown>): Record<string, unknown> {
  const result = { ...proof };
  for (const key of [
    'identity',
    'intent',
    'source_binding',
    'import_binding',
    'edit_binding',
    'mask',
    'cache_data_dir',
  ])
    delete result[key];
  return result;
}
export async function ensureSmartSegmentTransferOutput(
  jobs: JobStore,
  job: Job,
  dataDir: string,
  gateway: Gateway,
  assertAccount: () => void,
): Promise<void> {
  if (!transferFinalParent(job)) return;
  const context = transferOutputContext(jobs, job),
    saved = transferOutputProof(jobs, job);
  const originalContext = fingerprint(context);
  const guard = (): void => {
    assertAccount();
    assertTransferSnapshot(jobs, job);
    if (fingerprint(transferOutputContext(jobs, job)) !== originalContext)
      transferFail('The original transfer obligations changed during final verification.');
    assertAccount();
  };
  if (
    saved &&
    [saved, object(saved.mask)].every((value) =>
      hasVerifiedOutputCache(job.account_ref, byteProof(value), text(saved.cache_data_dir)),
    )
  ) {
    guard();
    assertTransferDelivery(jobs, job);
    return;
  }
  const originals: Buffer[] = [];
  for (const stage of [context.source, context.imported.stage]) {
    const bytes = await readVerifiedOutputCache(
      job.account_ref,
      byteProof(stage),
      text(stage.cache_data_dir),
    );
    guard();
    if (!bytes)
      return transferFail(
        'Restore the exact original source/import cache without submitting native steps again.',
      );
    originals.push(bytes);
  }
  const final = await nativeScaleBytes(job, context.artifact, gateway, dataDir);
  guard();
  const proof = await verifyTransferOutput(originals[0]!, context.preparation, originals[1]!, final);
  guard();
  if (saved && fingerprint(savedGeometry(saved)) !== fingerprint(proof))
    return transferFail('The native affine geometry differs from its complete original final proof.');
  let mask = saved
    ? await readVerifiedOutputCache(
        job.account_ref,
        byteProof(object(saved.mask)),
        text(saved.cache_data_dir),
      )
    : undefined;
  guard();
  mask ??= await verifiedArtifactBytes(context.mask);
  guard();
  if (!mask) {
    const url = await gateway.artifactUrl(job, context.mask);
    guard();
    mask = await downloadArtifactBytes(url, 'png');
    guard();
  }
  if (downloadedContent(mask, 'png').format !== 'png')
    return transferFail('The final semantic mask must retain original PNG bytes.');
  const maskProof = {
    artifact_id: context.mask.artifact_id,
    identity: smartSegmentImportIdentity(job, context.mask),
    sha256: sha(mask),
    bytes: mask.length,
    format: 'png',
  };
  if (
    (context.mask.sha256 !== undefined && context.mask.sha256 !== maskProof.sha256) ||
    (context.mask.bytes !== undefined && context.mask.bytes !== maskProof.bytes) ||
    (saved && fingerprint(maskProof) !== fingerprint(saved.mask))
  )
    return transferFail('The original native mask receipt or exact bytes changed.');
  const cacheDirectory = saved ? text(saved.cache_data_dir) : dataDir;
  await saveVerifiedOutputCache(job, context.artifact, byteProof(proof), final, cacheDirectory);
  guard();
  await saveVerifiedOutputCache(job, context.mask, byteProof(maskProof), mask, cacheDirectory);
  guard();
  if (!saved) {
    const complete = {
      ...proof,
      identity: smartSegmentImportIdentity(job, context.artifact),
      intent: fingerprint(context.intent),
      source_binding: fingerprint(context.source),
      import_binding: fingerprint(context.imported.stage),
      edit_binding: fingerprint(context.edited.edit),
      mask: maskProof,
      cache_data_dir: dataDir,
    };
    jobs.bindArtifactPolicy(job, context.artifact, transferOutputKey(job), complete);
    jobs.bindRequestPolicy(job.account_ref, transferOutputAnchorKey(job), { output: fingerprint(complete) });
  }
  assertTransferDelivery(jobs, job);
}
export function assertTransferOutputBytes(jobs: JobStore, job: Job, artifact: Artifact, bytes: Buffer): void {
  if (!transferFinalParent(job)) return;
  assertTransferDelivery(jobs, job, artifact);
  const proof = proofForArtifact(transferOutputProof(jobs, job)!, artifact);
  if (proof.sha256 !== sha(bytes) || proof.bytes !== bytes.length)
    return transferFail('The delivered GLB or PNG differs from the complete original transfer proof.');
}
export async function downloadSmartSegmentTransferArtifact(
  jobs: JobStore,
  job: Job,
  artifact: Artifact,
  destination: { root: string; relative: string },
  assertAccount: () => void,
): Promise<Record<string, unknown>> {
  const guard = (): void => {
    assertAccount();
    assertTransferSnapshot(jobs, job);
    assertTransferDelivery(jobs, job, artifact);
    assertAccount();
  };
  guard();
  const complete = transferOutputProof(jobs, job)!,
    proof = proofForArtifact(complete, artifact),
    bytes = await readVerifiedOutputCache(job.account_ref, byteProof(proof), text(complete.cache_data_dir));
  guard();
  if (!bytes) return transferFail('The original verified transfer artifact cache is missing.');
  assertTransferOutputBytes(jobs, job, artifact, bytes);
  const target = await outputTarget(destination.root, destination.relative);
  guard();
  const format = artifact.kind === 'model' ? 'glb' : 'png';
  if (path.extname(target).toLowerCase() !== '.' + format)
    throw new TripoError('OUTPUT_EXTENSION', `Use a .${format} destination.`);
  const current = jobs.get(job.job_id).artifacts.find((item) => item.artifact_id === artifact.artifact_id)!;
  if (registeredFrontendTarget(current, target, smartSegmentImportIdentity(job, artifact)))
    return { local_path: target, ...byteProof(proof), format, restored_from_cache: true };
  await localTarget(destination.root, destination.relative, format);
  guard();
  return { ...(await publishLocal(target, bytes, format, guard)), restored_from_cache: true };
}
export function smartSegmentTransferSummary(jobs: JobStore, job: Job): Record<string, unknown> | undefined {
  if (!transferFinalParent(job) || job.state !== 'succeeded') return;
  let proof: Record<string, unknown> | undefined;
  try {
    assertTransferDelivery(jobs, job);
    proof = transferOutputProof(jobs, job);
  } catch {
    /* 原succeeded回执保留，缺义务只报告待验。 */
  }
  return {
    state: proof ? 'succeeded' : 'needs_attention',
    remote_state: 'succeeded',
    smartsegment_affine_transfer_validation: {
      status: proof ? 'verified' : 'unverified',
      mechanism: 'pure_rotation_import',
      native_step_count: 3,
      ...(proof
        ? {
            source_sha256: proof.source_sha256,
            transform_matrix: proof.transform_matrix,
            tolerance: proof.tolerance,
            matched_oriented_faces: proof.matched_oriented_faces,
            maximum_position_error: proof.maximum_position_error,
            imported_sha256: proof.imported_sha256,
            sha256: proof.sha256,
            uses_geometry_fit: false,
            native_result_modified: false,
            native_attribute_scope: proof.native_attribute_scope,
          }
        : {}),
    },
  };
}
