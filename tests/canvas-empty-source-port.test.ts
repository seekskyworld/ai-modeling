/** Saved Agent edges may omit a single output port; validation must not rewrite the original edge. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canvasGraphIssues } from '../studio/api/canvas-graph.ts';
import { readCanvasEditState } from '../cli/local/canvas-edit-state.ts';
import { editCanvas } from '../cli/local/canvas-edit.ts';

const node = (id: string, type: string) => ({ id, type });
const edge = (id: string, source: string, target: string, sourcePort: string, targetPort: string) => ({
  id,
  source: { nodeId: source, port: sourcePort },
  target: { nodeId: target, port: targetPort },
});
function savedAgentGraph() {
  return {
    canvas: { canvasId: 'canvas', projectId: 'project', revision: '18' },
    nodes: [
      ...Array.from({ length: 11 }, (_, i) => node(`game-${i}`, 'NODE_TYPE_HOLY_MOLLY')),
      node('image', 'NODE_TYPE_GENERATE_IMAGE'),
      node('model', 'NODE_TYPE_GENERATE_HD_MODEL'),
      node('texture', 'NODE_TYPE_TEXTURE'),
    ],
    edges: [
      ...[
        [0, 1],
        [1, 2],
        [2, 3],
        [2, 4],
        [4, 5],
        [5, 6],
        [6, 7],
        [7, 8],
      ].map(([from, to], i) => edge(`game-edge-${i}`, `game-${from}`, `game-${to}`, 'html', 'html')),
      edge('image-model', 'image', 'model', '', 'image'),
      edge('model-texture', 'model', 'texture', '', 'model'),
    ],
  };
}

test('the saved fourteen-node Agent graph can be edited while preserving both empty source ports', () => {
  const saved = savedAgentGraph();
  const unchanged = structuredClone(saved);
  const imported = readCanvasEditState({ result: saved }, 'a'.repeat(64), {
    expected_canvas_id: 'canvas',
    expected_project_id: 'project',
    expected_revision: '18',
  });
  const edited = editCanvas(imported.state, [
    { action: 'add', node: { id: 'retopology', type: 'NODE_TYPE_RETOPOLOGY', params: {} } },
    { action: 'connect', edge: edge('texture-retopology', 'texture', 'retopology', 'model', 'model') },
  ]);
  assert.equal(edited.state.graph.nodes.length, 15);
  assert.equal(edited.state.graph.edges.length, 11);
  assert.deepEqual(edited.state.graph.edges.slice(0, 10), saved.edges);
  assert.deepEqual(saved, unchanged);
  const undone = editCanvas(edited.state, [{ action: 'undo' }, { action: 'undo' }]);
  assert.deepEqual(undone.state.graph, imported.state.graph);
});

test('single image and model output types resolve in both saved and active graph validation', () => {
  const graph = savedAgentGraph();
  for (const checkLabState of [false, true])
    assert.deepEqual(canvasGraphIssues(graph.nodes, graph.edges, checkLabState), []);
});

test('a multi-output node cannot infer a view from an empty source port, even when types match', () => {
  const nodes = [node('views', 'NODE_TYPE_MULTIVIEW'), node('model', 'NODE_TYPE_GENERATE_HD_MODEL')];
  for (const targetPort of ['image', 'front', 'images']) {
    assert.deepEqual(canvasGraphIssues(nodes, [edge('views-model', 'views', 'model', '', targetPort)]), [
      'Connection references an invalid node or port.',
    ]);
  }
  assert.deepEqual(canvasGraphIssues(nodes, [edge('front-model', 'views', 'model', 'front', 'image')]), []);
});

test('an explicit wrong source port never falls back to the only output', () => {
  const nodes = [node('image', 'NODE_TYPE_GENERATE_IMAGE'), node('model', 'NODE_TYPE_GENERATE_HD_MODEL')];
  for (const port of ['model', 'output', 'unknown'])
    assert.deepEqual(canvasGraphIssues(nodes, [edge('invalid', 'image', 'model', port, 'image')]), [
      'Connection references an invalid node or port.',
    ]);
});

test('implicit single outputs retain type and required target-port checks', () => {
  const nodes = [node('image', 'NODE_TYPE_GENERATE_IMAGE'), node('texture', 'NODE_TYPE_TEXTURE')];
  assert.deepEqual(canvasGraphIssues(nodes, [edge('wrong-kind', 'image', 'texture', '', 'model')]), [
    'Connection has incompatible port types.',
  ]);
  assert.deepEqual(canvasGraphIssues(nodes, [edge('no-target', 'image', 'texture', '', '')]), [
    'Connection references an invalid node or port.',
  ]);
});

test('empty output inference does not grant output to a section', () => {
  const nodes = [node('section', 'NODE_TYPE_SECTION'), node('model', 'NODE_TYPE_GENERATE_HD_MODEL')];
  assert.deepEqual(canvasGraphIssues(nodes, [edge('invalid', 'section', 'model', '', 'image')]), [
    'Connection references an invalid node or port.',
  ]);
});

test('Lab empty ports still require the selected output rather than a sole unselected asset type', () => {
  const lab = {
    ...node('lab', 'NODE_TYPE_AI_3D_LAB'),
    nodeAssets: [
      {
        assetId: 'model-asset',
        kind: 'ASSET_KIND_MODEL',
        role: 'ASSET_ROLE_CURRENT',
        source: 'ASSET_SOURCE_STUDIO',
        selected: false,
        url: 'https://example.test/model.glb',
      },
    ],
  };
  const nodes = [lab, node('texture', 'NODE_TYPE_TEXTURE')];
  const link = edge('lab-texture', 'lab', 'texture', '', 'model');
  assert.deepEqual(canvasGraphIssues(nodes, [link]), ['Connection references an invalid node or port.']);
  assert.deepEqual(canvasGraphIssues(nodes, [link], false), []);
  lab.nodeAssets[0]!.selected = true;
  assert.deepEqual(canvasGraphIssues(nodes, [link]), []);
});

test('existing system result edges keep their separate empty-port contract', () => {
  assert.deepEqual(
    canvasGraphIssues(
      [node('split', 'NODE_TYPE_SEMANTIC_SPLIT'), node('part', 'NODE_TYPE_SPLIT_RESULT')],
      [edge('system', 'split', 'part', '', '')],
    ),
    [],
  );
});

test('implicit output types do not bypass duplicate target, cycle or Holy material restrictions', () => {
  const nodes = [
    node('a', 'NODE_TYPE_GENERATE_HD_MODEL'),
    node('b', 'NODE_TYPE_GENERATE_HD_MODEL'),
    node('texture', 'NODE_TYPE_TEXTURE'),
    node('uv', 'NODE_TYPE_SMART_UV'),
    node('game', 'NODE_TYPE_HOLY_MOLLY'),
  ];
  assert.deepEqual(
    canvasGraphIssues(nodes, [
      edge('a-t', 'a', 'texture', '', 'model'),
      edge('b-t', 'b', 'texture', '', 'model'),
    ]),
    ['Input port accepts only one connection.'],
  );
  assert.deepEqual(
    canvasGraphIssues(nodes, [
      edge('t-u', 'texture', 'uv', '', 'model'),
      edge('u-t', 'uv', 'texture', '', 'model'),
    ]),
    ['Canvas graph must be acyclic.'],
  );
  assert.deepEqual(canvasGraphIssues(nodes, [edge('t-g', 'texture', 'game', '', 'materials')]), [
    'Connection references an invalid node or port.',
  ]);
});
