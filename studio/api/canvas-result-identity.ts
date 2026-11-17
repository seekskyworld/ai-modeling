/** 提取运行会增加系统子节点，动画资产链接仍指向原骨架；用服务端运行/批次/动作身份确认归属。 */
import { CanvasClient } from './canvas-client.ts';
import type { StudioClient } from './client.ts';
import { array, object, text, TripoError } from '../contracts/errors.ts';
import type { Job } from '../contracts/types.ts';

/** Studio 原始操作目录是可验证身份；不要仅凭文件名包含 UUID 或当前节点结果猜测。 */
export function taskUrlMatches(url: string, taskId: string): boolean {
  if (!taskId) return false;
  try {
    return new URL(url).pathname.split('/').some((part) => part === taskId || part.startsWith(taskId + '.'));
  } catch {
    return false;
  }
}

/** 下游补全会改写分割节点的当前 URL；读取已确认运行的原 operator 文件，不重新生成或使用最新模型。 */
export async function historicalModelAsset(
  studio: StudioClient,
  asset: Record<string, unknown>,
  taskId: string,
): Promise<Record<string, unknown>[]> {
  if (asset.kind !== 'ASSET_KIND_MODEL' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(taskId))
    return [];
  const result = object(
    await studio.request('POST', '/v2/studio/operation/download_with_name', {
      operator_id: taskId,
      file_name: `canvas-${taskId}`,
    }),
  );
  const url = text(result.model_url);
  if (!taskUrlMatches(url, taskId))
    throw new TripoError(
      'CONTRACT_CHANGED',
      'Historical Canvas model URL does not match its original operation.',
    );
  return [{ ...asset, url }];
}

/** 只有同一提取批次在创建时增加的子节点可扩大请求范围，普通执行保持精确匹配。 */
export async function verifyRunNodes(
  client: CanvasClient,
  job: Job,
  run: Record<string, unknown>,
): Promise<void> {
  const requested = array(job.input.node_ids).map(text);
  const actual = array(run.nodeIds).map(text);
  if (requested.length === actual.length && requested.every((id) => actual.includes(id))) return;
  const extra = actual.filter((id) => !requested.includes(id));
  if (
    !requested.every((id) => actual.includes(id)) ||
    run.scope !== 'RUN_SCOPE_SEGMENT' ||
    !['generate', 'regenerate'].includes(text(job.input.action)) ||
    !extra.length
  )
    throw new TripoError('CONTRACT_CHANGED', 'Canvas run nodes do not match the original request.');
  const owned = new Set<string>();
  for (const nodeId of requested) {
    const result = object(
      await client.call('/tripo.canvas.api.agent.NodeService/ListNodeBatches', { nodeId }),
    );
    for (const batch of array(result.batches).map(object)) {
      // 网页创建批次和运行使用同一服务端时间戳；不能使用“当前批次”推断旧运行归属。
      if (!text(run.createTime) || batch.createTime !== run.createTime) continue;
      for (const item of array(batch.items).map(object)) owned.add(text(item.nodeId));
    }
  }
  if (extra.some((id) => !owned.has(id)) || [...owned].some((id) => !extra.includes(id)))
    throw new TripoError(
      'CONTRACT_CHANGED',
      'Canvas generated nodes do not belong to the original extraction batch.',
    );
}

/** 内部提取 taskId 不在 URL 中；仅接受仍指向原 run/step 的明确选中资产，后续重跑则拒绝猜测。 */
export function internalAssetMatches(
  graph: Record<string, unknown>,
  run: Record<string, unknown>,
  step: Record<string, unknown>,
  asset: Record<string, unknown>,
): boolean {
  if (!text(step.taskId).startsWith('internaltask-') || !text(step.stepId)) return false;
  const current = array(graph.nodeRuns)
    .map(object)
    .find((item) => item.nodeId === step.nodeId);
  return (
    current?.runId === run.runId &&
    current?.currentStepId === step.stepId &&
    current?.selectedAssetId === asset.assetId &&
    current?.status === 'NODE_STATUS_DONE'
  );
}

/** 动画节点的主 URL 是骨架，动作在详情 retarget 中；返回原骨架及匹配动作，绝不冒充已合并的完整动画模型。 */
export async function animationAssets(
  client: CanvasClient,
  asset: Record<string, unknown>,
  taskId: string,
): Promise<Record<string, unknown>[]> {
  if (asset.kind !== 'ASSET_KIND_MODEL' || !taskId) return [];
  const response = object(
    await client.call('/tripo.canvas.api.agent.NodeService/GetNodeAssetDetail', { assetId: asset.assetId }),
  );
  if (response.assetId !== asset.assetId)
    throw new TripoError('CONTRACT_CHANGED', 'Canvas animation asset identity mismatch.');
  const detail = object(response.detail);
  const motion = array(detail.retarget)
    .map(object)
    .find((item) => item.operator_id === taskId && item.status === 'success');
  if (!motion || !text(motion.model_url)) return [];
  return [
    asset,
    {
      ...asset,
      assetId: `${text(asset.assetId)}-animation-${taskId}`,
      kind: 'ASSET_KIND_ANIMATION',
      url: motion.model_url,
    },
  ];
}
