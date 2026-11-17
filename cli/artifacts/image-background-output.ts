/** 原生不透明效果逐像素验证；原图缓存与证明固定后，恢复只读原资产。 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import type { Artifact, Job } from '../../studio/contracts/types.ts';
import type { Gateway } from '../../studio/api/gateway.ts';
import type { Fetcher } from '../../studio/api/client.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import { detectFormat } from '../../studio/files.ts';
import type { JobStore } from '../storage/jobs.ts';
import {
  readImageBackground,
  imageBackgroundIdentity,
  imageBackgroundProofKey,
  matchingImageBackgroundProof,
  assertImageBackgroundSnapshot,
  assertImageBackgroundDelivery,
} from '../core/image-background-policy.ts';
import { readImageOutputFormat } from '../core/image-output-policy.ts';
import { createImageCache, readImageCache } from './image-cache.ts';
import { downloadArtifactBytes } from './download.ts';
import { verifiedArtifactBytes } from './recover-download.ts';
import { localTarget, publishLocal } from '../local/files.ts';

async function inspect(
  bytes: Buffer,
): Promise<{ format: 'png' | 'jpeg' | 'webp'; width: number; height: number; nonopaque_pixels: number }> {
  try {
    const format = detectFormat(bytes);
    if (!['png', 'jpeg', 'webp'].includes(format)) throw new Error('Not an image.');
    const image = sharp(bytes, { failOn: 'error', limitInputPixels: 40_000_000 });
    const metadata = await image.metadata();
    if ((metadata.pages ?? 1) !== 1 || metadata.depth !== 'uchar')
      throw new Error('Only verified single-frame eight-bit sources are supported.');
    const { data, info } = await image
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.channels !== 4) throw new Error('Unexpected alpha layout.');
    let nonopaque_pixels = 0;
    for (let offset = 3; offset < data.length; offset += 4) if (data[offset] !== 255) nonopaque_pixels++;
    return {
      format: format as 'png' | 'jpeg' | 'webp',
      width: info.width,
      height: info.height,
      nonopaque_pixels,
    };
  } catch {
    throw new TripoError(
      'IMAGE_BACKGROUND_REQUIREMENT_FAILED',
      'The original image could not be fully decoded to verify every alpha value.',
      'read',
    );
  }
}

export async function assertOpaqueImageBytes(bytes: Buffer): Promise<void> {
  const actual = await inspect(bytes);
  if (actual.nonopaque_pixels !== 0)
    throw new TripoError(
      'IMAGE_BACKGROUND_REQUIREMENT_FAILED',
      'The image contains nonopaque pixels; do not fill its background or regenerate the original task.',
      'read',
      { nonopaque_pixels: actual.nonopaque_pixels },
    );
}

function imageSet(job: Job): Artifact[] {
  const images = job.artifacts.filter((a) => a.kind === 'image'),
    amount = job.input.amount ?? 1;
  if (
    job.operation !== 'image' ||
    job.input.model_version !== 'gpt_image_2.5_sunburst' ||
    job.state !== 'succeeded' ||
    images.length !== amount ||
    images.some((a) => !Number.isInteger(a.index) || a.index < 0 || a.index >= Number(amount)) ||
    new Set(images.map((a) => a.artifact_id)).size !== images.length ||
    new Set(images.map((a) => a.index)).size !== images.length
  )
    throw new TripoError(
      'ARTIFACT_NOT_READY',
      'All original Sunburst results must be available for background verification.',
      'read',
    );
  return images;
}

async function originalBytes(
  job: Job,
  artifact: Artifact,
  dataDir: string,
  gateway: Gateway,
  fetcher?: Fetcher,
): Promise<Buffer> {
  for (const [name, proof] of [
    ['image-background-cache', artifact.image_background],
    ['image-size-cache', artifact.image_size],
    ['image-output-cache', artifact.image_output],
  ] as const) {
    if (!proof) continue;
    const bytes = readImageCache(dataDir, name, proof.source_cache_path, {
      sha256: proof.source_sha256,
      bytes: proof.source_bytes,
    });
    if (bytes) return bytes;
  }
  if (!artifact.processing && !artifact.image_output) {
    const local = await verifiedArtifactBytes(artifact);
    if (local) return local;
  }
  const source = {
    ...artifact,
    format:
      artifact.image_background?.source_format ?? artifact.image_output?.source_format ?? artifact.format,
  };
  return await downloadArtifactBytes(await gateway.artifactUrl(job, source), 'image', fetcher);
}

export async function ensureImageBackground(
  job: Job,
  jobs: JobStore,
  dataDir: string,
  gateway: Gateway,
  fetcher?: Fetcher,
): Promise<Job> {
  if (!readImageBackground(jobs, job)) return job;
  for (const artifact of imageSet(job)) {
    const frozen = jobs.requestPolicy(job.account_ref, imageBackgroundProofKey(job, artifact));
    if (frozen && (!artifact.image_background || !matchingImageBackgroundProof(jobs, job, artifact)))
      throw new TripoError(
        'IMAGE_BACKGROUND_IDENTITY_CHANGED',
        'The original alpha proof changed; recover the original task.',
        'read',
      );
    const directory = createImageCache(dataDir, 'image-background-cache');
    let keep = false;
    try {
      const source = await originalBytes(job, artifact, dataDir, gateway, fetcher),
        sha256 = createHash('sha256').update(source).digest('hex');
      directory.check();
      if (frozen && (sha256 !== frozen.source_sha256 || source.length !== frozen.source_bytes))
        throw new TripoError(
          'IMAGE_BACKGROUND_CONTENT_CHANGED',
          'The original asset differs from its frozen background proof; no new image was accepted.',
          'read',
        );
      const actual = await inspect(source);
      directory.check();
      if (
        frozen &&
        (actual.width !== frozen.width ||
          actual.height !== frozen.height ||
          actual.format !== frozen.source_format ||
          actual.nonopaque_pixels !== frozen.nonopaque_pixels)
      )
        throw new TripoError(
          'IMAGE_BACKGROUND_CONTENT_CHANGED',
          'Decoded pixels differ from the original background proof.',
          'read',
        );
      if (
        artifact.image_background &&
        readImageCache(dataDir, 'image-background-cache', artifact.image_background.source_cache_path, {
          sha256,
          bytes: source.length,
        })
      ) {
        assertImageBackgroundSnapshot(jobs, job, artifact);
        continue;
      }
      const source_cache_path = directory.write(`original.${actual.format}`, source);
      jobs.saveImageBackground(job, artifact, {
        identity: imageBackgroundIdentity(job, artifact),
        background: 'opaque',
        width: actual.width,
        height: actual.height,
        nonopaque_pixels: actual.nonopaque_pixels,
        source_format: actual.format,
        source_sha256: sha256,
        source_bytes: source.length,
        source_cache_path,
        checked_at: new Date().toISOString(),
      });
      keep = true;
    } finally {
      if (!keep) directory.cleanup();
    }
  }
  const current = jobs.get(job.job_id);
  for (const artifact of imageSet(current)) assertImageBackgroundSnapshot(jobs, job, artifact);
  const mismatches = current.artifacts
    .filter((a) => a.kind === 'image' && a.image_background?.nonopaque_pixels !== 0)
    .map((a) => ({
      artifact_id: a.artifact_id,
      nonopaque_pixels: a.image_background?.nonopaque_pixels,
      source_sha256: a.image_background?.source_sha256,
      diagnostic_path: a.image_background?.source_cache_path,
    }));
  if (mismatches.length)
    throw new TripoError(
      'IMAGE_BACKGROUND_REQUIREMENT_FAILED',
      'Studio completed the original image, but its alpha does not satisfy background=opaque. Original diagnostics were retained; do not fill or regenerate.',
      'read',
      { mismatches },
    );
  return current;
}

function backgroundCacheState(
  jobs: JobStore,
  job: Job,
  artifact: Artifact,
  dataDir: string,
): { cached: boolean; encoded: boolean } {
  try {
    const proof = artifact.image_background;
    if (!proof || !matchingImageBackgroundProof(jobs, job, artifact))
      return { cached: false, encoded: false };
    const cached = Boolean(
      readImageCache(dataDir, 'image-background-cache', proof.source_cache_path, {
        sha256: proof.source_sha256,
        bytes: proof.source_bytes,
      }),
    );
    if (!readImageOutputFormat(jobs, job)) return { cached, encoded: true };
    const output = artifact.image_output;
    const encoded = Boolean(
      output &&
      output.source_sha256 === proof.source_sha256 &&
      output.source_bytes === proof.source_bytes &&
      output.source_format === proof.source_format &&
      output.width === proof.width &&
      output.height === proof.height &&
      readImageCache(dataDir, 'image-output-cache', output.cache_path, output),
    );
    return { cached, encoded };
  } catch {
    return { cached: false, encoded: false };
  }
}

export function imageBackgroundSummary(
  jobs: JobStore,
  job: Job,
  dataDir: string,
): Record<string, unknown> | undefined {
  if (!readImageBackground(jobs, job) || job.state !== 'succeeded') return;
  let verified = true;
  try {
    imageSet(job);
  } catch {
    verified = false;
  }
  const results = job.artifacts
    .filter((a) => a.kind === 'image')
    .map((artifact) => {
      const proof = artifact.image_background,
        matched = matchingImageBackgroundProof(jobs, job, artifact);
      const { cached, encoded } = backgroundCacheState(jobs, job, artifact, dataDir);
      const opaque = Boolean(matched && proof?.nonopaque_pixels === 0);
      if (!cached || !opaque || !encoded) verified = false;
      return {
        artifact_id: artifact.artifact_id,
        status: !matched
          ? 'unverified'
          : !opaque
            ? 'mismatch'
            : !cached
              ? 'cache_unavailable'
              : !encoded
                ? 'delivery_unverified'
                : 'verified',
        ...(matched && proof
          ? {
              nonopaque_pixels: proof.nonopaque_pixels,
              pixels: proof.width * proof.height,
              source_sha256: proof.source_sha256,
              diagnostic_path: proof.source_cache_path,
            }
          : {}),
      };
    });
  try {
    imageSet(jobs.get(job.job_id));
    for (const artifact of job.artifacts.filter((a) => a.kind === 'image'))
      assertImageBackgroundSnapshot(jobs, job, artifact);
  } catch {
    verified = false;
  }
  return {
    state: verified ? 'succeeded' : 'needs_attention',
    remote_state: 'succeeded',
    image_background_validation: {
      status: verified ? 'verified' : 'unverified',
      expected: 'opaque',
      processing: 'native_alpha_verified_without_background_fill',
      results,
    },
    ...(!verified
      ? {
          next_action:
            'Read the original image task to recover or verify its native alpha; do not regenerate.',
        }
      : {}),
  };
}

export async function downloadImageBackground(
  job: Job,
  artifact: Artifact,
  destination: { root: string; relative: string },
  inferExtension: boolean,
  jobs: JobStore,
  dataDir: string,
  gateway: Gateway,
): Promise<Record<string, unknown>> {
  const currentJob = await ensureImageBackground(job, jobs, dataDir, gateway),
    current = currentJob.artifacts.find((a) => a.artifact_id === artifact.artifact_id)!,
    proof = current.image_background!;
  const bytes = readImageCache(dataDir, 'image-background-cache', proof.source_cache_path, {
    sha256: proof.source_sha256,
    bytes: proof.source_bytes,
  });
  if (!bytes)
    throw new TripoError(
      'IMAGE_BACKGROUND_CONTENT_CHANGED',
      'Original opaque image cache changed before publication.',
      'read',
    );
  await assertOpaqueImageBytes(bytes);
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
  assertImageBackgroundSnapshot(jobs, currentJob, current);
  assertImageBackgroundDelivery(jobs, currentJob, current);
  return { ...(await publishLocal(target, bytes, proof.source_format)), image_background: proof };
}
