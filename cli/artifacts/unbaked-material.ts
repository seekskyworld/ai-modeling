/** 不改变原生产物，只比较提交前冻结的基础 PBR、图片字节和逐面 UV/颜色。 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Job, Artifact } from '../../studio/contracts/types.ts';
import type { Gateway } from '../../studio/api/gateway.ts';
import type { JobStore } from '../storage/jobs.ts';
import { nativeUnbakedPivot } from '../../studio/contracts/export-options.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import { download } from './download.ts';
import { verifiedArtifactBytes } from './recover-download.ts';
import { materialSnapshot, sameMaterialSnapshot } from './material-snapshot.ts';
import { saveVerifiedOutputCache, recoverVerifiedArtifact } from './verified-output-cache.ts';
import {
  unbakedRequested,
  unbakedSourceKey,
  unbakedProofKey,
  unbakedSourceIdentity,
  unbakedIdentity,
  readUnbakedSource,
  assertUnbakedIdentity,
  assertUnbakedSnapshot,
  type UnbakedOutputProof,
} from '../core/unbaked-material-policy.ts';

async function temporaryBytes(url: string, dataDir: string): Promise<Buffer> {
  const root = path.join(dataDir, 'unbaked-material-checks');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(path.join(root, 'verify-'));
  try {
    const saved = await download(url, temporary, 'model.glb', 'glb');
    return await readFile(saved.local_path);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** 仅在新提交前取来源；已提交旧任务缺少快照时不得用事后来源冒充原意图。 */
export async function freezeUnbakedSource(
  job: Job,
  jobs: JobStore,
  dataDir: string,
  gateway: Gateway,
  read: (url: string, dataDir: string) => Promise<Buffer> = temporaryBytes,
): Promise<void> {
  if (!unbakedRequested(job)) return;
  const existing = jobs.requestPolicy(job.account_ref, unbakedSourceKey(job));
  if (existing) {
    readUnbakedSource(jobs, job);
    return;
  }
  if (!gateway.materialSource)
    throw new TripoError(
      'UNBAKED_SOURCE_UNVERIFIED',
      'This gateway cannot verify the exact original material source.',
      'not_submitted',
    );
  const source = await gateway.materialSource(job);
  const bytes = await read(source.url, dataDir);
  const snapshot = await materialSnapshot(
    bytes,
    source.material_factors,
    true,
    nativeUnbakedPivot(job.input),
  );
  if (Number(job.input.texture_size) < snapshot.maximum_texture_size)
    throw new TripoError(
      'UNBAKED_MATERIAL_UNSUPPORTED',
      'bake=false cannot resize the original textures; select a texture_size at least as large as the source.',
      'not_submitted',
      { source_texture_size: snapshot.maximum_texture_size },
    );
  jobs.bindUnbakedPolicy(job, unbakedSourceKey(job), {
    identity: unbakedSourceIdentity(job),
    sha256: sha(bytes),
    bytes: bytes.length,
    snapshot,
  });
}

export async function verifyUnbakedBytes(
  job: Job,
  artifact: Artifact,
  bytes: Buffer,
  jobs: JobStore,
): Promise<UnbakedOutputProof> {
  if (artifact.kind !== 'model' || artifact.format !== 'glb' || artifact.processing)
    throw new TripoError(
      'UNBAKED_MATERIAL_UNSUPPORTED',
      'bake=false requires the original native GLB.',
      'read',
    );
  const source = readUnbakedSource(jobs, job);
  const old = assertUnbakedIdentity(jobs, job, artifact);
  const digest = sha(bytes);
  if (old && (old.sha256 !== digest || old.bytes !== bytes.length))
    throw new TripoError(
      'UNBAKED_OUTPUT_CONTENT_CHANGED',
      'The export bytes changed after material verification; no replacement was submitted.',
      'read',
    );
  const snapshot = await materialSnapshot(
    bytes,
    {},
    false,
    false,
    source.snapshot.surface_encoding === 'oriented-corners-v2',
  );
  if (!sameMaterialSnapshot(source.snapshot, snapshot))
    throw new TripoError(
      'UNBAKED_MATERIAL_REQUIREMENT_FAILED',
      'The native export did not preserve the original texture bytes, verified material values, requested placement or per-face UV/color associations. The original remote receipt was preserved.',
      'read',
    );
  assertUnbakedSnapshot(jobs, job, artifact);
  return {
    identity: unbakedIdentity(job, artifact),
    sha256: digest,
    bytes: bytes.length,
    snapshot,
    source_identity: source.identity,
    source_sha256: source.sha256,
  };
}

export async function verifyUnbakedOutput(
  job: Job,
  jobs: JobStore,
  dataDir: string,
  gateway: Gateway,
): Promise<void> {
  if (!unbakedRequested(job)) return;
  readUnbakedSource(jobs, job);
  const models = job.artifacts.filter((item) => item.kind === 'model');
  if (!models.length)
    throw new TripoError(
      'ARTIFACT_NOT_READY',
      'The native export is not ready for material verification.',
      'read',
    );
  for (const artifact of models) {
    assertUnbakedSnapshot(jobs, job, artifact);
    const existing = assertUnbakedIdentity(jobs, job, artifact);
    if (existing) {
      await recoverVerifiedArtifact(job, artifact, existing, jobs, dataDir);
      assertUnbakedSnapshot(jobs, job, artifact);
      continue;
    }
    const cached = !artifact.processing ? await verifiedArtifactBytes(artifact) : undefined;
    const bytes = cached ?? (await temporaryBytes(await gateway.artifactUrl(job, artifact), dataDir));
    const proof = await verifyUnbakedBytes(job, artifact, bytes, jobs);
    await saveVerifiedOutputCache(job, artifact, proof, bytes, dataDir);
    jobs.bindUnbakedPolicy(job, unbakedProofKey(job, artifact), proof, artifact);
  }
}
