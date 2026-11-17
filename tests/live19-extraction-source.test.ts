/** 换图须对应网页清理拆分参数的监听器，且不把移动/重签名或撤销当作又一次换源。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editCanvas } from '../cli/local/canvas-edit.ts';
import {
  extractionSourceIdentities,
  resetChangedExtractionSources,
} from '../cli/local/canvas-extraction-source.ts';
import { canvasSaveSchema } from '../studio/api/canvas.ts';
import { array, object } from '../studio/contracts/errors.ts';
import { extractionPlan, extractionPlanSchema } from '../studio/api/canvas-extraction-plan.ts';

function fixture(): Parameters<typeof editCanvas>[0] {
  return {
    kind: 'ai-modeling.canvas.graph',
    version: 1,
    source_sha256: 'a'.repeat(64),
    undo: [],
    redo: [],
    graph: canvasSaveSchema.parse({
      canvasId: 'canvas',
      clientId: 'client',
      revision: '9',
      nodes: [
        {
          id: 'upload',
          type: 'NODE_TYPE_UPLOAD_CARD',
          params: { assetType: 'image' },
          inputMount: [
            { assetId: 'old', filename: 'source.png', url: 'https://cdn.tripo3d.ai/a.png?signature=old' },
          ],
        },
        {
          id: 'other-upload',
          type: 'NODE_TYPE_UPLOAD_CARD',
          params: { assetType: 'image' },
          inputMount: [{ assetId: 'other', filename: 'source.png' }],
        },
        {
          id: 'split',
          type: 'NODE_TYPE_SEMANTIC_SPLIT',
          params: {
            split_mode: 'manual',
            amount: 3,
            model_version: 'model',
            scale: '1:1',
            candidate_titles: ['old head'],
            manual_titles: ['manual'],
            auto_titles: ['auto'],
          },
          extraction: { detectedParts: ['old head'], detectionStale: false },
        },
        {
          id: 'unrelated',
          type: 'NODE_TYPE_SEMANTIC_SPLIT',
          params: { split_mode: 'manual', manual_titles: ['keep'] },
        },
      ],
      edges: [
        {
          id: 'edge',
          source: { nodeId: 'upload', port: 'image' },
          target: { nodeId: 'split', port: 'image' },
        },
        {
          id: 'other-edge',
          source: { nodeId: 'other-upload', port: 'image' },
          target: { nodeId: 'unrelated', port: 'image' },
        },
      ],
    }),
  };
}
const expected = { split_mode: 'auto', detect_list_stale: true };
const target = (state: Parameters<typeof editCanvas>[0]) =>
  state.graph.nodes.find((node) => node.id === 'split')!;

test('same-type replacement resets only the affected executor and prepares a stale independent save', () => {
  const original = fixture(),
    before = structuredClone(original);
  const edited = editCanvas(original, [
    { action: 'replace_upload', node_id: 'upload', asset_id: 'new', kind: 'image' },
  ]);
  assert.deepEqual(target(edited.state).params, expected);
  assert.deepEqual(edited.state.graph.nodes.find((node) => node.id === 'unrelated')!.params, {
    split_mode: 'manual',
    manual_titles: ['keep'],
  });
  const reset = object(array(object(edited.receipts[0]).extraction_source_resets)[0]);
  assert.equal(reset.previous_source, 'upload:old');
  assert.equal(reset.source, 'upload:new');
  assert.ok(array(reset.cleared_parameter_keys).includes('model_version'));
  assert.deepEqual(edited.state.graph.edges, before.graph.edges);
  assert.equal(edited.state.graph.revision, '9');
  assert.deepEqual(original, before);
  const plan = extractionPlan(
    {
      canvas: { canvasId: 'canvas', revision: '9' },
      nodes: edited.state.graph.nodes,
      edges: edited.state.graph.edges,
    },
    [],
    extractionPlanSchema.parse({ canvasId: 'canvas', nodeId: 'split', action: 'generate' }),
  );
  assert.equal(plan.blocked, 'detection_stale');
  assert.deepEqual(object(plan.state).parts, []);
});

test('a disconnect/connect batch retains the previous source identity and reset is part of undo/redo', () => {
  const original = fixture();
  const edited = editCanvas(original, [
    { action: 'disconnect', edge_ids: ['edge'] },
    {
      action: 'connect',
      edge: {
        id: 'new-edge',
        source: { nodeId: 'other-upload', port: 'image' },
        target: { nodeId: 'split', port: 'image' },
      },
    },
  ]);
  assert.deepEqual(target(edited.state).params, expected);
  assert.equal(object(edited.receipts[0]).extraction_source_resets, undefined);
  assert.equal(array(object(edited.receipts[1]).extraction_source_resets).length, 1);
  const undo = editCanvas(edited.state, [{ action: 'undo' }]).state;
  assert.deepEqual(target(undo).params, target(original).params);
  assert.equal(
    undo.graph.edges.some((edge) => edge.target.nodeId === 'split'),
    false,
  );
  assert.deepEqual(editCanvas(undo, [{ action: 'redo' }]).state.graph, edited.state.graph);
  const restored = editCanvas(edited.state, [
    { action: 'undo' },
    { action: 'undo' },
    { action: 'rename', node_id: 'split', name: 'restored' },
  ]).state;
  assert.deepEqual(target(restored).params, target(original).params);
});

test('same asset, URL renewal, layout, names and unrelated parameters do not reset extraction', () => {
  const original = fixture();
  const edited = editCanvas(original, [
    { action: 'replace_upload', node_id: 'upload', asset_id: 'old', kind: 'image' },
    { action: 'rename', node_id: 'upload', name: 'another name' },
    { action: 'move', node_ids: ['upload', 'split'], offset: { x: 30, y: 50 } },
    { action: 'params', node_id: 'upload', params: { assetType: 'image', irrelevant: 'kept' } },
  ]);
  assert.deepEqual(target(edited.state).params, target(original).params);
  assert.ok(edited.receipts.every((receipt) => !object(receipt).extraction_source_resets));
  const ids = extractionSourceIdentities(original.graph);
  original.graph.nodes[0]!.inputMount![0]!.url = 'https://cdn.tripo3d.ai/a.png?signature=renewed';
  assert.deepEqual(resetChangedExtractionSources(original.graph, ids), []);
});

test('first connection has no prior source and an empty Upload Card is not an effective source', () => {
  const original = fixture();
  original.graph.edges = original.graph.edges.filter((edge) => edge.id !== 'edge');
  const connected = editCanvas(original, [
    {
      action: 'connect',
      edge: {
        id: 'new-edge',
        source: { nodeId: 'upload', port: 'image' },
        target: { nodeId: 'split', port: 'image' },
      },
    },
  ]);
  assert.deepEqual(target(connected.state).params, target(original).params);
  const empty = fixture();
  empty.graph.nodes[0]!.inputMount = [];
  assert.equal(extractionSourceIdentities(empty.graph).get('split'), '');
  const filled = editCanvas(empty, [
    { action: 'replace_upload', node_id: 'upload', asset_id: 'new', kind: 'image' },
  ]);
  assert.deepEqual(target(filled.state).params, target(empty).params);
});

test('generated sources follow the webpage first asset identity and copied executors have no old binding', () => {
  const original = fixture(),
    source = original.graph.nodes[0]!;
  source.type = 'NODE_TYPE_GENERATE_IMAGE';
  source.params = { prompt: 'source' };
  source.inputMount = [];
  source.nodeAssets = [
    { assetId: 'first', selected: false },
    { assetId: 'second', selected: true },
  ];
  const ids = extractionSourceIdentities(original.graph);
  assert.equal(ids.get('split'), 'upload:first');
  source.nodeAssets[0]!.assetId = 'new-first';
  assert.equal(resetChangedExtractionSources(original.graph, ids).length, 1);
  assert.deepEqual(target(original).params, expected);
  const fresh = fixture(),
    copy = editCanvas(fresh, [
      { action: 'duplicate', node_ids: ['split'], offset: { x: 30, y: 50 }, keep_inbound: true },
    ]);
  const cloned = copy.state.graph.nodes.find(
    (node) => !fresh.graph.nodes.some((previous) => previous.id === node.id),
  )!;
  assert.deepEqual(cloned.params, target(fresh).params);
  assert.equal(object(copy.receipts[0]).extraction_source_resets, undefined);
});
