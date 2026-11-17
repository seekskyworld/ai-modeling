/** 首个付费UV前判定可知的源结构限制；已有意图恢复不重新读取会变化的网页当前模型。 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Job } from '../../studio/contracts/types.ts';
import type { Gateway } from '../../studio/api/gateway.ts';
import type { JobStore } from '../storage/jobs.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import { fingerprint } from '../core/fingerprint.ts';
import { uvArtifactIdentity, uvInputPolicyKey } from '../core/uv-import-policy.ts';
import { inspectUvCompressionInput } from '../artifacts/uv-import-proof.ts';
import { verifiedArtifactBytes } from '../artifacts/recover-download.ts';
import { download } from '../artifacts/download.ts';

type Context = { jobs: JobStore; gateway: Gateway; dataDir: string; account: string };
async function sourceFile(context: Context, input: Record<string, unknown>, source?: Job): Promise<Buffer> {
  const models = source?.artifacts.filter((artifact) => artifact.kind === 'model') ?? [],
    artifact = models.length === 1 ? models[0] : undefined;
  const exact =
    source?.state === 'succeeded' &&
    source.account_ref === context.account &&
    source.remote_ids.project_id === input.project_id &&
    source.remote_ids.operator_id === input.current_operator_id &&
    artifact?.format === 'glb' &&
    !artifact.processing;
  if (exact) {
    const local = await verifiedArtifactBytes(artifact);
    if (local) return local;
  }
  const root = path.join(context.dataDir, 'uv-import-checks');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(path.join(root, 'preflight-'));
  try {
    const sourceUrl = exact
      ? { url: await context.gateway.artifactUrl(source!, artifact!) }
      : await context.gateway.uvSource?.(context.account, input);
    if (!sourceUrl)
      throw new TripoError(
        'UV_COMPRESSION_SOURCE_UNVERIFIED',
        'The exact source model cannot be inspected before UV generation.',
        'not_submitted',
      );
    const file = await download(sourceUrl.url, temporary, 'source.glb', 'glb');
    return await readFile(file.local_path);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
export async function freezeUvInput(
  context: Context,
  request: string,
  input: Record<string, unknown>,
  discardTextures: boolean,
  source?: Job,
): Promise<void> {
  const key = uvInputPolicyKey(request),
    previous = context.jobs.requestPolicy(context.account, key),
    intent = fingerprint(input);
  if (previous) {
    if (
      previous.intent !== intent ||
      previous.discard_textures !== discardTextures ||
      previous.source_job_id !== source?.job_id
    )
      throw new TripoError(
        'IDEMPOTENCY_CONFLICT',
        'The original UV compression source or texture policy changed.',
        'not_submitted',
      );
    return;
  }
  const bytes = await sourceFile(context, input, source),
    inspection = await inspectUvCompressionInput(bytes, { discardTextures }),
    policy = {
      version: 1,
      intent,
      discard_textures: discardTextures,
      source_job_id: source?.job_id,
      inspection,
    };
  const artifact = source?.artifacts.find((entry) => entry.kind === 'model');
  if (source && artifact) {
    context.jobs.bindArtifactPolicy(source, artifact, key, {
      ...policy,
      source_identity: uvArtifactIdentity(source, artifact),
    });
  } else context.jobs.bindRequestPolicy(context.account, key, policy);
}
