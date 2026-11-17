/** 前端转换只读取本人精确历史版本；未支持的编辑 metadata 必须拒绝，不能悄悄导出未编辑原件。 */
import type { StudioClient } from './client.ts';
import { array, object, text, TripoError } from '../contracts/errors.ts';
import {
  isFrontendMaterialFactor,
  isStudioFrontendMetadata,
  effectiveFrontendGeometryMetadata,
} from '../contracts/frontend-export.ts';

export interface FrontendSource {
  url: string;
  name: string;
  metadata: Record<string, unknown>;
  /** 只有 true 才按网页覆盖材质；保存在新证明中，授权前再次核对。 */
  is_pbr?: boolean;
}
export interface FrontendSourceSelection {
  /** 网页允许不选独立动作；它不等于从原文件删除骨骼或内嵌动画。默认仍拒绝隐式丢弃动作。 */
  exclude_retarget?: boolean;
}

function assertEditorMetadata(metadata: Record<string, unknown>): void {
  const allowed = new Set([
    'transform_matrix',
    'children_transform_matrix',
    'children_deleted',
    'children_rename',
    'material_factor',
  ]);
  if (Object.keys(metadata).some((key) => !allowed.has(key)))
    throw new TripoError(
      'FRONTEND_SOURCE_UNSUPPORTED',
      'This source has unverified editor metadata.',
      'not_submitted',
    );
  const empty = (value: unknown) =>
    value === undefined ||
    value === null ||
    (Array.isArray(value)
      ? value.length === 0
      : typeof value === 'object' && Object.keys(value).length === 0);
  // metadata先查形状，读到精确GLB后再限制静态正TRS/有效节点/删除及仅用于显示的别名。
  if (
    !isStudioFrontendMetadata({
      forward_axis: '-y',
      pivot_to_center_bottom: true,
      ...effectiveFrontendGeometryMetadata(metadata),
    })
  )
    throw new TripoError(
      'FRONTEND_SOURCE_UNSUPPORTED',
      'Editor geometry or display-name metadata is malformed.',
      'not_submitted',
    );
  const material = metadata.material_factor;
  if (!empty(material) && !isFrontendMaterialFactor(material))
    throw new TripoError(
      'FRONTEND_SOURCE_UNSUPPORTED',
      'Editor material factors must contain exactly finite metallic and roughness values in [0, 1].',
      'not_submitted',
    );
}

function sourcePbr(value: unknown, metadata: Record<string, unknown>): boolean {
  if (value !== undefined && typeof value !== 'boolean')
    throw new TripoError(
      'CONTRACT_CHANGED',
      'Source is_pbr must be a boolean when present.',
      'not_submitted',
    );
  // 有 PBR 标记但显式 material_factor 不完整时不能猜测引擎默认；原网页当前合同要求完整二元组。
  if (
    value === true &&
    metadata.material_factor !== undefined &&
    !isFrontendMaterialFactor(metadata.material_factor)
  )
    throw new TripoError(
      'FRONTEND_SOURCE_UNSUPPORTED',
      'PBR source material factors are incomplete.',
      'not_submitted',
    );
  return value === true;
}

export async function frontendExportSource(
  client: StudioClient,
  account: string,
  projectId: string,
  operatorId: string,
  selection: FrontendSourceSelection = {},
): Promise<FrontendSource> {
  const bound = client.forAccount(account);
  const detail = object(
    await bound.request(
      'GET',
      `/v2/studio/project/detail/v3/${encodeURIComponent(projectId)}?operator_id=${encodeURIComponent(operatorId)}`,
    ),
  );
  const operator = object(detail.operator);
  if (detail.id !== projectId || operator.operator_id !== operatorId)
    throw new TripoError(
      'PROJECT_CHANGED',
      'The requested exact frontend source is unavailable.',
      'not_submitted',
    );
  if (detail.is_owner !== true && operator.is_owner !== true)
    throw new TripoError('OWNERSHIP_REQUIRED', 'Frontend export requires your own model.', 'not_submitted');
  if (detail.running_operator)
    throw new TripoError('PROJECT_BUSY', 'Wait for the source project operation to finish.', 'not_submitted');
  if (operator.status !== 'success' || !text(detail.model_url))
    throw new TripoError('ARTIFACT_NOT_READY', 'The exact source has no completed model.', 'not_submitted');
  // 对应网页 animations=[]：仅显式排除独立 retarget 时读取主文件；不改变其骨骼/内嵌内容。
  if (operator.retarget !== undefined && operator.retarget !== null && !Array.isArray(operator.retarget))
    throw new TripoError(
      'CONTRACT_CHANGED',
      'Separate motion metadata has an unexpected shape.',
      'not_submitted',
    );
  if (array(operator.retarget).length && selection.exclude_retarget !== true)
    throw new TripoError(
      'FRONTEND_SOURCE_UNSUPPORTED',
      'Separate retarget motions require an explicit merge or exclude_retarget=true; this path preserves the verified main file and its embedded contents.',
      'not_submitted',
    );
  if (
    operator.metadata !== undefined &&
    operator.metadata !== null &&
    (typeof operator.metadata !== 'object' || Array.isArray(operator.metadata))
  )
    throw new TripoError(
      'CONTRACT_CHANGED',
      'Source editor metadata has an unexpected shape.',
      'not_submitted',
    );
  const metadata = object(operator.metadata);
  assertEditorMetadata(metadata);
  const isPbr = sourcePbr(operator.is_pbr, metadata);
  bound.credentials.load();
  return {
    url: text(detail.model_url),
    name: text(detail.project_name) || 'model',
    metadata,
    is_pbr: isPbr,
  };
}
