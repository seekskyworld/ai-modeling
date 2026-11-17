/** 网页前端导出先转换验收，再持久申请 export-lite；文件恢复只复用原证明，绝不重复未知提交。 */
import { z } from 'zod';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { TaskService } from './service.ts';
import type { StudioClient } from '../../studio/api/client.ts';
import { frontendExportSource } from '../../studio/api/frontend-export-source.ts';
import { stableCanvasResource } from '../../studio/api/canvas-state.ts';
import { id } from '../../studio/contracts/primitives.ts';
import { array, object, text, TripoError } from '../../studio/contracts/errors.ts';
import { download } from '../artifacts/download.ts';
import { readVerifiedOutputCache, saveVerifiedOutputCache } from '../artifacts/verified-output-cache.ts';
import { convertStudioFrontend } from '../artifacts/studio-assimp-runtime.ts';
import { runtimeSource } from '../runtime/cache.ts';
import { localTarget } from '../local/files.ts';
import { resolveDestination } from '../artifacts/destination.ts';
import { fingerprint } from './fingerprint.ts';
import {
  assertFrontendOutput,
  bindFrontendOutput,
  frontendTarget,
  frontendSourceContainerMatches,
  frontendSourceMetadataMatches,
} from './frontend-output.ts';
import { isBinaryFrontendFbx } from '../artifacts/studio-fbx-source.ts';
import {
  effectiveFrontendMaterialFactor,
  effectiveFrontendGeometryMetadata,
} from '../../studio/contracts/frontend-export.ts';

export const frontendExportSchema = z
  .object({
    project_id: id,
    operator_id: id.describe(
      'Exact successful source operator; verified GLB or bounded static binary FBX. GLB supports webpage PBR factors and bounded static root/child TRS or scene deletion with per-file proof.',
    ),
    request_id: id
      .max(210)
      .describe(
        'Persistent export intent. Reuse it to recover the original result without a new authorization.',
      ),
    destination_path: z
      .string()
      .min(1)
      .max(4096)
      .describe('Caller-selected GLB path; never overwrites. A retry may use another destination.'),
    format: z.literal('glb').default('glb'),
    forward_axis: z
      .enum(['+x', '-x', '+y', '-y'])
      .describe('Explicit webpage forward axis. Binary FBX currently requires -y.'),
    pivot_to_center_bottom: z
      .boolean()
      .describe('Explicit webpage bottom-center pivot switch. Binary FBX currently requires true.'),
    exclude_retarget: z
      .boolean()
      .optional()
      .describe(
        'Explicitly select no separate retarget motions. Source skeletons and embedded clips are retained; omitted or false keeps the separate-motion guard.',
      ),
    name: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[^/\\]+$/)
      .refine(
        (value) =>
          [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127),
        'The converter name must not contain control characters.',
      )
      .optional()
      .describe('Filename passed to the converter; defaults to the frozen source project name.'),
    runtime_dir: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe(
        'Optional directory containing the exact hash-pinned official JS/WASM runtime; engine files are not bundled.',
      ),
    max_credits: z
      .number()
      .finite()
      .min(0)
      .max(1000000)
      .default(0)
      .describe('Maximum estimated credits for the persistent export-lite authorization.'),
  })
  .strict();

export const frontendExportDescription =
  'export an exact Studio GLB or verified static binary FBX to GLB with the webpage engine and persistent lightweight authorization';
export const frontendExportSubmissionSchema = frontendExportSchema.omit({ destination_path: true });
type Input = z.infer<typeof frontendExportSubmissionSchema>;
type Conversion = Awaited<ReturnType<typeof convertStudioFrontend>>;
export interface FrontendExportRuntime {
  /** 兼容流水线沿用原步骤请求ID；独立网页入口保留既有前缀，不能互借产物证明。 */
  authorizationRequestId?: string;
  validatePrepared?: (prepared: { proof: Record<string, unknown>; bytes: Buffer }) => Promise<void> | void;
  source?: typeof frontendExportSource;
  read?: (url: string, dataDir: string) => Promise<Buffer>;
  convert?: (bytes: Buffer, options: Parameters<typeof convertStudioFrontend>[1]) => Promise<Conversion>;
}
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const policyKey = (request: string): string => `frontend-export-proof:${request}`;
const authorizationId = (request: string): string => `frontend-export:${request}`;
function requestIdentity(input: Input, runtime: FrontendExportRuntime): string {
  const request = runtime.authorizationRequestId ?? authorizationId(input.request_id);
  if (request !== input.request_id && request !== authorizationId(input.request_id))
    throw new TripoError('INVALID_INPUT', 'Frontend authorization must use this exact request identity.');
  return request;
}
function sourceLocation(url: string): string {
  // 只剔除明确签名字段；同路径下的模型版本、变体等业务查询必须参与授权前复核。
  return fingerprint(stableCanvasResource(new URL(url).toString()));
}

function intentInput(input: Input): Record<string, unknown> {
  // 交付位置、引擎存放位置与费用上限不改变导出结果；首次解析出的项目名另随结果证明保存。
  return {
    project_id: input.project_id,
    operator_id: input.operator_id,
    format: input.format,
    forward_axis: input.forward_axis,
    pivot_to_center_bottom: input.pivot_to_center_bottom,
    name: input.name ?? null,
    // 不为旧请求注入 false；显式选择一经保存，恢复时不能改值或省略。
    ...(input.exclude_retarget !== undefined ? { exclude_retarget: input.exclude_retarget } : {}),
  };
}
function intent(input: Input): string {
  return fingerprint(intentInput(input));
}

async function readSource(url: string, dataDir: string): Promise<Buffer> {
  const root = path.join(dataDir, 'frontend-export-checks');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(path.join(root, 'source-'));
  try {
    // 完整签名 URL 只用于本次读取；原来源后缀与实物魔数必须一致，不把处理后的 GLB 当作原 FBX。
    const format = path.extname(new URL(url).pathname).toLowerCase() === '.fbx' ? 'fbx' : 'glb';
    const file = await download(url, temporary, `source.${format}`, format);
    return await readFile(file.local_path);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function assertAccount(service: TaskService, account: string): void {
  if (service.accountRef() !== account)
    throw new TripoError(
      'ACCOUNT_MISMATCH',
      'The account changed during frontend conversion.',
      'not_submitted',
    );
}

function validProofBytes(proof: Record<string, unknown>): boolean {
  return (
    /^[a-f0-9]{64}$/.test(text(proof.source_sha256)) &&
    /^[a-f0-9]{64}$/.test(text(proof.source_location)) &&
    Number.isSafeInteger(proof.source_bytes) &&
    Number(proof.source_bytes) > 0 &&
    Number(proof.source_bytes) <= 150 * 1024 * 1024 &&
    /^[a-f0-9]{64}$/.test(text(proof.output_sha256)) &&
    Number.isSafeInteger(proof.output_bytes) &&
    Number(proof.output_bytes) > 0 &&
    Number(proof.output_bytes) <= 300 * 1024 * 1024
  );
}

function assertProof(
  proof: Record<string, unknown>,
  input: Input,
  account: string,
  authorizationRequest: string,
): void {
  if (
    ![1, 2].includes(Number(proof.version)) ||
    proof.account_ref !== account ||
    proof.intent !== intent(input) ||
    (proof.input === undefined
      ? input.exclude_retarget !== undefined
      : fingerprint(proof.input) !== intent(input)) ||
    proof.project_id !== input.project_id ||
    proof.operator_id !== input.operator_id ||
    (proof.authorization_request_id ?? authorizationId(input.request_id)) !== authorizationRequest ||
    !validProofBytes(proof) ||
    !frontendSourceContainerMatches(proof, object(proof.conversion)) ||
    !frontendSourceMetadataMatches(proof)
  )
    throw new TripoError(
      'IDEMPOTENCY_CONFLICT',
      'The existing frontend export has a different or invalid source/result proof.',
      'not_submitted',
    );
}

function freezeProof(
  service: TaskService,
  input: Input,
  account: string,
  proof: Record<string, unknown>,
  authorizationRequest: string,
): Record<string, unknown> {
  try {
    service.jobs.bindRequestPolicy(account, policyKey(input.request_id), proof);
    return proof;
  } catch (error) {
    if (!(error instanceof TripoError) || error.code !== 'IDEMPOTENCY_CONFLICT') throw error;
    const winner = service.jobs.requestPolicy(account, policyKey(input.request_id));
    if (!winner) throw error;
    assertProof(winner, input, account, authorizationRequest);
    // 同一来源和最终字节的并发证明只保留首份；不同产物不能借相同请求复用授权。
    for (const key of [
      'source_sha256',
      'source_bytes',
      'source_location',
      'output_sha256',
      'output_bytes',
      'name',
    ])
      if (winner[key] !== proof[key]) throw error;
    if (fingerprint(winner.source_metadata) !== fingerprint(proof.source_metadata)) throw error;
    if (winner.source_is_pbr !== proof.source_is_pbr) throw error;
    if ((winner.source_format ?? 'glb') !== (proof.source_format ?? 'glb')) throw error;
    return winner;
  }
}

async function prepare(
  service: TaskService,
  client: StudioClient,
  input: Input,
  account: string,
  runtime: FrontendExportRuntime,
): Promise<{ proof: Record<string, unknown>; bytes: Buffer }> {
  const authorizationRequest = requestIdentity(input, runtime);
  const saved = service.jobs.requestPolicy(account, policyKey(input.request_id));
  if (saved) {
    assertProof(saved, input, account, authorizationRequest);
    const bytes = await readVerifiedOutputCache(
      account,
      { sha256: text(saved.output_sha256), bytes: Number(saved.output_bytes) },
      service.config.dataDir,
    );
    if (!bytes)
      throw new TripoError(
        'FRONTEND_CACHE_MISSING',
        'Restore the original verified frontend file cache before retrying; no new export authorization was submitted.',
        'not_submitted',
      );
    return { proof: saved, bytes };
  }
  if (service.jobs.find(account, authorizationRequest))
    throw new TripoError(
      'IDEMPOTENCY_CONFLICT',
      'An authorization without this frontend proof already uses the request ID.',
      'not_submitted',
    );
  if (input.runtime_dir) runtimeSource(input.runtime_dir, service.config.inputRoots);
  const source = await (runtime.source ?? frontendExportSource)(
    client,
    account,
    input.project_id,
    input.operator_id,
    { exclude_retarget: input.exclude_retarget },
  );
  const sourceBytes = await (runtime.read ?? readSource)(source.url, service.config.dataDir);
  const name = frontendExportSchema.shape.name.unwrap().parse(input.name ?? source.name);
  const materialFactor = effectiveFrontendMaterialFactor(source.metadata, source.is_pbr === true);
  const conversion = await (runtime.convert ?? convertStudioFrontend)(sourceBytes, {
    dataDir: service.config.dataDir,
    runtimeDir: input.runtime_dir,
    inputRoots: service.config.inputRoots,
    projectName: name,
    metadata: {
      forward_axis: input.forward_axis,
      pivot_to_center_bottom: input.pivot_to_center_bottom,
      ...effectiveFrontendGeometryMetadata(source.metadata),
      ...(materialFactor ? { material_factor: materialFactor } : {}),
    },
  });
  const sourceFormat = isBinaryFrontendFbx(sourceBytes) ? 'fbx' : 'glb';
  if (!frontendSourceContainerMatches({ source_format: sourceFormat }, conversion.proof))
    throw new TripoError(
      'FRONTEND_EXPORT_UNVERIFIED',
      'The conversion proof does not match the original source container.',
      'not_submitted',
    );
  assertAccount(service, account);
  const proof = {
    version: 2,
    account_ref: account,
    intent: intent(input),
    input: intentInput(input),
    project_id: input.project_id,
    operator_id: input.operator_id,
    authorization_request_id: authorizationRequest,
    name,
    source_metadata: source.metadata,
    source_is_pbr: source.is_pbr === true,
    source_location: sourceLocation(source.url),
    source_format: sourceFormat,
    source_sha256: digest(sourceBytes),
    source_bytes: sourceBytes.length,
    output_sha256: digest(conversion.bytes),
    output_bytes: conversion.bytes.length,
    conversion: conversion.proof,
  };
  assertProof(proof, input, account, authorizationRequest);
  await saveVerifiedOutputCache(
    { account_ref: account },
    { artifact_id: 'frontend-model', kind: 'model', format: 'glb', index: 0 },
    { sha256: proof.output_sha256, bytes: proof.output_bytes },
    conversion.bytes,
    service.config.dataDir,
  );
  assertAccount(service, account);
  return {
    proof: freezeProof(service, input, account, proof, authorizationRequest),
    bytes: conversion.bytes,
  };
}

async function verifyBeforeAuthorization(
  service: TaskService,
  client: StudioClient,
  input: Input,
  account: string,
  proof: Record<string, unknown>,
  runtime: FrontendExportRuntime,
): Promise<void> {
  // operator 的编辑 metadata 可能原位改变；首次授权前再核快照，已有回执恢复不依赖当前网页。
  if (service.jobs.find(account, requestIdentity(input, runtime))) return;
  const source = await (runtime.source ?? frontendExportSource)(
    client,
    account,
    input.project_id,
    input.operator_id,
    { exclude_retarget: input.exclude_retarget },
  );
  if (
    fingerprint(source.metadata) !== fingerprint(proof.source_metadata) ||
    (proof.version === 2 && (source.is_pbr === true) !== proof.source_is_pbr) ||
    sourceLocation(source.url) !== proof.source_location
  )
    throw new TripoError(
      'PROJECT_CHANGED',
      'The exact frontend source changed before authorization. Keep the original result proof and inspect the project.',
      'not_submitted',
    );
  assertAccount(service, account);
}

/** 准备、额外效果核验与授权共用同一身份；不要求交付目录，供兼容任务的no-download和重启恢复使用。 */
export async function submitFrontendExport(
  service: TaskService,
  client: StudioClient,
  raw: unknown,
  runtime: FrontendExportRuntime = {},
): Promise<Record<string, unknown>> {
  const input = frontendExportSubmissionSchema.parse(raw),
    account = service.accountRef();
  const prepared = await prepare(service, client, input, account, runtime);
  await runtime.validatePrepared?.(prepared);
  assertAccount(service, account);
  await verifyBeforeAuthorization(service, client, input, account, prepared.proof, runtime);
  let authorization = await service.submit(
    'export_lite',
    requestIdentity(input, runtime),
    { project_id: input.project_id, operator_id: input.operator_id, format: 'glb', public_model: false },
    input.max_credits,
  );
  assertAccount(service, account);
  const remote = object(authorization.remote_ids);
  if (authorization.state === 'succeeded' || authorization.remote_state === 'succeeded') {
    if (remote.project_id !== input.project_id || remote.operator_id !== input.operator_id)
      throw new TripoError('CONTRACT_CHANGED', 'The export authorization belongs to another source.', 'read');
  }
  if (authorization.state === 'succeeded') {
    const job = await bindFrontendOutput(service.jobs, service.config.dataDir, text(authorization.job_id));
    assertAccount(service, account);
    authorization = service.summary(job);
  }
  return {
    request_id: input.request_id,
    export_lite_job_id: authorization.job_id,
    export_lite_job: authorization,
    source: {
      project_id: input.project_id,
      operator_id: input.operator_id,
      sha256: prepared.proof.source_sha256,
      bytes: prepared.proof.source_bytes,
      format: prepared.proof.source_format ?? 'glb',
    },
    conversion: prepared.proof.conversion,
    ...(input.exclude_retarget === true
      ? {
          motion_selection: {
            exclude_retarget: true,
            description:
              'Only separate retarget files are excluded. The exact source model, including its verified skeletons and embedded clips, is retained.',
          },
        }
      : {}),
  };
}

/** 已成功授权可从原缓存另存；未知、失败或仍在提交中的授权均不得发布为成功结果。 */
export async function exportFrontend(
  service: TaskService,
  client: StudioClient,
  raw: unknown,
  runtime: FrontendExportRuntime = {},
): Promise<Record<string, unknown>> {
  const input = frontendExportSchema.parse(raw);
  const { destination_path: destination, ...submission } = input;
  const checkTarget = async () => {
    const account = service.accountRef(),
      request = requestIdentity(submission, runtime),
      original = service.jobs.find(account, request),
      proof = service.jobs.requestPolicy(account, policyKey(input.request_id));
    // 与统一下载器共享原路径复用规则；其它已存在文件仍在任何上游操作前拒绝。
    if (original?.state === 'succeeded' && original.artifacts.length === 1 && proof) {
      assertProof(proof, submission, account, request);
      assertFrontendOutput(service.jobs, original, original.artifacts[0]!);
      return (
        await frontendTarget(
          service.jobs,
          original,
          await resolveDestination(service.config.outputDir, destination),
        )
      ).path;
    }
    return await localTarget(service.config.outputDir, destination, 'glb');
  };
  const target = await checkTarget();
  const result = await submitFrontendExport(service, client, submission, {
    ...runtime,
    validatePrepared: async (prepared) => {
      await runtime.validatePrepared?.(prepared);
      if ((await checkTarget()) !== target)
        throw new TripoError(
          'OUTPUT_PATH_DENIED',
          'The output directory changed before authorization.',
          'not_submitted',
        );
    },
  });
  const authorization = object(result.export_lite_job);
  if (authorization.state !== 'succeeded')
    throw new TripoError(
      'FRONTEND_AUTHORIZATION_INCOMPLETE',
      'Frontend output is verified but authorization is not complete. Inspect the original job; do not use a new request ID for an uncertain outcome.',
      authorization.state === 'outcome_unknown' ? 'unknown' : 'read',
      { job_id: authorization.job_id, state: authorization.state, error: authorization.error },
    );
  if ((await checkTarget()) !== target)
    throw new TripoError(
      'OUTPUT_PATH_DENIED',
      'The output directory changed after authorization. Recover the same request to a safe destination.',
      'read',
    );
  const models = array(authorization.artifacts)
    .map(object)
    .filter((artifact) => artifact.kind === 'model');
  if (models.length !== 1)
    throw new TripoError(
      'FRONTEND_OUTPUT_UNVERIFIED',
      'The authorization has no unique verified model.',
      'read',
    );
  return {
    ...result,
    ...(await service.download(text(authorization.job_id), text(models[0]!.artifact_id), destination)),
  };
}
