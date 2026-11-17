/** 明确 WxH 是交付义务；与网页比例分开冻结，不能从旧请求或一次相同比例反推原意图。 */
import { TripoError } from '../../studio/contracts/errors.ts';
import type { Artifact, Job } from '../../studio/contracts/types.ts';
import type { JobStore } from '../storage/jobs.ts';
import { fingerprint } from './fingerprint.ts';

export interface ImageSizeRequirement {
  width: number;
  height: number;
}
export const imageSizePolicyKey = (request: string): string => `image-size:${request}`;
export const imageSizeProofKey = (job: Job, artifact: Artifact): string =>
  `image-size-proof:${job.job_id}:${artifact.artifact_id}`;

function validSize(size: unknown): size is ImageSizeRequirement {
  if (!size || typeof size !== 'object') return false;
  const value = size as ImageSizeRequirement;
  return (
    Number.isInteger(value.width) &&
    value.width > 0 &&
    value.width <= 16384 &&
    Number.isInteger(value.height) &&
    value.height > 0 &&
    value.height <= 16384
  );
}

export function readImageSize(jobs: JobStore, job: Job): ImageSizeRequirement | undefined {
  const saved = jobs.requestPolicy(job.account_ref, imageSizePolicyKey(job.request_id));
  if (!saved) return;
  if (saved.version === 1 && saved.size === null) return;
  if (saved.version !== 1 || !validSize(saved.size))
    throw new TripoError(
      'IMAGE_SIZE_POLICY_INVALID',
      'The saved exact image size intent is invalid.',
      'read',
    );
  return saved.size;
}

export function freezeImageSizePolicy(
  jobs: JobStore,
  account: string,
  request: string,
  size: ImageSizeRequirement | undefined,
): void {
  if (size && !validSize(size))
    throw new TripoError(
      'INVALID_INPUT',
      'Exact image size must contain positive integer dimensions.',
      'not_submitted',
    );
  jobs.bindImageSizeIntent(account, request, size);
}

export function imageSizeIdentity(job: Job, artifact: Artifact, size: ImageSizeRequirement): string {
  // 编码可能改变 format，但原资产、输入、输出索引与 WxH 均不能变。
  return fingerprint({
    version: 1,
    account: job.account_ref,
    job_id: job.job_id,
    request_id: job.request_id,
    operation: job.operation,
    input: job.input,
    remote_ids: job.remote_ids,
    artifact_id: artifact.artifact_id,
    kind: artifact.kind,
    index: artifact.index,
    size,
  });
}

export function imageSizeFrozenProof(proof: NonNullable<Artifact['image_size']>): Record<string, unknown> {
  const frozen: Record<string, unknown> = { ...proof };
  delete frozen.source_cache_path;
  delete frozen.checked_at;
  return frozen;
}

export function matchingImageSizeProof(jobs: JobStore, job: Job, artifact: Artifact): boolean {
  const size = readImageSize(jobs, job),
    proof = artifact.image_size;
  if (!size || !proof || job.operation !== 'image' || artifact.kind !== 'image') return false;
  const frozen = jobs.requestPolicy(job.account_ref, imageSizeProofKey(job, artifact));
  return Boolean(
    frozen &&
    proof.identity === imageSizeIdentity(job, artifact, size) &&
    proof.expected_width === size.width &&
    proof.expected_height === size.height &&
    ['png', 'jpeg', 'webp'].includes(proof.source_format) &&
    /^[a-f0-9]{64}$/.test(proof.source_sha256) &&
    proof.source_bytes > 0 &&
    Number.isInteger(proof.width) &&
    proof.width > 0 &&
    Number.isInteger(proof.height) &&
    proof.height > 0 &&
    fingerprint(frozen) === fingerprint(imageSizeFrozenProof(proof)),
  );
}

export function imageSizeMatches(proof: NonNullable<Artifact['image_size']>): boolean {
  return proof.width === proof.expected_width && proof.height === proof.expected_height;
}

export function assertImageSizeSnapshot(jobs: JobStore, expected: Job, artifact: Artifact): Job {
  const job = jobs.get(expected.job_id),
    size = readImageSize(jobs, expected);
  const current = job.artifacts.find((a) => a.artifact_id === artifact.artifact_id);
  if (
    !size ||
    job.state !== 'succeeded' ||
    !current ||
    imageSizeIdentity(job, current, size) !== imageSizeIdentity(expected, artifact, size) ||
    !matchingImageSizeProof(jobs, job, current) ||
    !artifact.image_size ||
    fingerprint(imageSizeFrozenProof(current.image_size!)) !==
      fingerprint(imageSizeFrozenProof(artifact.image_size))
  )
    throw new TripoError(
      'IMAGE_SIZE_IDENTITY_CHANGED',
      'The original image identity or pixel-size proof changed; reread the original task.',
      'read',
    );
  const latest = jobs.get(expected.job_id),
    final = latest.artifacts.find((a) => a.artifact_id === artifact.artifact_id);
  if (
    latest.state !== 'succeeded' ||
    !final?.image_size ||
    imageSizeIdentity(latest, final, size!) !== imageSizeIdentity(expected, artifact, size!) ||
    fingerprint(imageSizeFrozenProof(final.image_size)) !==
      fingerprint(imageSizeFrozenProof(artifact.image_size!))
  )
    throw new TripoError(
      'IMAGE_SIZE_IDENTITY_CHANGED',
      'Original image identity changed while checking its pixel-size proof.',
      'read',
    );
  return job;
}

/** 数据库最终 CAS 也核原图与交付物；下载调用方遗漏可选guard不能绕过精确尺寸。 */
export function assertImageSizeDelivery(jobs: JobStore, job: Job, artifact: Artifact): void {
  if (!readImageSize(jobs, job)) return;
  const proof = artifact.image_size;
  if (!proof || !matchingImageSizeProof(jobs, job, artifact) || !imageSizeMatches(proof))
    throw new TripoError(
      'IMAGE_SIZE_REQUIREMENT_FAILED',
      'The image has no valid proof of the requested pixel dimensions.',
      'read',
    );
  const output = artifact.image_output;
  if (
    output &&
    (output.source_sha256 !== proof.source_sha256 ||
      output.source_bytes !== proof.source_bytes ||
      output.source_format !== proof.source_format ||
      output.width !== proof.width ||
      output.height !== proof.height)
  )
    throw new TripoError(
      'IMAGE_SIZE_CONTENT_CHANGED',
      'The encoded image does not match the verified original dimensions and bytes.',
      'read',
    );
  if (
    artifact.local_path &&
    (artifact.sha256 !== (output?.sha256 ?? proof.source_sha256) ||
      artifact.bytes !== (output?.bytes ?? proof.source_bytes))
  )
    throw new TripoError(
      'IMAGE_SIZE_CONTENT_CHANGED',
      'The delivered image differs from its verified pixel-size source.',
      'read',
    );
}

export const imageSizeWarning =
  'Exact WxH is mapped to verified Studio resolution/ratio controls and frozen as a delivery requirement. Every original result is decoded and checked; a pixel mismatch remains needs_attention with the original remote success and diagnostic image, without resizing or regeneration.';
