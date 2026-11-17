/** 只读精确复制回执；不通过原项目 current 版本替代历史来源。 */
import { createHash } from 'node:crypto';
import type { StudioClient } from './client.ts';
import type { Job } from '../contracts/types.ts';
import { object, text, TripoError } from '../contracts/errors.ts';
import { stableCanvasResource } from './canvas-state.ts';

export interface LabModelCopyTarget {
  project_id: string;
  operator_id: string;
  resource_identity: string;
  metadata: Record<string, unknown>;
  is_pbr: false;
}
export function assertLabModelCopyMetadata(metadata: Record<string, unknown>): void {
  const geometry = ['transform_matrix', 'children_transform_matrix', 'children_deleted', 'children_rename'];
  for (const key of Object.keys(metadata)) {
    const value = metadata[key];
    if (!geometry.includes(key) && key !== 'material_factor')
      throw new TripoError(
        'LAB_MODEL_ISOLATION_UNVERIFIED',
        'The copied model has unsupported saved metadata.',
        'read',
      );
    if (
      geometry.includes(key) &&
      value !== undefined &&
      value !== null &&
      (typeof value !== 'object' || Object.keys(value).length)
    )
      throw new TripoError(
        'LAB_MODEL_ISOLATION_UNVERIFIED',
        'The copied model has saved geometry or display-name edits.',
        'read',
      );
  }
  if (metadata.material_factor !== undefined && metadata.material_factor !== null) {
    const factor = object(metadata.material_factor);
    if (
      Object.keys(factor).some((key) => !['metallic', 'roughness'].includes(key)) ||
      !['metallic', 'roughness'].every(
        (key) => typeof factor[key] === 'number' && Number(factor[key]) >= 0 && Number(factor[key]) <= 1,
      )
    )
      throw new TripoError(
        'LAB_MODEL_ISOLATION_UNVERIFIED',
        'The copied material metadata is incomplete.',
        'read',
      );
  }
}
export async function readLabModelCopySource(
  client: StudioClient,
  copy: Job,
): Promise<{ target: LabModelCopyTarget; url: string }> {
  const project = text(copy.remote_ids.project_id),
    operatorId = text(copy.remote_ids.operator_id);
  if (!project || !operatorId)
    throw new TripoError(
      'LAB_MODEL_ISOLATION_UNVERIFIED',
      'The copy has no exact project and operator receipt.',
      'read',
    );
  const detail = object(
      await client
        .forAccount(copy.account_ref)
        .request(
          'GET',
          `/v2/studio/project/detail/v3/${encodeURIComponent(project)}?operator_id=${encodeURIComponent(operatorId)}`,
        ),
    ),
    operator = object(detail.operator),
    url = text(detail.model_url),
    metadata = object(operator.metadata);
  if (
    detail.id !== project ||
    operator.operator_id !== operatorId ||
    (detail.is_owner !== true && operator.is_owner !== true) ||
    operator.status !== 'success' ||
    operator.is_pbr !== false ||
    !url ||
    !operator.metadata ||
    Array.isArray(operator.metadata) ||
    (operator.model_url !== undefined &&
      stableCanvasResource(text(operator.model_url)) !== stableCanvasResource(url))
  )
    throw new TripoError(
      'LAB_MODEL_ISOLATION_UNVERIFIED',
      'The copy receipt has no owned, completed, exact untextured model.',
      'read',
    );
  assertLabModelCopyMetadata(metadata);
  return {
    url,
    target: {
      project_id: project,
      operator_id: operatorId,
      resource_identity: createHash('sha256').update(stableCanvasResource(url)).digest('hex'),
      metadata: structuredClone(metadata),
      is_pbr: false,
    },
  };
}
