/** 素材替换必须按网页类型清理出边，保留其余节点状态并维持可撤销的独立保存输入。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editCanvas, canvasEditOperations } from '../cli/local/canvas-edit.ts';
import { canvasSaveSchema } from '../studio/api/canvas.ts';
import { replaceUploadAction } from '../cli/local/canvas-replace-upload.ts';
import { object } from '../studio/contracts/errors.ts';

const transform = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1];
function graph(kind: 'image' | 'model' = 'image'): Parameters<typeof editCanvas>[0] {
  return {
    kind: 'ai-modeling.canvas.graph',
    version: 1,
    source_sha256: 'a'.repeat(64),
    undo: [],
    redo: [],
    graph: canvasSaveSchema.parse({
      canvasId: 'canvas',
      clientId: 'client',
      revision: '5',
      nodes: [
        {
          id: 'upload',
          type: 'NODE_TYPE_UPLOAD_CARD',
          name: 'retain name',
          params: {
            assetType: kind,
            extra: 'retain',
            uploadSource: { assetId: 'old', format: 'fbx', transformMatrix: transform },
          },
          inputMount: [
            { assetId: 'old', kind: `ASSET_KIND_${kind.toUpperCase()}`, url: 'https://example.test/old' },
          ],
          nodeAssets: [{ assetId: 'retained-node-asset' }],
          ui: { position: { x: 100, y: 200 } },
        },
        {
          id: 'target',
          type: kind === 'image' ? 'NODE_TYPE_GENERATE_HD_MODEL' : 'NODE_TYPE_RIGGING',
          params: {},
        },
        { id: 'lab', type: 'NODE_TYPE_AI_3D_LAB' },
        { id: 'unrelated', type: 'NODE_TYPE_GENERATE_IMAGE' },
      ],
      edges: [
        {
          id: 'typed',
          source: { nodeId: 'upload', port: 'image' },
          target: { nodeId: 'target', port: kind },
        },
        {
          id: 'lab-edge',
          source: { nodeId: 'upload', port: 'image' },
          target: { nodeId: 'lab', port: 'input' },
        },
      ],
    }),
  };
}

test('Replacing an image by a model removes incompatible output edges and returns independent Save input', () => {
  const state = graph(),
    before = structuredClone(state);
  const action = replaceUploadAction.parse({
    action: 'replace_upload',
    node_id: 'upload',
    asset_id: 'new',
    kind: 'model',
    format: 'glb',
    transformation: transform,
    expected_asset_ids: ['old'],
  });
  canvasEditOperations[0]!.schema.parse({
    graph_path: 'graph.json',
    destination_path: 'next.json',
    actions: [action],
  });
  const result = editCanvas(state, [action]),
    next = result.state.graph.nodes[0]!;
  assert.deepEqual(next.inputMount, [{ assetId: 'new' }]);
  assert.deepEqual(next.params, {
    assetType: 'model',
    extra: 'retain',
    uploadSource: { assetId: 'new', format: 'glb', transformMatrix: transform },
  });
  assert.deepEqual(next.nodeAssets, before.graph.nodes[0]!.nodeAssets);
  assert.deepEqual(next.ui, before.graph.nodes[0]!.ui);
  assert.equal(next.name, 'retain name');
  assert.deepEqual(
    result.state.graph.edges.map((edge) => edge.id),
    ['lab-edge'],
  );
  assert.equal(result.state.graph.revision, '5');
  assert.deepEqual(object(object(result.receipts[0]).result).removed_edge_ids, ['typed']);
  assert.equal(object(object(result.receipts[0]).result).remote_saved, false);
  assert.deepEqual(state, before);
});

test('Replacing a model by an image removes its stale model uploadSource and keeps unrelated state', () => {
  const result = editCanvas(graph('model'), [
    { action: 'replace_upload', node_id: 'upload', asset_id: 'image', kind: 'image' },
  ]);
  assert.deepEqual(result.state.graph.nodes[0]!.params, { assetType: 'image', extra: 'retain' });
  assert.deepEqual(
    result.state.graph.edges.map((edge) => edge.id),
    ['lab-edge'],
  );
});

test('Replacing by the same media type retains compatible edges and omission of a matrix does not reuse the old rotation', () => {
  const original = graph('model');
  const result = editCanvas(original, [
    { action: 'replace_upload', node_id: 'upload', asset_id: 'other', kind: 'model', format: 'obj' },
  ]);
  assert.deepEqual(result.state.graph.edges, original.graph.edges);
  assert.deepEqual(result.state.graph.nodes[0]!.params!.uploadSource, { assetId: 'other', format: 'obj' });
});

test('Replacement checks observed attachment identities atomically, while empty expectations permit an empty Upload Card', () => {
  const original = graph(),
    before = structuredClone(original);
  assert.throws(
    () =>
      editCanvas(original, [
        {
          action: 'replace_upload',
          node_id: 'upload',
          asset_id: 'new',
          kind: 'image',
          expected_asset_ids: ['changed'],
        },
      ]),
    { code: 'CANVAS_CHANGED' },
  );
  assert.deepEqual(original, before);
  original.graph.nodes[0]!.inputMount = [];
  assert.equal(
    editCanvas(original, [
      { action: 'replace_upload', node_id: 'upload', asset_id: 'new', kind: 'image', expected_asset_ids: [] },
    ]).state.graph.nodes[0]!.inputMount![0]!.assetId,
    'new',
  );
});

test('Replacement is persistently undoable and malformed image/model inputs never partially edit a graph', () => {
  const original = graph();
  const changed = editCanvas(original, [
    {
      action: 'replace_upload',
      node_id: 'upload',
      asset_id: 'new',
      kind: 'model',
      transformation: transform,
    },
  ]);
  const undo = editCanvas(changed.state, [{ action: 'undo' }]);
  assert.deepEqual(undo.state.graph, original.graph);
  assert.deepEqual(editCanvas(undo.state, [{ action: 'redo' }]).state.graph, changed.state.graph);
  assert.throws(
    () =>
      editCanvas(original, [{ action: 'replace_upload', node_id: 'target', asset_id: 'new', kind: 'image' }]),
    { code: 'INVALID_INPUT' },
  );
  for (const extra of [{ format: 'glb' }, { transformation: transform }])
    assert.equal(
      replaceUploadAction.safeParse({
        action: 'replace_upload',
        node_id: 'upload',
        asset_id: 'new',
        kind: 'image',
        ...extra,
      }).success,
      false,
    );
});

test('Replacement applies current catalog node and asset-kind restrictions without a network call', () => {
  const original = graph();
  const catalog = {
    nodeDefinitionsVersion: 'caller-version',
    nodeDefinitions: [
      {
        nodeType: 'NODE_TYPE_UPLOAD_CARD',
        userDownstreamNodeTypes: ['NODE_TYPE_GENERATE_HD_MODEL', 'NODE_TYPE_AI_3D_LAB'],
      },
      {
        nodeType: 'NODE_TYPE_GENERATE_HD_MODEL',
        inputPorts: [{ portId: 'image', valueType: 'PORT_VALUE_TYPE_IMAGE' }],
      },
      {
        nodeType: 'NODE_TYPE_AI_3D_LAB',
        inputPorts: [{ portId: 'input', valueType: 'PORT_VALUE_TYPE_ANY' }],
      },
    ],
    nodeConnections: [
      {
        nodeType: 'NODE_TYPE_UPLOAD_CARD',
        downstreamNodeTypes: ['NODE_TYPE_GENERATE_HD_MODEL', 'NODE_TYPE_AI_3D_LAB'],
        upstreamNodeTypes: [],
        downstreamByAssetKind: [
          { assetKind: 'ASSET_KIND_IMAGE', downstreamNodeTypes: ['NODE_TYPE_AI_3D_LAB'] },
        ],
      },
    ],
  };
  const result = editCanvas(original, [
    replaceUploadAction.parse({
      action: 'replace_upload',
      node_id: 'upload',
      asset_id: 'new',
      kind: 'image',
      catalog,
    }),
  ]);
  assert.deepEqual(
    result.state.graph.edges.map((edge) => edge.id),
    ['lab-edge'],
  );
  assert.equal(object(object(result.receipts[0]).result).capability_source, 'caller_catalog:caller-version');
});

test('Replacement honors single/multiview input modes and removes direct Upload Card to Animation edges', () => {
  const original = graph();
  original.graph.nodes[1]!.params = { input_mode: 'multi' };
  const removed = editCanvas(original, [
    { action: 'replace_upload', node_id: 'upload', asset_id: 'new', kind: 'image' },
  ]);
  assert.deepEqual(
    removed.state.graph.edges.map((edge) => edge.id),
    ['lab-edge'],
  );
  original.graph.edges[0]!.target.port = 'front';
  assert.equal(
    editCanvas(original, [{ action: 'replace_upload', node_id: 'upload', asset_id: 'new', kind: 'image' }])
      .state.graph.edges.length,
    2,
  );
  const model = graph('model');
  model.graph.nodes[1]!.type = 'NODE_TYPE_ANIMATION';
  assert.deepEqual(
    editCanvas(model, [
      { action: 'replace_upload', node_id: 'upload', asset_id: 'new', kind: 'model' },
    ]).state.graph.edges.map((edge) => edge.id),
    ['lab-edge'],
  );
});
