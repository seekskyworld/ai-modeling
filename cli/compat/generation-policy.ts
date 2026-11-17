/** 官方生成联动在兼容层归一化；网页原生入口仍可表达它自己的能力与参数。 */
import { text, TripoError } from '../../studio/contracts/errors.ts';

function removeInactiveImageAlignment(input: Record<string, unknown>, warnings: string[]): void {
  if (input.orientation !== 'align_image' || !['image', 'multiview'].includes(text(input.mode))) return;
  delete input.orientation;
  warnings.push(
    'orientation=align_image has no effect with texture=false (removed, matching the official contract); image viewpoint alignment is not requested.',
  );
}

export function validateTextureQuality(value: unknown): void {
  // 官方即使最终关闭贴图也会校验质量；先检查再清理无作用字段，避免拼写错误变成收费建模。
  // 必须先检查调用者原值，再把 extreme 转为网页 ultra；原生网页枚举不是官方 CLI 别名。
  if (
    value !== undefined &&
    (typeof value !== 'string' || !['fast', 'standard', 'detailed', 'extreme'].includes(value))
  )
    throw new TripoError(
      'INVALID_INPUT',
      'texture_quality must be one of fast/standard/detailed/extreme.',
      'not_submitted',
    );
}

export function adjustGeneration(input: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  // 官方 default 表示不请求图片视角对齐，对应网页普通生成；align_image 仍须有真实映射。
  if (input.orientation === 'default' && ['image', 'multiview'].includes(text(input.mode))) {
    delete input.orientation;
    warnings.push('orientation=default uses the normal Studio generation orientation.');
  }
  const version = text(input.model_version);
  const forbidden = version.startsWith('Nexus-v1')
    ? ['quad', 'smart_poly', 'generate_parts', 'geometry_quality']
    : version.startsWith('Nexus-v2')
      ? ['smart_poly', 'generate_parts', 'geometry_quality']
      : version.startsWith('v2.5')
        ? ['geometry_quality', 'quad', 'smart_poly', 'generate_parts', 'auto_size', 'compress']
        : [];
  for (const key of forbidden) {
    if (input[key] !== undefined)
      warnings.push(`${version} does not support ${key} in the official CLI contract (removed).`);
    delete input[key];
  }
  // false 是关闭现实尺寸估计，网页原生单位尺度无需额外操作；true 不能用手动缩放冒充。
  if (input.auto_size === false) {
    delete input.auto_size;
    warnings.push(
      'auto_size=false keeps the native Studio scale without requesting real-world size estimation.',
    );
  }
  if (input.generate_parts === true && input.smart_poly === true)
    throw new TripoError('INVALID_INPUT', 'generate_parts and smart_low_poly are mutually exclusive.');
  if (input.pbr === true && input.texture === false) {
    input.texture = true;
    warnings.push('pbr=true forces texture=true (adjusted).');
  }
  if (input.generate_parts === true) {
    for (const key of ['texture', 'pbr', 'quad']) {
      if (input[key] !== false) warnings.push(`generate_parts=true disables ${key} (adjusted).`);
      input[key] = false;
    }
  }
  if (input.texture === false) {
    // 官方 H/P 图片及多视图生成文档明确：align_image 只在有贴图时生效。
    // 必须在 PBR/parts 联动之后判断，避免 PBR 把贴图重新开启后仍丢掉有效朝向要求。
    removeInactiveImageAlignment(input, warnings);
    for (const key of ['texture_quality', 'texture_alignment', 'delight']) {
      if (input[key] !== undefined) warnings.push(`${key} has no effect with texture=false (removed).`);
      delete input[key];
    }
  }
  return warnings;
}
