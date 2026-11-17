/** 新消息附件绑定到当前已保存图；上传输入和节点生成结果分别核验，不以预览链接代替身份。 */
import type { CanvasClient } from './canvas-client.ts';
import { array, object, text, TripoError } from '../contracts/errors.ts';
import type { TurnAttachment } from './canvas-turn-compose.ts';
import { stableCanvasResource } from './canvas-state.ts';
export interface TurnGraph {
  canvas: Record<string, unknown>;
  nodes: Record<string, unknown>[];
}
const method = (service: string, action: string) => `/tripo.canvas.api.agent.${service}Service/${action}`;
function unavailable(message: string): never {
  throw new TripoError('INPUT_NOT_READY', message);
}
export function canvasAssetBinding(asset: Record<string, unknown>) {
  // 签名查询串可刷新；资产本体 URL/path 和版本变化才视为来源变化。
  const resource = stableCanvasResource(text(asset.url));
  return {
    assetId: asset.assetId,
    nodeId: asset.nodeId,
    status: asset.status,
    studioState: asset.studioState,
    version: asset.version,
    kind: asset.kind,
    filename: asset.filename,
    resource,
  };
}
export function isAvailableCanvasOutput(asset: Record<string, unknown>) {
  const bad = /(?:^|_)(queued|running|processing|pending|failed|error|cancelled|canceled)$/i;
  return Boolean(text(asset.url)) && !bad.test(text(asset.status)) && !bad.test(text(asset.studioState));
}
function inputAssets(graph: TurnGraph, attachments: TurnAttachment[]) {
  const ids = new Set<string>();
  for (const attachment of attachments) {
    const node = attachment.nodeId ? graph.nodes.find((node) => node.id === attachment.nodeId) : undefined;
    if (attachment.nodeId && !node)
      throw new TripoError('CANVAS_CHANGED', 'An attachment node is no longer in the saved Canvas.');
    if (node?.type === 'NODE_TYPE_UPLOAD_CARD') {
      const matches = array(node.inputMount).filter((value) => object(value).assetId === attachment.assetId);
      if (matches.length !== 1)
        throw new TripoError(
          'CANVAS_CHANGED',
          'The attachment upload no longer matches its exact node mount.',
        );
    }
    if (!node || node.type === 'NODE_TYPE_UPLOAD_CARD') ids.add(attachment.assetId);
  }
  return [...ids];
}
async function readInputs(client: CanvasClient, projectId: string, ids: string[]) {
  if (!ids.length) return [];
  const result = object(
    await client.call(method('Asset', 'BatchGetInputAssets'), { projectId, assetIds: ids }),
  );
  return ids.map((assetId) => {
    const matches = array(result.assets)
      .map(object)
      .filter((asset) => asset.assetId === assetId);
    if (matches.length !== 1 || matches[0]!.status !== 'INPUT_ASSET_STATUS_READY')
      unavailable(
        'A message attachment is not a READY input in this Canvas project; generated outputs require their exact nodeId.',
      );
    return canvasAssetBinding(matches[0]!);
  });
}
async function readOutputs(client: CanvasClient, attachments: TurnAttachment[]) {
  const nodeIds = [...new Set(attachments.map((attachment) => attachment.nodeId!))];
  if (!nodeIds.length) return [];
  const result = object(await client.call(method('Node', 'ListNodesAssets'), { nodeIds }));
  const nodes = array(result.nodes).map(object);
  return attachments.map((attachment) => {
    const matchingNodes = nodes.filter((node) => node.nodeId === attachment.nodeId);
    const matches =
      matchingNodes.length === 1
        ? array(matchingNodes[0]!.assets)
            .map(object)
            .filter((asset) => asset.assetId === attachment.assetId && asset.nodeId === attachment.nodeId)
        : [];
    if (matches.length !== 1 || !isAvailableCanvasOutput(matches[0]!))
      unavailable('A generated attachment is unavailable on its exact node and asset ID.');
    return canvasAssetBinding(matches[0]!);
  });
}
export async function verifyTurnAttachments(
  client: CanvasClient,
  graph: TurnGraph,
  attachments: TurnAttachment[],
) {
  const inputs = inputAssets(graph, attachments);
  const outputs = attachments.filter(
    (attachment) =>
      attachment.nodeId &&
      graph.nodes.find((node) => node.id === attachment.nodeId)?.type !== 'NODE_TYPE_UPLOAD_CARD',
  );
  const inputBindings = await readInputs(client, text(graph.canvas.projectId), inputs),
    outputBindings = await readOutputs(client, outputs);
  return JSON.stringify({ inputBindings, outputBindings });
}
