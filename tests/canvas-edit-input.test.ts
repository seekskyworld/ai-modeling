/** Canvas query output must remain an exact, undoable input to local graph editing. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { readCanvasEditState } from '../cli/local/canvas-edit-state.ts';
import { canvasEditOperations, editCanvas } from '../cli/local/canvas-edit.ts';
import type { Config } from '../cli/core/config.ts';
import { object } from '../studio/contracts/errors.ts';

const sourceHash = 'a'.repeat(64);
function response() {
  return {
    canvas: { canvasId: 'canvas', projectId: 'project', revision: '42', name: 'work' },
    nodes: [
      {
        id: 'node',
        type: 'NODE_TYPE_GENERATE_IMAGE',
        params: {
          prompt: 'old',
          model: 'gpt-image-2.5',
          amount: 2,
          enabled: true,
          seed: 5,
          image_ref: 'remove-me',
          options: { keep: true, replace: 1 },
        },
        nodeAssets: [{ assetId: 'asset', selected: true }],
        ui: { position: { x: 12, y: 24 }, size: null },
      },
    ],
    edges: [],
    nodeRuns: [{ nodeId: 'node', status: 'NODE_STATUS_SUCCEEDED' }],
  };
}

test('Canvas query imports preserve exact identity, graph and revision without copying runtime metadata', () => {
  for (const wrap of [false, true]) {
    const input = response(),
      before = structuredClone(input);
    const imported = readCanvasEditState(wrap ? { result: input } : input, sourceHash, {
      expected_canvas_id: 'canvas',
      expected_project_id: 'project',
      expected_revision: '42',
    });
    const graph = imported.state.graph;
    assert.equal(imported.source_format, 'canvas_response');
    assert.equal(imported.input_envelope, wrap ? 'cli_result' : 'none');
    assert.equal(graph.canvasId, 'canvas');
    assert.equal(graph.projectId, 'project');
    assert.equal(graph.revision, '42');
    assert.match(graph.clientId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(graph.nodes, input.nodes);
    assert.deepEqual(graph.edges, []);
    assert.equal(Object.hasOwn(graph, 'nodeRuns'), false);
    assert.equal(Object.hasOwn(graph, 'canvas'), false);
    assert.equal(imported.state.source_sha256, sourceHash);
    assert.deepEqual(imported.state.undo, []);
    assert.deepEqual(imported.state.redo, []);
    assert.deepEqual(input, before);
  }
});

test('SaveCanvas inputs and edit history retain their client identity and source fingerprint', () => {
  const initial = readCanvasEditState(response(), sourceHash).state;
  const imported = readCanvasEditState(initial.graph, sourceHash);
  assert.equal(imported.source_format, 'save_input');
  assert.deepEqual(imported.state, initial);
  const changed = editCanvas(initial, [{ action: 'rename', node_id: 'node', name: 'new' }]).state;
  const undone = editCanvas(changed, [{ action: 'undo' }]).state;
  const stateInput = readCanvasEditState({ result: undone }, 'b'.repeat(64));
  assert.equal(stateInput.source_format, 'edit_state');
  assert.deepEqual(stateInput.state, undone);
  assert.deepEqual(editCanvas(stateInput.state, [{ action: 'redo' }]).state, changed);
  assert.equal(stateInput.state.graph.clientId, initial.graph.clientId);
  assert.equal(stateInput.state.source_sha256, sourceHash);
});

test('Canvas imports reject incomplete, ambiguous and error responses instead of fabricating an empty graph', () => {
  const invalid: unknown[] = [
    null,
    [],
    { error: { code: 'AUTH_REQUIRED' } },
    { result: response(), error: { code: 'STALE' } },
    { result: { result: response() } },
    { ...response(), isError: true },
    { ...response(), canvasId: 'different' },
    { ...response(), clientId: 'different' },
    { ...response(), canvas: { canvasId: 'canvas', revision: '42' } },
    { ...response(), canvas: { projectId: 'project', revision: '42' } },
    { ...response(), canvas: { canvasId: 'canvas', projectId: 'project', revision: 42 } },
    { ...response(), canvas: { canvasId: 'canvas', projectId: 'project', revision: '' } },
    { ...response(), nodes: undefined },
    { ...response(), edges: undefined },
    { ...response(), nodes: [response().nodes[0], response().nodes[0]] },
    { ...response(), nodes: [{ ...response().nodes[0], unexpected: true }] },
    {
      ...response(),
      edges: [{ id: 'edge', source: { nodeId: 'node' }, target: { nodeId: 'missing' } }],
    },
  ];
  for (const input of invalid) assert.throws(() => readCanvasEditState(input, sourceHash));
  const empty = readCanvasEditState({ ...response(), nodes: [], edges: [] }, sourceHash);
  assert.deepEqual(empty.state.graph.nodes, []);
});

test('Optional input guards match the stored identities and revision without changing either', () => {
  for (const expected of [
    { expected_canvas_id: 'different' },
    { expected_project_id: 'different' },
    { expected_revision: '43' },
  ])
    assert.throws(() => readCanvasEditState(response(), sourceHash, expected), { code: 'CANVAS_CHANGED' });
  const graph = readCanvasEditState(response(), sourceHash).state.graph;
  delete graph.projectId;
  assert.throws(() => readCanvasEditState(graph, sourceHash, { expected_project_id: 'project' }), {
    code: 'CANVAS_CHANGED',
  });
});

test('Reserved JSON keys are rejected before parsing while ordinary own properties remain unchanged', () => {
  const input = response(),
    state = readCanvasEditState(input, sourceHash).state;
  const bad = JSON.parse('{"prompt":"new","__proto__":{"polluted":true}}');
  input.nodes[0]!.params = bad;
  assert.throws(() => readCanvasEditState(input, sourceHash), { code: 'INVALID_INPUT' });
  for (const set of [bad, { options: [bad] }]) {
    const actions = [{ action: 'patch_params' as const, node_id: 'node', set }];
    assert.throws(() => editCanvas(state, actions), { code: 'INVALID_INPUT' });
    assert.equal(
      canvasEditOperations[0]!.schema.safeParse({
        graph_path: 'in.json',
        destination_path: 'out.json',
        actions,
      }).success,
      false,
    );
  }
  const safe = JSON.parse('{"constructor":{"prototype":{"ordinary":true}},"prototype":"ordinary"}');
  const edited = editCanvas(state, [{ action: 'patch_params', node_id: 'node', set: safe }]).state;
  assert.deepEqual(edited.graph.nodes[0]!.params!.constructor, safe.constructor);
  assert.equal(edited.graph.nodes[0]!.params!.prototype, 'ordinary');
  assert.equal(Object.getPrototypeOf(edited.graph.nodes[0]!.params), Object.prototype);
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
  assert.equal(Object.hasOwn(Object.prototype, 'ordinary'), false);
  assert.equal(state.graph.nodes[0]!.params!.prompt, 'old');
  const metadata = z.toJSONSchema(canvasEditOperations[0]!.schema, { target: 'draft-7', io: 'input' });
  assert.equal(object(object(metadata.properties).graph_path).type, 'string');
  assert.equal(object(object(metadata.properties).actions).type, 'array');
});

test('Imported history enforces one bounded timeline and validates every snapshot before editing', () => {
  const state = readCanvasEditState(response(), sourceHash).state;
  const snapshot = { nodes: state.graph.nodes, edges: state.graph.edges };
  state.undo = Array.from({ length: 100 }, () => structuredClone(snapshot));
  state.redo = [structuredClone(snapshot)];
  assert.throws(() => readCanvasEditState(state, sourceHash), /at most 100 total/);
  state.redo = [];
  const imported = readCanvasEditState(state, sourceHash).state;
  const undone = editCanvas(
    imported,
    Array.from({ length: 100 }, () => ({ action: 'undo' as const })),
  ).state;
  assert.equal(undone.undo.length, 0);
  assert.equal(undone.redo.length, 100);
  const reopened = readCanvasEditState(undone, sourceHash).state;
  const redone = editCanvas(
    reopened,
    Array.from({ length: 100 }, () => ({ action: 'redo' as const })),
  ).state;
  assert.deepEqual(readCanvasEditState(redone, sourceHash).state, imported);
  for (const key of ['undo', 'redo'] as const) {
    const invalid = readCanvasEditState(response(), sourceHash).state;
    invalid[key] = [{ nodes: [snapshot.nodes[0]!, snapshot.nodes[0]!], edges: [] }];
    assert.throws(() => readCanvasEditState(invalid, sourceHash), /Duplicate node/);
    invalid[key] = [
      {
        nodes: snapshot.nodes,
        edges: [
          {
            id: 'dangling',
            source: { nodeId: 'node', port: 'image' },
            target: { nodeId: 'missing', port: 'image' },
          },
        ],
      },
    ];
    assert.throws(() => readCanvasEditState(invalid, sourceHash), /invalid node or port/);
  }
});

test('Parameter patches preserve unrelated settings, false/zero/null and explicit top-level deletion', () => {
  const state = readCanvasEditState(response(), sourceHash).state,
    before = structuredClone(state);
  const edited = editCanvas(state, [
    {
      action: 'patch_params',
      node_id: 'node',
      set: { prompt: 'new', seed: 0, enabled: false, image: null, options: { replace: 2 } },
      unset: ['image_ref'],
    },
  ]).state;
  assert.deepEqual(edited.graph.nodes[0]!.params, {
    prompt: 'new',
    model: 'gpt-image-2.5',
    amount: 2,
    enabled: false,
    seed: 0,
    image: null,
    options: { replace: 2 },
  });
  assert.deepEqual(edited.graph.nodes[0]!.nodeAssets, state.graph.nodes[0]!.nodeAssets);
  assert.deepEqual(state, before);
  assert.deepEqual(editCanvas(edited, [{ action: 'undo' }]).state.graph, state.graph);
  const replaced = editCanvas(state, [{ action: 'params', node_id: 'node', params: { prompt: 'only' } }]);
  assert.deepEqual(replaced.state.graph.nodes[0]!.params, { prompt: 'only' });
  state.graph.nodes[0]!.params = null;
  assert.deepEqual(
    editCanvas(state, [{ action: 'patch_params', node_id: 'node', set: { seed: 0 } }]).state.graph.nodes[0]!
      .params,
    { seed: 0 },
  );
});

test('Ambiguous or empty parameter patches fail atomically and unchanged patches retain history', () => {
  const state = readCanvasEditState(response(), sourceHash).state;
  for (const patch of [
    { action: 'patch_params' as const, node_id: 'node' },
    { action: 'patch_params' as const, node_id: 'node', set: { prompt: 'new' }, unset: ['prompt'] },
  ]) {
    assert.throws(() => editCanvas(state, [patch]));
    assert.throws(() =>
      canvasEditOperations[0]!.schema.parse({
        graph_path: 'in.json',
        destination_path: 'out.json',
        actions: [patch],
      }),
    );
  }
  const before = structuredClone(state);
  assert.throws(() =>
    editCanvas(state, [
      { action: 'patch_params', node_id: 'node', set: { prompt: 'first' } },
      { action: 'patch_params', node_id: 'missing', set: { prompt: 'second' } },
    ]),
  );
  assert.deepEqual(state, before);
  assert.deepEqual(
    editCanvas(state, [
      { action: 'patch_params', node_id: 'node', set: { prompt: 'old' }, unset: ['absent'] },
    ]).state,
    state,
  );
});

test('Graph-edit consumes a saved CLI query result, persists undo history and rejects mismatches before output', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-modeling-canvas-edit-input-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config: Config = { dataDir: dir, outputDir: dir, inputRoots: [dir], credentialProfile: 'offline' };
  const source = path.join(dir, 'query.json'),
    bytes = Buffer.from(JSON.stringify({ result: response() }));
  await writeFile(source, bytes);
  const operation = canvasEditOperations[0]!;
  const result = object(
    await operation.run(config, {
      graph_path: source,
      destination_path: 'edited.json',
      expected_canvas_id: 'canvas',
      expected_project_id: 'project',
      expected_revision: '42',
      actions: [{ action: 'patch_params', node_id: 'node', set: { prompt: 'changed' } }],
    }),
  );
  assert.equal(result.remote_saved, false);
  assert.equal(result.source_format, 'canvas_response');
  assert.equal(result.input_envelope, 'cli_result');
  assert.equal(result.undo_steps, 1);
  const stored = JSON.parse(await readFile(String(result.local_path), 'utf8'));
  assert.equal(stored.source_sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(stored.graph.revision, '42');
  assert.equal(stored.graph.nodes[0].params.prompt, 'changed');
  assert.equal(stored.graph.nodes[0].params.model, 'gpt-image-2.5');
  const undone = object(
    await operation.run(config, {
      graph_path: result.local_path,
      destination_path: 'undone.json',
      actions: [{ action: 'undo' }],
    }),
  );
  assert.equal(undone.source_format, 'edit_state');
  assert.equal(undone.redo_steps, 1);
  assert.equal(object(undone.save_input).clientId, stored.graph.clientId);
  assert.deepEqual(object(undone.save_input).nodes, response().nodes);
  await assert.rejects(
    operation.run(config, {
      graph_path: source,
      destination_path: 'mismatch.json',
      expected_revision: '43',
      actions: [{ action: 'rename', node_id: 'node', name: 'changed' }],
    }),
    { code: 'CANVAS_CHANGED' },
  );
  await assert.rejects(access(path.join(dir, 'mismatch.json')), { code: 'ENOENT' });
  await assert.rejects(
    operation.run(config, {
      graph_path: source,
      destination_path: 'edited.json',
      actions: [{ action: 'rename', node_id: 'node', name: 'different' }],
    }),
    { code: 'OUTPUT_EXISTS' },
  );
});
