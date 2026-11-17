/** 原图与交付物分开验身；私有缓存可恢复，丢失时只读同一原图，永不重提生成。 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Artifact, Job } from '../../studio/contracts/types.ts';
import type { Gateway } from '../../studio/api/gateway.ts';
import type { Fetcher } from '../../studio/api/client.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import type { JobStore } from '../storage/jobs.ts';
import { fingerprint } from '../core/fingerprint.ts';
import { readImageOutputFormat, type ImageOutputFormat } from '../core/image-output-policy.ts';
import { localTarget, publishLocal } from '../local/files.ts';
import { downloadArtifactBytes } from './download.ts';
import { verifiedArtifactBytes } from './recover-download.ts';
import { encodeImageOutput } from './image-encoding.ts';
import { readImageSize, assertImageSizeSnapshot } from '../core/image-size-policy.ts';
import { ensureImageSize, assertImageSizeBytes } from './image-size-output.ts';
import { createImageCache, readImageCache } from './image-cache.ts';
import { readImageBackground, assertImageBackgroundSnapshot } from '../core/image-background-policy.ts';
import { ensureImageBackground, assertOpaqueImageBytes } from './image-background-output.ts';

function identity(job: Job, artifact: Artifact, format: ImageOutputFormat): string {
  return fingerprint({
    version: 1,
    account: job.account_ref,
    job_id: job.job_id,
    operation: job.operation,
    remote_ids: job.remote_ids,
    artifact_id: artifact.artifact_id,
    index: artifact.index,
    target_format: format,
  });
}

function matchingProof(job: Job, artifact: Artifact, format: ImageOutputFormat): boolean {
  const proof = artifact.image_output;
  return Boolean(
    proof &&
    proof.identity === identity(job, artifact, format) &&
    proof.target_format === format &&
    artifact.format === format &&
    ['png', 'jpeg', 'webp'].includes(proof.source_format) &&
    /^[a-f0-9]{64}$/.test(proof.source_sha256) &&
    /^[a-f0-9]{64}$/.test(proof.sha256) &&
    proof.bytes > 0 &&
    proof.source_bytes > 0 &&
    proof.width > 0 &&
    proof.height > 0,
  );
}

export function hasImageOutputProof(job: Job, jobs: JobStore, dataDir?: string): boolean {
  const format = readImageOutputFormat(jobs, job);
  if (!format) return false;
  const images = job.artifacts.filter((a) => a.kind === 'image');
  return (
    images.length > 0 &&
    images.every((a) => {
      if (!matchingProof(job, a, format)) return false;
      if (!dataDir) return true;
      const proof = a.image_output!;
      try {
        return Boolean(readImageCache(dataDir, 'image-output-cache', proof.cache_path, proof));
      } catch {
        return false;
      }
    })
  );
}

async function cachedImage(job: Job, artifact: Artifact, format: ImageOutputFormat, dataDir: string) {
  if (!matchingProof(job, artifact, format)) return;
  const proof = artifact.image_output!;
  const bytes = readImageCache(dataDir, 'image-output-cache', proof.cache_path, proof);
  if (!bytes) return;
  const checked = await encodeImageOutput(bytes, format);
  if (checked.source_format !== format || checked.width !== proof.width || checked.height !== proof.height)
    return;
  return readImageCache(dataDir, 'image-output-cache', proof.cache_path, proof);
}

async function originalImage(
  job: Job,
  artifact: Artifact,
  dataDir: string,
  gateway: Gateway,
  fetcher?: Fetcher,
): Promise<Buffer> {
  const proof = artifact.image_output;
  if (proof && matchingProof(job, artifact, proof.target_format)) {
    const original = readImageCache(dataDir, 'image-output-cache', proof.source_cache_path, {
      bytes: proof.source_bytes,
      sha256: proof.source_sha256,
    });
    if (original) return original;
  }
  if (artifact.image_size) {
    const size = artifact.image_size;
    const original = readImageCache(dataDir, 'image-size-cache', size.source_cache_path, {
      bytes: size.source_bytes,
      sha256: size.source_sha256,
    });
    if (original) return original;
  }
  if (artifact.image_background) {
    const background = artifact.image_background;
    const original = readImageCache(dataDir, 'image-background-cache', background.source_cache_path, {
      bytes: background.source_bytes,
      sha256: background.source_sha256,
    });
    if (original) return original;
  }
  // 已处理交付物不能冒充网页原图；无处理标记的已验原图可在网络离线时复用。
  const local =
    !artifact.processing && !artifact.image_output ? await verifiedArtifactBytes(artifact) : undefined;
  if (local) return local;
  const original = { ...artifact, format: artifact.image_output?.source_format ?? artifact.format };
  return await downloadArtifactBytes(await gateway.artifactUrl(job, original), 'image', fetcher);
}

export async function ensureImageOutput(
  job: Job,
  jobs: JobStore,
  dataDir: string,
  gateway: Gateway,
  fetcher?: Fetcher,
): Promise<Job> {
  const format = readImageOutputFormat(jobs, job);
  if (!format) return job;
  job = await ensureImageSize(job, jobs, dataDir, gateway, fetcher);
  job = await ensureImageBackground(job, jobs, dataDir, gateway, fetcher);
  if (job.operation !== 'image')
    throw new TripoError(
      'IMAGE_OUTPUT_REQUIREMENT_FAILED',
      'Image output encoding requires an image generation task.',
      'read',
    );
  const images = job.artifacts.filter((a) => a.kind === 'image');
  if (!images.length)
    throw new TripoError(
      'ARTIFACT_NOT_READY',
      'The original Studio image is not ready for output encoding.',
      'read',
    );
  for (const artifact of images) {
    const cached = await cachedImage(job, artifact, format, dataDir);
    if (cached) {
      if (readImageBackground(jobs, job)) {
        await assertOpaqueImageBytes(cached);
        assertImageBackgroundSnapshot(jobs, job, artifact);
      }
      continue;
    }
    const cacheDirectory = createImageCache(dataDir, 'image-output-cache');
    let keep = false;
    try {
      const source = await originalImage(job, artifact, dataDir, gateway, fetcher);
      cacheDirectory.check();
      if (
        artifact.image_output &&
        matchingProof(job, artifact, format) &&
        createHash('sha256').update(source).digest('hex') !== artifact.image_output.source_sha256
      )
        throw new TripoError(
          'IMAGE_OUTPUT_REQUIREMENT_FAILED',
          'The remote image bytes changed from this task’s verified original. Recover the original source; do not regenerate or publish another image under this result.',
          'read',
        );
      const result = await encodeImageOutput(source, format);
      const size = readImageSize(jobs, job);
      if (size) {
        await assertImageSizeBytes(result.bytes, size);
        assertImageSizeSnapshot(jobs, job, artifact);
      }
      if (readImageBackground(jobs, job)) {
        await assertOpaqueImageBytes(result.bytes);
        assertImageBackgroundSnapshot(jobs, job, artifact);
      }
      cacheDirectory.check();
      const cache = cacheDirectory.write(`delivery.${format}`, result.bytes);
      const sourceCache = cacheDirectory.write(`original.${result.source_format}`, source);
      const proof: NonNullable<Artifact['image_output']> = {
        target_format: format,
        source_format: result.source_format,
        source_sha256: createHash('sha256').update(source).digest('hex'),
        source_cache_path: sourceCache,
        source_bytes: source.length,
        cache_path: cache,
        sha256: createHash('sha256').update(result.bytes).digest('hex'),
        bytes: result.bytes.length,
        identity: identity(job, artifact, format),
        width: result.width,
        height: result.height,
        processing: result.processing,
      };
      jobs.saveImageOutput(job.job_id, artifact.artifact_id, proof);
      keep = true;
    } finally {
      if (!keep) cacheDirectory.cleanup();
    }
  }
  return jobs.get(job.job_id);
}

export async function downloadImageOutput(
  job: Job,
  artifact: Artifact,
  destination: { root: string; relative: string },
  inferExtension: boolean,
  jobs: JobStore,
  dataDir: string,
  gateway: Gateway,
  fetcher?: Fetcher,
): Promise<Record<string, unknown>> {
  const format = readImageOutputFormat(jobs, job);
  if (!format)
    throw new TripoError(
      'IMAGE_OUTPUT_REQUIREMENT_FAILED',
      'No image output format was frozen for this task.',
      'read',
    );
  const refreshed = await ensureImageOutput(job, jobs, dataDir, gateway, fetcher);
  const current = refreshed.artifacts.find((a) => a.artifact_id === artifact.artifact_id)!;
  const bytes = await cachedImage(refreshed, current, format, dataDir);
  if (!bytes)
    throw new TripoError(
      'IMAGE_OUTPUT_REQUIREMENT_FAILED',
      'Image output cache changed before publication; retry downloading the same task.',
      'read',
    );
  const relative = inferExtension
    ? destination.relative.slice(0, destination.relative.length - path.extname(destination.relative).length) +
      '.' +
      format
    : destination.relative;
  const extension = format === 'jpeg' && path.extname(relative).toLowerCase() === '.jpg' ? 'jpg' : format;
  const target = await localTarget(destination.root, path.resolve(destination.root, relative), extension);
  const size = readImageSize(jobs, refreshed);
  if (size) {
    await assertImageSizeBytes(bytes, size);
    assertImageSizeSnapshot(jobs, refreshed, current);
  }
  if (readImageBackground(jobs, refreshed)) {
    await assertOpaqueImageBytes(bytes);
    assertImageBackgroundSnapshot(jobs, refreshed, current);
  }
  return {
    ...(await publishLocal(target, bytes, format)),
    processing: current.image_output!.processing,
    source_sha256: current.image_output!.source_sha256,
    image_output: current.image_output,
  };
}
