/** 默认导出必须依据已确认来源；空动作列表不能被解释成没有骨骼。 */
import type { StudioClient } from './client.ts';
import { array, object, text, TripoError } from '../contracts/errors.ts';

export interface ExportAnimationSource {
  operator_id: string;
  is_rigged: boolean;
  animations: string[];
}

export async function exportAnimationSource(
  client: Pick<StudioClient, 'request'>,
  projectId: string,
  expectedOperator?: string,
): Promise<ExportAnimationSource> {
  const detail = object(
    await client.request('GET', `/v2/studio/project/detail/v3/${encodeURIComponent(projectId)}`),
  );
  const operator = object(detail.operator),
    operatorId = text(operator.operator_id);
  if (detail.id !== projectId || !operatorId)
    throw new TripoError('CONTRACT_CHANGED', 'The export source identity could not be verified.', 'read');
  if (detail.is_owner !== true && operator.is_owner !== true)
    throw new TripoError('OWNERSHIP_REQUIRED', 'Default animation preservation requires your own model.');
  if (expectedOperator && expectedOperator !== operatorId)
    throw new TripoError('PROJECT_CHANGED', 'The export source model version has changed.', 'not_submitted');
  if (typeof operator.is_rigged !== 'boolean')
    throw new TripoError(
      'ANIMATION_SOURCE_UNVERIFIED',
      'The source does not explicitly identify whether it has a skeleton. Select a verified source or explicitly request a static export.',
      'not_submitted',
    );
  const animations = [
    ...new Set(
      array(operator.retarget)
        .map(object)
        .filter((motion) => motion.status === 'success' && text(motion.model_url))
        .map((motion) => text(motion.operator_id))
        .filter(Boolean),
    ),
  ];
  if (!operator.is_rigged && animations.length)
    throw new TripoError('CONTRACT_CHANGED', 'The export source has inconsistent rig and motion metadata.');
  return { operator_id: operatorId, is_rigged: operator.is_rigged, animations };
}
