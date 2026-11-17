/** P 系列网页分支只生成几何；HD-only 设置不能透传后宣称已生效。 */
import { text, TripoError } from './errors.ts';

export const isPSeries = (input: Record<string, unknown>): boolean =>
  /^Nexus-v[12]\./.test(text(input.model_version));

export function validatePSeriesGeometry(input: Record<string, unknown>): void {
  if (!isPSeries(input)) return;
  const unavailable = ['smart_poly', 'generate_parts', 'enable_image_autofix'].filter(
    (key) => input[key] === true,
  );
  if (input.model_version === 'Nexus-v1.0-20260214' && input.quad === true) unavailable.push('quad');
  if (unavailable.length)
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      `Studio P-series generation has no verified mapping for ${unavailable.join(', ')}. Choose an HD model for these settings.`,
      'not_submitted',
    );
}

/** 兼容 CLI 会显式拆分贴图；原生单任务入口不能把 texture=true 静默变成白模。 */
export function validateModelSubmission(input: Record<string, unknown>): void {
  validatePSeriesGeometry(input);
  if (isPSeries(input) && (input.texture === true || input.pbr === true || input.texture_seed !== undefined))
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      'Studio P-series generates geometry only. Use generate *-to-model for the resumable geometry → texture/PBR chain, or submit bare geometry and texture the resulting project separately.',
      'not_submitted',
    );
}
