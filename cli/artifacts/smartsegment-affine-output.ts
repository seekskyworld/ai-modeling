/** 父级最终义务直接比较原始A(P)；第二段M2(P_merge)的成功不能代替它。 */
import { createHash } from 'node:crypto';
import type { Artifact, Job } from '../../studio/contracts/types.ts';
import type { Gateway } from '../../studio/api/gateway.ts';
import type { JobStore } from '../storage/jobs.ts';
import { object, text } from '../../studio/contracts/errors.ts';
import { fingerprint } from '../core/fingerprint.ts';
import { smartSegmentImportIdentity } from '../core/smartsegment-transform-policy.ts';
import {
  affineFail,
  affineFinalParent,
  affineOutputContext,
  affineOutputKey,
  affineOutputProof,
  assertAffineDelivery,
} from '../core/smartsegment-affine-policy.ts';
import {
  hasVerifiedOutputCache,
  readVerifiedOutputCache,
  saveVerifiedOutputCache,
} from './verified-output-cache.ts';
import { verifySmartSegmentAffineOutput } from './smartsegment-affine-proof.ts';
import { nativeScaleBytes } from './smartsegment-scale-io.ts';

export async function ensureSmartSegmentAffineOutput(
  jobs: JobStore,
  job: Job,
  dataDir: string,
  gateway: Gateway,
  assertAccount: () => void,
): Promise<void> {
  if (!affineFinalParent(job)) return;
  const context = affineOutputContext(jobs, job),
    saved = affineOutputProof(jobs, job);
  if (
    saved &&
    hasVerifiedOutputCache(
      job.account_ref,
      { sha256: text(saved.sha256), bytes: Number(saved.bytes) },
      text(saved.cache_data_dir),
    )
  ) {
    assertAccount();
    assertAffineDelivery(jobs, job);
    return;
  }
  const originals: Buffer[] = [];
  for (const source of [context.source, context.first.stage, context.merged.stage]) {
    const bytes = await readVerifiedOutputCache(
      job.account_ref,
      { sha256: text(source.sha256), bytes: Number(source.bytes) },
      text(source.cache_data_dir),
    );
    assertAccount();
    affineOutputContext(jobs, job);
    if (!bytes)
      return affineFail(
        'An original affine intermediate cache is missing; restore it without submitting any native step again.',
      );
    originals.push(bytes);
  }
  const bytes = await nativeScaleBytes(job, context.artifact, gateway, dataDir);
  assertAccount();
  affineOutputContext(jobs, job);
  const proof = await verifySmartSegmentAffineOutput(
    originals[0]!,
    context.intent.matrix,
    originals[1]!,
    originals[2]!,
    bytes,
  );
  assertAccount();
  affineOutputContext(jobs, job);
  if (saved && (saved.sha256 !== proof.sha256 || saved.bytes !== proof.bytes))
    return affineFail('The native affine final bytes changed after their original proof.');
  await saveVerifiedOutputCache(
    job,
    context.artifact,
    { sha256: text(proof.sha256), bytes: Number(proof.bytes) },
    bytes,
    dataDir,
  );
  assertAccount();
  affineOutputContext(jobs, job);
  if (!saved)
    jobs.bindArtifactPolicy(job, context.artifact, affineOutputKey(job), {
      ...proof,
      identity: smartSegmentImportIdentity(job, context.artifact),
      intent: fingerprint(context.intent),
      source_binding: fingerprint(context.source),
      first_binding: fingerprint(context.first.stage),
      merge_binding: fingerprint(context.merged.stage),
      cache_data_dir: dataDir,
    });
  assertAffineDelivery(jobs, job);
}
export function assertAffineOutputBytes(jobs: JobStore, job: Job, artifact: Artifact, bytes: Buffer): void {
  if (!affineFinalParent(job)) return;
  assertAffineDelivery(jobs, job);
  if (artifact.kind !== 'model') return;
  const proof = affineOutputProof(jobs, job)!;
  if (proof.bytes !== bytes.length || proof.sha256 !== createHash('sha256').update(bytes).digest('hex'))
    return affineFail('Delivered model bytes differ from the proved original native affine result.');
}
export function smartSegmentAffineSummary(jobs: JobStore, job: Job): Record<string, unknown> | undefined {
  if (!affineFinalParent(job) || job.state !== 'succeeded') return;
  let verified = false,
    proof: Record<string, unknown> | undefined;
  try {
    assertAffineDelivery(jobs, job);
    proof = affineOutputProof(jobs, job);
    verified = true;
  } catch {
    /* list只报告待验，不重提远端或隐瞒其已成功回执。 */
  }
  return {
    state: verified ? 'succeeded' : 'needs_attention',
    remote_state: 'succeeded',
    smartsegment_affine_validation: {
      status: verified ? 'verified' : 'unverified',
      mechanism: 'native_two_trs_and_merge',
      native_step_count: 7,
      ...(verified
        ? {
            transform_matrix: proof!.transform_matrix,
            matched_oriented_faces: proof!.matched_oriented_faces,
            maximum_position_error: proof!.maximum_position_error,
            tolerance: object(proof!.tolerance),
            source_sha256: proof!.source_sha256,
            first_sha256: proof!.first_sha256,
            merged_sha256: proof!.merged_sha256,
            sha256: proof!.sha256,
            uses_geometry_fit: false,
            native_result_modified: false,
            native_attribute_scope: proof!.native_attribute_scope,
          }
        : {}),
    },
  };
}
