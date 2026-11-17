/** 输出编码属于网页 Canvas 的交付能力；独立冻结，不能改变收费生成请求或复用另一格式的意图。 */
import { TripoError } from '../../studio/contracts/errors.ts';
import type { Job } from '../../studio/contracts/types.ts';
import type { JobStore } from '../storage/jobs.ts';

export type ImageOutputFormat = 'png' | 'jpeg';
export const imageOutputPolicyKey = (request: string): string => `image-output:${request}`;

export function takeImageOutputFormat(input: Record<string, unknown>): ImageOutputFormat | undefined {
  const format = input.output_format;
  if (format === undefined) return;
  if (format !== 'png' && format !== 'jpeg')
    throw new TripoError('INVALID_INPUT', 'output_format must be png or jpeg.', 'not_submitted');
  delete input.output_format;
  return format;
}

export function readImageOutputFormat(jobs: JobStore, job: Job): ImageOutputFormat | undefined {
  const format = jobs.requestPolicy(job.account_ref, imageOutputPolicyKey(job.request_id))?.format;
  return format === 'png' || format === 'jpeg' ? format : undefined;
}

export function freezeImageOutputPolicy(
  jobs: JobStore,
  account: string,
  request: string,
  format: ImageOutputFormat | undefined,
): void {
  const key = imageOutputPolicyKey(request);
  if (format && !jobs.requestPolicy(account, key) && jobs.find(account, request))
    throw new TripoError(
      'IDEMPOTENCY_CONFLICT',
      'This existing task did not freeze an image output format. Recover its original result; use a new request for another output format.',
      'not_submitted',
    );
  jobs.bindRequestPolicy(account, key, { format: format ?? null });
}

export const imageOutputWarning =
  'output_format is an optional local CLI delivery encoding extension. Studio generates and retains the original image; no native output-format selector or webpage download re-encoding is claimed. Delivery bytes are checked as PNG/JPEG without another generation request.';
