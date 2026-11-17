/** 网页 ed/identity watcher/Kt 的本地图对应；源码及真实换源均确认后接入独立图编辑。 */
import { canvasGraphIssues } from '../../studio/api/canvas-graph.ts';
import { text } from '../../studio/contracts/errors.ts';
import type { CanvasGraph } from './canvas-layout.ts';

type Graph = Pick<CanvasGraph, 'nodes' | 'edges'>;
function inboundIdentity(graph: Graph, nodeId: string): string {
  for (const edge of graph.edges) {
    if (edge.target.nodeId !== nodeId || canvasGraphIssues(graph.nodes, [edge]).length) continue;
    const source = graph.nodes.find((node) => node.id === edge.source.nodeId);
    if (!source) continue;
    const uploaded = source.type === 'NODE_TYPE_UPLOAD_CARD';
    if (uploaded && !text(source.inputMount?.[0]?.assetId).trim()) continue;
    const assets = (uploaded ? source.inputMount : source.nodeAssets) ?? [];
    const asset = assets.find((value) => value.assetId) ?? assets[0];
    return `${source.id}:${text(asset?.assetId)}`;
  }
  return '';
}

export function extractionSourceIdentities(graph: Graph): Map<string, string> {
  return new Map(
    graph.nodes
      .filter((node) => node.type === 'NODE_TYPE_SEMANTIC_SPLIT')
      .map((node) => [node.id, inboundIdentity(graph, node.id)]),
  );
}

export function resetChangedExtractionSources(graph: Graph, previous: Map<string, string>) {
  const current = extractionSourceIdentities(graph);
  const resets: {
    node_id: string;
    previous_source: string;
    source: string;
    cleared_parameter_keys: string[];
  }[] = [];
  for (const [nodeId, identity] of current) {
    const before = previous.get(nodeId);
    if (before && identity && before !== identity) {
      const node = graph.nodes.find((node) => node.id === nodeId)!;
      const cleared = Object.keys(node.params ?? {})
        .filter((key) => key !== 'split_mode' && key !== 'detect_list_stale')
        .sort();
      // Kt 清整套参数；已有网页 stale 字段对应组件 yr/vr，避免保存/重启后旧清单复活。
      node.params = { split_mode: 'auto', detect_list_stale: true };
      resets.push({
        node_id: nodeId,
        previous_source: before,
        source: identity,
        cleared_parameter_keys: cleared,
      });
    }
    // 同批 disconnect/connect 仍记住上一个非空来源；undo/redo 由调用方整体重建基线。
    if (identity || !previous.has(nodeId)) previous.set(nodeId, identity);
  }
  for (const nodeId of previous.keys()) if (!current.has(nodeId)) previous.delete(nodeId);
  return resets;
}
