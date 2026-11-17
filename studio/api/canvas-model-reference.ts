/** 对齐网页 QM/YM/ZM：Canvas 模型素材先定位确切项目版本，再读取生成或纹理参考来源。 */
import { object, text, TripoError } from '../contracts/errors.ts';
import { CanvasClient } from './canvas-client.ts';
import type { StudioClient } from './client.ts';

export interface ModelReference {
  mode: 'image' | 'multiview' | 'text' | 'none';
  images: (Record<string, unknown> | null)[];
  prompt?: string;
}
const views = ['front', 'left', 'back', 'right'];
function contract(message: string): never {
  throw new TripoError('CONTRACT_CHANGED', message);
}
function image(value: unknown, view?: string): Record<string, unknown> | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) contract('Invalid model reference image.');
  const x = object(value);
  for (const key of ['bucket', 'key'])
    if (x[key] !== undefined && typeof x[key] !== 'string') contract('Invalid model image storage identity.');
  if (x.image_source !== undefined && !['upload', 'generate'].includes(text(x.image_source)))
    contract('Unknown model reference image source.');
  if (
    x.image_audit_result !== undefined &&
    !['pass', 'sensitive', 'nsfw', 'reject'].includes(text(x.image_audit_result))
  )
    contract('Unknown model reference image audit result.');
  const result: Record<string, unknown> = {};
  for (const key of ['bucket', 'key', 'image_source', 'image_audit_result'])
    if (x[key] !== undefined) result[key] = x[key];
  if (view) result.view = view;
  return result;
}
function source(value: unknown, promptField: string): ModelReference | null {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) contract('Invalid model reference parameters.');
  const x = object(value);
  const references = x.generate_image_object;
  if (references != null && !Array.isArray(references)) contract('Invalid model reference image list.');
  if (Array.isArray(references) && references.length) {
    if (references.length > 4) contract('Model reference has more than four source views.');
    const multi = references.length > 1;
    return {
      mode: multi ? 'multiview' : 'image',
      images: references.map((entry, index) => image(entry, multi ? views[index] : undefined)),
    };
  }
  const prompt = x[promptField];
  if (prompt != null && typeof prompt !== 'string') contract('Invalid model reference prompt.');
  return typeof prompt === 'string' && prompt.trim() ? { mode: 'text', images: [], prompt } : null;
}

export function parseModelReference(value: unknown, projectId: string, operatorId: string): ModelReference {
  const project = object(value);
  const operator = object(project.operator);
  if (project.id !== projectId || operator.operator_id !== operatorId)
    contract('Model reference belongs to a different project or historical version.');
  const textured =
    operator.texture_generation == null ? null : source(operator.texture_generation, 'prompt_text');
  return (
    textured ??
    source(
      operator.image_to_model ??
        operator.multiview_to_model ??
        operator.image_prompt_to_model ??
        operator.text_to_model,
      'prompt',
    ) ?? { mode: 'none', images: [] }
  );
}

/** 网页 DS 只继承单图，不能把多视图第一张或文字提示伪装成同一参考。 */
export function singleModelImage(reference: ModelReference): Record<string, unknown> | null {
  if (reference.mode !== 'image' || reference.images.length !== 1) return null;
  const image = reference.images[0];
  if (!text(image?.bucket).trim() || !text(image?.key).trim()) return null;
  const result = { ...image };
  delete result.view;
  delete result.url;
  return result;
}

export async function readCanvasModelReference(studio: StudioClient, assetId: string) {
  const response = object(
    await new CanvasClient(studio).call('/tripo.canvas.api.agent.NodeService/GetNodeAssetDetail', {
      assetId,
    }),
  );
  if (response.assetId !== assetId || response.provider !== 'studio')
    contract('Canvas model reference returned a different asset or provider.');
  const detail = object(response.detail);
  const projectId = text(detail.id),
    operatorId = text(detail.operator_id);
  if (!projectId.trim() || !operatorId.trim()) return null;
  const project = await studio.request(
    'GET',
    `/v2/studio/project/detail/v3/${encodeURIComponent(projectId)}?operator_id=${encodeURIComponent(operatorId)}`,
  );
  studio.credentials.load();
  return {
    source_project_id: projectId,
    source_operator_id: operatorId,
    ...parseModelReference(project, projectId, operatorId),
  };
}
