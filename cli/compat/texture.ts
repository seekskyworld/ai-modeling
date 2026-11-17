/** 官方 texture_prompt 的多视图键转为网页固定槽；风格图不得冒充内容图。 */
import path from 'node:path';
import { homedir } from 'node:os';
import { object, text, TripoError } from '../../studio/contracts/errors.ts';
type Input = Record<string, unknown>;

/** 引擎别名与种子不提供超出网页实际表现的保证，CLI 和 MCP 使用同一警告。 */
export function textureWarnings(input: Input, model: unknown): string[] {
  const warnings: string[] = [];
  if (['v3.5', 'v3.5-20260815'].includes(String(model)))
    warnings.push(
      'The native texture operator must report v3.5-20260815 before this task is reported successful.',
    );
  else if (model)
    warnings.push(
      'Studio selects its current texture engine (observed v3.5); the API model version is not pinned by this alias.',
    );
  if (input.texture_seed !== undefined)
    warnings.push(
      'Studio accepts and stores texture_seed, but live repeats with the same seed produced different textures; deterministic reproduction is not verified.',
    );
  return warnings;
}
const views = ['front', 'left', 'back', 'right'];
function imagePath(value: unknown): string {
  const ref = object(value);
  const raw = typeof value === 'string' ? value : text(ref.url) || text(ref.file_token);
  if (!raw || Object.keys(ref).some((key) => !['url', 'file_token', 'type'].includes(key)))
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      'Use an image file, URL or this account’s Studio upload handle; API object keys are not Studio references.',
    );
  return /^(https?:\/\/|studio_file_)/i.test(raw)
    ? raw
    : path.resolve(raw.startsWith('~/') ? path.join(homedir(), raw.slice(2)) : raw);
}
function viewImages(value: unknown): (string | null)[] {
  if (!Array.isArray(value)) throw new TripoError('INVALID_INPUT', 'texture images must be an array.');
  const keyed = value.some((v) => Object.keys(object(v)).some((k) => views.includes(k)));
  if (!keyed) return value.map((v) => (v == null ? null : imagePath(v)));
  const result: (string | null)[] = [null, null, null, null];
  for (const entry of value) {
    const item = object(entry),
      keys = Object.keys(item).filter((k) => views.includes(k));
    if (keys.length !== 1 || Object.keys(item).some((k) => k !== 'type' && !views.includes(k)))
      throw new TripoError(
        'INVALID_INPUT',
        'Each texture image needs exactly one front/left/back/right key.',
      );
    const index = views.indexOf(keys[0]!);
    if (result[index]) throw new TripoError('INVALID_INPUT', `Duplicate texture view: ${keys[0]}.`);
    result[index] = imagePath(item[keys[0]!]);
  }
  return result;
}
function set(input: Input, key: string, value: unknown): void {
  if (input[key] !== undefined)
    throw new TripoError('INVALID_INPUT', `Texture guidance ${key} was provided twice.`);
  input[key] = value;
}
/** 不支持的模型参数继续由严格领域 schema 拒绝，不能丢弃后伪装已映射。 */
export function normalizeTextureGuidance(input: Input): void {
  const guide = input.texture_prompt;
  delete input.texture_prompt;
  if (typeof guide === 'string') set(input, 'prompt', guide);
  else if (guide !== undefined) {
    if (!guide || typeof guide !== 'object' || Array.isArray(guide))
      throw new TripoError('INVALID_INPUT', 'texture_prompt must be text or a guidance object.');
    for (const [key, value] of Object.entries(object(guide))) {
      const target = key === 'text' ? 'prompt' : key;
      if (!['text', 'image', 'images', 'style_image'].includes(key))
        throw new TripoError(
          'STUDIO_CAPABILITY_UNAVAILABLE',
          `No verified Studio texture mapping for ${key}.`,
        );
      set(input, target, value);
    }
  }
  for (const [source, target] of [
    ['image', 'image_path'],
    ['style_image', 'style_image_path'],
  ] as const) {
    if (input[source] !== undefined) {
      set(input, target, imagePath(input[source]));
      delete input[source];
    }
  }
  if (input.images !== undefined) {
    set(input, 'image_paths', viewImages(input.images));
    delete input.images;
  }
}
