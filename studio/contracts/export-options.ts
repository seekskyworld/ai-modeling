/** 这些参数尚无已验证的独立导出请求映射；CLI 明确加工文件，不将未知接口写成不存在。 */
import { z } from 'zod';

export const localExportFields = {
  part_names: z
    .array(z.string().min(1).max(200))
    .min(1)
    .max(200)
    .optional()
    .describe('Keep only these exact mesh/node names from the exported GLB, using local processing.'),
  texture_format: z
    .enum(['BMP', 'DPX', 'HDR', 'JPEG', 'OPEN_EXR', 'PNG', 'TARGA', 'TIFF', 'WEBP'])
    .optional()
    .describe('Local texture encoding: OBJ/FBX support all listed formats; GLB PNG/JPEG/WEBP; USDZ PNG.'),
};

/** 不把不能承载贴图的容器或未验证的编码组合记为成功。 */
export function supportsExportTexture(input: { format: string; texture_format?: string }): boolean {
  if (!input.texture_format) return true;
  if (['obj', 'fbx'].includes(input.format)) return true;
  if (input.format === 'glb') return ['PNG', 'JPEG', 'WEBP'].includes(input.texture_format);
  return input.format === 'usdz' && input.texture_format === 'PNG';
}
export function needsExportTransform(input: Record<string, unknown>): boolean {
  return (
    (input.scale_factor !== undefined && input.scale_factor !== 1) ||
    (input.pivot_to_center_bottom === true && !nativeUnbakedPivot(input)) ||
    input.flatten_bottom === true ||
    (Array.isArray(input.part_names) && input.part_names.length > 0) ||
    input.texture_format !== undefined
  );
}
/** 显式静态不烘焙请求可核对原生默认底部中心；未填/false绝不能被自动改成true。 */
export function nativeUnbakedPivot(input: Record<string, unknown>): boolean {
  return input.bake === false && input.pivot_to_center_bottom === true;
}
export function transformedExportFormat(input: Record<string, unknown>): string {
  return input.format === 'obj' ||
    (input.texture_packaging === 'zip' && ['glb', 'fbx'].includes(String(input.format)))
    ? 'zip'
    : String(input.format);
}
