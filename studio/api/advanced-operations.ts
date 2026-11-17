/** 高级创作请求只使用已核对的网页字段；文件上传与最终提交分开。 */
import { encode } from '@msgpack/msgpack';
import { localEditBody } from './mesh-defaults.ts';
import { metadataBody } from './metadata.ts';
import { object, text, array, TripoError } from '../contracts/errors.ts';
import { readModelInput } from '../files.ts';
import { segmentationInput } from '../segmentation.ts';
import { decodeLabels } from '../contracts/segmentation.ts';
import { isFileToken, loadUpload } from '../auth/uploads.ts';
import { uploadFile } from './upload.ts';
import type { ImageReference } from './upload.ts';
import type { StudioClient } from './client.ts';
import type { Job } from '../contracts/types.ts';
import type { Submission } from './operations.ts';
export interface AdvancedContext {
  client: StudioClient;
  roots: string[];
  imageReference: (input: Record<string, unknown>, file?: string) => Promise<ImageReference>;
}
const operation = (name: string, body: Record<string, unknown>): Submission => ({
  route: `/v2/studio/operation/${name}`,
  body,
});
const pick = (input: Record<string, unknown>, keys: string[]): Record<string, unknown> =>
  Object.fromEntries(keys.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]));
/** 网页传的是每个三角面的 Uint8 标签；MessagePack 数组与 bin 不同，必须保持二进制契约。 */
export function modificationBytes(input: Record<string, unknown>): Buffer {
  const indices = Object.fromEntries(
    Object.entries(object(input.part_indices)).map(([name, labels]) => [
      name,
      Uint8Array.from(array(labels).map(Number)),
    ]),
  );
  return Buffer.from(encode({ part_indices: indices, part_indices_name: input.part_indices_name }));
}
export async function modificationFile(input: Record<string, unknown>, roots: string[]): Promise<Buffer> {
  if (!input.indices_path) return modificationBytes(input);
  const { state } = await segmentationInput(input, roots);
  const indices = Object.fromEntries(
    Object.entries(state.part_indices).map(([name, labels]) => [
      name,
      decodeLabels(labels, state.signature[name]!.faces),
    ]),
  );
  const used = new Set(Object.values(indices).flatMap((values) => [...new Set(values)]));
  const names = Object.fromEntries([...used].map((label) => [label, state.snapshot.part_names[label]]));
  return Buffer.from(encode({ part_indices: indices, part_indices_name: names }));
}
export async function advancedOperation(job: Job, context: AdvancedContext): Promise<Submission | undefined> {
  const x = job.input;
  switch (job.operation) {
    case 'project_edit':
      return operation('meta_modification', await metadataBody(context.client, x));
    case 'modification':
      return operation('modification', {
        project_id: x.project_id,
        model_version: 'default',
        modification_type: 'apply_indices',
        modification_params: {
          msgpack_binary_file: await uploadFile(
            context.client,
            await modificationFile(x, context.roots),
            'msgpack',
          ),
        },
      });
    case 'retry':
      return operation(`free-retry/${x.project_id}`, {});
    case 'remesh':
      return operation('remesh', {
        model_version: 'default',
        ...pick(x, ['project_id', 'face_limit', 'quad', 'smart_poly', 'part_name_list', 'bake']),
      });
    case 'segment':
    case 'resegment':
      return operation(
        job.operation === 'resegment' ? 'ai_segmentation/resegment' : 'ai_segmentation',
        pick(x, ['project_id', 'model_version', 'segmentation_granularity', 'prompt', 'operator_id']),
      );
    case 'complete':
      return operation(x.completion_mode === 'quick_cap' ? 'mesh_fill' : 'ai_completion', {
        project_id: x.project_id,
        part_names: x.part_names,
        model_version: x.completion_mode === 'quick_cap' ? 'default' : 'v1.0-20250506',
      });
    case 'local_edit':
      return operation('local_edit', await localEditBody(context.client, x));
    case 'uv_generate':
      return operation('uv_edit/generate', pick(x, ['project_id', 'current_operator_id', 'action']));
    case 'uv_commit':
      return operation(
        'uv_edit/apply',
        pick(x, ['project_id', 'current_operator_id', 'candidate_operator_id']),
      );
    case 'copy':
      return operation('save_as_new', pick(x, ['project_id', 'operator_id']));
    case 'motion':
      return { route: '/v2/studio/motion/generate', body: { segments: x.segments } };
    case 'retexture':
      return operation('retexture_generate', {
        ...pick(x, ['project_id', 'prompt', 'camera_matrix', 'strength']),
        model_version: 'v3.0-20250812',
        render_image: await context.imageReference(x),
      });
    case 'retexture_apply':
      return operation('apply_retexture', {
        project_id: x.project_id,
        model_version: 'v3.0-20250812',
        image_map: await Promise.all(
          array(x.image_map).map(async (row) => ({
            part_name: object(row).part_name,
            image: await context.imageReference(x, text(object(row).image_path)),
          })),
        ),
      });
    case 'import_model':
      return await importModel(x, context);
    case 'image_process':
      return await processImage(x, context);
    default:
      return undefined;
  }
}
async function importModel(input: Record<string, unknown>, context: AdvancedContext): Promise<Submission> {
  const file = await readModelInput(text(input.model_path), context.roots);
  if (object(input._input_files)[text(input.model_path)] !== file.sha256)
    throw new TripoError('INPUT_CHANGED', 'Model changed after preparation.', 'not_submitted');
  return operation('import_user_model', {
    ...pick(input, ['name', 'transform_matrix', 'use_original_uv']),
    format: file.format === 'gltf' ? 'glb' : file.format,
    model: isFileToken(text(input.model_path))
      ? loadUpload(text(input.model_path), context.client.credentials.load()?.accountRef ?? '').reference
      : await uploadFile(context.client, file.bytes, file.format),
  });
}
async function processImage(input: Record<string, unknown>, context: AdvancedContext): Promise<Submission> {
  if (input.image_path)
    return {
      route: '/v2/studio/image/gen_multiview',
      body: { if_upload: true, image: await context.imageReference(input) },
    };
  const asset = object(
    await context.client.request('POST', '/v2/studio/image/get_image_asset', { asset_id: input.asset_id }),
  );
  if (asset.asset_id !== input.asset_id)
    throw new TripoError('CONTRACT_CHANGED', 'Original image identity mismatch.');
  const action = text(input.action);
  if (action === 'regenerate' || action === 'regenerate_multiview') {
    if (!['success', 'failed'].includes(text(asset.status)))
      throw new TripoError('INPUT_NOT_READY', 'Wait for the original image task to finish.');
    const original = object(asset.input);
    const quoted = object(input._image_source);
    const expected = action === 'regenerate_multiview' ? { ...quoted, amount: quoted.source_amount } : quoted;
    if (['model_version', 'amount', 'resolution'].some((key) => original[key] !== expected[key]))
      throw new TripoError('INPUT_CHANGED', 'Original image pricing parameters changed after preparation.');
    return {
      route: `/v2/studio/image/${action === 'regenerate' ? 're_gen_image' : 're_gen_multiview'}`,
      body: { asset_id: input.asset_id },
    };
  }
  if (asset.status !== 'success') throw new TripoError('INPUT_NOT_READY', 'Image asset must be complete.');
  const image = object(array(object(asset.output).data)[Number(input.output_index)]);
  if (!text(image.key)) throw new TripoError('INVALID_INPUT', 'Image output does not exist.');
  if (action === 'multiview')
    return {
      route: '/v2/studio/image/gen_multiview',
      body: {
        if_upload: true,
        image: await context.imageReference({
          ...input,
          image_asset: { asset_id: input.asset_id, output_index: input.output_index },
        }),
      },
    };
  return { route: `/v2/studio/image/${action}`, body: { asset_id: input.asset_id, resource_key: image.key } };
}
