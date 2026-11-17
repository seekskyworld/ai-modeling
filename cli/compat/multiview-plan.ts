/** 官方逐视图编辑编译为独立网页图片编辑；四槽组合由 CLI 持久化，并非新的网页任务类型。 */
import { multiviewNames, multiviewPrompts } from '../core/multiview-bundle.ts';
import { normalize } from '../../studio/contracts/schemas.ts';
import { object, text, TripoError } from '../../studio/contracts/errors.ts';
import type { Plan, Flags } from './planning.ts';

export const multiviewEditWarning =
  'edit-multiview uses one native Studio image edit per requested view, with separate receipts and website charges. A local four-view composition retains untouched views; it is not an atomic remote task.';

export function editMultiviewPlan(input: string, flags: Flags): Plan {
  if (!/^@|^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(input))
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      'Use a successful Studio four-view task or asset. Arbitrary sheet URLs/file tokens have no verified view layout.',
      'not_submitted',
    );
  const parameters = object(flags.param);
  if (Object.keys(parameters).some((key) => key !== 'prompts') || flags.model)
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      'edit-multiview supports per-view prompts with the website image-edit engine; additional API options have no verified mapping.',
      'not_submitted',
    );
  const prompts = multiviewPrompts.parse(parameters.prompts);
  const model = 'flux.1_kontext_pro';
  return {
    multiviewEdit: { source: input, prompts, model },
    pending_uploads: [],
    warnings: [multiviewEditWarning],
    steps: prompts.map((item) => ({
      name: `edit-${item.view}`,
      operation: 'image',
      source: input,
      parameters: normalize('image', {
        prompt: text(item.prompt),
        model_version: model,
        amount: 1,
        image_asset: { asset_id: 'upstream', output_index: multiviewNames.indexOf(item.view) },
      }),
    })),
  };
}
