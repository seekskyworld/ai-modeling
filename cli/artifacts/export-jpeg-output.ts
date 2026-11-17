/** 缺省 JPEG 的原生结果与交付物分别保留摘要；仅重读原任务，不重新导出或调用模型转换器。 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Artifact, Job } from '../../studio/contracts/types.ts';
import type { Gateway } from '../../studio/api/gateway.ts';
import type { Fetcher } from '../../studio/api/client.ts';
import type { JobStore } from '../storage/jobs.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import { outputTarget } from '../../studio/files.ts';
import {
  exportJpegIdentity,
  exportJpegProofKey,
  exportJpegRequested,
  nativeExportEncodingReason,
} from '../core/export-jpeg-policy.ts';
import { encodeGlbJpeg, inspectGlbJpeg } from './glb-jpeg.ts';
import { saveVerifiedOutputCache, recoverVerifiedArtifact } from './verified-output-cache.ts';
import { verifiedArtifactBytes } from './recover-download.ts';
import { download } from './download.ts';
import { localTarget, publishLocal } from '../local/files.ts';
import { artifactMatchesDeliveryProof, validDeliveryProof } from '../core/delivery-proof.ts';
import { registeredFrontendTarget, retainFrontendDeliveries } from '../core/frontend-delivery.ts';

type Proof = Record<string, unknown> & {
  identity: string;
  sha256: string;
  bytes: number;
  source_sha256: string;
  source_bytes: number;
  processing: string;
};
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
function changed(message: string): never {
  throw new TripoError('JPEG_EXPORT_IDENTITY_CHANGED', message, 'read');
}
function proofFor(jobs: JobStore, job: Job, artifact: Artifact): Proof | undefined {
  const proof = jobs.requestPolicy(job.account_ref, exportJpegProofKey(job, artifact));
  if (!proof) return;
  if (proof.identity !== exportJpegIdentity(job, artifact))
    return changed('The verified JPEG delivery belongs to another receipt or model artifact.');
  if (!validDeliveryProof(proof, 'source_')) return changed('The original JPEG byte proof is invalid.');
  if (!artifactMatchesDeliveryProof(artifact, proof, 'source_'))
    throw new TripoError(
      'JPEG_EXPORT_CONTENT_CHANGED',
      'The saved model metadata differs from its frozen original or JPEG delivery bytes.',
      'read',
    );
  return proof as Proof;
}

/** 事务只合并真正的JPEG交付；原生PNG来源的local_path不能借首次转码登记为交付历史。 */
export function retainExportJpegDeliveries(
  jobs: JobStore,
  job: Job,
  current: Artifact | undefined,
  next: Artifact,
): Artifact | undefined {
  if (next.kind !== 'model' || !exportJpegRequested(jobs, job)) return;
  const proof = current && proofFor(jobs, job, current);
  if (!proof || !artifactMatchesDeliveryProof(next, proof, 'source_', true))
    return changed('Downloaded JPEG bytes differ from the original frozen delivery proof.');
  return retainFrontendDeliveries(
    current && artifactMatchesDeliveryProof(current, proof, 'source_', true) ? current : undefined,
    next,
    proof.identity,
  );
}
/** 历史列表只读已有证明；没有证明时不能把上游成功显示为交付验收成功。 */
export function exportJpegSummary(jobs: JobStore, job: Job): Record<string, unknown> | undefined {
  if (job.state !== 'succeeded') return;
  const native = nativeExportEncodingReason(jobs, job);
  if (native)
    return {
      jpeg_output_validation: {
        status: 'native_preserved',
        texture_format: 'unverified_native',
        reason: native,
      },
    };
  if (!exportJpegRequested(jobs, job)) return;
  let verified = false;
  try {
    const models = job.artifacts.filter((artifact) => artifact.kind === 'model');
    verified =
      models.length > 0 &&
      models.every((artifact) => artifact.format === 'glb' && Boolean(proofFor(jobs, job, artifact)));
  } catch {
    /* 身份不匹配也按未验收显示；明确get调用提供具体错误。 */
  }
  return {
    state: verified ? 'succeeded' : 'needs_attention',
    remote_state: 'succeeded',
    jpeg_output_validation: {
      status: verified ? 'verified' : 'unverified',
      texture_format: 'JPEG',
      processing: 'local_texture_encoding_model_structures_retained',
    },
  };
}
function assertSnapshot(jobs: JobStore, job: Job, artifact: Artifact): Job {
  const current = jobs.get(job.job_id),
    latest = current.artifacts.find((entry) => entry.artifact_id === artifact.artifact_id);
  if (!latest || exportJpegIdentity(current, latest) !== exportJpegIdentity(job, artifact))
    return changed('The original export changed while checking its JPEG delivery.');
  if (!exportJpegRequested(jobs, current)) return changed('The original JPEG requirement changed.');
  proofFor(jobs, current, latest);
  return current;
}
async function cachedBytes(
  job: Job,
  artifact: Artifact,
  proof: { sha256: string; bytes: number },
  jobs: JobStore,
  dataDir: string,
): Promise<Buffer | undefined> {
  const cached = await recoverVerifiedArtifact(job, artifact, proof, jobs, dataDir);
  return cached && (await verifiedArtifactBytes(cached));
}
async function originalBytes(
  job: Job,
  artifact: Artifact,
  proof: Proof | undefined,
  jobs: JobStore,
  dataDir: string,
  gateway: Gateway,
  fetcher?: Fetcher,
): Promise<Buffer> {
  if (proof) {
    const saved = await cachedBytes(
      job,
      artifact,
      { sha256: proof.source_sha256, bytes: proof.source_bytes },
      jobs,
      dataDir,
    );
    if (saved) return saved;
  } else if (!artifact.processing) {
    const saved = await verifiedArtifactBytes(artifact);
    if (saved) return saved;
  }
  const root = path.join(dataDir, 'jpeg-export-checks');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(path.join(root, 'result-'));
  try {
    const url = await gateway.artifactUrl(job, artifact);
    assertSnapshot(jobs, job, artifact);
    const file = await download(url, temporary, 'native.glb', 'glb', fetcher);
    return await readFile(file.local_path);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
async function checkedDelivery(bytes: Buffer): Promise<void> {
  const checked = await inspectGlbJpeg(bytes);
  if (checked.images.some((image) => image.mime !== 'image/jpeg'))
    throw new TripoError(
      'JPEG_EXPORT_REQUIREMENT_FAILED',
      'The delivery still contains non-JPEG textures.',
      'read',
    );
}

/** 即使 --no-download 也检查最终结果；透明或损坏的结果保留回执并报告 needs_attention。 */
export async function ensureExportJpeg(
  job: Job,
  jobs: JobStore,
  dataDir: string,
  gateway: Gateway,
  fetcher?: Fetcher,
): Promise<Job> {
  if (!exportJpegRequested(jobs, job)) return job;
  const models = job.artifacts.filter((artifact) => artifact.kind === 'model');
  if (!models.length)
    throw new TripoError(
      'ARTIFACT_NOT_READY',
      'The original export has no model file ready for JPEG verification.',
      'read',
    );
  for (const artifact of models) {
    if (artifact.format !== 'glb')
      throw new TripoError(
        'JPEG_EXPORT_REQUIREMENT_FAILED',
        'JPEG texture-only delivery requires a native GLB result.',
        'read',
      );
    const previous = proofFor(jobs, job, artifact);
    if (previous) {
      const cached = await cachedBytes(job, artifact, previous, jobs, dataDir);
      if (cached) {
        await checkedDelivery(cached);
        assertSnapshot(jobs, job, artifact);
        continue;
      }
    }
    const source = await originalBytes(job, artifact, previous, jobs, dataDir, gateway, fetcher);
    if (previous && (digest(source) !== previous.source_sha256 || source.length !== previous.source_bytes))
      throw new TripoError(
        'JPEG_EXPORT_CONTENT_CHANGED',
        'The original export bytes changed after JPEG verification; no replacement was submitted.',
        'read',
      );
    const encoded = await encodeGlbJpeg(source);
    await checkedDelivery(encoded.bytes);
    const proof: Proof = {
      version: 1,
      identity: exportJpegIdentity(job, artifact),
      source_sha256: digest(source),
      source_bytes: source.length,
      sha256: digest(encoded.bytes),
      bytes: encoded.bytes.length,
      inspection: encoded.inspection,
      processing: encoded.processing,
    };
    await saveVerifiedOutputCache(
      job,
      artifact,
      { sha256: proof.source_sha256, bytes: proof.source_bytes },
      source,
      dataDir,
    );
    await saveVerifiedOutputCache(job, artifact, proof, encoded.bytes, dataDir);
    jobs.bindArtifactPolicy(job, artifact, exportJpegProofKey(job, artifact), proof);
  }
  return assertSnapshot(jobs, job, models[0]!);
}

export async function downloadExportJpeg(
  job: Job,
  artifact: Artifact,
  destination: { root: string; relative: string },
  jobs: JobStore,
  dataDir: string,
  gateway: Gateway,
): Promise<Record<string, unknown>> {
  const checked = await ensureExportJpeg(job, jobs, dataDir, gateway),
    current = checked.artifacts.find((entry) => entry.artifact_id === artifact.artifact_id);
  if (!current) return changed('The JPEG output artifact is no longer available.');
  const proof = proofFor(jobs, checked, current);
  if (!proof) return changed('The JPEG output has not been verified.');
  const bytes = await cachedBytes(checked, current, proof, jobs, dataDir);
  if (!bytes) return changed('The JPEG output cache changed before publication; retry the original task.');
  await checkedDelivery(bytes);
  assertSnapshot(jobs, checked, current);
  const originalTarget = await outputTarget(destination.root, destination.relative),
    latest = assertSnapshot(jobs, checked, current).artifacts.find(
      (entry) => entry.artifact_id === artifact.artifact_id,
    )!;
  if (
    artifactMatchesDeliveryProof(latest, proof, 'source_', true) &&
    registeredFrontendTarget(latest, originalTarget, proof.identity)
  )
    return {
      local_path: originalTarget,
      bytes: proof.bytes,
      sha256: proof.sha256,
      format: 'glb',
      processing: proof.processing,
      source_sha256: proof.source_sha256,
    };
  const target = await localTarget(
    destination.root,
    path.resolve(destination.root, destination.relative),
    'glb',
  );
  return {
    ...(await publishLocal(target, bytes, 'glb')),
    processing: proof.processing,
    source_sha256: proof.source_sha256,
  };
}
