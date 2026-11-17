/** 多图任务引用与文件保留同一槽位顺序，执行前统一核对来源，不把 @name 当作本机路径。 */
import path from 'node:path';
import { homedir } from 'node:os';
import { array, object, text, TripoError } from '../../studio/contracts/errors.ts';
import type { Job } from '../../studio/contracts/types.ts';
import { referenceImageResult, type AuditImage } from '../../studio/auth/image-admission.ts';

export interface ImageReferenceBinding {
  reference: string;
  target: 'image_asset' | 'image_sources';
  index?: number;
}
export interface ImageReferencePlan {
  parameters: Record<string, unknown>;
  bindings: ImageReferenceBinding[];
}
type ImageInput = { image_path: string } | { asset_id: string; output_index: number } | null;
export interface ImageReferenceResolver {
  accountRef: string;
  findJob(reference: string): Job | Promise<Job>;
  refreshJob(jobId: string): Promise<Job>;
  readAsset(assetId: string): Promise<unknown>;
  auditReference?: AuditImage;
}

const taskReference = (value: string): boolean =>
  /^@|^task_[A-Za-z0-9_-]+$|^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
const localPath = (value: string): string =>
  /^(https?:\/\/|studio_file_)/i.test(value)
    ? value
    : path.resolve(value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value);

/** 返回 undefined 时继续旧规划路径，避免改变单图引用和纯文件数组的历史请求指纹。 */
export function planImageReferences(
  inputs: (string | null)[],
  primary = false,
): ImageReferencePlan | undefined {
  if (inputs.length < 2 || !inputs.some((value) => value !== null && taskReference(value))) return undefined;
  const plan: ImageReferencePlan = { parameters: {}, bindings: [] };
  const sources = inputs.map((value, index): ImageInput => {
    if (value === null) return null;
    if (!taskReference(value)) return { image_path: localPath(value) };
    const isPrimary = primary && index === 0;
    plan.bindings.push({
      reference: value,
      target: isPrimary ? 'image_asset' : 'image_sources',
      ...(isPrimary ? {} : { index: primary ? index - 1 : index }),
    });
    return { asset_id: `cli-reference-${index}`, output_index: 0 };
  });
  if (primary) {
    const first = sources.shift();
    if (!first) throw new TripoError('INVALID_INPUT', 'Image editing requires a primary image.');
    if ('image_path' in first) plan.parameters.image_path = first.image_path;
    else plan.parameters.image_asset = first;
  }
  plan.parameters.image_sources = sources;
  return plan;
}

function assertImageJob(job: Job, accountRef: string): void {
  if (job.account_ref !== accountRef)
    throw new TripoError('ACCOUNT_MISMATCH', 'Image input belongs to another Studio account.');
  if (!['image', 'image_process'].includes(job.operation))
    throw new TripoError(
      'INVALID_INPUT',
      'Every image task reference must refer to an image-producing task.',
    );
}

async function sourceAsset(reference: string, resolver: ImageReferenceResolver): Promise<string> {
  let source: Job;
  try {
    source = await resolver.findJob(reference);
  } catch (error) {
    if (!(error instanceof TripoError) || error.code !== 'JOB_NOT_FOUND' || reference.startsWith('@'))
      throw error;
    if (reference.startsWith('task_'))
      throw new TripoError(
        'STUDIO_CAPABILITY_UNAVAILABLE',
        'Official API task IDs cannot be used as Studio image assets.',
        'not_submitted',
      );
    return reference;
  }
  assertImageJob(source, resolver.accountRef);
  if (source.state !== 'succeeded') {
    const originalId = source.job_id;
    source = await resolver.refreshJob(originalId);
    if (source.job_id !== originalId)
      throw new TripoError('CONTRACT_CHANGED', 'Image source refresh returned a different task.');
    assertImageJob(source, resolver.accountRef);
  }
  if (source.state !== 'succeeded')
    throw new TripoError(
      'INPUT_NOT_READY',
      'Wait for every source image task to succeed before generating.',
      'not_submitted',
    );
  const assetId = text(source.remote_ids.asset_id);
  if (!assetId) throw new TripoError('INVALID_INPUT', 'Image source task has no Studio asset identity.');
  return assetId;
}

/** 只读完整来源数组；任何身份、状态或审核失败都会发生在生成提交之前。 */
async function validatedAsset(
  reference: string,
  resolver: ImageReferenceResolver,
  original?: { asset_id: string; output_index: number },
): Promise<{ asset_id: string; output_index: number }> {
  const assetId = await sourceAsset(reference, resolver);
  // 原请求已经审核并提交；恢复只核对相同来源身份，不依赖可能已删的上游来源再次在线审核。
  if (original) {
    if (original.asset_id !== assetId || original.output_index !== 0)
      throw new TripoError(
        'IDEMPOTENCY_CONFLICT',
        'The original image source identity or output slot has changed.',
      );
    return original;
  }
  const asset = object(await resolver.readAsset(assetId));
  if (asset.asset_id !== assetId)
    throw new TripoError('CONTRACT_CHANGED', 'Studio returned a different source image asset.');
  if (asset.status !== 'success')
    throw new TripoError('INPUT_NOT_READY', 'Every source image asset must be complete.', 'not_submitted');
  const output = object(array(object(asset.output).data)[0]);
  await referenceImageResult(output, resolver.auditReference);
  return { asset_id: assetId, output_index: 0 };
}

/** 参数全部解析成功后才返回副本；调用方随后沿既有 service.prepare 路径冻结输入和提交意图。 */
export async function resolveImageReferences(
  parameters: Record<string, unknown>,
  bindings: ImageReferenceBinding[],
  resolver: ImageReferenceResolver,
  previous?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const pending = new Map<string, Promise<{ asset_id: string; output_index: number }>>();
  const resolved = await Promise.all(
    bindings.map((binding) => {
      const original = previous ? savedSource(previous, binding) : undefined;
      // 同一引用可出现在不同角色；原请求每个位置都必须核对，不能因引用去重跳过第二个槽。
      const key = original ? JSON.stringify([binding.reference, original]) : binding.reference;
      if (!pending.has(key)) pending.set(key, validatedAsset(binding.reference, resolver, original));
      return pending.get(key)!;
    }),
  );
  const result = { ...parameters };
  const sources = Array.isArray(parameters.image_sources) ? [...parameters.image_sources] : undefined;
  for (const [index, binding] of bindings.entries()) {
    if (binding.target === 'image_asset') result.image_asset = resolved[index];
    else {
      if (!sources || binding.index === undefined || binding.index < 0 || binding.index >= sources.length)
        throw new TripoError('INVALID_INPUT', 'Image source binding does not match its input slot.');
      sources[binding.index] = resolved[index];
    }
  }
  if (sources) result.image_sources = sources;
  return result;
}

function savedSource(
  parameters: Record<string, unknown>,
  binding: ImageReferenceBinding,
): { asset_id: string; output_index: number } {
  const source = object(
    binding.target === 'image_asset'
      ? parameters.image_asset
      : array(parameters.image_sources)[binding.index ?? -1],
  );
  if (!text(source.asset_id) || (source.output_index !== undefined && source.output_index !== 0))
    throw new TripoError(
      'IDEMPOTENCY_CONFLICT',
      'The original image source role or output slot has changed.',
    );
  return { asset_id: text(source.asset_id), output_index: 0 };
}
