/** 网页授权与本机前端转换各保原证明；授权回执不是模型URL，下载不得退回未转换源文件。 */
import path from 'node:path';
import type { Artifact, Job } from '../../studio/contracts/types.ts';
import type { JobStore } from '../storage/jobs.ts';
import { object, text, errorResult, TripoError } from '../../studio/contracts/errors.ts';
import { outputTarget } from '../../studio/files.ts';
import { fingerprint } from './fingerprint.ts';
import {
  frontendOrientationProofMatches,
  isFrontendOrientationMapping,
} from '../compat/frontend-orientation.ts';
import { hasVerifiedOutputCache, readVerifiedOutputCache } from '../artifacts/verified-output-cache.ts';
import { registeredFrontendTarget } from './frontend-delivery.ts';
import { localTarget, publishLocal } from '../local/files.ts';
import {
  effectiveFrontendMaterialFactor,
  isStudioFrontendMetadata,
  isFrontendMaterialFactor,
  effectiveFrontendGeometryMetadata,
} from '../../studio/contracts/frontend-export.ts';

export const frontendProcessing = 'Verified Studio frontend conversion; original authorization retained';
export const frontendOutputKey = (job: Job): string => `frontend-output:${job.job_id}`;
const hash = (value: unknown): boolean => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const bytes = (value: unknown): boolean =>
  Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 300 * 1024 * 1024;
const changed = (message: string): never => {
  throw new TripoError('FRONTEND_OUTPUT_IDENTITY_CHANGED', message, 'read');
};
export function frontendOutputIdentity(job: Job): string {
  return fingerprint({
    job_id: job.job_id,
    account_ref: job.account_ref,
    request_id: job.request_id,
    operation: job.operation,
    input_hash: job.input_hash,
    input: job.input,
    remote_ids: job.remote_ids,
  });
}
function candidateProofs(jobs: JobStore, job: Job) {
  const requests = [job.request_id];
  if (job.request_id.startsWith('frontend-export:')) requests.push(job.request_id.slice(16));
  return requests.flatMap((request) => {
    const key = `frontend-export-proof:${request}`;
    const proof = jobs.requestPolicy(job.account_ref, key);
    return proof ? [{ request, key, proof }] : [];
  });
}
export function frontendOutputRequested(jobs: JobStore, job: Job): boolean {
  return (
    Boolean(jobs.requestPolicy(job.account_ref, frontendOutputKey(job))) ||
    job.artifacts.some((artifact) => artifact.processing === frontendProcessing) ||
    (job.operation === 'export_lite' &&
      (job.request_id.startsWith('frontend-export:') || candidateProofs(jobs, job).length > 0))
  );
}
function sourceProof(jobs: JobStore, job: Job) {
  const candidates = candidateProofs(jobs, job).filter(
    ({ request, proof }) =>
      (proof.authorization_request_id ?? `frontend-export:${request}`) === job.request_id,
  );
  if (candidates.length !== 1)
    return changed('The frontend authorization has no unique original conversion proof.');
  const source = candidates[0]!,
    proof = source.proof,
    conversion = object(proof.conversion);
  if (
    job.operation !== 'export_lite' ||
    ![1, 2].includes(Number(proof.version)) ||
    proof.account_ref !== job.account_ref ||
    proof.project_id !== job.input.project_id ||
    proof.operator_id !== job.input.operator_id ||
    job.input.format !== 'glb' ||
    job.input.public_model !== false ||
    fingerprint(job.remote_ids) !==
      fingerprint({ project_id: proof.project_id, operator_id: proof.operator_id }) ||
    !validInputIdentity(proof) ||
    !hash(proof.source_location) ||
    !hash(proof.source_sha256) ||
    !bytes(proof.source_bytes) ||
    !hash(proof.output_sha256) ||
    !bytes(proof.output_bytes) ||
    !frontendSourceContainerMatches(proof, conversion) ||
    conversion.source_sha256 !== proof.source_sha256 ||
    conversion.output_sha256 !== proof.output_sha256 ||
    !frontendSourceMetadataMatches(proof)
  )
    return changed('The frontend conversion proof does not match its exact authorization or bytes.');
  return source;
}
function validInputIdentity(proof: Record<string, unknown>): boolean {
  return hash(proof.intent) && (proof.input === undefined || fingerprint(proof.input) === proof.intent);
}
export function frontendSourceContainerMatches(
  proof: Record<string, unknown>,
  conversion: Record<string, unknown>,
): boolean {
  // 缺字段的历史证明只能表示原 GLB；FBX 必须在来源与效果证明中同时冻结，不能由最新 URL 推断。
  const source = proof.source_format === undefined ? 'glb' : proof.source_format,
    converted = conversion.source_format === undefined ? 'glb' : conversion.source_format;
  return (
    (source === 'glb' || source === 'fbx') &&
    converted === source &&
    // 同时丢失两处标记也不能把现存 FBX 效果证明冒充成历史 GLB；null 不是旧版缺字段。
    [conversion.normalization, conversion.rest_state_restoration].every(
      (value) => object(value).source_format === undefined || object(value).source_format === source,
    ) &&
    (conversion.transform_representation !== 'verified_static_fbx_world_surface_bake' || source === 'fbx')
  );
}
/** 新证明同时绑定原 is_pbr、原编辑metadata和传给引擎的有效值；旧证明只恢复当时已验的原文件。 */
export function frontendSourceMetadataMatches(proof: Record<string, unknown>): boolean {
  const metadata = object(object(proof.conversion).metadata);
  if (proof.version === 1)
    return (
      metadata.forward_axis === '-y' &&
      metadata.pivot_to_center_bottom === true &&
      Object.keys(metadata).every((key) => ['forward_axis', 'pivot_to_center_bottom'].includes(key))
    );
  const source = object(proof.source_metadata),
    input = object(proof.input);
  if (
    proof.version !== 2 ||
    typeof proof.source_is_pbr !== 'boolean' ||
    !isStudioFrontendMetadata(metadata) ||
    !Object.keys(input).length
  )
    return false;
  if (
    proof.source_is_pbr &&
    source.material_factor !== undefined &&
    !isFrontendMaterialFactor(source.material_factor)
  )
    return false;
  const factor = effectiveFrontendMaterialFactor(source, proof.source_is_pbr);
  return (
    fingerprint(metadata) ===
    fingerprint({
      forward_axis: input.forward_axis,
      pivot_to_center_bottom: input.pivot_to_center_bottom,
      ...effectiveFrontendGeometryMetadata(source),
      ...(factor ? { material_factor: factor } : {}),
    })
  );
}
export function assertFrontendMetadata(artifact: Artifact, proof: Record<string, unknown>): void {
  if (
    artifact.artifact_id !== 'model' ||
    artifact.kind !== 'model' ||
    artifact.format !== 'glb' ||
    artifact.index !== 0 ||
    artifact.processing !== frontendProcessing ||
    artifact.sha256 !== proof.sha256 ||
    artifact.bytes !== proof.bytes ||
    artifact.source_sha256 !== proof.source_sha256
  )
    throw new TripoError(
      'FRONTEND_OUTPUT_CONTENT_CHANGED',
      'The model metadata differs from the frozen frontend output.',
      'read',
    );
}
/** 下载CAS和普通读取都复核原proof、兼容意图与任务身份，不能把漂移后的同名缓存挂回旧任务。 */
export function assertFrontendOutput(jobs: JobStore, job: Job, artifact: Artifact): Record<string, unknown> {
  const proof = jobs.requestPolicy(job.account_ref, frontendOutputKey(job));
  if (!proof || proof.version !== 1 || proof.identity !== frontendOutputIdentity(job))
    return changed('The frontend output is not bound to this original task identity.');
  const source = sourceProof(jobs, job),
    compatibility = compatibilityProof(jobs, job, source.proof);
  if (
    job.state !== 'succeeded' ||
    proof.source_key !== source.key ||
    proof.source_fingerprint !== fingerprint(source.proof) ||
    proof.compatibility_fingerprint !== compatibility.intent ||
    proof.compatibility_proof_fingerprint !== compatibility.proof ||
    proof.task_type !== (compatibility.proof ? 'convert_model' : 'frontend_export') ||
    proof.sha256 !== source.proof.output_sha256 ||
    proof.bytes !== source.proof.output_bytes ||
    proof.source_sha256 !== source.proof.source_sha256 ||
    !hash(proof.sha256) ||
    !bytes(proof.bytes)
  )
    return changed('The original frontend source, authorization or compatibility intent changed.');
  assertFrontendMetadata(artifact, proof);
  return proof;
}
function outputArtifact(proof: Record<string, unknown>): Artifact {
  return {
    artifact_id: 'model',
    kind: 'model',
    format: 'glb',
    index: 0,
    processing: frontendProcessing,
    sha256: text(proof.output_sha256),
    bytes: Number(proof.output_bytes),
    source_sha256: text(proof.source_sha256),
  };
}
function mappedCompatibilityMatches(
  intent: Record<string, unknown>,
  proof: Record<string, unknown>,
  source: Record<string, unknown>,
): boolean {
  if (intent.version !== 2) return true;
  const mapping = intent.orientation_mapping,
    validation = object(proof.validation);
  return (
    isFrontendOrientationMapping(mapping, object(intent.parameters).export_orientation) &&
    frontendOrientationProofMatches(source, mapping) &&
    validation.version === 2 &&
    fingerprint(validation.orientation_mapping) === fingerprint(mapping) &&
    validation.frontend_source_sha256 === source.source_sha256 &&
    validation.frontend_output_sha256 === source.output_sha256
  );
}
function compatibilityProof(jobs: JobStore, job: Job, source: Record<string, unknown>) {
  const intent = jobs.requestPolicy(job.account_ref, `frontend-convert-intent:${job.request_id}`),
    proof = jobs.requestPolicy(job.account_ref, `frontend-convert-proof:${job.request_id}`);
  if (!intent && !proof) return { intent: null, proof: null };
  if (
    !intent ||
    !proof ||
    (intent.version !== 1 && intent.version !== 2) ||
    proof.version !== intent.version ||
    intent.project_id !== source.project_id ||
    intent.operator_id !== source.operator_id ||
    proof.intent !== fingerprint(intent) ||
    proof.source_sha256 !== source.source_sha256 ||
    proof.output_sha256 !== source.output_sha256 ||
    proof.output_bytes !== source.output_bytes ||
    !Object.keys(object(proof.validation)).length
  )
    return changed('The compatible conversion has no matching original semantic validation.');
  if (!mappedCompatibilityMatches(intent, proof, source))
    return changed('The compatible conversion axis mapping does not match its frozen frontend proof.');
  return { intent: fingerprint(intent), proof: fingerprint(proof) };
}
/** 只在成功授权且原缓存字节仍有效时原子挂载产物；不会读取网页、重新转换或创建第二个任务。 */
export async function bindFrontendOutput(jobs: JobStore, dataDir: string, jobId: string): Promise<Job> {
  const job = jobs.get(jobId);
  if (job.state !== 'succeeded')
    throw new TripoError(
      'FRONTEND_AUTHORIZATION_INCOMPLETE',
      'Wait for the original frontend authorization; no model was published.',
      'read',
    );
  const source = sourceProof(jobs, job),
    artifact = outputArtifact(source.proof),
    existing = jobs.requestPolicy(job.account_ref, frontendOutputKey(job));
  if (existing) {
    if (job.artifacts.length !== 1)
      return changed('The frontend task must retain exactly one verified model artifact.');
    assertFrontendOutput(jobs, job, job.artifacts[0]!);
  } else if (job.artifacts.length)
    return changed('An unbound frontend authorization already contains an unexpected artifact.');
  const data = await readVerifiedOutputCache(
    job.account_ref,
    { sha256: artifact.sha256!, bytes: artifact.bytes! },
    dataDir,
  );
  if (!data)
    throw new TripoError(
      'FRONTEND_CACHE_MISSING',
      'Restore the original verified frontend cache; no upstream source or new export will be used.',
      'read',
    );
  const compatibility = compatibilityProof(jobs, job, source.proof);
  const policy = {
    version: 1,
    identity: frontendOutputIdentity(job),
    source_key: source.key,
    source_fingerprint: fingerprint(source.proof),
    compatibility_fingerprint: compatibility.intent,
    compatibility_proof_fingerprint: compatibility.proof,
    task_type: compatibility.proof ? 'convert_model' : 'frontend_export',
    sha256: artifact.sha256,
    bytes: artifact.bytes,
    source_sha256: artifact.source_sha256,
  };
  return jobs.bindFrontendArtifact(job, artifact, source.key, source.proof, policy);
}
function attention(job: Job, error: unknown): Record<string, unknown> {
  return {
    state: job.state === 'succeeded' ? 'needs_attention' : job.state,
    remote_state: job.state,
    artifacts: [],
    frontend_output_validation: { status: 'unverified', processing: 'studio_frontend_engine' },
    ...(job.state === 'succeeded' ? { error: errorResult(error) } : {}),
    next_action:
      'Recover the original frontend request and verified cache; do not create a new authorization.',
  };
}
/** 历史入口保持同步、本地读取；缺缓存和无绑定证明不会显示为可交付成功。 */
export function frontendOutputSummary(
  jobs: JobStore,
  dataDir: string,
  job: Job,
): Record<string, unknown> | undefined {
  if (!frontendOutputRequested(jobs, job)) return;
  try {
    if (job.state !== 'succeeded') return attention(job, undefined);
    if (job.artifacts.length !== 1)
      return changed('The frontend output has not been bound to this authorization.');
    const proof = assertFrontendOutput(jobs, job, job.artifacts[0]!);
    if (
      !hasVerifiedOutputCache(
        job.account_ref,
        { sha256: text(proof.sha256), bytes: Number(proof.bytes) },
        dataDir,
      )
    )
      throw new TripoError(
        'FRONTEND_CACHE_MISSING',
        'The original verified frontend cache is missing or invalid.',
        'read',
      );
    return {
      state: 'succeeded',
      task_type: proof.task_type,
      artifacts: job.artifacts,
      frontend_output_validation: {
        status: 'verified',
        processing: 'studio_frontend_engine',
        authorization_job_id: job.job_id,
        source_sha256: proof.source_sha256,
        sha256: proof.sha256,
        bytes: proof.bytes,
      },
    };
  } catch (error) {
    return attention(job, error);
  }
}
export async function frontendOutputView(
  jobs: JobStore,
  dataDir: string,
  job: Job,
): Promise<Record<string, unknown> | undefined> {
  if (!frontendOutputRequested(jobs, job)) return;
  try {
    if (job.state === 'succeeded') job = await bindFrontendOutput(jobs, dataDir, job.job_id);
    return frontendOutputSummary(jobs, dataDir, job);
  } catch (error) {
    return attention(job, error);
  }
}
/** 目录别名不代表另一份产物；仅复用原文件，不能凭相同字节认领其他既存目标。 */
export async function frontendTarget(
  jobs: JobStore,
  expected: Job,
  destination: { root: string; relative: string },
): Promise<{ path: string; reused: boolean }> {
  const target = await outputTarget(destination.root, destination.relative);
  if (path.extname(target).toLowerCase() !== '.glb')
    throw new TripoError('OUTPUT_EXTENSION', 'Use a .glb destination.');
  // 解析目录后重新读取当前完整证明和登记集合，不能依赖await之前的旧local_path。
  const current = jobs.get(expected.job_id);
  if (frontendOutputIdentity(current) !== frontendOutputIdentity(expected))
    return changed('The frontend authorization changed before its delivery could be reused.');
  const artifact = current.artifacts[0];
  if (!artifact || current.artifacts.length !== 1)
    return changed('The frontend task must retain its one original model artifact.');
  const proof = assertFrontendOutput(jobs, current, artifact);
  if (registeredFrontendTarget(artifact, target, text(proof.identity))) return { path: target, reused: true };
  return {
    path: await localTarget(destination.root, destination.relative, 'glb'),
    reused: false,
  };
}
/** 唯一交付来源是原SHA缓存；不存在“尝试网页URL后回退”的分支。 */
export async function downloadFrontendOutput(
  jobs: JobStore,
  dataDir: string,
  job: Job,
  artifactId: string,
  destination: { root: string; relative: string },
): Promise<Record<string, unknown>> {
  if (artifactId !== 'model')
    throw new TripoError('ARTIFACT_NOT_FOUND', 'The frontend task has one model artifact.');
  job = await bindFrontendOutput(jobs, dataDir, job.job_id);
  const artifact = job.artifacts[0]!,
    proof = assertFrontendOutput(jobs, job, artifact);
  const data = await readVerifiedOutputCache(
    job.account_ref,
    { sha256: text(proof.sha256), bytes: Number(proof.bytes) },
    dataDir,
  );
  if (!data)
    throw new TripoError(
      'FRONTEND_CACHE_MISSING',
      'Restore the exact original frontend cache before downloading.',
    );
  const target = await frontendTarget(jobs, job, destination);
  assertFrontendOutput(jobs, jobs.get(job.job_id), artifact);
  const saved = {
    ...(target.reused
      ? { local_path: target.path, bytes: data.length, sha256: artifact.sha256, format: 'glb' }
      : await publishLocal(target.path, data, 'glb')),
    processing: frontendProcessing,
    source_sha256: artifact.source_sha256,
    restored_from_cache: true,
  };
  if (!target.reused)
    jobs.saveArtifact(
      job.job_id,
      { ...artifact, ...saved },
      {
        account_ref: job.account_ref,
        operation: job.operation,
        input: job.input,
        remote_ids: job.remote_ids,
        kind: artifact.kind,
        format: artifact.format,
        index: artifact.index,
      },
    );
  return { job_id: job.job_id, artifact_id: artifact.artifact_id, ...saved };
}
