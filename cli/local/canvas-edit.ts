/** 网页复制/分组/布局/历史的本地对应；产出 SaveCanvas 输入，由调用方独立保存到原网页接口。 */
import { z } from 'zod';
import { randomUUID, createHash } from 'node:crypto';
import { canvasNode, canvasSaveSchema } from '../../studio/api/canvas.ts';
import { canvasGraphIssues } from '../../studio/api/canvas-graph.ts';
import { readBoundedFile } from '../../studio/files.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import { localTarget, publishLocal } from './files.ts';
import { dimensions, position, place, layoutCanvas, type CanvasGraph } from './canvas-layout.ts';
import { expandCanvasImages } from './canvas-image-plan.ts';
import { planCanvasFragment, remapSectionSources } from './canvas-fragment.ts';
import { replaceCanvasUpload, replaceUploadAction } from './canvas-replace-upload.ts';
import { extractionSourceIdentities, resetChangedExtractionSources } from './canvas-extraction-source.ts';
import type { LocalSpec } from './operations.ts';

// 编辑既有图必须接受与 SaveCanvas 相同的稳定标识；系统节点不保证全部使用 UUID。
const graphId = canvasNode.shape.id;
const ids = z.array(graphId).min(1).max(1000);
const point = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
const actions = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add'), node: canvasNode }).strict(),
  z
    .object({ action: z.literal('delete'), node_ids: ids, keep_children: z.boolean().default(false) })
    .strict(),
  z.object({ action: z.literal('rename'), node_id: graphId, name: z.string().max(500) }).strict(),
  z
    .object({ action: z.literal('params'), node_id: graphId, params: z.record(z.string(), z.json()) })
    .strict(),
  z.object({ action: z.literal('move'), node_ids: ids, offset: point }).strict(),
  replaceUploadAction,
  z
    .object({
      action: z.literal('resize'),
      node_id: graphId,
      width: z.number().positive(),
      height: z.number().positive(),
    })
    .strict(),
  z.object({ action: z.literal('connect'), edge: canvasSaveSchema.shape.edges.element }).strict(),
  z.object({ action: z.literal('disconnect'), edge_ids: ids }).strict(),
  z
    .object({
      action: z.literal('duplicate'),
      node_ids: ids,
      offset: point.default({ x: 80, y: 80 }),
      keep_inbound: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      action: z.literal('group'),
      node_ids: ids,
      name: z.string().max(500).default('Untitled block'),
      section_id: graphId.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('paste'),
      source_graph: canvasSaveSchema,
      node_ids: ids,
      offset: point.default({ x: 80, y: 80 }),
    })
    .strict(),
  z.object({ action: z.literal('ungroup'), node_id: graphId }).strict(),
  z.object({ action: z.literal('auto_layout'), gap: z.number().min(20).max(1000).default(80) }).strict(),
  z
    .object({ action: z.literal('expand_images'), node_ids: ids })
    .strict()
    .describe('Expand selected GenerateImage amount 2–4 into independent nodes; save and run separately.'),
  z.object({ action: z.literal('undo') }).strict(),
  z.object({ action: z.literal('redo') }).strict(),
]);
type Action = z.infer<typeof actions>;
const snapshotSchema = z
  .object({ nodes: canvasSaveSchema.shape.nodes, edges: canvasSaveSchema.shape.edges })
  .strict();
type Snapshot = z.infer<typeof snapshotSchema>;
const stateSchema = z
  .object({
    kind: z.literal('ai-modeling.canvas.graph'),
    version: z.literal(1),
    source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    graph: canvasSaveSchema,
    undo: z.array(snapshotSchema).max(100),
    redo: z.array(snapshotSchema).max(100),
  })
  .strict();
type State = z.infer<typeof stateSchema>;
const schema = z
  .object({
    graph_path: z.string().min(1),
    destination_path: z.string().min(1),
    actions: z.array(actions).min(1).max(200),
  })
  .strict();

function node(graph: CanvasGraph, id: string) {
  const found = graph.nodes.find((n) => n.id === id);
  if (!found) throw new TripoError('INVALID_INPUT', 'Canvas node does not exist: ' + id);
  return found;
}
function descendants(graph: CanvasGraph, selected: string[]): Set<string> {
  selected.forEach((id) => node(graph, id));
  const result = new Set(selected);
  for (let changed = true; changed;) {
    changed = false;
    for (const n of graph.nodes)
      if (n.pid && result.has(n.pid) && !result.has(n.id)) {
        result.add(n.id);
        changed = true;
      }
  }
  return result;
}
function ungroup(graph: CanvasGraph, id: string) {
  const section = node(graph, id);
  if (section.type !== 'NODE_TYPE_SECTION')
    throw new TripoError('INVALID_INPUT', 'Only sections can be ungrouped.');
  for (const child of graph.nodes.filter((n) => n.pid === id)) {
    place(child, position(child).x + position(section).x, position(child).y + position(section).y);
    child.pid = section.pid || '';
  }
  graph.nodes = graph.nodes.filter((n) => n.id !== id);
}
function group(graph: CanvasGraph, action: Extract<Action, { action: 'group' }>) {
  const selected = [...new Set(action.node_ids)].map((id) => node(graph, id));
  const parent = selected[0]!.pid || '';
  if (selected.some((n) => (n.pid || '') !== parent))
    throw new TripoError('INVALID_INPUT', 'Group nodes at the same nesting level.');
  const id = action.section_id ?? randomUUID();
  if (graph.nodes.some((n) => n.id === id))
    throw new TripoError('INVALID_INPUT', 'Section ID already exists.');
  const x = Math.min(...selected.map((n) => position(n).x)) - 40;
  const y = Math.min(...selected.map((n) => position(n).y)) - 80;
  const width = Math.max(...selected.map((n) => position(n).x + dimensions(n).width)) - x + 40;
  const height = Math.max(...selected.map((n) => position(n).y + dimensions(n).height)) - y + 40;
  for (const n of selected) {
    place(n, position(n).x - x, position(n).y - y);
    n.pid = id;
  }
  graph.nodes.push({
    id,
    type: 'NODE_TYPE_SECTION',
    name: action.name,
    pid: parent,
    params: {},
    ui: { position: { x, y }, size: { width, height } },
  });
  return { section_id: id };
}
function absolutePosition(graph: CanvasGraph, id: string) {
  let current = node(graph, id),
    point = { ...position(current) };
  while (current.pid) {
    current = node(graph, current.pid);
    point = { x: point.x + position(current).x, y: point.y + position(current).y };
  }
  return point;
}
function duplicate(graph: CanvasGraph, action: Extract<Action, { action: 'duplicate' }>, source = graph) {
  const sameCanvas = source.canvasId === graph.canvasId;
  const plan = planCanvasFragment(source, descendants(source, action.node_ids));
  const selected = plan.kept,
    mapping = new Map([...selected].map((id) => [id, randomUUID()]));
  const copies = plan.nodes.map((n) => {
    const copy = structuredClone(n);
    copy.id = mapping.get(n.id)!;
    if (copy.nodeAssets)
      copy.nodeAssets = copy.nodeAssets.map((asset) =>
        asset.assetId && !asset.nodeId ? { ...asset, nodeId: n.id } : asset,
      );
    remapSectionSources(copy, mapping);
    if (n.pid && selected.has(n.pid)) copy.pid = mapping.get(n.pid)!;
    else {
      delete copy.pid;
      const origin = absolutePosition(source, n.id);
      place(copy, origin.x + action.offset.x, origin.y + action.offset.y);
    }
    return copy;
  });
  const edges = plan.edges
    .filter(
      (e) =>
        selected.has(e.target.nodeId) &&
        (selected.has(e.source.nodeId) ||
          (sameCanvas &&
            action.keep_inbound &&
            graph.nodes.some((n) => n.id === e.source.nodeId) &&
            plan.byId.get(e.source.nodeId)?.type !== 'NODE_TYPE_AI_3D_LAB' &&
            plan.byId.get(e.target.nodeId)?.type !== 'NODE_TYPE_AI_3D_LAB')),
    )
    .map((e) => ({
      id: randomUUID(),
      source: { ...e.source, nodeId: mapping.get(e.source.nodeId) ?? e.source.nodeId },
      target: { ...e.target, nodeId: mapping.get(e.target.nodeId)! },
    }));
  graph.nodes.push(...copies);
  graph.edges.push(...edges);
  return {
    node_ids: Object.fromEntries(mapping),
    edge_ids: edges.map((e) => e.id),
    detached_upload_ids: [...plan.detached].map((id) => mapping.get(id)!),
    excluded_node_ids: plan.excluded,
  };
}
function remove(graph: CanvasGraph, action: Extract<Action, { action: 'delete' }>) {
  if (action.keep_children)
    for (const id of action.node_ids) if (node(graph, id).type === 'NODE_TYPE_SECTION') ungroup(graph, id);
  const remaining = action.node_ids.filter((id) => graph.nodes.some((n) => n.id === id));
  const removed = descendants(graph, remaining);
  graph.nodes = graph.nodes.filter((n) => !removed.has(n.id));
  graph.edges = graph.edges.filter((e) => !removed.has(e.source.nodeId) && !removed.has(e.target.nodeId));
}
function move(graph: CanvasGraph, action: Extract<Action, { action: 'move' }>) {
  const selected = new Set(action.node_ids);
  for (const id of selected) {
    const n = node(graph, id);
    let parent = n.pid,
      hasSelectedAncestor = false;
    while (parent) {
      if (selected.has(parent)) {
        hasSelectedAncestor = true;
        break;
      }
      parent = node(graph, parent).pid;
    }
    if (!hasSelectedAncestor) place(n, position(n).x + action.offset.x, position(n).y + action.offset.y);
  }
}
function change(graph: CanvasGraph, action: Action): unknown {
  switch (action.action) {
    case 'add':
      graph.nodes.push(structuredClone(action.node));
      break;
    case 'delete':
      remove(graph, action);
      break;
    case 'rename':
      node(graph, action.node_id).name = action.name;
      break;
    case 'params':
      node(graph, action.node_id).params = structuredClone(action.params);
      break;
    case 'move':
      move(graph, action);
      break;
    case 'resize': {
      const n = node(graph, action.node_id);
      n.ui = { position: position(n), size: { width: action.width, height: action.height } };
      break;
    }
    case 'connect': {
      const issues = canvasGraphIssues(graph.nodes, [action.edge]);
      if (issues.length) throw new TripoError('INVALID_INPUT', issues.join(' '));
      graph.edges.push(structuredClone(action.edge));
      break;
    }
    case 'disconnect':
      graph.edges = graph.edges.filter((e) => !action.edge_ids.includes(e.id));
      break;
    case 'duplicate':
      return duplicate(graph, action);
    case 'paste':
      return duplicate(
        graph,
        { action: 'duplicate', node_ids: action.node_ids, offset: action.offset, keep_inbound: true },
        action.source_graph,
      );
    case 'group':
      return group(graph, action);
    case 'ungroup':
      ungroup(graph, action.node_id);
      break;
    case 'auto_layout':
      layoutCanvas(graph, action.gap);
      break;
    case 'expand_images':
      return expandCanvasImages(graph, action.node_ids);
    case 'replace_upload':
      return replaceCanvasUpload(graph, action);
  }
}
function snapshot(graph: CanvasGraph): Snapshot {
  return structuredClone({ nodes: graph.nodes, edges: graph.edges });
}

/** 一批动作先完整校验再写文件；失败时原图和历史不变，撤销不回滚远端任务产物。 */
export function editCanvas(state: State, requested: z.infer<typeof schema>['actions']) {
  const result = structuredClone(state),
    receipts: unknown[] = [];
  let extractionSources = extractionSourceIdentities(result.graph);
  for (const action of requested) {
    if (action.action === 'undo' || action.action === 'redo') {
      const source = action.action === 'undo' ? result.undo : result.redo;
      const target = action.action === 'undo' ? result.redo : result.undo;
      const previous = source.pop();
      if (!previous) throw new TripoError('HISTORY_BOUNDARY', 'No ' + action.action + ' step is available.');
      target.push(snapshot(result.graph));
      Object.assign(result.graph, previous);
      extractionSources = extractionSourceIdentities(result.graph);
    } else {
      const before = snapshot(result.graph);
      const changed = change(result.graph, action);
      const resets = resetChangedExtractionSources(result.graph, extractionSources);
      receipts.push({
        action: action.action,
        result: changed,
        ...(resets.length ? { extraction_source_resets: resets } : {}),
      });
      if (JSON.stringify(before) !== JSON.stringify(snapshot(result.graph))) {
        result.undo.push(before);
        result.undo = result.undo.slice(-100);
        result.redo = [];
      }
    }
    result.graph = canvasSaveSchema.parse(result.graph);
  }
  return { state: result, receipts };
}

export const canvasEditOperations: LocalSpec[] = [
  {
    name: 'canvas_graph_edit',
    group: 'canvas',
    description:
      'edit a saved Canvas graph locally: copy, group, layout, expand image batches, replace uploads and persistent undo/redo; save separately',
    schema,
    run: async (config, input) => {
      const x = schema.parse(input),
        source = await readBoundedFile(x.graph_path, config.inputRoots, 32 * 1024 * 1024);
      const raw = JSON.parse(source.bytes.toString('utf8'));
      const state: State =
        raw.kind === 'ai-modeling.canvas.graph'
          ? stateSchema.parse(raw)
          : {
              kind: 'ai-modeling.canvas.graph',
              version: 1,
              source_sha256: source.sha256,
              graph: canvasSaveSchema.parse(raw),
              undo: [],
              redo: [],
            };
      const target = await localTarget(config.outputDir, x.destination_path, 'json'),
        edited = editCanvas(state, x.actions);
      const bytes = Buffer.from(JSON.stringify(edited.state, null, 2) + '\n');
      return {
        ...(await publishLocal(target, bytes, 'json')),
        canvas_id: state.graph.canvasId,
        revision: state.graph.revision,
        nodes: edited.state.graph.nodes.length,
        edges: edited.state.graph.edges.length,
        graph_sha256: createHash('sha256').update(JSON.stringify(edited.state.graph)).digest('hex'),
        undo_steps: edited.state.undo.length,
        redo_steps: edited.state.redo.length,
        receipts: edited.receipts,
        save_input: edited.state.graph,
        remote_saved: false,
        layout_pixel_equivalent: false,
      };
    },
  },
];
