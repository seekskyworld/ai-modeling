/** 完整处理链的文件预检供所有CLI和MCP入口共用，避免先导入付费再发现末尾缺文件。 */
import { readInput, readModelInput } from '../../studio/files.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import type { Plan } from './planning.ts';

/** Lab 的上传由专门执行器编排，离线预检收集调用方指定的两个原件。 */
function collectLabReferenceFiles(plan: Plan, files: Map<string, boolean>): void {
  if (!plan.labReferenceEdit) return;
  for (const [reference, model] of [
    [plan.labReferenceEdit.source, true],
    [plan.labReferenceEdit.reference, false],
  ] as const)
    if (!/^@|^[a-f\d]{8}-[a-f\d-]{27}$/i.test(reference)) files.set(reference, model);
}

/** 只读本机文件，无认证、下载或上传；远程 URL 与上传句柄在实际执行时再次校验。 */
export async function validatePlanFiles(plan: Plan): Promise<string[]> {
  const files = new Map<string, boolean>();
  collectLabReferenceFiles(plan, files);
  for (const step of plan.steps) {
    if (Array.isArray(step.parameters.image_sources))
      for (const source of step.parameters.image_sources)
        if (source && typeof source === 'object' && typeof source.image_path === 'string')
          files.set(source.image_path, false);
    for (const key of ['image_path', 'image_paths', 'style_image_path', 'model_path']) {
      if (key === 'model_path' && step.uvImportFromChain) continue;
      const value = step.parameters[key];
      for (const file of Array.isArray(value) ? value : [value])
        if (typeof file === 'string' && file) files.set(file, key === 'model_path');
    }
  }
  for (const [file, model] of files) {
    if (/^(https?:\/\/|studio_file_)/i.test(file)) continue;
    try {
      if (model) await readModelInput(file, []);
      else await readInput(file, []);
    } catch (error) {
      if (error instanceof TripoError) throw error;
      throw new TripoError('INVALID_INPUT', `Input file is not readable: ${file}`);
    }
  }
  return [...files.keys()];
}
