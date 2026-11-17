/** 重做是新的生成意图；只为已验证的网页操作选择种子，未知原任务不能借此重复提交。 */
import { randomInt } from 'node:crypto';
import type { Job } from '../../studio/contracts/types.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import { normalize } from '../../studio/contracts/schemas.ts';
import { processingPlan, type Plan, type PlannedStep } from './planning.ts';
import { textureWarnings } from './texture.ts';
import { pSeriesGeneration } from './p-series-generation.ts';
import { isMultiviewBundle, multiviewBundle } from '../core/multiview-bundle.ts';
import { editMultiviewPlan } from './multiview-plan.ts';
import type { ImageOutputFormat } from '../core/image-output-policy.ts';
import type { ImageSizeRequirement } from '../core/image-size-policy.ts';
import type { ImageBackground } from '../core/image-background-policy.ts';

/** 恢复固定来源；首次重做使用原结果，原失败任务无回执时保留输入中的来源保护。 */
function textureRedoSource(job: Job, previous?: Job['input']): unknown {
  return previous?.expected_operator_id ?? job.remote_ids.operator_id ?? job.input.expected_operator_id;
}
function redoMultiview(job: Job, seed: unknown): Plan | undefined {
  if (!isMultiviewBundle(job)) return;
  if (seed !== undefined)
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      'Website multiview image edits have no verified seed control.',
    );
  const saved = multiviewBundle(job);
  return editMultiviewPlan(saved.source_reference, { param: { prompts: saved.intent.prompts } });
}
function redoStep(
  job: Job,
  input: Job['input'],
  requireNativeMeshopt: boolean,
  requireTextureModel?: string,
  imageOutputFormat?: ImageOutputFormat,
  imageSize?: ImageSizeRequirement,
  imageBackground?: ImageBackground,
): PlannedStep {
  return {
    name: 'redo',
    operation: job.operation,
    parameters: normalize(job.operation, input),
    ...(requireNativeMeshopt ? { requireNativeMeshopt: true as const } : {}),
    requireTextureModel,
    imageOutputFormat,
    imageSize,
    imageBackground,
  };
}

function assertRedoSource(job: Job): void {
  if (!['succeeded', 'failed'].includes(job.state))
    throw new TripoError('INPUT_NOT_READY', 'Resolve the original task before creating a fresh submission.');
  if (job.operation === 'export_lite')
    throw new TripoError(
      'FRONTEND_REDO_INTENT_REQUIRED',
      'An export-lite receipt alone cannot recreate a converted model. Use the original verified compatible convert intent, or repeat the explicit studio frontend-export command.',
      'not_submitted',
    );
}

/** 保留原参数并应用新的模型/贴图种子；其他操作显式指定种子时拒绝，贴图不保证确定性。 */
export function redoPlan(
  job: Job,
  seed?: unknown,
  previousRedo?: Job,
  requireNativeMeshopt = false,
  requireTextureModel?: string,
  imageOutputFormat?: ImageOutputFormat,
  imageSize?: ImageSizeRequirement,
  imageBackground?: ImageBackground,
): Plan {
  assertRedoSource(job);
  const multiview = redoMultiview(job, seed);
  if (multiview) return multiview;
  const input = Object.fromEntries(Object.entries(job.input).filter(([key]) => !key.startsWith('_')));
  const seededTexture = job.operation === 'texture' && input.action === 'generate';
  const previous = previousRedo?.operation === job.operation ? previousRedo.input : undefined;
  // 自动种子属于新意图的一部分；恢复相同request时复用，显式新种子仍由提交指纹拒绝冲突。
  if (job.operation === 'model') input.model_seed = seed ?? previous?.model_seed ?? randomInt(2147483647);
  else if (seededTexture) input.texture_seed = seed ?? previous?.texture_seed ?? randomInt(2147483647);
  else if (seed !== undefined)
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      'This Studio operation has no verified seed parameter.',
    );
  // 自动前缀冻结过来源版本；新的贴图重做从原结果版本出发，重连仍复用上次 redo 保存的来源。
  if (seededTexture && input.expected_operator_id !== undefined)
    input.expected_operator_id = textureRedoSource(job, previous);
  const prefix = pSeriesGeneration(
    redoStep(
      job,
      input,
      requireNativeMeshopt,
      requireTextureModel,
      imageOutputFormat,
      imageSize,
      imageBackground,
    ),
    (param) => processingPlan('texture', 'upstream', { param }),
  );
  return {
    steps: prefix.steps,
    pending_uploads: [],
    warnings: [...prefix.warnings, ...(seededTexture ? textureWarnings(input, undefined) : [])],
    ...(prefix.layout ? { generationLayout: prefix.layout, generationSteps: prefix.steps.length } : {}),
  };
}
