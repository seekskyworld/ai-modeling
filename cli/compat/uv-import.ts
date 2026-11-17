/** 上一步真实 UV 产物作为网页导入文件；缓存、来源身份和参数在任何新导入前一起冻结。 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Plan } from './planning.ts';
import type { Job, Artifact } from '../../studio/contracts/types.ts';
import type { Gateway } from '../../studio/api/gateway.ts';
import type { JobStore } from '../storage/jobs.ts';
import { text, TripoError } from '../../studio/contracts/errors.ts';
import { fingerprint } from '../core/fingerprint.ts';
import { uvImportPolicyKey, uvArtifactIdentity } from '../core/uv-import-policy.ts';
import { inspectUvImportSource } from '../artifacts/uv-import-proof.ts';
import { splitUvImportSource } from '../artifacts/uv-import-layout.ts';
import { verifiedArtifactBytes } from '../artifacts/recover-download.ts';
import { saveVerifiedOutputCache, recoverVerifiedArtifact } from '../artifacts/verified-output-cache.ts';
import { download } from '../artifacts/download.ts';

type Context = { jobs: JobStore; gateway: Gateway; dataDir: string; account: string };
export function freezeUvImportLayout(
  context: Pick<Context, 'jobs' | 'account'>,
  plan: Plan,
  request: string,
): void {
  const positions = plan.steps.flatMap((step, index) => (step.uvImportFromChain ? [index] : [])),
    key = `uv-import-layout:${request}`,
    saved = context.jobs.requestPolicy(context.account, key);
  if (!positions.length && !saved) return;
  if (positions.some((index) => index !== plan.steps.length - 1))
    throw new TripoError(
      'UV_COMPRESSION_CONTINUATION_UNVERIFIED',
      'UV compression currently requires a final delivery step; use the original UV task for further web editing.',
      'not_submitted',
    );
  if (!saved && plan.steps.some((_, index) => context.jobs.find(context.account, `${request}-${index}`)))
    throw new TripoError(
      'IDEMPOTENCY_CONFLICT',
      'An existing UV run cannot acquire a new import/compression step.',
      'not_submitted',
    );
  context.jobs.bindRequestPolicy(context.account, key, {
    positions,
    operations: plan.steps.map((step) => step.operation),
  });
}
async function sourceBytes(
  context: Context,
  job: Job,
  artifact: Artifact,
  saved?: Record<string, unknown>,
): Promise<Buffer> {
  const proof = saved && { sha256: text(saved.source_sha256), bytes: Number(saved.source_bytes) };
  const cached =
    proof && (await recoverVerifiedArtifact(job, artifact, proof, context.jobs, context.dataDir));
  const bytes = await verifiedArtifactBytes(cached || artifact);
  if (bytes) return bytes;
  const root = path.join(context.dataDir, 'uv-import-checks');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(path.join(root, 'source-'));
  try {
    const file = await download(
      await context.gateway.artifactUrl(job, artifact),
      temporary,
      'source.glb',
      'glb',
    );
    return await readFile(file.local_path);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
export async function prepareUvImport(
  context: Context,
  request: string,
  parameters: Record<string, unknown>,
  source: Job,
): Promise<Record<string, unknown>> {
  const models = source.artifacts.filter((artifact) => artifact.kind === 'model'),
    artifact = models[0],
    key = uvImportPolicyKey(request),
    previous = context.jobs.requestPolicy(context.account, key);
  if (
    source.account_ref !== context.account ||
    source.operation !== 'uv_commit' ||
    source.state !== 'succeeded' ||
    models.length !== 1 ||
    artifact?.format !== 'glb' ||
    artifact.processing
  )
    throw new TripoError(
      'UV_COMPRESSION_UNSUPPORTED',
      'Compression needs one successful native UV-apply GLB artifact from this account.',
      'not_submitted',
    );
  const identity = uvArtifactIdentity(source, artifact);
  if (previous && previous.source_identity !== identity)
    throw new TripoError(
      'IDEMPOTENCY_CONFLICT',
      'The original UV compression source changed.',
      'not_submitted',
    );
  const bytes = await sourceBytes(context, source, artifact, previous),
    inspection = await inspectUvImportSource(bytes);
  if (
    previous &&
    (previous.source_sha256 !== inspection.source_sha256 || previous.source_bytes !== bytes.length)
  )
    throw new TripoError(
      'INPUT_CHANGED',
      'The original UV compression source bytes changed.',
      'not_submitted',
    );
  const original = await saveVerifiedOutputCache(
      source,
      artifact,
      { sha256: inspection.source_sha256, bytes: bytes.length },
      bytes,
      context.dataDir,
    ),
    prepared = await splitUvImportSource(bytes),
    cached = prepared.proof
      ? await saveVerifiedOutputCache(
          source,
          artifact,
          { sha256: text(prepared.proof.import_sha256), bytes: prepared.bytes.length },
          prepared.bytes,
          context.dataDir,
        )
      : original,
    input = { ...parameters, model_path: cached.local_path };
  if (previous && previous.input !== fingerprint(input))
    throw new TripoError('IDEMPOTENCY_CONFLICT', 'The original UV import options changed.', 'not_submitted');
  context.jobs.bindArtifactPolicy(source, artifact, key, {
    version: 1,
    input: fingerprint(input),
    source_job_id: source.job_id,
    source_artifact_id: artifact.artifact_id,
    source_identity: identity,
    source_sha256: inspection.source_sha256,
    source_bytes: bytes.length,
    ...(prepared.proof
      ? {
          import_sha256: prepared.proof.import_sha256,
          import_bytes: prepared.bytes.length,
          primitive_split: prepared.proof,
        }
      : {}),
    inspection,
  });
  return input;
}
