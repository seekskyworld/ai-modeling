/** 逐张验证原生像素；失败也保留原图诊断，恢复只读取原资产，永不缩放或补生成。 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import type { Artifact, Job } from '../../studio/contracts/types.ts';
import type { Gateway } from '../../studio/api/gateway.ts';
import type { Fetcher } from '../../studio/api/client.ts';
import { detectFormat } from '../../studio/files.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import type { JobStore } from '../storage/jobs.ts';
import {
  readImageSize,
  imageSizeIdentity,
  imageSizeProofKey,
  imageSizeMatches,
  matchingImageSizeProof,
  assertImageSizeSnapshot,
  assertImageSizeDelivery,
  type ImageSizeRequirement,
} from '../core/image-size-policy.ts';
import { readImageOutputFormat } from '../core/image-output-policy.ts';
import { localTarget, publishLocal } from '../local/files.ts';
import { downloadArtifactBytes } from './download.ts';
import { verifiedArtifactBytes } from './recover-download.ts';
import { createImageCache, readImageCache } from './image-cache.ts';
import { readImageBackground, assertImageBackgroundSnapshot } from '../core/image-background-policy.ts';
import { ensureImageBackground, assertOpaqueImageBytes } from './image-background-output.ts';

const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

async function inspect(
  bytes: Buffer,
): Promise<{ format: 'png' | 'jpeg' | 'webp'; width: number; height: number }> {
  try {
    const format = detectFormat(bytes);
    if (!['png', 'jpeg', 'webp'].includes(format)) throw new Error('Not an image.');
    // 真实完整解码；只读IHDR不足以证明文件可交付，也不通过rotate/resize改变所请求像素。
    const image = sharp(bytes, { failOn: 'error', limitInputPixels: 40_000_000 });
    const metadata = await image.metadata();
    if ((metadata.pages ?? 1) !== 1) throw new Error('Multiple frames are unsupported.');
    const { info } = await image.raw().toBuffer({ resolveWithObject: true });
    return { format: format as 'png' | 'jpeg' | 'webp', width: info.width, height: info.height };
  } catch {
    throw new TripoError(
      'IMAGE_SIZE_REQUIREMENT_FAILED',
      'The original image could not be fully decoded to verify exact dimensions.',
      'read',
    );
  }
}

export async function assertImageSizeBytes(bytes: Buffer, size: ImageSizeRequirement): Promise<void> {
  const actual = await inspect(bytes);
  if (actual.width !== size.width || actual.height !== size.height)
    throw new TripoError(
      'IMAGE_SIZE_REQUIREMENT_FAILED',
      'Image pixels differ from the frozen exact dimensions; the original task must not be regenerated automatically.',
      'read',
      {
        expected: size,
        actual: { width: actual.width, height: actual.height },
      },
    );
}

function imageSet(job: Job): Artifact[] {
  const images = job.artifacts.filter((a) => a.kind === 'image');
  const amount = job.input.amount ?? 1;
  if (
    job.operation !== 'image' ||
    job.state !== 'succeeded' ||
    images.length !== amount ||
    images.some((a) => !Number.isInteger(a.index) || a.index < 0 || a.index >= Number(amount)) ||
    new Set(images.map((a) => a.artifact_id)).size !== images.length ||
    new Set(images.map((a) => a.index)).size !== images.length
  )
    throw new TripoError(
      'ARTIFACT_NOT_READY',
      'All original image results must be available for exact pixel-size verification.',
      'read',
    );
  return images;
}

async function originalBytes(
  job: Job,
  artifact: Artifact,
  jobs: JobStore,
  dataDir: string,
  gateway: Gateway,
  fetcher?: Fetcher,
): Promise<Buffer> {
  const size = artifact.image_size;
  if (size && matchingImageSizeProof(jobs, job, artifact)) {
    const cached = readImageCache(dataDir, 'image-size-cache', size.source_cache_path, {
      sha256: size.source_sha256,
      bytes: size.source_bytes,
    });
    if (cached) return cached;
  }
  const encoding = artifact.image_output;
  if (artifact.image_background) {
    const proof = artifact.image_background;
    const cached = readImageCache(dataDir, 'image-background-cache', proof.source_cache_path, {
      sha256: proof.source_sha256,
      bytes: proof.source_bytes,
    });
    if (cached) return cached;
  }
  if (encoding) {
    const cached = readImageCache(dataDir, 'image-output-cache', encoding.source_cache_path, {
      sha256: encoding.source_sha256,
      bytes: encoding.source_bytes,
    });
    if (cached) return cached;
  } else if (!artifact.processing) {
    const local = await verifiedArtifactBytes(artifact);
    if (local) return local;
  }
  const source = { ...artifact, format: size?.source_format ?? encoding?.source_format ?? artifact.format };
  return await downloadArtifactBytes(await gateway.artifactUrl(job, source), 'image', fetcher);
}

function requireMatched(job: Job): void {
  const mismatches = job.artifacts
    .filter((a) => a.kind === 'image' && a.image_size && !imageSizeMatches(a.image_size))
    .map((a) => ({
      artifact_id: a.artifact_id,
      expected: { width: a.image_size!.expected_width, height: a.image_size!.expected_height },
      actual: { width: a.image_size!.width, height: a.image_size!.height },
      source_sha256: a.image_size!.source_sha256,
      source_bytes: a.image_size!.source_bytes,
      diagnostic_path: a.image_size!.source_cache_path,
    }));
  if (mismatches.length)
    throw new TripoError(
      'IMAGE_SIZE_REQUIREMENT_FAILED',
      'Studio completed the original image task, but its native pixels do not match the requested WxH. Original diagnostics were retained; do not regenerate or resize this result.',
      'read',
      { mismatches },
    );
}

export async function ensureImageSize(
  job: Job,
  jobs: JobStore,
  dataDir: string,
  gateway: Gateway,
  fetcher?: Fetcher,
): Promise<Job> {
  const size = readImageSize(jobs, job);
  if (!size) return job;
  const images = imageSet(job);
  for (const artifact of images) {
    const frozen = jobs.requestPolicy(job.account_ref, imageSizeProofKey(job, artifact));
    if (frozen && (!artifact.image_size || !matchingImageSizeProof(jobs, job, artifact)))
      throw new TripoError(
        'IMAGE_SIZE_IDENTITY_CHANGED',
        'The original image proof metadata changed; recover the original task.',
        'read',
      );
    const cacheDirectory = createImageCache(dataDir, 'image-size-cache');
    let keep = false;
    try {
      const source = await originalBytes(job, artifact, jobs, dataDir, gateway, fetcher),
        sha = digest(source);
      cacheDirectory.check();
      if (frozen && (sha !== frozen.source_sha256 || source.length !== frozen.source_bytes))
        throw new TripoError(
          'IMAGE_SIZE_CONTENT_CHANGED',
          'The original asset now returns different bytes from its frozen size proof; no new image was accepted.',
          'read',
        );
      const actual = await inspect(source);
      cacheDirectory.check();
      if (
        frozen &&
        (actual.width !== frozen.width ||
          actual.height !== frozen.height ||
          actual.format !== frozen.source_format)
      )
        throw new TripoError(
          'IMAGE_SIZE_CONTENT_CHANGED',
          'The original image no longer matches its frozen decoded pixel proof.',
          'read',
        );
      if (
        artifact.image_size &&
        cachedProofFile(
          dataDir,
          'image-size-cache',
          artifact.image_size.source_cache_path,
          sha,
          source.length,
        )
      ) {
        assertImageSizeSnapshot(jobs, job, artifact);
        continue;
      }
      // 即使尺寸不匹配也先绑定原始字节，保留文件与实际尺寸，避免失败后的重读悄悄替换产物。
      const cache = cacheDirectory.write(`original.${actual.format}`, source);
      const proof: NonNullable<Artifact['image_size']> = {
        identity: imageSizeIdentity(job, artifact, size),
        expected_width: size.width,
        expected_height: size.height,
        width: actual.width,
        height: actual.height,
        source_format: actual.format,
        source_sha256: sha,
        source_bytes: source.length,
        source_cache_path: cache,
        checked_at: new Date().toISOString(),
      };
      jobs.saveImageSize(job, artifact, proof);
      keep = true;
    } finally {
      if (!keep) cacheDirectory.cleanup();
    }
  }
  const current = jobs.get(job.job_id);
  for (const artifact of current.artifacts.filter((a) => a.kind === 'image'))
    assertImageSizeSnapshot(jobs, job, artifact);
  requireMatched(current);
  return current;
}

function cachedProofFile(
  dataDir: string,
  name: 'image-size-cache' | 'image-output-cache',
  file: string,
  sha: string,
  bytes: number,
): boolean {
  try {
    return Boolean(readImageCache(dataDir, name, file, { sha256: sha, bytes }));
  } catch {
    return false;
  }
}

export function imageSizeSummary(
  jobs: JobStore,
  job: Job,
  dataDir: string,
): Record<string, unknown> | undefined {
  const size = readImageSize(jobs, job);
  if (!size || job.state !== 'succeeded') return;
  let verified = true;
  try {
    imageSet(job);
  } catch {
    verified = false;
  }
  const images = job.artifacts.filter((a) => a.kind === 'image');
  const results = images.map((artifact) => {
    const proof = artifact.image_size;
    const matched = matchingImageSizeProof(jobs, job, artifact);
    const cached = Boolean(
      matched &&
      proof &&
      cachedProofFile(
        dataDir,
        'image-size-cache',
        proof.source_cache_path,
        proof.source_sha256,
        proof.source_bytes,
      ),
    );
    const exact = Boolean(matched && proof && imageSizeMatches(proof));
    if (!cached || !exact) verified = false;
    if (readImageOutputFormat(jobs, job)) {
      const encoded = artifact.image_output;
      if (
        !encoded ||
        !proof ||
        encoded.source_sha256 !== proof.source_sha256 ||
        encoded.source_bytes !== proof.source_bytes ||
        encoded.width !== size.width ||
        encoded.height !== size.height ||
        !cachedProofFile(dataDir, 'image-output-cache', encoded.cache_path, encoded.sha256, encoded.bytes)
      )
        verified = false;
    }
    return {
      artifact_id: artifact.artifact_id,
      status: !matched ? 'unverified' : !exact ? 'mismatch' : !cached ? 'cache_unavailable' : 'verified',
      ...(matched && proof
        ? {
            actual: { width: proof.width, height: proof.height },
            source_sha256: proof.source_sha256,
            diagnostic_path: proof.source_cache_path,
          }
        : {}),
    };
  });
  try {
    imageSet(jobs.get(job.job_id));
    for (const artifact of images) assertImageSizeSnapshot(jobs, job, artifact);
  } catch {
    verified = false;
  }
  return {
    state: verified ? 'succeeded' : 'needs_attention',
    remote_state: 'succeeded',
    image_size_validation: {
      status: verified ? 'verified' : 'unverified',
      expected: size,
      processing: 'native_pixels_verified_without_resizing',
      results,
    },
    ...(!verified
      ? {
          next_action:
            'Read the original image task to verify or recover its original pixels; do not regenerate.',
        }
      : {}),
  };
}

export async function downloadImageSize(
  job: Job,
  artifact: Artifact,
  destination: { root: string; relative: string },
  inferExtension: boolean,
  jobs: JobStore,
  dataDir: string,
  gateway: Gateway,
  fetcher?: Fetcher,
): Promise<Record<string, unknown>> {
  const sized = await ensureImageSize(job, jobs, dataDir, gateway, fetcher);
  const currentJob = await ensureImageBackground(sized, jobs, dataDir, gateway, fetcher);
  const current = currentJob.artifacts.find((a) => a.artifact_id === artifact.artifact_id)!;
  const proof = current.image_size!;
  const bytes = readImageCache(dataDir, 'image-size-cache', proof.source_cache_path, {
    sha256: proof.source_sha256,
    bytes: proof.source_bytes,
  });
  if (!bytes)
    throw new TripoError(
      'IMAGE_SIZE_CONTENT_CHANGED',
      'The verified original image cache changed before publication; reread this task.',
      'read',
    );
  await assertImageSizeBytes(bytes, readImageSize(jobs, currentJob)!);
  if (readImageBackground(jobs, currentJob)) await assertOpaqueImageBytes(bytes);
  const relative = inferExtension
    ? destination.relative.slice(0, destination.relative.length - path.extname(destination.relative).length) +
      '.' +
      proof.source_format
    : destination.relative;
  const extension =
    proof.source_format === 'jpeg' && path.extname(relative).toLowerCase() === '.jpg'
      ? 'jpg'
      : proof.source_format;
  const target = await localTarget(destination.root, path.resolve(destination.root, relative), extension);
  assertImageSizeSnapshot(jobs, currentJob, current);
  if (readImageBackground(jobs, currentJob)) assertImageBackgroundSnapshot(jobs, currentJob, current);
  assertImageSizeDelivery(jobs, currentJob, current);
  return { ...(await publishLocal(target, bytes, proof.source_format)), image_size: proof };
}
