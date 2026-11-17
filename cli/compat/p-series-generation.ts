/** P 系列在网页上先生成白模再贴图；原始意图与步骤布局必须独立保存，防止升级后重复收费。 */
import { isDeepStrictEqual } from 'node:util';
import { isPSeries, validatePSeriesGeometry } from '../../studio/contracts/model-policy.ts';
import { normalize } from '../../studio/contracts/schemas.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import type { Plan, PlannedStep } from './planning.ts';
import type { Application } from './runtime.ts';
import { explicitTextureWarning } from './texture-version.ts';

export interface GenerationLayout {
  original: PlannedStep;
  prefixLength: number;
}

export const pSeriesWarning =
  'Studio P1/P2 texture=true runs geometry, then native texture generation; pbr=true adds a separate PBR task. Each step uses website pricing and its own receipt. --no-wait requires texture=false.';

/** 所有分步在离线规划中先规范化；贴图参数不进入低模生成，也不在生成后才发现无效。 */
export function pSeriesGeneration(
  initial: PlannedStep,
  texturePlan: (parameters: Record<string, unknown>) => Plan,
): { steps: PlannedStep[]; warnings: string[]; layout?: GenerationLayout } {
  const input = initial.parameters;
  const pSeries = isPSeries(input);
  if (initial.operation !== 'model' || (!pSeries && !initial.requireTextureModel))
    return { steps: [initial], warnings: [] };
  if (pSeries) validatePSeriesGeometry(input);
  if (input.texture !== true) {
    if (input.texture_seed !== undefined)
      throw new TripoError('INVALID_INPUT', 'texture_seed requires texture=true for P-series generation.');
    return { steps: [initial], warnings: [], layout: { original: initial, prefixLength: 1 } };
  }
  if (Array.isArray(input.variations))
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      'P-series variations returns multiple projects. Use texture=false, then texture each selected project explicitly; a single upstream texture task cannot preserve all variations.',
      'not_submitted',
    );
  const geometry: Record<string, unknown> = { ...input, texture: false, pbr: false };
  const texture: Record<string, unknown> = { pbr: input.pbr };
  for (const key of ['texture_quality', 'texture_alignment', 'delight', 'texture_seed']) {
    if (input[key] !== undefined) texture[key] = input[key];
    delete geometry[key];
  }
  // 拆步再次进入公开 texture 规划器时还原 CLI 枚举；外部 ultra 不能绕过原始参数校验。
  if (texture.texture_quality === 'ultra') texture.texture_quality = 'extreme';
  const compiled = texturePlan(texture);
  const steps = [
    { ...initial, requireTextureModel: undefined, parameters: normalize('model', geometry) },
    ...compiled.steps.map((step) => ({
      ...step,
      ...(initial.requireNativeMeshopt ? { requireNativeMeshopt: true as const } : {}),
      ...(initial.requireTextureModel && step.parameters.action === 'generate'
        ? { requireTextureModel: initial.requireTextureModel }
        : {}),
      parameters: normalize('texture', { ...step.parameters, expected_operator_id: 'upstream' }),
    })),
  ];
  return {
    steps,
    warnings: [
      pSeries ? pSeriesWarning : explicitTextureWarning,
      ...(pSeries && initial.requireTextureModel ? [explicitTextureWarning] : []),
      ...compiled.warnings,
    ],
    layout: { original: initial, prefixLength: steps.length },
  };
}

function originalIntent(step: PlannedStep): Record<string, unknown> {
  // warnings 不属于用户意图；说明文字更新不应使已收费请求无法恢复。
  return JSON.parse(
    JSON.stringify({
      operation: step.operation,
      parameters: step.parameters,
      source: step.source,
      imageReferences: step.imageReferences,
      exportEdits: step.exportEdits,
      preflight: step.preflight,
      requireTextureBaking: step.requireTextureBaking,
      requireNativeMeshopt: step.requireNativeMeshopt,
      requireTextureModel: step.requireTextureModel,
      imageOutputFormat: step.imageOutputFormat,
      imageSize: step.imageSize,
      imageBackground: step.imageBackground,
      genericAnimation: step.genericAnimation,
      animationsFromChain: step.animationsFromChain,
      animationsFromSource: step.animationsFromSource,
    }),
  );
}

/** 在历史引用冻结之前恢复布局，防止新增贴图改变旧来源位置和已收费的 request 索引。 */
export function freezeGenerationLayout(app: Application, plan: Plan, request: string): Plan {
  const layout = plan.generationLayout;
  const account = app.service.accountRef();
  const key = `p-series-generation:${request}`;
  if (!layout) {
    if (app.service.jobs.requestPolicy(account, key))
      throw new TripoError(
        'IDEMPOTENCY_CONFLICT',
        'This request originally used a native generation/texture pipeline; its layout cannot be omitted.',
        'not_submitted',
      );
    return plan;
  }
  const intent = {
    generation: originalIntent(layout.original),
    tail: plan.steps.slice(layout.prefixLength).map(originalIntent),
  };
  const saved = app.service.jobs.requestPolicy(account, key);
  if (saved) {
    if (!isDeepStrictEqual(saved.intent, intent))
      throw new TripoError('IDEMPOTENCY_CONFLICT', 'The original P-series generation intent has changed.');
    if (!Array.isArray(saved.steps) || !saved.steps.length)
      throw new TripoError('CONTRACT_CHANGED', 'The saved P-series generation layout is incomplete.');
    return replacePrefix(plan, saved.steps as PlannedStep[]);
  }
  const prior = app.service.jobs.find(account, `${request}-0`);
  if (prior) {
    const legacy = replacePrefix(plan, [layout.original]);
    // 旧版未持久化完整待办链，只能恢复已经登记的步骤，不能把新的后处理夹带成“恢复”。
    const missing = legacy.steps.some(
      (step, index) => !step.preflight && !app.service.jobs.find(account, `${request}-${index}`),
    );
    const extra = app.service.jobs.pipeline(account, prior.job_id).some((job) => {
      const suffix = job.request_id.startsWith(`${request}-`) ? job.request_id.slice(request.length + 1) : '';
      return /^\d+$/.test(suffix) && Number(suffix) >= legacy.steps.length;
    });
    if (missing || extra)
      throw new TripoError(
        'IDEMPOTENCY_CONFLICT',
        'This legacy request cannot prove a changed or unfinished processing layout. Recover its recorded tasks, then use a new request for further processing.',
        'not_submitted',
      );
    return {
      ...legacy,
      warnings: [
        ...new Set([
          ...plan.warnings.filter((warning) => warning !== pSeriesWarning),
          'This legacy P-series request keeps its original single generation step. No new texture/PBR work is inserted; the original output may be untextured. Use a new request to explicitly run the new chain.',
        ]),
      ],
    };
  }
  const steps = plan.steps.slice(0, layout.prefixLength);
  app.service.jobs.bindRequestPolicy(account, key, { intent, steps });
  return plan;
}

function replacePrefix(plan: Plan, steps: PlannedStep[]): Plan {
  const layout = plan.generationLayout!;
  return {
    ...plan,
    steps: [...steps, ...plan.steps.slice(layout.prefixLength)],
    generationSteps: (plan.generationSteps ?? layout.prefixLength) - layout.prefixLength + steps.length,
    generationLayout: { ...layout, prefixLength: steps.length },
  };
}

/** 种子属于每个候选的原始意图；完整生成前缀须随该候选一起执行。 */
export function candidateGeneration(plan: Plan, seed: number): Plan {
  const seeded = (step: PlannedStep): PlannedStep => ({
    ...step,
    parameters: { ...step.parameters, model_seed: seed },
  });
  return {
    ...plan,
    steps: [seeded(plan.steps[0]!), ...plan.steps.slice(1, generationPrefixLength(plan))],
    ...(plan.generationLayout
      ? { generationLayout: { ...plan.generationLayout, original: seeded(plan.generationLayout.original) } }
      : {}),
  };
}

export const generationPrefixLength = (plan: Plan): number =>
  plan.generationSteps ?? (plan.generationExport ? 2 : 1);
