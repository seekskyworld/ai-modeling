/** 原件在提交前冻结；查询时只读真实导入产物验证缩放，失败不改变原任务或补提交。 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Artifact, Job } from '../../studio/contracts/types.ts';
import type { Gateway } from '../../studio/api/gateway.ts';
import type { JobStore } from '../storage/jobs.ts';
import { errorResult, object, text, TripoError } from '../../studio/contracts/errors.ts';
import { readModelInput } from '../../studio/files.ts';
import { fingerprint } from '../core/fingerprint.ts';
import {
  importNormalizationIdentity,
  importNormalizationProofKey,
  importNormalizationSourceKey,
  importNormalizationSummary,
  normalizationUnavailable,
} from '../core/import-normalization-policy.ts';
import { inspectImportNormalizationSource, verifyImportNormalization } from './import-normalization-proof.ts';
import { readVerifiedOutputCache, saveVerifiedOutputCache } from './verified-output-cache.ts';
import { verifiedArtifactBytes } from './recover-download.ts';
import { download } from './download.ts';

type Context = {
  jobs: JobStore;
  dataDir: string;
  inputRoots?: string[];
  checkAccount: () => void;
};
const sourceArtifact: Artifact = {
  artifact_id: 'import-normalization-source',
  kind: 'model',
  format: 'glb',
  index: 0,
};
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** 只为新请求增加可选快照；旧 prepared、failed、unknown 和成功任务均不回填原件。 */
export async function freezeImportNormalization(
  context: Context & { inputRoots: string[] },
  account: string,
  request: string,
  input: Record<string, unknown>,
): Promise<void> {
  if (context.jobs.find(account, request)) return;
  const key = importNormalizationSourceKey(request),
    inputHash = fingerprint(input),
    previous = context.jobs.requestPolicy(account, key);
  if (previous) {
    if (previous.input_hash !== inputHash)
      throw new TripoError('IDEMPOTENCY_CONFLICT', 'The frozen normalization source input changed.');
    return;
  }
  let policy: Record<string, unknown>;
  try {
    if (fingerprint(input.transform_matrix) !== fingerprint(identity) || input.use_original_uv !== true)
      throw new TripoError(
        'IMPORT_NORMALIZATION_UNSUPPORTED',
        'Scale metadata currently requires identity import and original UVs; the import still runs normally.',
      );
    const file = await readModelInput(text(input.model_path), context.inputRoots);
    if (file.format !== 'glb' || object(input._input_files)[text(input.model_path)] !== file.sha256)
      throw new TripoError(
        'IMPORT_NORMALIZATION_UNSUPPORTED',
        'Scale metadata needs the exact self-contained GLB read for this submission.',
      );
    const inspection = await inspectImportNormalizationSource(file.bytes);
    await saveVerifiedOutputCache(
      { account_ref: account },
      sourceArtifact,
      { sha256: file.sha256, bytes: file.bytes.length },
      file.bytes,
      context.dataDir,
    );
    policy = {
      version: 1,
      status: 'eligible',
      input_hash: inputHash,
      source_sha256: file.sha256,
      source_bytes: file.bytes.length,
      cache_data_dir: context.dataDir,
      inspection,
    };
  } catch (error) {
    const failure = errorResult(error);
    policy = {
      version: 1,
      status: 'unavailable',
      input_hash: inputHash,
      reason: failure.message,
      code: failure.code,
    };
  }
  context.checkAccount();
  // 解析期间其它进程已创建请求时不追补快照，避免旧任务获得事后证明。
  if (!context.jobs.find(account, request)) context.jobs.bindRequestPolicy(account, key, policy);
}

async function originalImportBytes(context: Context, gateway: Gateway, job: Job, artifact: Artifact) {
  const local = await verifiedArtifactBytes(artifact);
  if (local) return local;
  const root = path.join(context.dataDir, 'import-normalization-checks');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(path.join(root, 'import-'));
  try {
    const file = await download(await gateway.artifactUrl(job, artifact), temporary, 'import.glb', 'glb');
    return await readFile(file.local_path);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function ensureImportNormalization(
  context: Context,
  gateway: Gateway,
  job: Job,
): Promise<Record<string, unknown>> {
  const summary = importNormalizationSummary(context.jobs, job),
    source = context.jobs.requestPolicy(job.account_ref, importNormalizationSourceKey(job.request_id));
  if (
    summary.normalize_scale !== undefined ||
    job.state !== 'succeeded' ||
    source?.status !== 'eligible' ||
    source.input_hash !== fingerprint(job.input)
  )
    return summary;
  try {
    const models = job.artifacts.filter((artifact) => artifact.kind === 'model'),
      artifact = models[0];
    if (models.length !== 1 || artifact?.format !== 'glb' || artifact.processing) return summary;
    const sourceBytes = await readVerifiedOutputCache(
      job.account_ref,
      { sha256: text(source.source_sha256), bytes: Number(source.source_bytes) },
      text(source.cache_data_dir),
    );
    if (!sourceBytes)
      return normalizationUnavailable('The original pre-submission source cache is missing or changed.');
    const imported = await originalImportBytes(context, gateway, job, artifact),
      proof = await verifyImportNormalization(sourceBytes, imported);
    context.checkAccount();
    await saveVerifiedOutputCache(
      job,
      artifact,
      { sha256: text(proof.imported_sha256), bytes: Number(proof.imported_bytes) },
      imported,
      context.dataDir,
    );
    context.checkAccount();
    context.jobs.bindArtifactPolicy(job, artifact, importNormalizationProofKey(job), {
      ...proof,
      identity: importNormalizationIdentity(job, artifact),
    });
    return importNormalizationSummary(context.jobs, context.jobs.get(job.job_id));
  } catch (error) {
    const failure = errorResult(error);
    return normalizationUnavailable(text(failure.message), text(failure.code));
  }
}
