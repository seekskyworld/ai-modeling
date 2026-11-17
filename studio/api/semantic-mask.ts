import type { Job } from '../contracts/types.ts';
import { object, text, TripoError } from '../contracts/errors.ts';

/** Parts及v2分割的PNG是网页独立预览，不保证原图像素坐标，也不是文字部件标签。 */
export function requiresSemanticMask(job: Pick<Job, 'operation' | 'input'>): boolean {
  return (
    (job.operation === 'model' && job.input.generate_parts === true) ||
    (job.operation === 'segment' && job.input.model_version === 'v2.0-20260430') ||
    job.operation === 'resegment'
  );
}

export function missingSemanticMasks(job: Job): boolean {
  if (!requiresSemanticMask(job)) return false;
  const ids = job.remote_ids.models?.length
    ? job.remote_ids.models.flatMap((item, index) =>
        item.accepted === true ? [`semantic-mask-${index}`] : [],
      )
    : ['semantic-mask'];
  return ids.some((id) => !job.artifacts.some((artifact) => artifact.artifact_id === id));
}

function identity(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return parsed.origin + parsed.pathname;
  } catch {
    // 解析错误只报告契约变化，不能把可能含签名的原URL放入错误。
  }
  throw new TripoError('CONTRACT_CHANGED', 'Studio returned an invalid segmentation preview URL.');
}

export function semanticMaskUrl(job: Job, detail: Record<string, unknown>): string {
  if (!requiresSemanticMask(job))
    throw new TripoError('CONTRACT_CHANGED', 'This task does not identify a segmentation preview.');
  return segmentationPreviewUrl(detail, job.remote_ids.project_id ?? '', job.remote_ids.operator_id ?? '');
}

/** 已有网页素材也按调用者指定的project/operator取预览，无需创建本机生成任务。 */
export function segmentationPreviewUrl(
  detail: Record<string, unknown>,
  projectId: string,
  operatorId: string,
): string {
  const operator = object(detail.operator);
  if (!projectId || !operatorId || detail.id !== projectId || operator.operator_id !== operatorId)
    throw new TripoError('CONTRACT_CHANGED', 'The segmentation preview has a different model identity.');
  if (detail.is_owner !== true && operator.is_owner !== true)
    throw new TripoError('OWNERSHIP_REQUIRED', 'The segmentation preview requires your own model.');
  if (operator.status !== 'success' || operator.is_segmented !== true)
    throw new TripoError('ARTIFACT_NOT_READY', 'The original model has no completed segmentation.', 'read');
  // 只使用精确历史详情的明确字段，不回退缩略图、当前项目或别的operator。
  const url = text(detail.segmentation_map_url) || text(operator.segmentation_map_url);
  if (!url)
    throw new TripoError('ARTIFACT_NOT_READY', 'The original segmentation preview is not ready.', 'read');
  identity(url);
  if (
    text(detail.segmentation_map_url) &&
    text(operator.segmentation_map_url) &&
    identity(text(detail.segmentation_map_url)) !== identity(text(operator.segmentation_map_url))
  )
    throw new TripoError('CONTRACT_CHANGED', 'Project and operator segmentation previews disagree.');
  return url;
}
