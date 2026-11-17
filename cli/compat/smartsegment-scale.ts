/** 完整三步先冻结；文件原件与精确历史来源均独立缓存，不用当前项目替换恢复来源。 */
import type { Plan } from './planning.ts';
import type { Application } from './runtime.ts';
import { resolveJob } from './runtime.ts';
import { object, text, TripoError } from '../../studio/contracts/errors.ts';
import type { Artifact } from '../../studio/contracts/types.ts';
import { operationSchemas } from '../../studio/contracts/schemas.ts';
import { readModelInput } from '../../studio/files.ts';
import { smartSegmentScaleSnapshot } from '../../studio/api/smartsegment-scale-source.ts';
import { materializeInputs } from '../artifacts/source.ts';
import {
  inspectSmartSegmentScaleSource,
  inspectSmartSegmentScaleReference,
} from '../artifacts/smartsegment-scale-proof.ts';
import { nativeScaleBytes, scaleUrlBytes } from '../artifacts/smartsegment-scale-io.ts';
import { readVerifiedOutputCache, saveVerifiedOutputCache } from '../artifacts/verified-output-cache.ts';
import {
  smartSegmentImportIdentity,
  smartSegmentTransformIntentKey,
} from '../core/smartsegment-transform-policy.ts';
import { fingerprint } from '../core/fingerprint.ts';
import {
  scaleContext,
  scaleIntentKey,
  scaleNativeModel,
  scaleSource,
  scaleSourceKey,
  scaleStepKey,
} from '../core/smartsegment-scale-policy.ts';
import { assertUneditedScaleMetadata } from './smartsegment-scale-steps.ts';

const sourceArtifact: Artifact = {
  artifact_id: 'smartsegment-scale-source',
  kind: 'model',
  format: 'glb',
  index: 0,
};
export function assertScaleAccount(app: Application, account: string): void {
  if (app.service.accountRef() !== account)
    throw new TripoError(
      'ACCOUNT_MISMATCH',
      'The metadata-scale account changed during preparation.',
      'not_submitted',
    );
}
/** 在任何namespace落盘前比较链种类；错误的新意图不能污染仍可恢复的旧链。 */
export function assertSmartSegmentLayouts(app: Application, plan: Plan, request: string): void {
  for (const [key, present] of [
    [smartSegmentTransformIntentKey(request), Boolean(plan.smartSegmentTransform)],
    [scaleIntentKey(request), Boolean(plan.smartSegmentScale)],
    [`smartsegment-image:${request}`, Boolean(plan.smartSegmentImage)],
    [`smartsegment-affine-intent:${request}`, Boolean(plan.smartSegmentAffine)],
    [`smartsegment-affine-transfer-intent:${request}`, Boolean(plan.smartSegmentAffine)],
  ] as const) {
    if (app.service.jobs.requestPolicy(app.service.accountRef(), key) && !present)
      throw new TripoError(
        'IDEMPOTENCY_CONFLICT',
        'The original smartsegment chain type cannot change. Resume its complete original intent.',
        'not_submitted',
      );
  }
}
export function freezeSmartSegmentScale(app: Application, plan: Plan, request: string): string | undefined {
  const account = app.service.accountRef(),
    jobs = app.service.jobs,
    saved = jobs.requestPolicy(account, scaleIntentKey(request));
  if (!plan.smartSegmentScale) {
    if (saved)
      throw new TripoError(
        'IDEMPOTENCY_CONFLICT',
        'The original request includes metadata-scale steps.',
        'not_submitted',
      );
    return;
  }
  const first = plan.smartSegmentScale.source_kind === 'file' ? 'import_model' : 'copy';
  if (plan.steps.map((s) => s.operation).join(',') !== `${first},project_edit,segment`)
    throw new TripoError(
      'SMARTSEGMENT_SCALE_UNVERIFIED',
      'The complete import/copy, metadata and segmentation layout is required.',
      'not_submitted',
    );
  if (!saved && plan.steps.some((_, i) => jobs.find(account, `${request}-${i}`)))
    throw new TripoError(
      'IDEMPOTENCY_CONFLICT',
      'Existing steps cannot acquire a new metadata-scale obligation.',
      'not_submitted',
    );
  const intent = {
    version: 1,
    matrix: plan.smartSegmentScale.matrix,
    first_operation: first,
    // 新引用的路由义务先进入三步完整意图；仅修改source不能伪装成旧无路由请求。
    ...(first === 'copy' && (!saved || saved.reference_segmentation_strategy === 'ordinary')
      ? { reference_segmentation_strategy: 'ordinary' }
      : {}),
    layout: fingerprint(
      plan.steps.map(({ operation, parameters, source }) => ({ operation, parameters, source })),
    ),
  };
  jobs.bindRequestPolicy(account, scaleIntentKey(request), intent);
  for (let index = 0; index < 3; index++)
    jobs.bindRequestPolicy(account, scaleStepKey(`${request}-${index}`), {
      parent: request,
      index,
      intent: fingerprint(intent),
    });
  return account;
}
export async function readScaleOriginal(app: Application, account: string, request: string): Promise<Buffer> {
  const { source } = scaleSource(app.service.jobs, account, request);
  const bytes = await readVerifiedOutputCache(
    account,
    { sha256: text(source.sha256), bytes: Number(source.bytes) },
    text(source.cache_data_dir),
  );
  assertScaleAccount(app, account);
  scaleSource(app.service.jobs, account, request);
  if (!bytes)
    throw new TripoError(
      'SMARTSEGMENT_SCALE_SOURCE_MISSING',
      'The frozen original source cache is missing or changed. Recover it without submitting again.',
      'not_submitted',
    );
  return bytes;
}

export async function prepareSmartSegmentScaleSource(
  app: Application,
  plan: Plan,
  request: string,
): Promise<Plan> {
  if (!plan.smartSegmentScale) return plan;
  const account = app.service.accountRef(),
    jobs = app.service.jobs,
    intent = scaleContext(jobs, account, request),
    saved = jobs.requestPolicy(account, scaleSourceKey(request));
  if (saved) {
    await readScaleOriginal(app, account, request);
    return {
      ...plan,
      steps: [
        { ...plan.steps[0]!, source: undefined, parameters: object(saved.parameters) },
        ...plan.steps.slice(1),
      ],
    };
  }
  if (plan.smartSegmentScale.source_kind !== 'file') return plan;
  if (jobs.find(account, `${request}-0`))
    throw new TripoError(
      'SMARTSEGMENT_SCALE_UNVERIFIED',
      'The original import has no pre-submission source proof.',
      'not_submitted',
    );
  plan = await materializeInputs(plan, app.service.config.dataDir, request);
  const input = await readModelInput(
    text(plan.steps[0]!.parameters.model_path),
    app.service.config.inputRoots,
  );
  if (input.format !== 'glb')
    throw new TripoError('INPUT_FORMAT', 'Metadata-scale requires a GLB model.', 'not_submitted');
  const inspection = await inspectSmartSegmentScaleSource(input.bytes),
    cached = await saveVerifiedOutputCache(
      { account_ref: account },
      sourceArtifact,
      { sha256: text(inspection.sha256), bytes: input.bytes.length },
      input.bytes,
      app.service.config.dataDir,
    ),
    parameters = operationSchemas.import_model.parse({
      ...plan.steps[0]!.parameters,
      model_path: cached.local_path,
    });
  assertScaleAccount(app, account);
  jobs.bindRequestPolicy(account, scaleSourceKey(request), {
    version: 1,
    intent: fingerprint(intent),
    kind: 'file',
    sha256: inspection.sha256,
    bytes: input.bytes.length,
    inspection,
    parameters,
    cache_data_dir: app.service.config.dataDir,
  });
  return { ...plan, steps: [{ ...plan.steps[0]!, parameters }, ...plan.steps.slice(1)] };
}

/** 首次copy前冻结历史原件；copy不会替用户应用旧metadata，因此有待应用编辑的来源必须拒绝。 */
export async function prepareScaleReference(
  app: Application,
  plan: Plan,
  request: string,
  parameters: Record<string, unknown>,
): Promise<void> {
  const account = app.service.accountRef(),
    jobs = app.service.jobs;
  if (jobs.requestPolicy(account, scaleSourceKey(request))) {
    const saved = scaleSource(jobs, account, request).source;
    if (fingerprint(parameters) !== fingerprint(saved.parameters))
      throw new TripoError(
        'IDEMPOTENCY_CONFLICT',
        'The frozen historical copy source changed.',
        'not_submitted',
      );
    return;
  }
  const sourceIdentity = localScaleSource(app, plan, parameters);
  const intent = scaleContext(jobs, account, request),
    snapshot = await smartSegmentScaleSnapshot(
      app.studio.client,
      account,
      text(parameters.project_id),
      text(parameters.operator_id),
      true,
    ),
    bytes = await referenceBytes(app, sourceIdentity, snapshot.url),
    inspection = await inspectSmartSegmentScaleReference(bytes);
  assertUneditedScaleMetadata(snapshot.metadata);
  await saveVerifiedOutputCache(
    { account_ref: account },
    sourceArtifact,
    { sha256: text(inspection.sha256), bytes: bytes.length },
    bytes,
    app.service.config.dataDir,
  );
  assertScaleAccount(app, account);
  if (fingerprint(localScaleSource(app, plan, parameters)) !== fingerprint(sourceIdentity))
    throw new TripoError(
      'SMARTSEGMENT_SCALE_UNVERIFIED',
      'The original source task changed while its bytes were being frozen.',
      'not_submitted',
    );
  jobs.bindRequestPolicy(account, scaleSourceKey(request), {
    version: intent.reference_segmentation_strategy === 'ordinary' ? 2 : 1,
    intent: fingerprint(intent),
    kind: 'reference',
    sha256: inspection.sha256,
    bytes: bytes.length,
    inspection,
    parameters,
    metadata: snapshot.metadata,
    // 原生merge可能保留is_segmented=true；新版单实体同样冻结普通路线，旧完整意图不补义务。
    ...(intent.reference_segmentation_strategy === 'ordinary' || inspection.version === 2
      ? { segmentation_strategy: 'ordinary' }
      : {}),
    cache_data_dir: app.service.config.dataDir,
    ...sourceIdentity,
  });
  scaleSource(jobs, account, request);
}
async function referenceBytes(
  app: Application,
  identity: Record<string, unknown>,
  url: string,
): Promise<Buffer> {
  if (!identity.source_job_id) return await scaleUrlBytes(url, app.service.config.dataDir);
  const job = app.service.jobs.get(text(identity.source_job_id)),
    artifact = job.artifacts.find((a) => a.artifact_id === identity.source_artifact_id)!;
  return await nativeScaleBytes(job, artifact, app.service.gateway, app.service.config.dataDir);
}
function localScaleSource(
  app: Application,
  plan: Plan,
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  const ref = plan.steps[0]!.source;
  if (!ref) return {};
  try {
    const job = resolveJob(app, ref),
      artifact = scaleNativeModel(job);
    if (
      job.state !== 'succeeded' ||
      job.remote_ids.project_id !== parameters.project_id ||
      job.remote_ids.operator_id !== parameters.operator_id
    )
      throw new TripoError(
        'SMARTSEGMENT_SCALE_UNVERIFIED',
        'The task source has no unique native model.',
        'not_submitted',
      );
    return {
      source_job_id: job.job_id,
      source_artifact_id: artifact.artifact_id,
      source_identity: smartSegmentImportIdentity(job, artifact),
    };
  } catch (error) {
    if (!(error instanceof TripoError) || error.code !== 'JOB_NOT_FOUND' || ref.startsWith('@')) throw error;
    return {};
  }
}
