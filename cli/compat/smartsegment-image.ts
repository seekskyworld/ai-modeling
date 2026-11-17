/** 图片智能分割复用网页 Generate Parts；返回的是规范化分割预览，不伪造官方内部任务或部件标签。 */
import path from 'node:path';
import { z } from 'zod';
import { TripoError } from '../../studio/contracts/errors.ts';
import type { JobStore } from '../storage/jobs.ts';
import type { Plan } from './planning.ts';

const imageOptions = z
  .object({
    seg_type: z.literal('image').optional(),
    granularity: z.enum(['coarse', 'medium', 'fine']).default('medium'),
    hint: z.string().optional(),
    transform: z.unknown().optional(),
  })
  .strict();

export function isImageSmartSegment(source: string, input: Record<string, unknown>): boolean {
  if (input.seg_type !== undefined && input.seg_type !== 'image' && input.seg_type !== 'model')
    throw new TripoError('INVALID_INPUT', 'seg_type must be image or model.', 'not_submitted');
  if (input.seg_type !== undefined) return input.seg_type === 'image';
  const pathname = /^https?:\/\//i.test(source) ? new URL(source).pathname : source;
  return (
    /^(studio_file_image_)/i.test(source) ||
    ['.png', '.jpg', '.jpeg', '.webp'].includes(path.extname(pathname).toLowerCase())
  );
}

export function smartSegmentImageOptions(input: Record<string, unknown>): {
  granularity: 'coarse' | 'medium' | 'fine';
  hint?: string;
} {
  const options = imageOptions.parse(input);
  if (options.transform !== undefined)
    throw new TripoError('INVALID_INPUT', 'transform only applies to seg_type=model.', 'not_submitted');
  const hint = options.hint?.trim() || undefined;
  if (hint && Array.from(hint).length > 1000)
    throw new TripoError(
      'INVALID_INPUT',
      'Studio segmentation hints must be at most 1000 Unicode characters.',
      'not_submitted',
    );
  return { granularity: options.granularity, ...(hint ? { hint } : {}) };
}

export function smartSegmentImageParameters(input: Record<string, unknown>): Record<string, unknown> {
  const options = smartSegmentImageOptions(input);
  return {
    mode: 'image',
    model_version: 'v3.1-20260211',
    texture: false,
    pbr: false,
    quad: false,
    generate_parts: !options.hint,
    // 有提示时第一步只建白模；粒度属于第二步 REST 分割，不能误传给已关闭的 Generate Parts。
    ...(!options.hint ? { generate_parts_level: options.granularity } : {}),
  };
}

export const smartSegmentImageWarning =
  'Image smartsegment returns a segmented GLB plus a normalized segmentation-preview PNG. The preview is not guaranteed to align with original-image pixels. Studio does not return semantic part-label text or the official internal model_task_id/seg_task_id; these are not synthesized.';
export const smartSegmentImageHintWarning =
  'An image hint creates an untextured H3.1 model and then performs a separately billed v2 segmentation at the selected coarse, medium or fine granularity. Both task receipts are retained; retry with the original request_id to resume. Hints and granularity guide the service and do not guarantee exact part counts or a finer split on every model.';

/** 两个付费步骤在第一步前冻结完整提示意图；中断后不能沿用建模回执偷偷换分割提示。 */
export function freezeSmartSegmentImage(jobs: JobStore, account: string, plan: Plan, request: string): void {
  const key = `smartsegment-image:${request}`,
    saved = jobs.requestPolicy(account, key);
  if (!plan.smartSegmentImage) {
    if (saved)
      throw new TripoError(
        'IDEMPOTENCY_CONFLICT',
        'The original request included an image smartsegment hint pipeline.',
        'not_submitted',
      );
    return;
  }
  if (!saved && jobs.find(account, `${request}-0`))
    throw new TripoError(
      'IDEMPOTENCY_CONFLICT',
      'An existing request cannot be extended with a new image smartsegment hint pipeline.',
      'not_submitted',
    );
  jobs.bindRequestPolicy(account, key, { version: 1, ...plan.smartSegmentImage });
}
