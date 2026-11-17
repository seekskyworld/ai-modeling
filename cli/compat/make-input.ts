/** make 的输入分类必须先于生成规划，避免把任务ID、不支持的素材或拼错路径当成付费提示词。 */
import { statSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { TripoError } from '../../studio/contracts/errors.ts';

type InputKind = 'text' | 'image' | 'model' | 'reference';
export interface MakeInputs {
  kind: InputKind | 'multiview';
  values: string[];
}
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const modelExtensions = new Set(['.glb', '.gltf', '.fbx', '.obj', '.stl']);
const officialImagesWithoutWebMapping = new Set(['.bmp', '.tiff', '.tif']);

function invalid(message: string): never {
  throw new TripoError('INVALID_INPUT', message, 'not_submitted');
}
function localFile(value: string): boolean {
  const expanded = value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value;
  try {
    const state = statSync(expanded);
    if (!state.isFile()) invalid('make input exists but is not a regular file.');
    return true;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code))) return false;
    if (error instanceof TripoError) throw error;
    invalid('Cannot inspect the make input file.');
  }
}
function extensionKind(extension: string): InputKind | undefined {
  if (imageExtensions.has(extension)) return 'image';
  if (modelExtensions.has(extension)) return 'model';
  if (officialImagesWithoutWebMapping.has(extension))
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      'Studio image inputs support PNG/JPEG/WEBP. Convert this BMP/TIFF file explicitly before using make.',
      'not_submitted',
    );
}
function classifyOne(value: string): InputKind {
  if (/^file_[A-Za-z0-9_-]+$/.test(value))
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      'Official API file tokens are not Studio upload handles. Use files upload with this CLI.',
      'not_submitted',
    );
  if (/^@|^task_[A-Za-z0-9_-]+$|^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value)) return 'reference';
  if (value.startsWith('studio_file_image_')) return 'image';
  if (value.startsWith('studio_file_model_')) return 'model';
  if (value.startsWith('studio_file_')) invalid('Unknown Studio upload handle type.');
  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      invalid('Use a valid HTTP(S) input URL.');
    }
    if (url.username || url.password) invalid('Input URLs must not embed credentials.');
    return extensionKind(path.extname(url.pathname).toLowerCase()) ?? 'image';
  }
  const kind = extensionKind(path.extname(value).toLowerCase());
  if (kind) return kind;
  if (localFile(value)) invalid('The existing file has no supported Studio image or model extension.');
  // 显式路径前缀可含空格；普通带空格的自然语言仍保留为提示词。
  if (/^(?:\.?\.?\/|~\/|[A-Za-z]:[\\/])/.test(value) || (!/\s/.test(value) && /[\\/]/.test(value)))
    invalid('Input path does not exist or uses an unsupported format.');
  return 'text';
}

/** 只读分类；支持格式的本机文件字节仍由提交前统一文件验证，URL与上传句柄不在此联网。 */
export function classifyMakeInputs(inputs: string[]): MakeInputs {
  const values = inputs.map((value) => value.trim());
  if (!values.length || values.some((value) => !value)) invalid('Supply nonempty make inputs.');
  const kinds = values.map(classifyOne);
  const first = kinds[0]!;
  if (kinds.some((kind) => kind !== first)) invalid('Mixed input types are not supported by make.');
  if (first === 'reference' || first === 'model') {
    if (values.length !== 1) invalid('Use one model or task reference per make command.');
    return { kind: first, values };
  }
  if (first === 'image') {
    if (values.length > 4) invalid('Multiview make requires two to four images.');
    return { kind: values.length === 1 ? 'image' : 'multiview', values };
  }
  return { kind: 'text', values: inputs };
}
