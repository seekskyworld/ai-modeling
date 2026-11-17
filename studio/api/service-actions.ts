/** 只提交用户明确指定的服务动作；不隐式改变可见性，也不自动执行付款。 */
import type { StudioClient } from './client.ts';
import type { Job, RemoteIds, RemoteStatus } from '../contracts/types.ts';
import { object, text, TripoError } from '../contracts/errors.ts';

export async function submitServiceAction(
  client: StudioClient,
  job: Job,
): Promise<{ remote_ids: RemoteIds; status: RemoteStatus }> {
  const x = job.input;
  // 网页历史版本只允许原 model_url 本地转换后 export-lite；不能用最新版本检查拒绝固定历史素材。
  // 带 operator_id 读取同一版本仍须核身份，不得静默切换最新版本或回退到后端 export。
  const versionQuery =
    job.operation === 'export_lite' ? `?operator_id=${encodeURIComponent(text(x.operator_id))}` : '';
  const detail = object(
    await client.request(
      'GET',
      `/v2/studio/project/detail/v3/${encodeURIComponent(text(x.project_id))}${versionQuery}`,
    ),
  );
  const operator = object(detail.operator);
  if (detail.id !== x.project_id) throw new TripoError('CONTRACT_CHANGED', 'Project identity mismatch.');
  const owner = detail.is_owner === true || operator.is_owner === true;
  if (!owner && !(job.operation === 'export_lite' && x.public_model === true))
    throw new TripoError('OWNERSHIP_REQUIRED', 'Use your own project.');
  if (detail.running_operator)
    throw new TripoError('PROJECT_BUSY', 'Wait for the project operation to finish.');
  if (job.operation === 'export_lite') {
    if (operator.operator_id !== x.operator_id)
      throw new TripoError(
        'PROJECT_CHANGED',
        'The requested model version is unavailable for lightweight export.',
      );
    await client.request(
      'POST',
      '/v2/studio/operation/export-lite',
      {
        project_id: x.project_id,
        operator_id: x.operator_id,
        is_owner: owner,
        format: x.format === 'glb' ? 'gltf' : x.format,
      },
      { paid: true },
    );
    return {
      remote_ids: { project_id: text(x.project_id), operator_id: text(x.operator_id) },
      status: { state: 'succeeded', progress: 100, artifacts: [] },
    };
  }
  if (detail.visibility === 'private')
    throw new TripoError(
      'PROJECT_NOT_SHAREABLE',
      'Human refinement requires a shareable project. Explicitly change visibility before submitting.',
      'not_submitted',
    );
  const result = object(
    await client.request(
      'POST',
      '/v2/studio/pro_refine/create',
      {
        project_id: x.project_id,
        requirement: x.requirement,
        success_url: 'https://studio.tripo3d.ai/?refine_success=true',
        cancel_url: 'https://studio.tripo3d.ai/?refine_fail=true',
      },
      { paid: true },
    ),
  );
  if (typeof result.if_need_payment !== 'boolean')
    throw new TripoError(
      'CONTRACT_CHANGED',
      'Human refinement receipt was not understood. Inspect refine-history; do not submit again.',
      'unknown',
    );
  // checkout_url 可包含订单秘密，调用方在 Studio 完成付款；成功仅表示申请已被接收。
  return {
    remote_ids: {
      project_id: text(x.project_id),
      refinement: {
        payment_required: result.if_need_payment,
        request_received: true,
        delivery_pending: true,
      },
    },
    status: { state: 'succeeded', progress: 100, artifacts: [] },
  };
}
