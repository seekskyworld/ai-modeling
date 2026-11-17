/** 官方文档声明的导出默认值延迟到首次提交解析，避免升级改变已登记的任务/计划指纹。 */
import type { Job } from '../../studio/contracts/types.ts';

export type ExportDefaultField =
  'with_animation' | 'texture_size' | 'animate_in_place' | 'export_orientation' | 'texture_format';
const defaults = { texture_size: 4096, animate_in_place: false, export_orientation: '+x' } as const;

/** 动画和 JPEG 由独立来源预检决定；此处恢复旧实际编码，不把新默认补到旧任务。 */
export function applyExportDefaultValues(
  parameters: Record<string, unknown>,
  fields: readonly ExportDefaultField[] | undefined,
  existing?: Pick<Job, 'operation' | 'input'>,
): void {
  if (!fields) return;
  const restored = existing?.operation === 'export' && existing.input.project_id === parameters.project_id;
  if (restored && fields.includes('texture_format')) {
    if (Object.hasOwn(existing.input, 'texture_format'))
      parameters.texture_format = existing.input.texture_format;
    else delete parameters.texture_format;
  }
  for (const key of Object.keys(defaults) as Array<keyof typeof defaults>) {
    if (!fields.includes(key)) continue;
    if (restored) {
      if (Object.hasOwn(existing.input, key)) parameters[key] = existing.input[key];
      else delete parameters[key];
    } else if (parameters.bake !== false) parameters[key] = defaults[key];
  }
}
