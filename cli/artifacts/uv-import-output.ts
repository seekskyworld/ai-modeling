/** UV 导入压缩的原生结果与坐标恢复交付分开证明；读取/下载只恢复原任务和原字节。 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Artifact, Job } from '../../studio/contracts/types.ts';
import type { Gateway } from '../../studio/api/gateway.ts';
import type { Fetcher } from '../../studio/api/client.ts';
import type { JobStore } from '../storage/jobs.ts';
import { text, TripoError } from '../../studio/contracts/errors.ts';
import {
  uvImportPolicy,
  uvImportProofKey,
  uvImportSource,
  uvArtifactIdentity,
} from '../core/uv-import-policy.ts';
import { verifyUvImport } from './uv-import-proof.ts';
import { verifyNativeMeshopt } from './native-meshopt.ts';
import { saveVerifiedOutputCache, recoverVerifiedArtifact } from './verified-output-cache.ts';
import { verifiedArtifactBytes } from './recover-download.ts';
import { download } from './download.ts';
import { localTarget, publishLocal } from '../local/files.ts';
import { artifactMatchesDeliveryProof, validDeliveryProof } from '../core/delivery-proof.ts';

type Proof = Record<string, unknown> & {
  identity: string;
  sha256: string;
  bytes: number;
  imported_sha256: string;
  imported_bytes: number;
  processing: string;
};
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
function changed(message: string): never {
  throw new TripoError('UV_COMPRESSION_IDENTITY_CHANGED', message, 'read');
}
function proofFor(jobs: JobStore, job: Job, artifact: Artifact): Proof | undefined {
  const policy = uvImportPolicy(jobs, job),
    proof = jobs.requestPolicy(job.account_ref, uvImportProofKey(job, artifact));
  if (!proof) return;
  if (
    !policy ||
    proof.identity !== uvArtifactIdentity(job, artifact) ||
    proof.source_identity !== policy.source_identity
  )
    return changed('The UV compression proof belongs to another task, source or artifact.');
  if (!validDeliveryProof(proof, 'imported_'))
    return changed('The original UV compression byte proof is invalid.');
  if (!artifactMatchesDeliveryProof(artifact, proof, 'imported_'))
    throw new TripoError(
      'UV_COMPRESSION_CONTENT_CHANGED',
      'The saved model metadata differs from its frozen imported or restored UV delivery bytes.',
      'read',
    );
  return proof as Proof;
}
function assertSnapshot(jobs: JobStore, job: Job, artifact: Artifact): Job {
  const current = jobs.get(job.job_id),
    latest = current.artifacts.find((entry) => entry.artifact_id === artifact.artifact_id);
  if (
    current.state !== 'succeeded' ||
    !latest ||
    uvArtifactIdentity(current, latest) !== uvArtifactIdentity(job, artifact)
  )
    return changed('The imported UV receipt changed during verification.');
  const policy = uvImportPolicy(jobs, current);
  if (!policy) return changed('The original UV compression policy is missing.');
  uvImportSource(jobs, current, policy);
  proofFor(jobs, current, latest);
  return current;
}
async function cachedBytes(
  job: Job,
  artifact: Artifact,
  proof: { sha256: string; bytes: number },
  jobs: JobStore,
  dir: string,
): Promise<Buffer | undefined> {
  const cached = await recoverVerifiedArtifact(job, artifact, proof, jobs, dir);
  return cached && (await verifiedArtifactBytes(cached));
}
async function importedBytes(
  job: Job,
  artifact: Artifact,
  proof: Proof | undefined,
  jobs: JobStore,
  dir: string,
  gateway: Gateway,
  fetcher?: Fetcher,
): Promise<Buffer> {
  const previous =
    proof &&
    (await cachedBytes(
      job,
      artifact,
      { sha256: proof.imported_sha256, bytes: proof.imported_bytes },
      jobs,
      dir,
    ));
  if (previous) return previous;
  if (!proof && !artifact.processing) {
    const local = await verifiedArtifactBytes(artifact);
    if (local) return local;
  }
  const root = path.join(dir, 'uv-import-checks');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(path.join(root, 'import-'));
  try {
    const url = await gateway.artifactUrl(job, artifact);
    assertSnapshot(jobs, job, artifact);
    const file = await download(url, temporary, 'native.glb', 'glb', fetcher);
    return await readFile(file.local_path);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
export function uvImportSummary(jobs: JobStore, job: Job): Record<string, unknown> | undefined {
  if (job.state !== 'succeeded') return;
  const policy = uvImportPolicy(jobs, job);
  if (!policy) return;
  let verified = false;
  try {
    uvImportSource(jobs, job, policy);
    const models = job.artifacts.filter((artifact) => artifact.kind === 'model');
    verified =
      models.length === 1 &&
      models.every((artifact) => artifact.format === 'glb' && Boolean(proofFor(jobs, job, artifact)));
  } catch {
    /* 列表不触网，失去来源/证明显示待验收，get给具体错误。 */
  }
  return {
    task_type: 'smart_uv',
    state: verified ? 'succeeded' : 'needs_attention',
    remote_state: 'succeeded',
    uv_compression_validation: {
      status: verified ? 'verified' : 'unverified',
      geometry_compression: 'meshopt',
      original_uv_task_id: policy.source_job_id,
      delivery_coordinates: 'original_uv_source',
      imported_project_coordinates: 'normalized',
      local_processing: policy.primitive_split
        ? 'json_primitive_split_and_verified_regrouping_with_root_transform_and_names'
        : 'root_transform_and_names_only',
      uv_quantization_tolerance: 0.00025,
      normal_vector_tolerance: 0.01,
    },
  };
}
export async function ensureUvImport(
  job: Job,
  jobs: JobStore,
  dir: string,
  gateway: Gateway,
  fetcher?: Fetcher,
): Promise<Job> {
  const policy = uvImportPolicy(jobs, job);
  if (!policy) return job;
  const source = uvImportSource(jobs, job, policy),
    models = job.artifacts.filter((artifact) => artifact.kind === 'model');
  if (models.length !== 1 || models[0]!.format !== 'glb')
    throw new TripoError(
      'ARTIFACT_NOT_READY',
      'UV compression requires exactly one native imported GLB result.',
      'read',
    );
  const artifact = models[0]!,
    previous = proofFor(jobs, job, artifact);
  if (previous) {
    const delivered = await cachedBytes(job, artifact, previous, jobs, dir);
    if (delivered) {
      await verifyNativeMeshopt(delivered);
      return assertSnapshot(jobs, job, artifact);
    }
  }
  const sourceBytes = await cachedBytes(
    source.job,
    source.artifact,
    { sha256: text(policy.source_sha256), bytes: Number(policy.source_bytes) },
    jobs,
    dir,
  );
  if (!sourceBytes)
    throw new TripoError(
      'UV_COMPRESSION_SOURCE_MISSING',
      'Restore the exact frozen UV source bytes before verifying the original import.',
      'read',
    );
  const native = await importedBytes(job, artifact, previous, jobs, dir, gateway, fetcher);
  if (previous && (previous.imported_sha256 !== digest(native) || previous.imported_bytes !== native.length))
    throw new TripoError(
      'UV_COMPRESSION_CONTENT_CHANGED',
      'The original imported UV bytes changed; no new import was submitted.',
      'read',
    );
  const result = await verifyUvImport(sourceBytes, native),
    proof: Proof = {
      ...result.proof,
      identity: uvArtifactIdentity(job, artifact),
      source_identity: policy.source_identity,
      sha256: text(result.proof.sha256),
      bytes: Number(result.proof.bytes),
      imported_sha256: text(result.proof.imported_sha256),
      imported_bytes: Number(result.proof.imported_bytes),
      processing: text(result.proof.processing),
    };
  await saveVerifiedOutputCache(job, artifact, { sha256: digest(native), bytes: native.length }, native, dir);
  await saveVerifiedOutputCache(job, artifact, proof, result.bytes, dir);
  assertSnapshot(jobs, job, artifact);
  jobs.bindArtifactPolicy(job, artifact, uvImportProofKey(job, artifact), proof);
  return assertSnapshot(jobs, job, artifact);
}
export async function downloadUvImport(
  job: Job,
  artifact: Artifact,
  destination: { root: string; relative: string },
  jobs: JobStore,
  dir: string,
  gateway: Gateway,
): Promise<Record<string, unknown>> {
  const checked = await ensureUvImport(job, jobs, dir, gateway),
    current = checked.artifacts.find((entry) => entry.artifact_id === artifact.artifact_id);
  if (!current) return changed('The compressed UV artifact is no longer available.');
  const proof = proofFor(jobs, checked, current);
  if (!proof) return changed('The compressed UV delivery has no proof.');
  const bytes = await cachedBytes(checked, current, proof, jobs, dir);
  if (!bytes) return changed('The verified compressed UV cache is missing.');
  await verifyNativeMeshopt(bytes);
  assertSnapshot(jobs, checked, current);
  const target = await localTarget(
    destination.root,
    path.resolve(destination.root, destination.relative),
    'glb',
  );
  return {
    ...(await publishLocal(target, bytes, 'glb')),
    processing: proof.processing,
    source_sha256: proof.imported_sha256,
  };
}
