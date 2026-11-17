/** 网页纹理节点初始化的准备命令：返回独立编辑动作，付费生成和 SaveCanvas 由调用方另行执行。 */
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { id } from '../contracts/primitives.ts';
import { array, object, sanitize, text, TripoError } from '../contracts/errors.ts';
import { CanvasClient, bindCanvasAccount } from './canvas-client.ts';
import type { StudioClient } from './client.ts';
import { readCanvasModelReference, singleModelImage } from './canvas-model-reference.ts';
import { referenceCatalog, textureReferencePlan, type ReferenceGraph } from './canvas-texture-graph.ts';

export const textureReferenceSchema = z
  .object({
    canvasId: id,
    nodeId: id,
    revision: z.string().regex(/^\d+$/).optional(),
  })
  .strict();

function graphSnapshot(result: Record<string, unknown>): ReferenceGraph {
  if (!Array.isArray(result.nodes) || !Array.isArray(result.edges) || result.nodes.length > 1000)
    throw new TripoError('CONTRACT_CHANGED', 'Canvas reference graph is incomplete.');
  const nodes = result.nodes.map((value) => {
    const node = object(value);
    if (!text(node.id) || !text(node.type))
      throw new TripoError('CONTRACT_CHANGED', 'Canvas reference node has no identity.');
    return {
      id: text(node.id),
      type: text(node.type),
      params: object(node.params),
      nodeAssets: array(node.nodeAssets),
      inputMount: array(node.inputMount),
    };
  });
  const ids = new Set(nodes.map((n) => n.id));
  if (ids.size !== nodes.length)
    throw new TripoError('CONTRACT_CHANGED', 'Canvas reference graph has duplicate nodes.');
  const edges = result.edges.map((value) => {
    const edge = object(value),
      source = object(edge.source),
      target = object(edge.target);
    if (!text(edge.id) || !ids.has(text(source.nodeId)) || !ids.has(text(target.nodeId)))
      throw new TripoError('CONTRACT_CHANGED', 'Canvas reference edge has a missing endpoint.');
    return {
      id: text(edge.id),
      source: { nodeId: text(source.nodeId), port: text(source.port) },
      target: { nodeId: text(target.nodeId), port: text(target.port) },
    };
  });
  return { nodes, edges };
}
function fingerprint(graph: ReferenceGraph) {
  // 签名 URL 轮换不表示素材变了；反之节点选中结果可能变化而 graph revision 不变。
  const assets = (values: unknown[] | undefined) =>
    array(values)
      .map(object)
      .map(({ assetId, selected, role, nodeId, kind, source, slotIndex, filename, url, thumbnailUrl }) => ({
        assetId,
        selected,
        role,
        nodeId,
        kind,
        source,
        slotIndex,
        filename,
        has_url: /^https?:\/\//.test(text(url).trim()),
        has_thumbnail: /^https?:\/\//.test(text(thumbnailUrl).trim()),
      }));
  return JSON.stringify({
    edges: graph.edges,
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      params: n.params,
      nodeAssets: assets(n.nodeAssets),
      inputMount: assets(n.inputMount),
    })),
  });
}

export async function resolveCanvasTextureReference(
  studio: StudioClient,
  requested: unknown,
): Promise<unknown> {
  const input = textureReferenceSchema.parse(requested);
  studio = bindCanvasAccount(studio);
  const client = new CanvasClient(studio);
  const read = () =>
    client.call('/tripo.canvas.api.agent.CanvasService/GetCanvas', { canvasId: input.canvasId }).then(object);
  const result = await read();
  const canvas = object(result.canvas),
    revision = text(canvas.revision);
  if (canvas.canvasId !== input.canvasId || !/^\d+$/.test(revision))
    throw new TripoError('CONTRACT_CHANGED', 'Canvas returned another graph or an invalid revision.');
  if (input.revision !== undefined && input.revision !== revision)
    throw new TripoError('CANVAS_CHANGED', 'Read the current graph before preparing its texture reference.');
  const graph = graphSnapshot(result);
  const catalogValue = await client.call('/tripo.canvas.api.agent.ToolService/ListTools', {});
  const plan = textureReferencePlan(graph, input.nodeId, referenceCatalog(catalogValue));
  const target = graph.nodes.find((n) => n.id === input.nodeId)!;
  const actions: unknown[] = [];
  let decision: string = plan.kind;
  let reason = plan.kind === 'unchanged' ? plan.reason : '';
  let source: Record<string, unknown> = {};
  if (plan.kind === 'connect_image') {
    const params = { ...target.params };
    if ('image' in params) {
      delete params.image;
      actions.push({ action: 'params', node_id: input.nodeId, params });
    }
    actions.push({
      action: 'connect',
      edge: {
        id: randomUUID(),
        source: { nodeId: plan.source_node_id, port: plan.source_port },
        target: { nodeId: input.nodeId, port: 'image' },
      },
    });
    source = { source_node_id: plan.source_node_id };
  } else if (plan.kind === 'model_source') {
    const reference = await readCanvasModelReference(studio, plan.source_asset_id);
    const image = reference && singleModelImage(reference);
    source = { source_asset_id: plan.source_asset_id, ...(reference ?? {}) };
    if (image) {
      decision = 'inherit_image';
      actions.push({ action: 'params', node_id: input.nodeId, params: { ...target.params, image } });
    } else {
      decision = 'unchanged';
      reason = reference ? 'source_is_not_single_image' : 'source_version_unavailable';
    }
  }
  const latest = await read();
  if (
    object(latest.canvas).canvasId !== input.canvasId ||
    object(latest.canvas).revision !== revision ||
    fingerprint(graphSnapshot(latest)) !== fingerprint(graph)
  )
    throw new TripoError(
      'CANVAS_CHANGED',
      'Canvas or selected source changed while resolving its texture reference.',
    );
  studio.credentials.load();
  return sanitize({
    canvas_id: input.canvasId,
    node_id: input.nodeId,
    source_revision: revision,
    decision,
    ...(reason ? { reason } : {}),
    ...source,
    actions,
    catalog_version: object(catalogValue).nodeDefinitionsVersion ?? null,
    remote_saved: false,
    execution_started: false,
  });
}
