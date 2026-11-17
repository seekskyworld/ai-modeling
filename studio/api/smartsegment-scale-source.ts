/** 缩放链只接受指定归属/版本的原件；签名链接仅在内存交给下载器。 */
import type { StudioClient } from './client.ts';
import { object, text, TripoError } from '../contracts/errors.ts';
import { segmentEntityMetadata } from '../contracts/segment-entity.ts';

export async function smartSegmentScaleSnapshot(
  client: StudioClient,
  account: string,
  projectId: string,
  operatorId: string,
  historical: boolean,
): Promise<{ url: string; metadata: Record<string, unknown>; complete_metadata: Record<string, unknown> }> {
  const suffix = historical ? `?operator_id=${encodeURIComponent(operatorId)}` : '';
  const detail = object(
    await client
      .forAccount(account)
      .request('GET', `/v2/studio/project/detail/v3/${encodeURIComponent(projectId)}${suffix}`),
  );
  const operator = object(detail.operator);
  if (detail.id !== projectId || operator.operator_id !== operatorId)
    throw new TripoError(
      'PROJECT_CHANGED',
      'The exact metadata-scale source version changed.',
      'not_submitted',
    );
  if (detail.is_owner !== true && operator.is_owner !== true)
    throw new TripoError('OWNERSHIP_REQUIRED', 'Metadata-scale requires an owned model.', 'not_submitted');
  if (operator.status !== 'success' || !text(detail.model_url) || operator.is_rigged === true)
    throw new TripoError(
      'INPUT_NOT_READY',
      'Metadata-scale requires a completed static model.',
      'not_submitted',
    );
  const metadata = object(operator.metadata);
  return {
    url: text(detail.model_url),
    complete_metadata: segmentEntityMetadata(operator.metadata),
    metadata: Object.fromEntries(
      ['children_deleted', 'children_rename', 'children_transform_matrix', 'material_factor'].map((key) => [
        key,
        metadata[key] ?? (key === 'children_deleted' ? [] : {}),
      ]),
    ),
  };
}
