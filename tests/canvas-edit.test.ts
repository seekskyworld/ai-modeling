/** 本地画布编辑必须保留图连接、绝对位置及不可变历史，失败不得污染输入。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { editCanvas, canvasEditOperations } from '../cli/local/canvas-edit.ts';
import { canvasSaveSchema } from '../studio/api/canvas.ts';

function source() {
  const first = randomUUID(),
    second = randomUUID(),
    section = randomUUID();
  const graph = canvasSaveSchema.parse({
    canvasId: randomUUID(),
    clientId: randomUUID(),
    revision: '2',
    nodes: [first, second].map((id, i) => ({
      id,
      type: 'NODE_TYPE_GENERATE_IMAGE',
      name: 'image-' + i,
      params: { prompt: 'robot' },
      ui: { position: { x: i * 500, y: 20 }, size: { width: 300, height: 240 } },
    })),
    edges: [
      {
        id: randomUUID(),
        source: { nodeId: first, port: 'image' },
        target: { nodeId: second, port: 'image' },
      },
    ],
  });
  const state: Parameters<typeof editCanvas>[0] = {
    kind: 'ai-modeling.canvas.graph',
    version: 1,
    source_sha256: 'a'.repeat(64),
    graph,
    undo: [],
    redo: [],
  };
  return { state, first, second, section };
}
test('persisted graph identifiers remain editable without imposing a UUID-only contract', () => {
  const { state } = source();
  state.graph.nodes[0]!.id = 'node:existing_1';
  state.graph.edges[0]!.source.nodeId = 'node:existing_1';
  state.graph = canvasSaveSchema.parse(state.graph);
  const requested = [{ action: 'rename' as const, node_id: 'node:existing_1', name: 'changed' }];
  canvasEditOperations[0]!.schema.parse({
    graph_path: 'graph.json',
    destination_path: 'edited.json',
    actions: requested,
  });
  const edited = editCanvas(state, requested).state;
  assert.equal(edited.graph.nodes[0]!.name, 'changed');
  assert.deepEqual(edited.graph.edges, state.graph.edges);
  assert.equal(state.graph.nodes[0]!.name, 'image-0');
});
test('group, duplicate and ungroup retain connections, membership and absolute positions', () => {
  const { state, first, second, section } = source(),
    original = structuredClone(state);
  const grouped = editCanvas(state, [
    { action: 'group', node_ids: [first, second], name: 'block', section_id: section },
  ]).state;
  const parent = grouped.graph.nodes.find((n) => n.id === section)!;
  for (const original of state.graph.nodes) {
    const child = grouped.graph.nodes.find((n) => n.id === original.id)!;
    assert.equal(child.ui!.position.x + parent.ui!.position.x, original.ui!.position.x);
    assert.equal(child.ui!.position.y + parent.ui!.position.y, original.ui!.position.y);
  }
  const copied = editCanvas(grouped, [
    { action: 'duplicate', node_ids: [section], offset: { x: 1000, y: 0 }, keep_inbound: true },
  ]).state;
  assert.equal(copied.graph.nodes.length, 6);
  assert.equal(copied.graph.edges.length, 2);
  const copies = copied.graph.nodes.filter((n) => !grouped.graph.nodes.some((o) => o.id === n.id));
  const copyParent = copies.find((n) => n.type === 'NODE_TYPE_SECTION')!;
  assert.equal(copies.filter((n) => n.pid === copyParent.id).length, 2);
  const restored = editCanvas(grouped, [{ action: 'ungroup', node_id: section }]).state;
  assert.deepEqual(
    restored.graph.nodes.map((n) => n.ui),
    state.graph.nodes.map((n) => n.ui),
  );
  assert.deepEqual(state, original);
});
test('layout and persistent undo/redo preserve remote identity, params and topology', () => {
  const { state, first, second } = source();
  const arranged = editCanvas(state, [{ action: 'auto_layout', gap: 80 }]).state;
  const a = arranged.graph.nodes.find((n) => n.id === first)!,
    b = arranged.graph.nodes.find((n) => n.id === second)!;
  assert.ok(b.ui!.position.x >= a.ui!.position.x + a.ui!.size!.width + 80);
  assert.deepEqual(arranged.graph.edges, state.graph.edges);
  const undo = editCanvas(JSON.parse(JSON.stringify(arranged)), [{ action: 'undo' }]).state;
  assert.deepEqual(undo.graph, state.graph);
  const redo = editCanvas(undo, [{ action: 'redo' }]).state;
  assert.deepEqual(redo.graph, arranged.graph);
  assert.equal(redo.graph.revision, '2');
});
test('invalid edits do not partially mutate the original graph or history', () => {
  const { state, first, second } = source(),
    original = structuredClone(state);
  assert.throws(
    () =>
      editCanvas(state, [
        { action: 'rename', node_id: first, name: 'temporary' },
        {
          action: 'connect',
          edge: {
            id: randomUUID(),
            source: { nodeId: second, port: 'image' },
            target: { nodeId: first, port: 'image' },
          },
        },
      ]),
    /acyclic/,
  );
  assert.deepEqual(state, original);
  assert.throws(() => editCanvas(state, [{ action: 'undo' }]), /No undo/);
});

test('paste into another canvas remaps IDs and drops inbound links outside the copied selection', () => {
  const original = source(),
    target = source();
  const pasted = editCanvas(target.state, [
    {
      action: 'paste',
      source_graph: original.state.graph,
      node_ids: [original.second],
      offset: { x: 80, y: 80 },
    },
  ]).state;
  assert.equal(pasted.graph.nodes.length, 3);
  assert.equal(pasted.graph.edges.length, target.state.graph.edges.length);
  assert.equal(pasted.graph.canvasId, target.state.graph.canvasId);
  assert.ok(!pasted.graph.nodes.some((n) => n.id === original.second));
  assert.equal(pasted.graph.nodes[2]!.params!.prompt, 'robot');
});

function holySource() {
  const { state } = source();
  state.graph = canvasSaveSchema.parse({
    ...state.graph,
    nodes: [
      { id: 'holy1', type: 'NODE_TYPE_HOLY_MOLLY', params: {} },
      { id: 'holy2', type: 'NODE_TYPE_HOLY_MOLLY', params: {} },
    ],
    edges: [
      {
        id: 'materials',
        source: { nodeId: 'holy1', port: 'html' },
        target: { nodeId: 'holy2', port: 'materials' },
      },
    ],
  });
  return state;
}

test('duplicate and cross-canvas paste reject new unverified HolyMolly materials links atomically', () => {
  const original = holySource(),
    before = structuredClone(original);
  assert.throws(
    () =>
      editCanvas(original, [
        {
          action: 'duplicate',
          node_ids: ['holy1', 'holy2'],
          offset: { x: 80, y: 80 },
          keep_inbound: true,
        },
      ]),
    /Copied HolyMolly connections are unsupported/,
  );
  assert.deepEqual(original, before);
  const target = source().state,
    targetBefore = structuredClone(target);
  assert.throws(
    () =>
      editCanvas(target, [
        {
          action: 'paste',
          source_graph: original.graph,
          node_ids: ['holy1', 'holy2'],
          offset: { x: 80, y: 80 },
        },
      ]),
    /Copied HolyMolly connections are unsupported/,
  );
  assert.deepEqual(target, targetBefore);
  const renamed = editCanvas(original, [
    { action: 'rename', node_id: 'holy1', name: 'Keep saved link' },
  ]).state;
  assert.deepEqual(renamed.graph.edges, original.graph.edges);
  assert.deepEqual(editCanvas(renamed, [{ action: 'undo' }]).state.graph, original.graph);
});

test('copying verified HolyMolly HTML links preserves their topology and Lab context handling', () => {
  const original = holySource();
  original.graph.edges[0]!.target.port = 'html';
  original.graph.nodes.push({ id: 'lab', type: 'NODE_TYPE_AI_3D_LAB', params: { sessionId: 'old' } });
  original.graph.edges.push({
    id: 'to-lab',
    source: { nodeId: 'holy1', port: 'html' },
    target: { nodeId: 'lab', port: 'input' },
  });
  const copied = editCanvas(original, [
    {
      action: 'duplicate',
      node_ids: ['holy1', 'holy2', 'lab'],
      offset: { x: 80, y: 80 },
      keep_inbound: true,
    },
  ]).state;
  assert.equal(copied.graph.nodes.length, 6);
  assert.equal(copied.graph.edges.length, 4);
  assert.equal(copied.graph.edges.filter((edge) => edge.target.port === 'html').length, 2);
  assert.equal(copied.graph.edges.filter((edge) => edge.target.port === 'input').length, 2);
  assert.deepEqual(
    copied.graph.nodes.find((node) => node.type === 'NODE_TYPE_AI_3D_LAB' && node.id !== 'lab')!.params,
    {},
  );
});
