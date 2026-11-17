/** 重生成继承原资产的收费参数，不能由调用方省略数量或伪报模型降低报价。 */
import type { StudioClient } from './client.ts';
import type { Operation } from '../contracts/types.ts';
import { object, text, TripoError } from '../contracts/errors.ts';
import { prepareCanvasRun } from './canvas-run.ts';
import { validateModelSubmission } from '../contracts/model-policy.ts';

export async function prepareInput(
  client: StudioClient,
  operation: Operation,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (operation === 'model') validateModelSubmission(input);
  if (operation === 'canvas_run') return await prepareCanvasRun(client, input);
  if (operation !== 'image_process' || !['regenerate', 'regenerate_multiview'].includes(text(input.action)))
    return input;
  const asset = object(
    await client.request('POST', '/v2/studio/image/get_image_asset', { asset_id: input.asset_id }),
  );
  if (asset.asset_id !== input.asset_id)
    throw new TripoError('CONTRACT_CHANGED', 'Original image identity mismatch.');
  const original = object(asset.input);
  if (input.action === 'regenerate_multiview') {
    if (asset.type !== 'multiview_images')
      throw new TripoError('INVALID_INPUT', 'regenerate_multiview requires a multiview image asset.');
    if (input.model_version)
      throw new TripoError(
        'STUDIO_CAPABILITY_UNAVAILABLE',
        'The website multiview engine has no model override.',
      );
    // 真实多视图资产返回 amount=0、空模型/分辨率；网页重生成计一次多视图任务。
    return {
      ...input,
      _image_source: {
        kind: 'multiview',
        amount: 1,
        source_amount: original.amount,
        model_version: original.model_version,
        resolution: original.resolution,
      },
    };
  }
  if (asset.type === 'multiview_images')
    throw new TripoError('INVALID_INPUT', 'Use regenerate_multiview for a multiview asset.');
  const model = text(original.model_version);
  if (input.model_version && input.model_version !== model)
    throw new TripoError('INVALID_INPUT', 'model_version differs from the original image.');
  const amount = original.amount;
  const resolution = text(original.resolution);
  if (
    !model ||
    !Number.isInteger(amount) ||
    Number(amount) < 1 ||
    Number(amount) > 4 ||
    !['1K', '2K', '4K'].includes(resolution)
  )
    throw new TripoError(
      'PRICE_UNKNOWN',
      'Original image has incomplete model, amount or resolution metadata.',
    );
  return { ...input, _image_source: { model_version: model, amount, resolution } };
}
