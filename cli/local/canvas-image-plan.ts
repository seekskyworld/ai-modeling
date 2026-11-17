/** 网页 GenerateImage 批量规划的本地对应；只修改图，不保存或提交任何生成任务。 */
import { randomUUID } from 'node:crypto';
import { TripoError } from '../../studio/contracts/errors.ts';
import { position, type CanvasGraph, type CanvasNode } from './canvas-layout.ts';

function imageAmount(node: CanvasNode): number {
  const amount = node.params?.amount;
  return node.type === 'NODE_TYPE_GENERATE_IMAGE' && typeof amount === 'number' && [2, 3, 4].includes(amount)
    ? amount
    : 1;
}

function worldPosition(node: CanvasNode, byId: Map<string, CanvasNode>) {
  const result = { ...position(node) };
  let parent = node.pid;
  while (parent) {
    const ancestor = byId.get(parent);
    if (!ancestor) break;
    result.x += position(ancestor).x;
    result.y += position(ancestor).y;
    parent = ancestor.pid;
  }
  return result;
}

/**
 * 网页 nx/tx 在 SaveCanvas 前将合法 amount 展开为独立节点；只复制入边。
 * 原节点保留已有结果，新节点清空结果身份，防止把旧产物冒称新一张的输出。
 */
export function expandCanvasImages(graph: CanvasGraph, requested: string[]) {
  const selected = new Set(requested);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const executable = [...selected].filter((id) => {
    const node = byId.get(id);
    return node && node.type !== 'NODE_TYPE_SECTION';
  });
  const candidates = graph.nodes.filter((node) => selected.has(node.id) && imageAmount(node) > 1);
  const expansions: {
    source_node_id: string;
    requested_amount: number;
    section_id: string;
    node_ids: string[];
  }[] = [];
  const known = new Set([...byId.keys(), ...graph.edges.map((edge) => edge.id)]);
  const nextId = () => {
    const id = randomUUID();
    if (known.has(id)) throw new TripoError('INVALID_INPUT', 'Image batch requires unique graph IDs.');
    known.add(id);
    return id;
  };
  // Dv96avMB.wn 的分组内边距；具体 UI 字体和节点显示仍不承诺像素等同。
  const padding = { left: 20, right: 20, top: 64, bottom: 20 };
  const edges = [...graph.edges];
  for (const source of candidates) {
    const amount = imageAmount(source);
    const sectionId = nextId();
    const nodeIds = [source.id];
    const origin = worldPosition(source, byId);
    const inbound = edges.filter((edge) => edge.target.nodeId === source.id);
    const params = { ...source.params, amount: 1 };
    graph.nodes[graph.nodes.findIndex((node) => node.id === source.id)] = {
      ...source,
      params,
      pid: sectionId,
      ui: { ...source.ui, position: { x: padding.left, y: padding.top } },
    };
    for (let index = 1; index < amount; index++) {
      const id = nextId();
      nodeIds.push(id);
      executable.push(id);
      graph.nodes.push({
        id,
        type: 'NODE_TYPE_GENERATE_IMAGE',
        name: source.name,
        params: structuredClone(params),
        inputMount: structuredClone(source.inputMount ?? []),
        nodeAssets: [],
        pid: sectionId,
        ui: { position: { x: padding.left, y: padding.top + index * 427 } },
      });
      for (const edge of inbound)
        graph.edges.push({
          id: nextId(),
          source: { ...edge.source },
          target: { ...edge.target, nodeId: id },
        });
    }
    graph.nodes.push({
      id: sectionId,
      type: 'NODE_TYPE_SECTION',
      name: 'Section',
      params: {},
      ui: {
        position: { x: origin.x - padding.left, y: origin.y - padding.top },
        size: {
          width: padding.left + 303 + padding.right,
          height: padding.top + amount * 303 + (amount - 1) * 124 + padding.bottom,
        },
      },
    });
    expansions.push({
      source_node_id: source.id,
      requested_amount: amount,
      section_id: sectionId,
      node_ids: nodeIds,
    });
  }
  if (expansions.length)
    graph.nodes = [
      ...graph.nodes.filter((node) => node.type === 'NODE_TYPE_SECTION'),
      ...graph.nodes.filter((node) => node.type !== 'NODE_TYPE_SECTION'),
    ];
  return { executable_node_ids: [...new Set(executable)], expansions };
}
