/** Canvas 前端自动布局的确定性对应：依赖分层、分组递归和不重叠间距，不声称像素一致。 */
import type { z } from 'zod';
import { canvasSaveSchema } from '../../studio/api/canvas.ts';
import { TripoError } from '../../studio/contracts/errors.ts';

export type CanvasGraph = z.infer<typeof canvasSaveSchema>;
export type CanvasNode = CanvasGraph['nodes'][number];
export function dimensions(node: CanvasNode) {
  return { width: node.ui?.size?.width || 303, height: node.ui?.size?.height || 303 };
}
export function position(node: CanvasNode) {
  return node.ui?.position ?? { x: 0, y: 0 };
}
export function place(node: CanvasNode, x: number, y: number) {
  node.ui = { ...node.ui, position: { x, y } };
}

function ranks(graph: CanvasGraph, siblings: CanvasNode[], parent: string) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const child = (id: string): string | undefined => {
    let node = byId.get(id);
    while (node && (node.pid || '') !== parent) node = byId.get(node.pid || '');
    return node?.id;
  };
  const edges = graph.edges
    .map((e) => [child(e.source.nodeId), child(e.target.nodeId)])
    .filter(([a, b]) => a && b && a !== b) as [string, string][];
  const rank = new Map<string, number>(),
    waiting = new Set(siblings.map((n) => n.id));
  while (waiting.size) {
    const ready = [...waiting].filter((id) => edges.every(([from, to]) => to !== id || !waiting.has(from)));
    if (!ready.length)
      throw new TripoError(
        'LAYOUT_CONSTRAINT',
        'Cross-group dependencies cannot be layered without a cycle; adjust the groups first.',
      );
    for (const id of ready) {
      rank.set(
        id,
        Math.max(0, ...edges.filter(([, to]) => to === id).map(([from]) => (rank.get(from) ?? 0) + 1)),
      );
      waiting.delete(id);
    }
  }
  return rank;
}

export function layoutCanvas(graph: CanvasGraph, gap: number, parent = ''): void {
  const siblings = graph.nodes.filter((n) => (n.pid || '') === parent);
  for (const section of siblings.filter((n) => n.type === 'NODE_TYPE_SECTION'))
    layoutCanvas(graph, gap, section.id);
  const rank = ranks(graph, siblings, parent);
  let x = parent ? 40 : 0;
  for (let column = 0; column <= Math.max(-1, ...rank.values()); column++) {
    const nodes = siblings.filter((n) => rank.get(n.id) === column);
    let y = parent ? 80 : 0;
    for (const node of nodes) {
      place(node, x, y);
      y += dimensions(node).height + gap;
    }
    x += Math.max(0, ...nodes.map((n) => dimensions(n).width)) + gap;
  }
  const section = graph.nodes.find((n) => n.id === parent);
  if (section)
    section.ui = {
      position: position(section),
      size: {
        width: Math.max(303, ...siblings.map((n) => position(n).x + dimensions(n).width + 40)),
        height: Math.max(303, ...siblings.map((n) => position(n).y + dimensions(n).height + 40)),
      },
    };
}
