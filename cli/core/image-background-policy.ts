/** opaque 是原图交付约束，不伪造网页字段、不补白底，也不把旧任务追认为显式背景请求。 */
import { TripoError } from '../../studio/contracts/errors.ts';
import type { Artifact, Job } from '../../studio/contracts/types.ts';
import type { JobStore } from '../storage/jobs.ts';
import { fingerprint } from './fingerprint.ts';

export type ImageBackground = 'opaque';
export const imageBackgroundPolicyKey = (request: string): string => `image-background:${request}`;
export const imageBackgroundProofKey = (job: Job, artifact: Artifact): string =>
  `image-background-proof:${job.job_id}:${artifact.artifact_id}`;

export function takeImageBackground(input: Record<string, unknown>): ImageBackground | undefined {
  if (input.background === undefined) return;
  if (input.background !== 'opaque')
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      'Only background=opaque has a verified Sunburst delivery mapping. Studio Cutout changes the frame, so it cannot establish transparent or auto background semantics.',
      'not_submitted',
    );
  delete input.background;
  return 'opaque';
}

export function readImageBackground(jobs: JobStore, job: Job): ImageBackground | undefined {
  const saved = jobs.requestPolicy(job.account_ref, imageBackgroundPolicyKey(job.request_id));
  if (!saved || (saved.version === 1 && saved.background === null)) return;
  if (saved.version !== 1 || saved.background !== 'opaque')
    throw new TripoError(
      'IMAGE_BACKGROUND_POLICY_INVALID',
      'Saved image background intent is invalid.',
      'read',
    );
  return saved.background;
}

export function freezeImageBackgroundPolicy(
  jobs: JobStore,
  account: string,
  request: string,
  background: ImageBackground | undefined,
): void {
  if (background !== undefined && background !== 'opaque')
    throw new TripoError('INVALID_INPUT', 'Only opaque image background is supported.', 'not_submitted');
  jobs.bindImageBackgroundIntent(account, request, background);
}

export function imageBackgroundIdentity(job: Job, artifact: Artifact): string {
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
    background: 'opaque',
  });
}

export function imageBackgroundFrozenProof(
  proof: NonNullable<Artifact['image_background']>,
): Record<string, unknown> {
  const frozen: Record<string, unknown> = { ...proof };
  delete frozen.source_cache_path;
  delete frozen.checked_at;
  return frozen;
}

export function validImageBackgroundProof(proof: NonNullable<Artifact['image_background']>): boolean {
  return Boolean(
    proof.background === 'opaque' &&
    ['png', 'jpeg', 'webp'].includes(proof.source_format) &&
    /^[a-f0-9]{64}$/.test(proof.source_sha256) &&
    Number.isInteger(proof.source_bytes) &&
    proof.source_bytes > 0 &&
    Number.isInteger(proof.width) &&
    proof.width > 0 &&
    Number.isInteger(proof.height) &&
    proof.height > 0 &&
    proof.width * proof.height <= 40_000_000 &&
    Number.isInteger(proof.nonopaque_pixels) &&
    proof.nonopaque_pixels >= 0 &&
    proof.nonopaque_pixels <= proof.width * proof.height,
  );
}

export function matchingImageBackgroundProof(jobs: JobStore, job: Job, artifact: Artifact): boolean {
  const proof = artifact.image_background;
  if (
    !readImageBackground(jobs, job) ||
    !proof ||
    job.operation !== 'image' ||
    job.input.model_version !== 'gpt_image_2.5_sunburst' ||
    artifact.kind !== 'image'
  )
    return false;
  const frozen = jobs.requestPolicy(job.account_ref, imageBackgroundProofKey(job, artifact));
  return Boolean(
    frozen &&
    validImageBackgroundProof(proof) &&
    proof.identity === imageBackgroundIdentity(job, artifact) &&
    fingerprint(frozen) === fingerprint(imageBackgroundFrozenProof(proof)),
  );
}

export function assertImageBackgroundSnapshot(jobs: JobStore, expected: Job, artifact: Artifact): Job {
  const job = jobs.get(expected.job_id),
    current = job.artifacts.find((a) => a.artifact_id === artifact.artifact_id);
  if (
    job.state !== 'succeeded' ||
    !current ||
    imageBackgroundIdentity(job, current) !== imageBackgroundIdentity(expected, artifact) ||
    !matchingImageBackgroundProof(jobs, job, current) ||
    !artifact.image_background ||
    fingerprint(imageBackgroundFrozenProof(current.image_background!)) !==
      fingerprint(imageBackgroundFrozenProof(artifact.image_background))
  )
    throw new TripoError(
      'IMAGE_BACKGROUND_IDENTITY_CHANGED',
      'Original image identity or background proof changed; reread the original task.',
      'read',
    );
  // 证明查询期间可能有另一连接改写回执；最后再核当前身份，不能只返回查询前的对象。
  const latest = jobs.get(expected.job_id),
    final = latest.artifacts.find((a) => a.artifact_id === artifact.artifact_id);
  if (
    latest.state !== 'succeeded' ||
    !final?.image_background ||
    imageBackgroundIdentity(latest, final) !== imageBackgroundIdentity(expected, artifact) ||
    fingerprint(imageBackgroundFrozenProof(final.image_background)) !==
      fingerprint(imageBackgroundFrozenProof(artifact.image_background!))
  )
    throw new TripoError(
      'IMAGE_BACKGROUND_IDENTITY_CHANGED',
      'Original image identity changed while checking its alpha proof.',
      'read',
    );
  return job;
}

export function assertImageBackgroundDelivery(jobs: JobStore, job: Job, artifact: Artifact): void {
  if (!readImageBackground(jobs, job)) return;
  const proof = artifact.image_background;
  if (!proof || !matchingImageBackgroundProof(jobs, job, artifact) || proof.nonopaque_pixels !== 0)
    throw new TripoError(
      'IMAGE_BACKGROUND_REQUIREMENT_FAILED',
      'The original image has no valid proof of a fully opaque background.',
      'read',
    );
  for (const other of [artifact.image_size, artifact.image_output])
    if (
      other &&
      (other.source_sha256 !== proof.source_sha256 ||
        other.source_bytes !== proof.source_bytes ||
        other.source_format !== proof.source_format ||
        other.width !== proof.width ||
        other.height !== proof.height)
    )
      throw new TripoError(
        'IMAGE_BACKGROUND_CONTENT_CHANGED',
        'Image delivery differs from the original opaque pixel proof.',
        'read',
      );
  const output = artifact.image_output;
  if (
    artifact.local_path &&
    (artifact.sha256 !== (output?.sha256 ?? proof.source_sha256) ||
      artifact.bytes !== (output?.bytes ?? proof.source_bytes))
  )
    throw new TripoError(
      'IMAGE_BACKGROUND_CONTENT_CHANGED',
      'Delivered bytes differ from the verified opaque image.',
      'read',
    );
}

export const imageBackgroundWarning =
  'background=opaque is frozen as a native Sunburst delivery requirement. Every original image is fully decoded and must have alpha=255 everywhere; a mismatch remains needs_attention with the original remote success and diagnostics. No background fill, resizing, regeneration or extra processing task is performed.';
