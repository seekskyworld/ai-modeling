/** 远端成功与几何义务分离：只验原生字节，失败保留回执而不交付错误模型。 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Artifact, Job } from '../../studio/contracts/types.ts';
import type { Gateway } from '../../studio/api/gateway.ts';
import type { JobStore } from '../storage/jobs.ts';
import { text, object, TripoError } from '../../studio/contracts/errors.ts';
import { fingerprint } from '../core/fingerprint.ts';
import { outputTarget } from '../../studio/files.ts';
import { registeredFrontendTarget } from '../core/frontend-delivery.ts';
import { smartSegmentImportIdentity } from '../core/smartsegment-transform-policy.ts';
import {
  assertScaleOutputSnapshot,
  scaleOutputContext,
  scaleOutputKey,
  scaleOutputProof,
  scaleNativeOutput,
  smartSegmentScaleRequested,
} from '../core/smartsegment-scale-policy.ts';
import {
  hasVerifiedOutputCache,
  readVerifiedOutputCache,
  recoverVerifiedArtifact,
  saveVerifiedOutputCache,
} from './verified-output-cache.ts';
import { verifiedArtifactBytes } from './recover-download.ts';
import { nativeScaleBytes } from './smartsegment-scale-io.ts';
import { verifySmartSegmentScaleOutput } from './smartsegment-scale-proof.ts';

function modelArtifact(job: Job): Artifact {
  return scaleNativeOutput(job);
}
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
export function assertScaleOutputBytes(jobs: JobStore, job: Job, artifact: Artifact, bytes: Buffer): void {
  assertScaleOutputSnapshot(jobs, job, artifact);
  const proof = scaleOutputProof(jobs, job, artifact);
  if (!proof || proof.sha256 !== digest(bytes) || proof.bytes !== bytes.length)
    throw new TripoError(
      'SMARTSEGMENT_SCALE_OUTPUT_CHANGED',
      'The bytes differ from the verified original scaled segmentation.',
      'read',
    );
}
async function cachedOutput(
  jobs: JobStore,
  job: Job,
  artifact: Artifact,
  dataDir: string,
): Promise<Buffer | undefined> {
  const proof = scaleOutputProof(jobs, job, artifact);
  if (!proof) return;
  const expected = { sha256: text(proof.sha256), bytes: Number(proof.bytes) };
  let bytes = await readVerifiedOutputCache(job.account_ref, expected, text(proof.cache_data_dir));
  if (!bytes) {
    const recovered = await recoverVerifiedArtifact(job, artifact, expected, jobs, dataDir);
    if (recovered) bytes = await verifiedArtifactBytes(recovered);
  }
  if (bytes) assertScaleOutputBytes(jobs, job, artifact, bytes);
  return bytes;
}
export async function ensureSmartSegmentScaleOutput(
  jobs: JobStore,
  job: Job,
  dataDir: string,
  gateway: Gateway,
  assertAccount: () => void,
): Promise<void> {
  if (!smartSegmentScaleRequested(jobs, job)) return;
  const context = scaleOutputContext(jobs, job),
    artifact = modelArtifact(job),
    original = await readVerifiedOutputCache(
      job.account_ref,
      {
        sha256: text(context.source.sha256),
        bytes: Number(context.source.bytes),
      },
      text(context.source.cache_data_dir),
    );
  assertAccount();
  assertScaleOutputSnapshot(jobs, job, artifact);
  if (!original)
    throw new TripoError(
      'SMARTSEGMENT_SCALE_SOURCE_MISSING',
      'The frozen pre-segmentation source bytes are missing or changed.',
      'read',
    );
  const cached = await cachedOutput(jobs, job, artifact, dataDir);
  assertAccount();
  assertScaleOutputSnapshot(jobs, job, artifact);
  if (cached) return;
  const bytes = await nativeScaleBytes(job, artifact, gateway, dataDir),
    saved = scaleOutputProof(jobs, job, artifact);
  if (saved) {
    assertScaleOutputBytes(jobs, job, artifact, bytes);
    await saveVerifiedOutputCache(
      job,
      artifact,
      { sha256: text(saved.sha256), bytes: Number(saved.bytes) },
      bytes,
      dataDir,
    );
  } else {
    const proof = await verifySmartSegmentScaleOutput(
      original,
      context.intent.matrix as number[],
      bytes,
      context.source.kind === 'reference' ? 'reference' : undefined,
    );
    await saveVerifiedOutputCache(
      job,
      artifact,
      { sha256: text(proof.sha256), bytes: Number(proof.bytes) },
      bytes,
      dataDir,
    );
    assertAccount();
    assertScaleOutputSnapshot(jobs, job, artifact);
    jobs.bindArtifactPolicy(job, artifact, scaleOutputKey(job, artifact), {
      ...proof,
      identity: smartSegmentImportIdentity(job, artifact),
      intent: fingerprint(context.intent),
      cache_data_dir: dataDir,
    });
  }
  assertAccount();
  assertScaleOutputBytes(jobs, job, artifact, bytes);
}
export function smartSegmentScaleSummary(
  jobs: JobStore,
  job: Job,
  dataDir: string,
): Record<string, unknown> | undefined {
  if (!smartSegmentScaleRequested(jobs, job) || job.state !== 'succeeded') return;
  let verified = false,
    proof: Record<string, unknown> | undefined;
  try {
    const context = scaleOutputContext(jobs, job);
    proof = scaleOutputProof(jobs, job, modelArtifact(job));
    verified = Boolean(
      proof &&
      hasVerifiedOutputCache(
        job.account_ref,
        { sha256: text(context.source.sha256), bytes: Number(context.source.bytes) },
        text(context.source.cache_data_dir),
      ) &&
      [text(proof.cache_data_dir), dataDir].some((dir) => {
        try {
          return hasVerifiedOutputCache(
            job.account_ref,
            { sha256: text(proof!.sha256), bytes: Number(proof!.bytes) },
            dir,
          );
        } catch {
          return false;
        }
      }),
    );
  } catch {
    /* 列表只给待验状态，不下载、重提或掩盖远端成功。 */
  }
  return {
    state: verified ? 'succeeded' : 'needs_attention',
    remote_state: 'succeeded',
    smartsegment_transform_validation: {
      status: verified ? 'verified' : 'unverified',
      mechanism: 'native_metadata_then_segmentation',
      ...(verified
        ? {
            matched_oriented_faces: proof?.matched_oriented_faces,
            maximum_position_error: proof?.maximum_position_error,
            tolerance: object(proof?.tolerance),
            native_result_modified: false,
            native_attribute_scope: proof?.native_attribute_scope,
          }
        : {}),
    },
  };
}

/** 只复用最终事务登记且 inode/父目录/摘要一致的交付文件，不认领陌生同字节副本。 */
export async function reusedSmartSegmentScaleDelivery(
  jobs: JobStore,
  job: Job,
  artifact: Artifact,
  destination: { root: string; relative: string },
  assertAccount: () => void,
): Promise<Record<string, unknown> | undefined> {
  const target = await outputTarget(destination.root, destination.relative);
  assertAccount();
  if (path.extname(target).toLowerCase() !== '.glb')
    throw new TripoError('OUTPUT_EXTENSION', 'Use a .glb destination.');
  const current = assertScaleOutputSnapshot(jobs, job, artifact),
    latest = current.artifacts.find((a) => a.artifact_id === artifact.artifact_id)!,
    proof = scaleOutputProof(jobs, current, latest);
  if (!proof || !registeredFrontendTarget(latest, target, text(proof.identity))) return;
  return {
    local_path: target,
    sha256: proof.sha256,
    bytes: proof.bytes,
    format: 'glb',
    restored_from_cache: true,
  };
}
