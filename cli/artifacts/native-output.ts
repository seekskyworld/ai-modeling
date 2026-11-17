/** 用原始网页回执验收压缩效果；只临时读取原产物并保存证明，不重新生成、转换或压缩。 */
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Artifact, Job } from '../../studio/contracts/types.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import type { Gateway } from '../../studio/api/gateway.ts';
import type { JobStore } from '../storage/jobs.ts';
import { fingerprint } from '../core/fingerprint.ts';
import { download } from './download.ts';
import { verifiedArtifactBytes } from './recover-download.ts';
import { verifyNativeMeshopt } from './native-meshopt.ts';
import { supportsNativeMeshopt } from '../core/native-output-policy.ts';
import { saveVerifiedOutputCache, recoverVerifiedArtifact } from './verified-output-cache.ts';

function identity(job: Job, artifact: Artifact): string {
  return fingerprint({
    version: 1,
    account: job.account_ref,
    job_id: job.job_id,
    operation: job.operation,
    remote_ids: job.remote_ids,
    artifact_id: artifact.artifact_id,
    format: artifact.format,
    index: artifact.index,
  });
}

export function hasNativeOutputProof(job: Job): boolean {
  const models = job.artifacts.filter((artifact) => artifact.kind === 'model');
  return (
    models.length > 0 &&
    models.every(
      (artifact) =>
        artifact.format === 'glb' &&
        artifact.native_validation?.geometry_compression === 'meshopt' &&
        artifact.native_validation.identity === identity(job, artifact) &&
        (!artifact.sha256 || artifact.sha256 === artifact.native_validation.sha256) &&
        (!artifact.bytes || artifact.bytes === artifact.native_validation.bytes),
    )
  );
}

/** 已验原版本不能因新回执或新缓存被覆盖而移植证明；下载恢复也必须先检查身份。 */
export function assertNativeOutputIdentity(job: Job, artifact: Artifact): void {
  const proof = artifact.native_validation;
  if (!proof) return;
  if (proof.identity !== identity(job, artifact))
    throw new TripoError(
      'NATIVE_OUTPUT_IDENTITY_CHANGED',
      'The verified native artifact belongs to another receipt or artifact identity; recover the original task.',
      'read',
    );
  if (
    (artifact.sha256 && artifact.sha256 !== proof.sha256) ||
    (artifact.bytes && artifact.bytes !== proof.bytes)
  )
    throw new TripoError(
      'NATIVE_OUTPUT_CONTENT_CHANGED',
      'The recorded native artifact differs from its original verified bytes.',
      'read',
    );
}

/** 每次异步读取返回后重新匹配整个任务/产物快照；事务保存仍会再执行最终 CAS。 */
export function assertNativeOutputSnapshot(job: Job, artifact: Artifact, current: Job): Artifact {
  const latest = current.artifacts.find((item) => item.artifact_id === artifact.artifact_id);
  if (!latest || identity(current, latest) !== identity(job, artifact))
    throw new TripoError(
      'NATIVE_OUTPUT_IDENTITY_CHANGED',
      'The original native task changed during download; no replacement result was accepted.',
      'read',
    );
  assertNativeOutputIdentity(current, latest);
  return latest;
}

/** 同一 URL 可返回另一份同样压缩的模型；压缩验证之外还要守住先前验过的原字节。 */
export async function verifyNativeArtifactBytes(
  job: Job,
  artifact: Artifact,
  bytes: Buffer,
  format: string,
): Promise<void> {
  assertNativeOutputIdentity(job, artifact);
  await verifyNativeMeshopt(bytes, format);
  const proof = artifact.native_validation;
  if (
    proof &&
    (proof.bytes !== bytes.length || proof.sha256 !== createHash('sha256').update(bytes).digest('hex'))
  )
    throw new TripoError(
      'NATIVE_OUTPUT_CONTENT_CHANGED',
      'Studio returned different bytes for the original verified native artifact; no replacement was submitted.',
      'read',
    );
}

async function originalBytes(
  job: Job,
  artifact: Artifact,
  dataDir: string,
  gateway: Gateway,
): Promise<Buffer> {
  const cached = !artifact.processing ? await verifiedArtifactBytes(artifact) : undefined;
  if (cached) return cached;
  const root = path.join(dataDir, 'native-output-checks');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(path.join(root, 'verify-'));
  try {
    const saved = await download(
      await gateway.artifactUrl(job, artifact),
      temporary,
      'model.glb',
      'glb',
      undefined,
      false,
      {
        validateBytes: async (bytes, format) => {
          await verifyNativeMeshopt(bytes, format);
        },
      },
    );
    return await readFile(saved.local_path);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function verifyNativeJobOutput(
  job: Job,
  jobs: JobStore,
  dataDir: string,
  gateway: Gateway,
): Promise<Record<string, unknown>> {
  if (!supportsNativeMeshopt(job.operation))
    throw new TripoError(
      'NATIVE_OUTPUT_REQUIREMENT_FAILED',
      'This task has no verified native Meshopt mapping.',
      'read',
    );
  const models = job.artifacts.filter((artifact) => artifact.kind === 'model');
  if (!models.length)
    throw new TripoError(
      'ARTIFACT_NOT_READY',
      'The native model artifact is not ready for compression verification.',
      'read',
    );
  for (const artifact of models) {
    assertNativeOutputIdentity(job, artifact);
    if (artifact.format !== 'glb')
      throw new TripoError(
        'NATIVE_OUTPUT_REQUIREMENT_FAILED',
        'Studio returned a non-GLB model; native Meshopt compression was not met.',
        'read',
      );
    const key = identity(job, artifact);
    if (
      artifact.native_validation?.identity === key &&
      artifact.native_validation.geometry_compression === 'meshopt'
    ) {
      await recoverVerifiedArtifact(job, artifact, artifact.native_validation, jobs, dataDir);
      assertNativeOutputSnapshot(job, artifact, jobs.get(job.job_id));
      continue;
    }
    const bytes = await originalBytes(job, artifact, dataDir, gateway);
    const checked = await verifyNativeMeshopt(bytes, artifact.format);
    await saveVerifiedOutputCache(
      job,
      artifact,
      { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length },
      bytes,
      dataDir,
    );
    jobs.saveNativeValidation(
      job.job_id,
      artifact.artifact_id,
      {
        geometry_compression: 'meshopt',
        identity: key,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
        checked_at: new Date().toISOString(),
        ...checked,
      },
      {
        account_ref: job.account_ref,
        operation: job.operation,
        remote_ids: job.remote_ids,
        format: artifact.format,
        index: artifact.index,
      },
    );
  }
  return {
    status: 'verified',
    geometry_compression: 'meshopt',
    artifact_ids: models.map((artifact) => artifact.artifact_id),
  };
}
