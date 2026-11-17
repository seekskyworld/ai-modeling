/** 只读取当前本人静态模型；下载授权 URL 仅在进程内返回，持久身份使用摘要。 */
import { createHash } from 'node:crypto';
import type { StudioClient } from './client.ts';
import { object, text, TripoError } from '../contracts/errors.ts';
import { segmentEntityMetadata } from '../contracts/segment-entity.ts';
import { stableCanvasResource } from './canvas-state.ts';

export interface SegmentEntitySnapshot {
  account_ref: string;
  project_id: string;
  operator_id: string;
  url: string;
  resource_fingerprint: string;
  format: string;
  metadata: Record<string, unknown>;
}

export const segmentResourceFingerprint = (url: string): string =>
  createHash('sha256').update(stableCanvasResource(url)).digest('hex');

export async function segmentEntitySnapshot(
  client: StudioClient,
  account: string,
  input: Record<string, unknown>,
): Promise<SegmentEntitySnapshot> {
  const project = text(input.project_id);
  const detail = object(
    await client
      .forAccount(account)
      .request('GET', `/v2/studio/project/detail/v3/${encodeURIComponent(project)}`),
  );
  const operator = object(detail.operator),
    operatorId = text(operator.operator_id),
    url = text(detail.model_url);
  if (
    detail.id !== project ||
    !operatorId ||
    (input.expected_operator_id && input.expected_operator_id !== operatorId)
  )
    throw new TripoError(
      'PROJECT_CHANGED',
      'Refresh the exact model before preparing segmentation.',
      'not_submitted',
    );
  if (detail.is_owner !== true && operator.is_owner !== true)
    throw new TripoError(
      'OWNERSHIP_REQUIRED',
      'Only an owned segment source can be inspected.',
      'not_submitted',
    );
  if (detail.running_operator || operator.status !== 'success')
    throw new TripoError('PROJECT_BUSY', 'Wait for the source model operation to finish.', 'not_submitted');
  if (operator.is_rigged === true)
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      'Studio segmentation does not support rigged models.',
      'not_submitted',
    );
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TripoError('INVALID_ARTIFACT', 'The native source has no valid model URL.', 'not_submitted');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new TripoError(
      'INVALID_ARTIFACT',
      'The native model URL cannot be used for source inspection.',
      'not_submitted',
    );
  return {
    account_ref: account,
    project_id: project,
    operator_id: operatorId,
    url,
    resource_fingerprint: segmentResourceFingerprint(url),
    format: /\.([a-z0-9]+)$/i.exec(parsed.pathname)?.[1]?.toLowerCase() ?? '',
    metadata: segmentEntityMetadata(operator.metadata),
  };
}
