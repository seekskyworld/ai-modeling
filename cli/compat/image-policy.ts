/** 对齐官方图片字段联动：被官方忽略的跨模型选项也明确告警后移除，不误称网页生效。 */
import { TripoError } from '../../studio/contracts/errors.ts';

/** 官方 template 两端的角色不同；网页额外模板可经原生 template_name 入口调用。 */
export function validateImageTemplate(input: Record<string, unknown>, editing: boolean): void {
  const value = input.template;
  if (value === undefined) return;
  const templates = ['character_completion', 't_pose', 'variants', 'figure'];
  templates.push(editing ? '3d_enhance' : 'asset_extraction');
  if (typeof value !== 'string' || !templates.includes(value))
    throw new TripoError(
      'INVALID_INPUT',
      `${editing ? 'image-to-image' : 'text-to-image'} template must be one of ${templates.join('/')}.`,
      'not_submitted',
    );
}

/** edit-base 只改变主图角色，仍计入官方参考图总数，不能借分开字段多提交一张。 */
export function validateImageReferenceCount(inputs: string[], model: string, editing: boolean): void {
  if (!editing) return;
  const maximum = model.startsWith('gemini_') ? 10 : 16;
  if (inputs.length < 1 || inputs.length > maximum)
    throw new TripoError(
      'INVALID_INPUT',
      `Image editing requires between 1 and ${maximum} reference images, including the primary image.`,
      'not_submitted',
    );
}

export function applyImagePolicy(input: Record<string, unknown>, model: string): string[] {
  const warnings: string[] = [];
  const remove = (key: string, explanation: string): void => {
    if (input[key] === undefined) return;
    delete input[key];
    warnings.push(`${key} ${explanation} (removed, matching the official CLI).`);
  };
  const chat25 = model === 'gpt_image_2.5_sunburst';
  // Studio 扩展的 scale 保持网页含义；只调整官方 aspect_ratio 参数。
  if (model.startsWith('gpt_'))
    remove('aspect_ratio', 'only applies to banana models; set size or describe the shape in the prompt');
  if (!model.startsWith('seedream')) remove('watermark', 'only applies to Seedream models');
  if (model !== 'gpt_image_2' && !chat25) remove('quality', 'only applies to GPT Image 2 and 2.5 models');
  if (!chat25) remove('background', 'is ignored outside GPT Image 2.5 models');
  return warnings;
}
