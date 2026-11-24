/** 官方命令执行器复用去重服务；每一处理步骤都保留原始任务身份。 */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pollingDelay, type PollTiming } from './polling.ts';
import { object, text, array, errorResult, TripoError } from '../../studio/contracts/errors.ts';
import { callResource, resources } from '../../studio/api/resources.ts';
import type { createApplication } from '../core/application.ts';
import type { Artifact, Job } from '../../studio/contracts/types.ts';
import { taskType } from '../../studio/contracts/task-type.ts';
import { assertCanvasArtifact, canvasResultView } from '../../studio/contracts/canvas-result.ts';
import { bindCanvasModelSource } from './canvas-source.ts';
import { canvasModelSourceProof, prepareCanvasModelSource } from './canvas-source-policy.ts';
import {
  prepareLabModelSource,
  prepareLabModelIsolationCopy,
  freezeLabModelIsolationLayout,
  freezeLabModelSourceSelection,
  bindLabModelSource,
  bindLabModelSourceDelivery,
} from './lab-model-source.ts';
import type { Plan, PlannedStep, Flags } from './planning.ts';
import { prepareExportEdits } from './export-edits.ts';
import { expandSegmentationPlan } from './segmentation-plan.ts';
import { materializeInputs } from '../artifacts/source.ts';
import { executionExitCode, validateExecutionOptions } from './execution-policy.ts';
import { validateCompatibilityChain } from './chain-policy.ts';
import { verifiedArtifactBytes } from '../artifacts/recover-download.ts';
import { checkedRigChain } from './rig-chain.ts';
import { outputDirectory } from './output-directory.ts';
import { resolveImageReferences } from './image-references.ts';
import { freezePlanReferences } from './source-policy.ts';
import { freezeGenerationLayout, generationPrefixLength } from './p-series-generation.ts';
import { validatePlanFiles } from './plan-files.ts';
import { freezeNativeOutputPolicy, nativeMeshoptRequested } from './native-output-policy.ts';
import { verifyNativeMeshopt } from '../artifacts/native-meshopt.ts';
import { isMultiviewBundle, multiviewSources } from '../core/multiview-bundle.ts';
import { executeMultiviewEdit } from './multiview-runtime.ts';
import { assertLabReferenceEditPlan, executeLabReferenceEdit } from './lab-reference-edit-runtime.ts';
import { labReferenceEditPolicy } from './lab-reference-edit-policy.ts';
import { frontendOutputRequested } from '../core/frontend-output.ts';
import { unbakedRequested } from '../core/unbaked-material-policy.ts';
import { localExportDeliveryRequested } from '../artifacts/local-export-delivery.ts';
import { freezeTextureModel } from '../core/texture-version-policy.ts';
import { freezeImageOutputPolicy } from '../core/image-output-policy.ts';
import { freezeImageSizePolicy } from '../core/image-size-policy.ts';
import { freezeImageBackgroundPolicy } from '../core/image-background-policy.ts';
import { applyDefaultExportAnimations, importedAnimationWarning } from './export-animation-default.ts';
import { applyExportDefaultValues } from './export-default-values.ts';
import { applyDefaultExportJpeg } from './export-jpeg-default.ts';
import {
  canDefaultExportJpeg,
  canExplicitExportJpeg,
  exportJpegPolicyKey,
  exportJpegRequested,
} from '../core/export-jpeg-policy.ts';
import { freezeUvImportLayout, prepareUvImport } from './uv-import.ts';
import { rejectUvImportContinuation } from '../core/uv-import-policy.ts';
import { freezeUvInput } from './uv-input.ts';
import { freezeSmartSegmentImage } from './smartsegment-image.ts';
import {
  assertSmartSegmentLayouts,
  freezeSmartSegmentScale,
  prepareSmartSegmentScaleSource,
} from './smartsegment-scale.ts';
import { prepareSmartSegmentScaleStep } from './smartsegment-scale-steps.ts';
import { smartSegmentScaleRequested } from '../core/smartsegment-scale-policy.ts';
import { affineFinalParent, prepareAffineComponent } from '../core/smartsegment-affine-policy.ts';
import { executeSmartSegmentAffine } from './smartsegment-affine-runtime.ts';
import { executeSmartSegmentTransfer } from './smartsegment-affine-transfer-runtime.ts';
import { selectAffinePlan } from './smartsegment-affine-transfer-plan.ts';
import {
  prepareTransferComponent,
  transferFinalParent,
} from '../core/smartsegment-affine-transfer-policy.ts';
import {
  freezeSmartSegmentTransform,
  prepareSmartSegmentTransformSource,
  verifySmartSegmentTransformImport,
} from './smartsegment-transform.ts';
import {
  assertFrontendConvertPlan,
  executeFrontendConvert,
  rejectFrontendConvertContinuation,
} from './frontend-convert.ts';
import {
  resolveMultiviewReference,
  resolveProjectReference,
  resolveExportAnimations,
  projectTextureStatus,
  projectRigType,
  auditReferenceImage,
} from '../../studio/api/discovery.ts';
export type Application = Awaited<ReturnType<typeof createApplication>>;
export function resolveJob(app: Application, ref: string): Job {
  const account = app.service.accountRef();
  if (['@', '@last', '@last:any'].includes(ref) || /^@\d+$/.test(ref)) {
    const index = ref === '@' || ref.startsWith('@last') ? 0 : Number(ref.slice(1)) - 1;
    if (index < 0) throw new TripoError('JOB_NOT_FOUND', 'History references start at @1.');
    const job = app.service.jobs.listOutputs(
      account,
      1,
      index,
      ref === '@last:any' ? undefined : 'succeeded',
    )[0];
    if (!job) throw new TripoError('JOB_NOT_FOUND', 'No successful task in local history.');
    return job;
  }
  const id = ref.startsWith('@') ? app.service.jobs.alias(account, ref.slice(1)) : ref;
  if (!id) throw new TripoError('JOB_NOT_FOUND', 'No matching history name.');
  const job = app.service.jobs.get(id);
  if (job.account_ref !== account)
    throw new TripoError('ACCOUNT_MISMATCH', 'Task belongs to another account.');
  return job;
}
export function taskResult(job: Record<string, unknown>): Record<string, unknown> {
  const statuses: Record<string, string> = {
    submitted: 'queued',
    running: 'running',
    succeeded: 'success',
    failed: 'failed',
  };
  return {
    task_id: job.job_id,
    type: job.task_type ?? (job.input ? taskType(job as unknown as Job) : job.operation),
    studio_operation: job.operation,
    status: statuses[text(job.state)] ?? job.state,
    progress: job.progress,
    credits_consumed:
      object(job.observed_cost).status === 'fulfilled' ? object(job.observed_cost).credits : undefined,
    ...(job.observed_cost ? { observed_cost: job.observed_cost } : {}),
    studio: job.remote_ids,
    request_id: job.request_id,
    artifacts: job.artifacts,
    ...Object.fromEntries(
      [
        'intermediate_artifacts',
        'canvas_output_validation',
        'canvas_acceptance',
        'lab_reference_edit_validation',
        'lab_projected_segment_validation',
        'source_representation',
        'lab_model_source',
        'smartsegment_affine_validation',
        'smartsegment_affine_transfer_validation',
        'normalize_scale',
        'normalize_scale_provenance',
        'normalize_scale_validation',
      ]
        .filter((key) => job[key] !== undefined)
        .map((key) => [key, job[key]]),
    ),
    created_at: job.created_at,
    updated_at: job.updated_at,
    ...(job.wait_timed_out ? { wait_timed_out: true } : {}),
    ...(job.error ? { error: job.error } : {}),
    ...(job.poll_error ? { poll_error: job.poll_error } : {}),
    ...(job.native_output_validation ? { native_output_validation: job.native_output_validation } : {}),
    ...(job.image_output_validation ? { image_output_validation: job.image_output_validation } : {}),
    ...(job.image_size_validation ? { image_size_validation: job.image_size_validation } : {}),
    ...(job.image_background_validation
      ? { image_background_validation: job.image_background_validation }
      : {}),
    ...(job.jpeg_output_validation ? { jpeg_output_validation: job.jpeg_output_validation } : {}),
    ...(job.uv_compression_validation ? { uv_compression_validation: job.uv_compression_validation } : {}),
    ...(job.frontend_output_validation ? { frontend_output_validation: job.frontend_output_validation } : {}),
    ...(job.smartsegment_transform_validation
      ? { smartsegment_transform_validation: job.smartsegment_transform_validation }
      : {}),
    ...(job.remote_state ? { remote_state: job.remote_state } : {}),
    ...(job.composition ? { composition: job.composition } : {}),
    ...(job.next_action ? { next_action: job.next_action } : {}),
  };
}
async function sourceParameters(
  app: Application,
  step: PlannedStep,
  previous?: Record<string, unknown>,
  existing?: Job,
): Promise<Record<string, unknown>> {
  const params = step.imageReferences
    ? await resolveImageReferences(
        step.parameters,
        step.imageReferences,
        {
          accountRef: app.service.accountRef(),
          findJob: (reference) => resolveJob(app, reference),
          refreshJob: async (jobId) => {
            await app.service.get(jobId);
            return app.service.jobs.get(jobId);
          },
          readAsset: async (assetId) =>
            await callResource(
              app.studio.client,
              resources.find((r) => r.name === 'image_get')!,
              { asset_id: assetId },
            ),
          auditReference: (image) => auditReferenceImage(app.studio.client, image),
        },
        existing?.operation === step.operation && existing.state !== 'prepared' ? existing.input : undefined,
      )
    : { ...step.parameters };
  if (!step.source) return params;
  const source = step.source === 'upstream' ? previous : undefined;
  let sourceJob: Job | undefined = source ? app.service.jobs.get(text(source.job_id)) : undefined;
  let remote = object(source?.remote_ids);
  const imageSource = ['image', 'image_process', 'model'].includes(step.operation);
  if (!source) {
    try {
      sourceJob = resolveJob(app, step.source);
      remote = { ...sourceJob.remote_ids };
    } catch (error) {
      if (!(error instanceof TripoError) || error.code !== 'JOB_NOT_FOUND' || step.source.startsWith('@'))
        throw error;
      if (imageSource) remote = { asset_id: step.source };
      // 原意图已保存来源身份，恢复无需再次读取会变化或暂时不可用的项目“当前版本”。
      else if (existing?.operation === step.operation && existing.input.project_id === step.source)
        remote = { project_id: step.source };
      else remote = { ...(await resolveProjectReference(app.studio.client, step.source)) };
    }
  }
  bindDefaultExportSource(step, sourceJob);
  if (imageSource) return await resolvedImageSource(app, step, params, remote, sourceJob, existing);
  return await modelSourceParameters(app, step, params, remote, sourceJob, existing);
}
/** 文件级组合必须使用前一步已确认产物，不能把项目ID误当作本机输入路径。 */
async function executionParameters(
  app: Application,
  step: PlannedStep,
  request: string,
  previous?: Record<string, unknown>,
  existing?: Job,
): Promise<Record<string, unknown>> {
  const context = {
    jobs: app.service.jobs,
    gateway: app.service.gateway,
    dataDir: app.service.config.dataDir,
    account: app.service.accountRef(),
  };
  if (!step.uvImportFromChain) {
    const input = await sourceParameters(app, step, previous, existing);
    if (step.requireUvCompressionInput)
      await freezeUvInput(
        context,
        request,
        input,
        step.requireTextureBaking === false,
        uvSourceJob(app, step, previous),
      );
    if (context.account !== app.service.accountRef())
      throw new TripoError('ACCOUNT_MISMATCH', 'The Studio account changed during source preparation.');
    return input;
  }
  if (!previous?.job_id)
    throw new TripoError(
      'UV_COMPRESSION_SOURCE_MISSING',
      'Wait for the original UV application before importing its output.',
      'not_submitted',
    );
  const input = await prepareUvImport(
    context,
    request,
    step.parameters,
    app.service.jobs.get(text(previous.job_id)),
  );
  if (context.account !== app.service.accountRef())
    throw new TripoError('ACCOUNT_MISMATCH', 'The Studio account changed during UV source preparation.');
  return input;
}
function uvSourceJob(
  app: Application,
  step: PlannedStep,
  previous?: Record<string, unknown>,
): Job | undefined {
  if (step.source === 'upstream' && previous?.job_id) return app.service.jobs.get(text(previous.job_id));
  if (!step.source) return;
  try {
    return resolveJob(app, step.source);
  } catch (error) {
    if (!(error instanceof TripoError) || error.code !== 'JOB_NOT_FOUND') throw error;
  }
}
function bindDefaultExportSource(step: PlannedStep, source?: Job): void {
  if (!step.exportDefaults || !source) return;
  if (step.source !== 'upstream') step.source = source.job_id;
  if (source.operation === 'import_model' && step.exportDefaults.includes('with_animation'))
    step.warnings = [...(step.warnings ?? []), importedAnimationWarning];
}
async function resolvedImageSource(
  app: Application,
  step: PlannedStep,
  params: Record<string, unknown>,
  remote: Record<string, unknown>,
  source?: Job,
  existing?: Job,
): Promise<Record<string, unknown>> {
  if (source && isMultiviewBundle(source))
    return await bundleSourceParameters(app, step, params, source, existing);
  return await imageSourceParameters(app, step, params, remote, existing);
}
/** 已编辑多视图引用展开成四个真实资产槽；新提交先读完成状态，恢复保留原数组身份。 */
async function bundleSourceParameters(
  app: Application,
  step: PlannedStep,
  params: Record<string, unknown>,
  source: Job,
  existing?: Job,
): Promise<Record<string, unknown>> {
  if (step.operation !== 'model' || params.mode !== 'multiview')
    throw new TripoError(
      'INVALID_INPUT',
      'An edited multiview composition can feed multiview-to-model; select individual image outputs for other operations.',
    );
  if (!existing && (await app.service.get(source.job_id)).state !== 'succeeded')
    throw new TripoError(
      'INPUT_NOT_READY',
      'Wait for every edited view before generating a model.',
      'not_submitted',
    );
  const views = multiviewSources(app.service.jobs, app.service.jobs.get(source.job_id));
  if (existing && !isDeepStrictEqual(existing.input.image_assets, views))
    throw new TripoError('IDEMPOTENCY_CONFLICT', 'The original edited multiview sources changed.');
  return { ...params, image_assets: views };
}
/** 网页模型身份、动作和导出编辑均在持久提交前解析。 */
async function modelSourceParameters(
  app: Application,
  step: PlannedStep,
  params: Record<string, unknown>,
  remote: Record<string, unknown>,
  sourceJob?: Job,
  existing?: Job,
): Promise<Record<string, unknown>> {
  rejectUvImportContinuation(app.service.jobs, sourceJob);
  rejectFrontendConvertContinuation(app.service.jobs, sourceJob);
  ({ parameters: params, remote } = checkedModelSource(app, step, params, remote, sourceJob));
  params.project_id = remote.project_id;
  bindSourceOperators(step, params, remote, sourceJob, existing);
  if (step.operation === 'export') applyExportDefaultValues(params, step.exportDefaults, existing);
  if (step.requireStaticExportSource && !existing)
    await applyDefaultExportAnimations(
      app.studio.client,
      params,
      text(remote.operator_id),
      sourceJob,
      undefined,
      true,
    );
  if (step.exportDefaults?.includes('with_animation') && !step.animationsFromChain)
    params = await applyDefaultExportAnimations(
      app.studio.client,
      params,
      text(remote.operator_id),
      sourceJob,
      existing,
    );
  if (step.genericAnimation) await resolveGenericAnimation(app, step, params, remote, sourceJob, existing);
  if (step.exportEdits) {
    if (
      existing &&
      (existing.input.project_id !== params.project_id ||
        !isDeepStrictEqual(existing.input.export_edits, step.exportEdits))
    )
      throw new TripoError('IDEMPOTENCY_CONFLICT', 'Export selection changed for an existing request.');
    return existing?.operation === 'project_edit'
      ? { ...existing.input }
      : await prepareExportEdits(
          app.studio.client,
          params,
          step.exportEdits,
          sourceJob?.operation === 'copy'
            ? {
                project_id: text(sourceJob.input.project_id),
                operator_id: text(sourceJob.input.operator_id),
              }
            : undefined,
        );
  }
  if (step.animationsFromSource)
    params.animations = await sourceAnimations(app, text(remote.project_id), sourceJob, existing);
  if (step.operation === 'uv_commit' && sourceJob) {
    params.current_operator_id = sourceJob.input.current_operator_id;
    params.candidate_operator_id = remote.operator_id;
  }
  await checkUvTextureBaking(app, step, params, existing);
  bindDefaultTextureSource(step, params, remote, sourceJob, existing);
  return params;
}
/** Canvas运行身份与模型项目身份分离；解析后统一走已有来源版本守卫。 */
function checkedModelSource(
  app: Application,
  step: PlannedStep,
  parameters: Record<string, unknown>,
  remote: Record<string, unknown>,
  source?: Job,
): { parameters: Record<string, unknown>; remote: Record<string, unknown> } {
  const proof = canvasModelSourceProof(app.service.jobs, source);
  const result = bindLabModelSource(
    app.service.jobs,
    source,
    step.operation,
    parameters,
    step.sourceRepresentation,
  ) ??
    bindCanvasModelSource(source, step.operation, parameters, proof) ?? { parameters, remote };
  if (!text(result.remote.project_id))
    throw new TripoError('INVALID_INPUT', 'Processing requires a model task or project ID.');
  return result;
}
/** JPEG 来源预检应冻结模型版本；已导出/动作任务引用自己的基础模型，不能拿导出回执当模型operator。 */
function bindDefaultTextureSource(
  step: PlannedStep,
  params: Record<string, unknown>,
  remote: Record<string, unknown>,
  source?: Job,
  existing?: Job,
): void {
  if (!step.exportDefaults?.includes('texture_format') && !canExplicitExportJpeg(params)) return;
  const operator =
    source && ['export', 'animate'].includes(source.operation)
      ? source.input.expected_operator_id
      : remote.operator_id;
  if (existing) {
    // JPEG精确读取不可用时首轮仍可能冻结来源；恢复不能丢该字段，也不能给旧任务补新身份。
    if (
      existing.operation === 'export' &&
      existing.input.project_id === params.project_id &&
      existing.input.expected_operator_id !== undefined
    )
      params.expected_operator_id ??= operator ?? existing.input.expected_operator_id;
    return;
  }
  if (canDefaultExportJpeg(params) || canExplicitExportJpeg(params)) params.expected_operator_id ??= operator;
}

async function prepareDefaultJpeg(
  app: Application,
  step: PlannedStep,
  params: Record<string, unknown>,
  request: string,
  existing?: Job,
): Promise<void> {
  const explicit = !step.exportDefaults?.includes('texture_format') && canExplicitExportJpeg(params);
  if (step.operation !== 'export' || (!step.exportDefaults?.includes('texture_format') && !explicit)) {
    if (app.service.jobs.requestPolicy(app.service.accountRef(), exportJpegPolicyKey(request)))
      throw new TripoError('IDEMPOTENCY_CONFLICT', 'The original request used a frozen JPEG export intent.');
    return;
  }
  const warnings = await applyDefaultExportJpeg(
    {
      jobs: app.service.jobs,
      gateway: app.service.gateway,
      dataDir: app.service.config.dataDir,
      accountRef: () => app.service.accountRef(),
    },
    request,
    params,
    existing,
    undefined,
    explicit,
  );
  step.warnings = [...(step.warnings ?? []), ...warnings];
}

/** 通用动作保留原意图；恢复使用已保存骨架类型，新调用按原绑定任务或网页来源解析。 */
async function resolveGenericAnimation(
  app: Application,
  step: PlannedStep,
  params: Record<string, unknown>,
  remote: Record<string, unknown>,
  source?: Job,
  existing?: Job,
): Promise<void> {
  const saved =
    existing?.operation === 'animate' && existing.input.project_id === params.project_id
      ? text(existing.input.rig_type)
      : '';
  const known = source?.operation === 'rig' ? text(source.input.rig_type) : '';
  const rigType =
    saved ||
    (['biped', 'quadruped', 'avian', 'aquatic', 'hexapod', 'octopod', 'serpentine'].includes(known)
      ? known
      : await projectRigType(
          app.studio.client,
          text(params.project_id),
          text(remote.operator_id) || undefined,
        ));
  params.rig_type = rigType;
  params.animation = `preset:${rigType}:${step.genericAnimation}`;
}

/** 项目当前版本会被本次操作推进；重试只冻结自动选取的来源，显式换版本仍参与指纹冲突检查。 */
function bindSourceOperators(
  step: PlannedStep,
  params: Record<string, unknown>,
  remote: Record<string, unknown>,
  sourceJob?: Job,
  existing?: Job,
): void {
  const saved =
    !sourceJob &&
    step.source !== 'upstream' &&
    existing?.operation === step.operation &&
    existing.input.project_id === remote.project_id
      ? existing.input
      : undefined;
  for (const key of ['operator_id', 'expected_operator_id', 'current_operator_id', 'source_operator_id'])
    if (params[key] === 'upstream') params[key] = text(saved?.[key]) || remote.operator_id;
}

/** 官方 UV 默认要求烘焙贴图，网页却会移除贴图；在创建付费意图之前验证原版本。 */
async function checkUvTextureBaking(
  app: Application,
  step: PlannedStep,
  params: Record<string, unknown>,
  existing?: Job,
): Promise<void> {
  if (!step.requireTextureBaking || (existing && existing.state !== 'prepared')) return;
  const textured = await projectTextureStatus(
    app.studio.client,
    text(params.project_id),
    text(params.current_operator_id),
  );
  if (textured !== false)
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      'Studio Smart UV removes existing textures and cannot honor bake=true. Use -p bake=false to explicitly request geometry/UV output.',
      'not_submitted',
    );
}
/** 已保存的动作选择优先于可能改变的项目当前列表。 */
async function sourceAnimations(
  app: Application,
  projectId: string,
  source?: Job,
  existing?: Job,
): Promise<unknown> {
  if (existing?.operation === 'export') return existing.input.animations;
  const preferred =
    source?.operation === 'animate'
      ? [text(source.remote_ids.operator_id)]
      : source?.operation === 'export'
        ? array(source.input.animations).map(text)
        : undefined;
  return await resolveExportAnimations(app.studio.client, projectId, preferred);
}
/** 原图、额外参考图和四视图的角色不同，只有建模的四视图引用才展开成列表。 */
async function imageSourceParameters(
  app: Application,
  step: PlannedStep,
  params: Record<string, unknown>,
  remote: Record<string, unknown>,
  existing?: Job,
): Promise<Record<string, unknown>> {
  if (!text(remote.asset_id))
    throw new TripoError('INVALID_INPUT', 'This command requires a successful image task.');
  if (params.asset_id === 'upstream') params.asset_id = remote.asset_id;
  if (params.image_asset) params.image_asset = { ...object(params.image_asset), asset_id: remote.asset_id };
  if (step.operation === 'model' && params.mode === 'multiview' && params.image_assets) {
    const original =
      existing?.operation === 'model' && existing.state !== 'prepared' ? existing.input : undefined;
    if (original) {
      const views = array(original.image_assets).map(object);
      if (
        original.mode !== 'multiview' ||
        views.length !== 4 ||
        views.some((view, index) => view.asset_id !== remote.asset_id || view.output_index !== index)
      )
        throw new TripoError(
          'IDEMPOTENCY_CONFLICT',
          'The original multiview source or view order has changed.',
        );
      params.image_assets = views.map((view) => ({ ...view }));
    } else params.image_assets = await resolveMultiviewReference(app.studio.client, text(remote.asset_id));
  }
  return params;
}
export async function waitTask(
  app: Application,
  id: string,
  seconds = 1800,
  timing: PollTiming = { now: Date.now, sleep: delay },
): Promise<Record<string, unknown>> {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 7200)
    throw new TripoError('INVALID_INPUT', 'timeout must be between 0 and 7200 seconds.');
  const deadline = timing.now() + seconds * 1000;
  let failures = 0;
  for (;;) {
    const job = await app.service.get(id, Math.min(30, Math.max(0, (deadline - timing.now()) / 1000)));
    if (!['submitted', 'running', 'submitting'].includes(text(job.state))) return job;
    if (timing.now() >= deadline) return { ...job, wait_timed_out: true };
    failures = job.poll_error ? failures + 1 : 0;
    const pause = job.poll_error
      ? pollingDelay(job.poll_error, failures)
      : job.state === 'submitting'
        ? 2000
        : 0;
    if (pause) await timing.sleep(Math.min(pause, Math.max(0, deadline - timing.now())));
    if (timing.now() >= deadline) return { ...job, wait_timed_out: true };
  }
}
/** 有交付身份合同的产物必须经service复核inode/父目录；字节相同不能绕过原文件登记。 */
function serviceManagedDownload(app: Application, original: Job, artifact: Record<string, unknown>): boolean {
  if (
    frontendOutputRequested(app.service.jobs, original) ||
    Array.isArray(artifact.frontend_deliveries) ||
    original.artifacts.some(
      (item) => item.artifact_id === artifact.artifact_id && localExportDeliveryRequested(original, item),
    )
  )
    return true;
  if (
    artifact.kind === 'model' &&
    (labReferenceEditPolicy(app.service.jobs, original) ||
      exportJpegRequested(app.service.jobs, original) ||
      unbakedRequested(original))
  )
    return true;
  return (
    (smartSegmentScaleRequested(app.service.jobs, original) ||
      Boolean(affineFinalParent(original)) ||
      Boolean(transferFinalParent(original))) &&
    original.artifacts.some(
      (a) =>
        a.artifact_id === artifact.artifact_id && (a.kind === 'model' || a.artifact_id === 'semantic-mask'),
    )
  );
}

export async function downloadTask(
  app: Application,
  job: Record<string, unknown>,
  flags: Flags,
): Promise<Record<string, unknown>> {
  const account = app.service.accountRef();
  const name = app.service.jobs.name(account, text(job.job_id));
  const dir = outputDirectory({ ...job, ...(name ? { name } : {}) }, flags);
  const files = [];
  const original = app.service.jobs.get(text(job.job_id));
  const assertAccount = (): void => {
    if (original.account_ref !== account || app.service.accountRef() !== account)
      throw new TripoError('ACCOUNT_MISMATCH', 'The download account changed.', 'read');
  };
  assertAccount();
  if (canvasResultView(original).state === 'needs_attention')
    throw new TripoError(
      'CANVAS_FINAL_ARTIFACT_UNVERIFIED',
      'Read the original Canvas task to verify its final capped output before downloading.',
      'read',
    );
  for (const artifact of array(job.artifacts).map(object)) {
    assertCanvasArtifact(original, artifact as unknown as Artifact);
    const format = artifact.format === 'image' ? 'png' : text(artifact.format);
    const base = artifact.artifact_id === 'model-0' ? 'model' : text(artifact.artifact_id);
    const dest = path.join(dir, `${base}.${format}`);
    if (!serviceManagedDownload(app, original, artifact) && artifact.local_path === dest) {
      const bytes = await verifiedArtifactBytes(artifact as unknown as Artifact);
      assertAccount();
      if (bytes) {
        if (
          artifact.kind === 'model' &&
          nativeMeshoptRequested(app.service.jobs, app.service.jobs.get(text(job.job_id)))
        )
          await verifyNativeMeshopt(bytes, text(artifact.format));
        assertAccount();
        files.push(artifact);
        continue;
      }
    }
    files.push(await app.service.download(text(job.job_id), text(artifact.artifact_id), dest, true));
    assertAccount();
  }
  assertAccount();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  assertAccount();
  const metadata = path.join(dir, 'task.json');
  await writeFile(metadata, JSON.stringify(taskResult(job), null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
    if (object(JSON.parse(await readFile(metadata, 'utf8'))).task_id !== job.job_id)
      throw new TripoError('OUTPUT_EXISTS', 'Output directory already contains another task.json.');
  });
  assertAccount();
  return {
    task_file: metadata,
    output_dir: dir,
    files: files.map((f) => f.local_path),
    file_records: files,
    model_file: files.find((f) => /\.(glb|gltf|fbx|obj|stl|usdz|3mf|zip)$/.test(text(f.local_path)))
      ?.local_path,
    preview: files.find((f) => /\.(png|jpe?g|webp)$/.test(text(f.local_path)))?.local_path,
  };
}
/** prepared 尚未发出远端请求，等待账号提交槽后可用同一意图领取；其他状态绝不重提。 */
async function submitStep(
  app: Application,
  step: PlannedStep,
  requestId: string,
  params: Record<string, unknown>,
  flags: Flags,
  transformAccount?: string,
): Promise<Record<string, unknown>> {
  const existing = app.service.jobs.find(app.service.accountRef(), requestId);
  const quote = existing?.quote ?? (await app.service.quote(step.operation, params));
  if (
    (!quote.known || quote.credits === undefined) &&
    !(quote.variable && params.accept_variable_cost === true)
  )
    throw new TripoError('PRICE_UNKNOWN', quote.explanation);
  const maximum = typeof flags.maxCredits === 'number' ? flags.maxCredits : (quote.credits ?? 0);
  const deadline = Date.now() + Math.min(180, Number(flags.timeout ?? 180)) * 1000;
  for (;;) {
    if (transformAccount && app.service.accountRef() !== transformAccount)
      throw new TripoError(
        'ACCOUNT_MISMATCH',
        'The account changed during the transformed smartsegment chain.',
        'not_submitted',
      );
    const job = step.frontendConvert
      ? await executeFrontendConvert(app, step, params, requestId, maximum)
      : await app.service.submit(step.operation, requestId, params, maximum);
    // --no-wait 跳过远端生成等待，不跳过本机提交槽；否则并行候选只会真正提交第一项。
    if (job.state !== 'prepared' || Date.now() >= deadline) return job;
    await delay(500);
  }
}
function freezeSegmentExecution(app: Application, plan: Plan, request: string): string | undefined {
  assertSmartSegmentLayouts(app, plan, request);
  const transformed = freezeSmartSegmentTransform(app.service.jobs, app.service.accountRef(), plan, request);
  const scaled = freezeSmartSegmentScale(app, plan, request);
  return transformed ?? scaled;
}
export async function executePlan(
  app: Application,
  plan: Plan,
  flags: Flags,
): Promise<Record<string, unknown>> {
  validateExecutionOptions(flags);
  const request = text(flags.requestId) || randomUUID();
  flags = { ...flags, requestId: request };
  assertLabReferenceEditPlan(app.service.jobs, app.service.accountRef(), request, plan);
  if (plan.labReferenceEdit) return await executeLabReferenceEdit(app, plan, flags, request);
  if (plan.multiviewEdit) return await executeMultiviewEdit(app, plan, flags);
  flags = { ...flags, outIsRoot: true };
  if (plan.smartSegmentAffine) {
    plan = selectAffinePlan(app, plan, request);
    return plan.steps.length === 7
      ? await executeSmartSegmentAffine(app, plan, flags, request)
      : await executeSmartSegmentTransfer(app, plan, flags, request);
  }
  return await executeSequentialPlan(app, plan, flags, request);
}
async function executeSequentialPlan(
  app: Application,
  plan: Plan,
  flags: Flags,
  request: string,
): Promise<Record<string, unknown>> {
  const transformAccount = freezeSegmentExecution(app, plan, request);
  freezeSmartSegmentImage(app.service.jobs, app.service.accountRef(), plan, request);
  plan = freezeGenerationLayout(app, plan, request);
  plan = freezeLabModelIsolationLayout(app.service.jobs, app.service.accountRef(), request, plan);
  plan = freezePlanReferences(app, plan, request);
  const beforeSourceSelection = plan.steps;
  const selectedSteps = freezeLabModelSourceSelection(
    app.service.jobs,
    app.service.accountRef(),
    request,
    beforeSourceSelection,
    (reference) => resolveJob(app, reference),
  );
  const selectedIndex = beforeSourceSelection.findIndex(
    (step) => step.sourceRepresentation && step.source === plan.sourceValidation?.reference,
  );
  plan = {
    ...plan,
    steps: selectedSteps,
    ...(plan.sourceValidation && selectedIndex >= 0
      ? { sourceValidation: { ...plan.sourceValidation, reference: selectedSteps[selectedIndex]!.source! } }
      : {}),
  };
  freezeUvImportLayout({ jobs: app.service.jobs, account: app.service.accountRef() }, plan, request);
  await validateSourcePlan(app, plan, request);
  let previous: Record<string, unknown> | undefined;
  const chain: Record<string, unknown>[] = [];
  const animations: string[] = [];
  const deliveries: Record<string, unknown>[] = [];
  plan = await expandSegmentationPlan(plan, app.service.config.inputRoots);
  for (const [index, step] of plan.steps.entries()) {
    freezeImageSizePolicy(app.service.jobs, app.service.accountRef(), `${request}-${index}`, step.imageSize);
    freezeImageBackgroundPolicy(
      app.service.jobs,
      app.service.accountRef(),
      `${request}-${index}`,
      step.imageBackground,
    );
    assertFrontendConvertPlan(app.service.jobs, app.service.accountRef(), `${request}-${index}`, step);
    freezeNativeOutputPolicy(
      app.service.jobs,
      app.service.accountRef(),
      `${request}-${index}`,
      Boolean(step.requireNativeMeshopt),
    );
    freezeTextureModel(
      app.service.jobs,
      app.service.accountRef(),
      `${request}-${index}`,
      step.requireTextureModel,
    );
    freezeImageOutputPolicy(
      app.service.jobs,
      app.service.accountRef(),
      `${request}-${index}`,
      step.imageOutputFormat,
    );
  }
  plan = await prepareSmartSegmentTransformSource(app, plan, request);
  plan = await prepareSmartSegmentScaleSource(app, plan, request);
  await validatePlanFiles(plan);
  if (flags.wait === false && plan.steps.length > 1)
    throw new TripoError('INVALID_INPUT', '--no-wait cannot execute a processing chain.');
  plan = await materializeInputs(plan, app.service.config.dataDir, request);
  plan = { ...plan, steps: plan.steps.map((step) => ({ ...step })), warnings: [...plan.warnings] };
  const name = planName(plan, flags);
  for (const [i, step] of plan.steps.entries()) {
    freezeImageSizePolicy(app.service.jobs, app.service.accountRef(), `${request}-${i}`, step.imageSize);
    freezeImageBackgroundPolicy(
      app.service.jobs,
      app.service.accountRef(),
      `${request}-${i}`,
      step.imageBackground,
    );
    freezeTextureModel(
      app.service.jobs,
      app.service.accountRef(),
      `${request}-${i}`,
      step.requireTextureModel,
    );
    freezeImageOutputPolicy(
      app.service.jobs,
      app.service.accountRef(),
      `${request}-${i}`,
      step.imageOutputFormat,
    );
    freezeNativeOutputPolicy(
      app.service.jobs,
      app.service.accountRef(),
      `${request}-${i}`,
      Boolean(step.requireNativeMeshopt),
    );
    const existing = app.service.jobs.find(app.service.accountRef(), `${request}-${i}`);
    await verifySmartSegmentTransformImport(app, plan, request, previous, i);
    let params = await executionParameters(app, step, `${request}-${i}`, previous, existing);
    params = await prepareSmartSegmentScaleStep(app, plan, request, i, params);
    prepareAffineComponent(
      app.service.jobs,
      app.service.accountRef(),
      `${request}-${i}`,
      step.operation,
      params,
    );
    prepareTransferComponent(
      app.service.jobs,
      app.service.accountRef(),
      `${request}-${i}`,
      step.operation,
      params,
    );
    bindLabModelSourceDelivery(
      app.service.jobs,
      app.service.accountRef(),
      `${request}-${i}`,
      step.operation,
      uvSourceJob(app, step, previous),
      step.sourceRepresentation,
      params,
    );
    // 链上新生成的动作属于导出意图本身，必须先并入参数，再冻结 JPEG 缺省意图；否则提交前核对必然不一致。
    if (step.animationsFromChain) Object.assign(params, { with_animation: true, animations });
    await prepareDefaultJpeg(app, step, params, `${request}-${i}`, existing);
    recordExecutionPolicy(app, plan, step, `${request}-${i}`, existing);
    if (step.preflight === 'rig') {
      const terminal = await preflightStep(app, plan, i, params, chain, request, previous);
      if (terminal) return await stoppedPlan(app, plan, flags, terminal, previous, chain, deliveries);
      continue;
    }
    previous = await submitStep(app, step, `${request}-${i}`, params, flags, transformAccount);
    app.service.jobs.linkStep(app.service.accountRef(), request, i, text(previous.job_id));
    if (i === plan.steps.length - 1)
      app.service.jobs.assignName(app.service.accountRef(), name, text(previous.job_id));
    if (flags.wait !== false)
      previous = await waitTask(
        app,
        text(previous.job_id),
        typeof flags.timeout === 'number' ? flags.timeout : 1800,
      );
    previous = await verifyLabCopyStep(app, step, previous);
    chain.push(taskResult(previous));
    if (
      i === generationPrefixLength(plan) - 1 &&
      plan.downloadGeneration &&
      previous.state === 'succeeded' &&
      flags.download !== false
    )
      deliveries.push({
        task_id: previous.job_id,
        ...(await downloadTask(app, previous, {
          ...flags,
          name,
        })),
      });
    if (step.operation === 'animate' && previous.state === 'succeeded')
      animations.push(text(object(previous.remote_ids).operator_id));
    if (previous.state !== 'succeeded') break;
  }
  return await completePlan(app, plan, flags, previous, chain, deliveries);
}

/** 下游只能继承已核原字节的隔离副本；恢复使用冻结缓存，不重选网页当前版本。 */
async function verifyLabCopyStep(
  app: Application,
  step: PlannedStep,
  previous: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (step.operation !== 'copy' || previous.state !== 'succeeded') return previous;
  const proof = await prepareLabModelIsolationCopy(
    {
      jobs: app.service.jobs,
      client: app.studio.client,
      dataDir: app.service.config.dataDir,
      accountRef: () => app.service.accountRef(),
      checkTargetCurrent: false,
    },
    app.service.jobs.get(text(previous.job_id)),
  );
  return proof ? await app.service.get(text(previous.job_id)) : previous;
}

/** 预检否定的是后续绑定，不是否定先前生成；沿官方行为保留并交付已成功模型。 */
async function stoppedPlan(
  app: Application,
  plan: Plan,
  flags: Flags,
  check: Record<string, unknown>,
  previous: Record<string, unknown> | undefined,
  chain: Record<string, unknown>[],
  deliveries: Record<string, unknown>[],
): Promise<Record<string, unknown>> {
  if (!previous || !check.stopped_early) return check;
  return {
    ...(await completePlan(app, plan, flags, previous, chain, deliveries)),
    stopped_early: true,
    riggable: false,
    stopped_reason: check.stopped_reason,
  };
}

/** 不把 CLI 层的保护标志透传网页；旧记录只能恢复并警告，不能从产物反推原意图。 */
function recordExecutionPolicy(
  app: Application,
  plan: Plan,
  step: PlannedStep,
  request: string,
  existing?: Job,
): void {
  plan.warnings = [...new Set([...plan.warnings, ...(step.warnings ?? [])])];
  if (step.operation === 'export' && step.exportDefaults) {
    const key = `export-default-intent:${request}`;
    // 旧任务没有缺省来源证据，不补写成新语义；新任务的显式来源/缺省字段必须保持。
    if (!existing || app.service.jobs.requestPolicy(app.service.accountRef(), key))
      app.service.jobs.bindRequestPolicy(app.service.accountRef(), key, {
        source: step.source,
        defaults: step.exportDefaults,
      });
  }
  if (step.requireTextureBaking === undefined) return;
  const legacy = app.service.jobs.bindRequestPolicy(app.service.accountRef(), request, {
    require_texture_baking: step.requireTextureBaking,
  });
  if (legacy)
    plan.warnings.push(
      'This legacy UV task did not store its original bake policy. Recovery returns the original output, which may have no textures; it does not establish bake=true support.',
    );
}

/** 有本机来源记录时在上传/付费前核对其真实类型；原生网页项目仍由适配层检查权限和状态。 */
async function validateSourcePlan(app: Application, plan: Plan, request: string): Promise<void> {
  if (!plan.sourceValidation) return;
  const { reference, chain } = plan.sourceValidation;
  let source: Job;
  try {
    source = resolveJob(app, reference);
  } catch (error) {
    if (!(error instanceof TripoError) || error.code !== 'JOB_NOT_FOUND' || reference.startsWith('@'))
      throw error;
    if (reference.startsWith('task_'))
      throw new TripoError(
        'STUDIO_CAPABILITY_UNAVAILABLE',
        'Official API task IDs cannot be used as Studio projects.',
        'not_submitted',
      );
    return;
  }
  rejectFrontendConvertContinuation(app.service.jobs, source);
  const selectedSteps = plan.steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.sourceRepresentation && step.source === source.job_id);
  const submittingSelections = selectedSteps.filter(({ step }) => !step.preflight);
  const labSource = selectedSteps.length
    ? await prepareLabModelSource(
        {
          jobs: app.service.jobs,
          client: app.studio.client,
          dataDir: app.service.config.dataDir,
          accountRef: () => app.service.accountRef(),
          checkTargetCurrent:
            submittingSelections.length === 0 ||
            submittingSelections.some(({ index }) => {
              const existing = app.service.jobs.find(app.service.accountRef(), `${request}-${index}`);
              return !existing || existing.state === 'prepared';
            }),
        },
        source,
        'studio_normalized',
      )
    : undefined;
  // 普通任务的类型校验只需本地记录，不为不相关的来源引入 Canvas 客户端依赖。
  const canvasSource =
    source.operation === 'canvas_run'
      ? await prepareCanvasModelSource(
          { jobs: app.service.jobs, client: app.studio.client, accountRef: () => app.service.accountRef() },
          source,
        )
      : undefined;
  validateCompatibilityChain(chain, labSource?.task_type ?? canvasSource?.task_type ?? taskType(source));
  if (source.state !== 'succeeded') {
    const current = await app.service.get(source.job_id);
    if (current.state !== 'succeeded')
      throw new TripoError(
        'INPUT_NOT_READY',
        'Wait for the original source task to succeed before processing it.',
        'not_submitted',
      );
  }
}

function planName(plan: Plan, flags: Flags): string {
  const first = plan.steps[0]!;
  return (
    text(flags.name) ||
    (plan.smartSegmentTransform || plan.smartSegmentScale ? text(first.parameters.name) : '') ||
    text(first.parameters.prompt) ||
    text(first.parameters.model_path) ||
    text(first.parameters.image_path) ||
    first.name
  );
}
async function preflightStep(
  app: Application,
  plan: Plan,
  index: number,
  params: Record<string, unknown>,
  chain: Record<string, unknown>[],
  request: string,
  previous?: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  const check = await checkedRigChain(app, plan, index, params, request, previous);
  chain.push({ type: 'animate_prerigcheck', ...check });
  const identity = previous ? { task_id: previous.job_id } : {};
  if (typeof check.riggable !== 'boolean')
    throw new TripoError('CONTRACT_CHANGED', 'Rig check returned no explicit riggability verdict.');
  if (check.riggable === false)
    return {
      status: 'success',
      type: 'animate_prerigcheck',
      ...check,
      stopped_early: index < plan.steps.length - 1,
      stopped_reason: 'Rig check says the model is not riggable; no downstream task was submitted.',
      chain,
      ...identity,
    };
  if (index === plan.steps.length - 1)
    return { status: 'success', type: 'animate_prerigcheck', ...check, chain, ...identity };
  const next = plan.steps[index + 1]!;
  if (!previous && next.source === 'upstream')
    plan.steps[index + 1] = { ...next, source: plan.steps[index]!.source };
  return undefined;
}
async function completePlan(
  app: Application,
  plan: Plan,
  flags: Flags,
  previous: Record<string, unknown> | undefined,
  chain: Record<string, unknown>[],
  deliveries: Record<string, unknown>[],
): Promise<Record<string, unknown>> {
  if (!previous) throw new TripoError('INVALID_INPUT', 'No task was planned.');
  // 官方文件处理链携带首次导入的因子；任务ID入口和专用矩阵链不追溯或猜测原始尺寸。
  if (
    plan.steps[0]?.operation === 'import_model' &&
    !plan.smartSegmentAffine &&
    !plan.smartSegmentScale &&
    !plan.smartSegmentTransform &&
    chain[0]?.normalize_scale !== undefined &&
    previous.normalize_scale === undefined
  )
    previous = {
      ...previous,
      ...Object.fromEntries(
        ['normalize_scale', 'normalize_scale_provenance', 'normalize_scale_validation'].map((key) => [
          key,
          chain[0]![key],
        ]),
      ),
    };
  const result = taskResult(previous);
  result.name = app.service.jobs.name(app.service.accountRef(), text(previous.job_id));
  if (chain.length > 1) result.chain = chain;
  if (previous.state === 'succeeded' && flags.download !== false) {
    try {
      Object.assign(
        result,
        await downloadTask(app, previous, {
          ...flags,
          name: result.name ?? flags.name ?? planName(plan, flags),
        }),
      );
    } catch (error) {
      result.download_error = errorResult(error);
    }
  }
  if (deliveries.length) result.generation_downloads = deliveries;
  if (plan.warnings.length) result.warnings = plan.warnings;
  return result;
}

/** 批量查询容忍不存在的任务；权限、认证和网络错误逐项保留，不能吞成空列表。 */
export async function queryTasks(app: Application, references: string[]): Promise<Record<string, unknown>> {
  const results = await Promise.allSettled(
    references.map(async (ref) => taskResult(await app.service.get(resolveJob(app, ref).job_id))),
  );
  const tasks: Record<string, unknown>[] = [],
    missed: string[] = [],
    errors: Record<string, unknown>[] = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') tasks.push(result.value);
    else if (result.reason instanceof TripoError && result.reason.code === 'JOB_NOT_FOUND')
      missed.push(references[index]!);
    else errors.push({ task_id: references[index], error: errorResult(result.reason) });
  });
  return { tasks, missed, ...(errors.length ? { errors } : {}) };
}

export function taskExitCode(result: Record<string, unknown>): number {
  return executionExitCode(result);
}

export function historyResult(app: Application, job: Record<string, unknown>): Record<string, unknown> {
  const downloaded = array(job.artifacts)
    .map(object)
    .map((a) => text(a.local_path))
    .find(Boolean);
  return {
    ...taskResult(job),
    name: app.service.jobs.name(app.service.accountRef(), text(job.job_id)),
    ...(downloaded ? { output_dir: path.dirname(downloaded) } : {}),
  };
}

/** 从明确保存的成员关系读取处理链，账号隔离与单任务查询一致。 */
export function pipelineDetails(app: Application, jobId: string): Record<string, unknown>[] {
  return app.service.jobs
    .pipeline(app.service.accountRef(), jobId)
    .map((job) => taskResult(app.service.summary(job)));
}
