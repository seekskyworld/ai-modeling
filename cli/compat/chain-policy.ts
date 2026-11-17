/** 官方链约束先于任何上传或付费生成执行；原始 preset 名称在网页映射前保留其版本语义。 */
import { text, TripoError } from '../../studio/contracts/errors.ts';
import type { ChainStep } from './chain.ts';
import { compatibleRigModel, validateRigPolicy } from './rig-policy.ts';

const outputs: Record<string, string> = {
  texture: 'texture_model',
  convert: 'convert_model',
  import: 'import_model',
  rig: 'animate_rig',
  retarget: 'animate_retarget',
  segment: 'mesh_segmentation',
  complete: 'mesh_completion',
  decimate: 'highpoly_to_lowpoly',
  uv: 'mesh_uv',
  edit: 'mesh_edit',
};
const modelTypes = new Set([
  'text_to_model',
  'image_to_model',
  'multiview_to_model',
  'refine_model',
  'stylize_model',
  'mesh_decimate',
  'smart_uv',
  'copy',
  ...Object.values(outputs),
]);

function checkSource(step: ChainStep, source?: string): void {
  if (['import', 'smartsegment'].includes(step.name))
    throw new TripoError(
      'INVALID_INPUT',
      `${step.name} takes a file input and cannot follow a task in --then.`,
      'not_submitted',
    );
  if (!source) return;
  const required =
    step.name === 'retarget' ? 'animate_rig' : step.name === 'complete' ? 'mesh_segmentation' : undefined;
  if (required ? source !== required : !modelTypes.has(source))
    throw new TripoError(
      'INVALID_INPUT',
      `${step.name} requires ${required ?? 'a model-producing task'}, but the preceding step produces ${source}.`,
      'not_submitted',
    );
}

/** 原始 API 的 biped: 前缀属于旧引擎；网页对新引擎的前缀转换发生在此校验之后。 */
function checkPresets(step: ChainStep, model: string): void {
  const requested = step.param.animations ?? step.param.animation;
  const presets = Array.isArray(requested) ? requested : [requested];
  for (const value of presets) {
    const preset = text(value);
    if (preset.startsWith('preset:') && (model === 'v1.0-20240301') !== preset.startsWith('preset:biped:'))
      throw new TripoError(
        'INVALID_INPUT',
        `Preset ${preset} is incompatible with rig model ${model}; v1.0 requires preset:biped:*, and v2.5/v3.0 require generic or other body-type presets.`,
        'not_submitted',
      );
  }
}

/** 已知源类型立即验整条链；已有任务的未知类型只跳过首步，后续类型和绑定版本仍可验证。 */
export function validateCompatibilityChain(chain: ChainStep[], sourceType?: string): void {
  let currentType = sourceType;
  let rigModel: string | undefined;
  for (const step of chain) {
    checkSource(step, currentType);
    if (step.name === 'rig') {
      validateRigPolicy(step.param);
      rigModel = compatibleRigModel(step.param.model, step.param.rig_type);
    } else if (step.name !== 'rig-check') {
      if (step.name === 'retarget' && rigModel) checkPresets(step, rigModel);
      rigModel = undefined;
    }
    if (step.name !== 'rig-check') currentType = outputs[step.name];
  }
}
