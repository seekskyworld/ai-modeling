/** 将网页只读发现与项目引用解析留在 Studio 层，上层命令不持有 URL 或 HTTP 细节。 */
import type { StudioClient } from './client.ts';
import { array, object, text, sanitize, TripoError } from '../contracts/errors.ts';
import type { RemoteIds } from '../contracts/types.ts';
import type { StorageImage } from '../auth/image-admission.ts';
type Reader = Pick<StudioClient, 'request'>;

/** 参考图准入查询保留网页返回分类，上层仅消费结果，不持有审核请求协议。 */
export async function auditReferenceImage(client: Reader, image: StorageImage): Promise<unknown> {
  return await client.request('POST', '/v2/studio/audit/image', { image });
}

/** 编辑目标必须仍为当前版本；只读复制来源可显式读取历史 operator，仍核对归属和身份。 */
export async function projectMetadataSnapshot(
  client: Reader,
  projectId: string,
  operatorId: string,
  historical = false,
): Promise<Record<string, unknown>> {
  const suffix = historical ? `?operator_id=${encodeURIComponent(operatorId)}` : '';
  const detail = object(
    await client.request('GET', `/v2/studio/project/detail/v3/${encodeURIComponent(projectId)}${suffix}`),
  );
  const operator = object(detail.operator);
  if (detail.id !== projectId || operator.operator_id !== operatorId)
    throw new TripoError('PROJECT_CHANGED', 'Refresh the export source before applying native edits.');
  if (detail.is_owner !== true && operator.is_owner !== true)
    throw new TripoError('OWNERSHIP_REQUIRED', 'Native export edits require your own project.');
  return object(operator.metadata);
}
export async function discoverCapabilities(client: Reader): Promise<Record<string, unknown>> {
  const results = await Promise.allSettled([
    client.request('POST', '/v2/studio/operation/quota', {}),
    client.request('GET', '/v2/studio/marketing/detail?locale=zh'),
  ]);
  return {
    account_permission: 'unknown_until_accepted_by_studio',
    quota: results[0]?.status === 'fulfilled' ? sanitize(results[0].value) : null,
    trials: results[1]?.status === 'fulfilled' ? sanitize(results[1].value) : null,
    observed_at: new Date().toISOString(),
  };
}
export async function resolveProjectReference(client: Reader, projectId: string): Promise<RemoteIds> {
  const detail = object(
    await client.request('GET', `/v2/studio/project/detail/v3/${encodeURIComponent(projectId)}`),
  );
  const operator = text(object(detail.operator).operator_id);
  if (detail.id !== projectId || !operator)
    throw new TripoError('CONTRACT_CHANGED', 'Studio project reference could not be verified.');
  return { project_id: projectId, operator_id: operator };
}

/** 查询指定历史版本的纹理状态；未知标记不能被解释为可安全移除纹理。 */
export async function projectTextureStatus(
  client: Reader,
  projectId: string,
  operatorId: string,
): Promise<boolean | undefined> {
  const detail = object(
    await client.request(
      'GET',
      `/v2/studio/project/detail/v3/${encodeURIComponent(projectId)}?operator_id=${encodeURIComponent(operatorId)}`,
    ),
  );
  const operator = object(detail.operator);
  if (detail.id !== projectId || operator.operator_id !== operatorId)
    throw new TripoError('CONTRACT_CHANGED', 'Studio source version could not be verified.');
  return typeof operator.is_textured === 'boolean' ? operator.is_textured : undefined;
}

/** 网页 rigging.type 是通用动作预设映射的依据；未知骨架不能默认为双足后收费。 */
export async function projectRigType(
  client: Reader,
  projectId: string,
  operatorId?: string,
): Promise<string> {
  const suffix = operatorId ? `?operator_id=${encodeURIComponent(operatorId)}` : '';
  const detail = object(
    await client.request('GET', `/v2/studio/project/detail/v3/${encodeURIComponent(projectId)}${suffix}`),
  );
  const operator = object(detail.operator),
    rigging = object(operator.rigging);
  if (detail.id !== projectId || (operatorId && operator.operator_id !== operatorId))
    throw new TripoError('CONTRACT_CHANGED', 'Studio rig source identity could not be verified.');
  const type = text(rigging.type);
  if (
    rigging.status !== 'success' ||
    !['biped', 'quadruped', 'avian', 'aquatic', 'hexapod', 'octopod', 'serpentine'].includes(type)
  )
    throw new TripoError(
      'INPUT_NOT_READY',
      'A completed rig with a known body type is required for a generic motion preset.',
      'not_submitted',
    );
  return type;
}

/** 自动动作关联仍以该项目的成功 retarget 列表为准，绝不把预设名或其他项目动作当作导出 ID。 */
export async function resolveExportAnimations(
  client: Reader,
  projectId: string,
  preferred?: string[],
): Promise<string[]> {
  const detail = object(
    await client.request('GET', `/v2/studio/project/detail/v3/${encodeURIComponent(projectId)}`),
  );
  const operator = object(detail.operator);
  if (detail.id !== projectId || (detail.is_owner !== true && operator.is_owner !== true))
    throw new TripoError('OWNERSHIP_REQUIRED', 'Automatic animation selection requires your own project.');
  const available = array(operator.retarget)
    .map(object)
    .filter((motion) => motion.status === 'success' && text(motion.model_url))
    .map((motion) => text(motion.operator_id))
    .filter(Boolean);
  const selected = [...new Set(preferred?.length ? preferred : available)];
  if ((!selected.length && operator.is_rigged !== true) || selected.some((id) => !available.includes(id)))
    throw new TripoError(
      'ANIMATION_NOT_READY',
      'No matching completed source animations are available for export.',
    );
  return selected;
}

/** 单个任务引用只能自动展开真正的四视图资产，不能把普通四候选图片误作同一模型的四面。 */
export async function resolveMultiviewReference(
  client: Reader,
  assetId: string,
): Promise<{ asset_id: string; output_index: number }[]> {
  const asset = object(
    await client.request('POST', '/v2/studio/image/get_image_asset', { asset_id: assetId }),
  );
  if (asset.asset_id !== assetId)
    throw new TripoError('CONTRACT_CHANGED', 'Studio image reference could not be verified.');
  if (asset.status !== 'success')
    throw new TripoError('INPUT_NOT_READY', 'Wait for the multiview image task to succeed.');
  if (asset.type !== 'multiview_images' || array(object(asset.output).data).length !== 4)
    throw new TripoError(
      'INVALID_INPUT',
      'A single multiview task reference must contain four generated views; pass explicit image files for other inputs.',
    );
  return [0, 1, 2, 3].map((output_index) => ({ asset_id: assetId, output_index }));
}
