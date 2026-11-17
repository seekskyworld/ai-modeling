/** 网页输入素材链回归：转换后的字节、Import 的字段和受理后 READY 查询必须一致。 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { S3Client, type PutObjectCommand } from '@aws-sdk/client-s3';
import { canvasUploadOptionsSchema, uploadCanvasFile } from '../studio/api/canvas-upload.ts';
import { StudioClient } from '../studio/api/client.ts';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { object } from '../studio/contracts/errors.ts';
import { tinyGlb, quote } from './helpers.ts';
import { submitServiceAction } from '../studio/api/service-actions.ts';
import type { Job } from '../studio/contracts/types.ts';
import { editCanvas, canvasEditOperations } from '../cli/local/canvas-edit.ts';
import { callCanvas, canvasResources, canvasSaveBody, canvasSaveSchema } from '../studio/api/canvas.ts';
import { matchSavedAssets } from '../studio/api/canvas-rebind.ts';
import { validateCanvasVideo } from '../studio/api/canvas-input.ts';
import { canvasGraphIssues } from '../studio/api/canvas-graph.ts';
import { resolveLabInputs, selectLabUpstream } from '../studio/api/canvas-lab-inputs.ts';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function imageGraph(amount: unknown = 3): Parameters<typeof editCanvas>[0] {
  return {
    kind: 'ai-modeling.canvas.graph',
    version: 1,
    source_sha256: 'c'.repeat(64),
    undo: [],
    redo: [],
    graph: canvasSaveSchema.parse({
      canvasId: 'canvas',
      clientId: 'client',
      revision: '8',
      nodes: [
        { id: 'parent', type: 'NODE_TYPE_SECTION', ui: { position: { x: 800, y: 200 } } },
        { id: 'reference', type: 'NODE_TYPE_GENERATE_IMAGE', params: { amount: 1 } },
        {
          id: 'source',
          type: 'NODE_TYPE_GENERATE_IMAGE',
          pid: 'parent',
          name: 'concept',
          params: { amount, prompt: 'a sculpture' },
          ui: { position: { x: 100, y: 200 } },
          inputMount: [{ assetId: 'attached', kind: 'ASSET_KIND_IMAGE' }],
          nodeAssets: [{ assetId: 'old-output', selected: true }],
          displayNo: '8',
          batchId: 'old-batch',
          extraction: { old: true },
          taskInstructions: { old: true },
        },
        { id: 'downstream', type: 'NODE_TYPE_GENERATE_IMAGE' },
      ],
      edges: [
        {
          id: 'inbound',
          source: { nodeId: 'reference', port: 'image' },
          target: { nodeId: 'source', port: 'image' },
        },
        {
          id: 'outbound',
          source: { nodeId: 'source', port: 'image' },
          target: { nodeId: 'downstream', port: 'image' },
        },
      ],
    }),
  };
}

test('Canvas image expansion preserves the original output and world position while clearing copied result identities', () => {
  const original = imageGraph();
  const before = structuredClone(original);
  const requested = [
    { action: 'expand_images' as const, node_ids: ['source', 'source', 'parent', 'missing'] },
  ];
  canvasEditOperations[0]!.schema.parse({
    graph_path: 'caller/graph.json',
    destination_path: 'caller/prepared.json',
    actions: requested,
  });
  const edited = editCanvas(original, requested);
  const graph = edited.state.graph;
  const receipt = object(object(edited.receipts[0]).result);
  const expansion = object((receipt.expansions as unknown[])[0]);
  const group = graph.nodes.find((node) => node.id === expansion.section_id)!;
  const source = graph.nodes.find((node) => node.id === 'source')!;
  const copies = graph.nodes.filter((node) => node.pid === group.id && node.id !== source.id);
  assert.equal(expansion.requested_amount, 3);
  assert.equal(copies.length, 2);
  assert.deepEqual(receipt.executable_node_ids, expansion.node_ids);
  assert.equal(source.params!.amount, 1);
  assert.deepEqual(source.nodeAssets, before.graph.nodes[2]!.nodeAssets);
  assert.equal(source.displayNo, '8');
  assert.equal(group.pid, undefined);
  assert.equal(group.ui!.position.x + source.ui!.position.x, 900);
  assert.equal(group.ui!.position.y + source.ui!.position.y, 400);
  for (const copy of copies) {
    assert.deepEqual(copy.params, { amount: 1, prompt: 'a sculpture' });
    assert.deepEqual(copy.inputMount, source.inputMount);
    assert.deepEqual(copy.nodeAssets, []);
    for (const field of ['displayNo', 'batchId', 'extraction', 'taskInstructions'])
      assert.equal(Object.hasOwn(copy, field), false);
    assert.deepEqual(
      graph.edges.filter((edge) => edge.target.nodeId === copy.id).map((edge) => edge.source),
      [{ nodeId: 'reference', port: 'image' }],
    );
    assert.equal(
      graph.edges.some((edge) => edge.source.nodeId === copy.id),
      false,
    );
  }
  assert.deepEqual(graph.edges.slice(0, 2), before.graph.edges);
  assert.equal(graph.revision, '8');
  assert.equal(new Set([...graph.nodes.map((n) => n.id), ...graph.edges.map((e) => e.id)]).size, 11);
  assert.deepEqual(original, before);
});

test('Canvas expansion is persistently undoable and a second expansion has no new work', () => {
  const original = imageGraph(4);
  const edited = editCanvas(original, [{ action: 'expand_images', node_ids: ['source', 'reference'] }]);
  const result = object(object(edited.receipts[0]).result);
  const repeated = editCanvas(edited.state, [
    { action: 'expand_images', node_ids: result.executable_node_ids as string[] },
  ]);
  assert.deepEqual(object(object(repeated.receipts[0]).result).expansions, []);
  assert.deepEqual(repeated.state, edited.state);
  const undo = editCanvas(JSON.parse(JSON.stringify(edited.state)), [{ action: 'undo' }]);
  assert.deepEqual(undo.state.graph, original.graph);
  assert.deepEqual(editCanvas(undo.state, [{ action: 'redo' }]).state.graph, edited.state.graph);
});

test('Canvas expansion only handles the webpage amount enum and never publishes an oversized partial graph', () => {
  for (const amount of [1, 0, 5, 2.5, '2', null]) {
    const original = imageGraph(amount);
    const result = editCanvas(original, [{ action: 'expand_images', node_ids: ['source'] }]);
    assert.deepEqual(result.state, original);
    assert.deepEqual(object(object(result.receipts[0]).result).executable_node_ids, ['source']);
  }
  const full = imageGraph(4);
  for (let index = full.graph.nodes.length; index < 999; index++)
    full.graph.nodes.push({ id: `node-${index}`, type: 'NODE_TYPE_SECTION', params: {} });
  const before = structuredClone(full);
  assert.throws(() => editCanvas(full, [{ action: 'expand_images', node_ids: ['source'] }]));
  assert.deepEqual(full, before);
});

test('SaveCanvas preserves copied result references so the server can allocate their new asset identities', () => {
  const original = imageGraph(1);
  const edited = editCanvas(original, [
    { action: 'duplicate', node_ids: ['source'], offset: { x: 24, y: 24 }, keep_inbound: true },
  ]);
  const mapping = object(object(object(edited.receipts[0]).result).node_ids);
  const body = canvasSaveBody(edited.state.graph);
  const copy = (body.nodes as Record<string, unknown>[]).find((node) => node.id === mapping.source)!;
  assert.deepEqual(copy.nodeAssets, [{ assetId: 'old-output', selected: true, nodeId: 'source' }]);
  assert.equal(copy.displayNo, undefined);
  assert.equal(copy.inputMount, undefined);
  assert.equal(copy.pid, undefined);
  assert.deepEqual(object(copy.ui).position, { x: 924, y: 424 });
  assert.deepEqual(original.graph.nodes[2]!.nodeAssets, [{ assetId: 'old-output', selected: true }]);
});

test('Saved asset matching uses slot identities rather than result order and leaves ambiguous or conflicting references unresolved', () => {
  const before = [
    { assetId: 'old-image', slotIndex: 0, kind: 'ASSET_KIND_IMAGE' },
    { assetId: 'old-model', slotIndex: 1, kind: 'ASSET_KIND_MODEL' },
    { assetId: 'unchanged', kind: 'ASSET_KIND_IMAGE' },
  ];
  const after = [
    { assetId: 'new-model', slotIndex: 1, kind: 'ASSET_KIND_MODEL' },
    { assetId: 'unchanged', kind: 'ASSET_KIND_IMAGE' },
    { assetId: 'new-image', slotIndex: 0, kind: 'ASSET_KIND_IMAGE' },
  ];
  assert.deepEqual(matchSavedAssets('copy', before, after), {
    mappings: [
      { node_id: 'copy', from_asset_id: 'old-image', to_asset_id: 'new-image' },
      { node_id: 'copy', from_asset_id: 'old-model', to_asset_id: 'new-model' },
    ],
    unresolved: [],
  });
  assert.deepEqual(
    matchSavedAssets('copy', [{ assetId: 'old', kind: 'image' }], [{ assetId: 'new', kind: 'model' }])
      .mappings,
    [],
  );
  assert.deepEqual(
    matchSavedAssets(
      'copy',
      [{ assetId: 'old', kind: 'ASSET_KIND_VIDEO', slotIndex: 0 }],
      [{ assetId: 'new', kind: 'ASSET_KIND_MODEL', slotIndex: 0 }],
    ).mappings,
    [],
  );
  const ambiguous = matchSavedAssets(
    'copy',
    [{ assetId: 'old' }],
    [{ assetId: 'new-a' }, { assetId: 'new-b' }],
  );
  assert.equal(ambiguous.mappings.length, 0);
  assert.equal(ambiguous.unresolved.length, 1);
  assert.equal(
    matchSavedAssets(
      'copy',
      [
        { assetId: 'duplicate', slotIndex: 0 },
        { assetId: 'duplicate', slotIndex: 1 },
      ],
      [
        { assetId: 'new-a', slotIndex: 0 },
        { assetId: 'new-b', slotIndex: 1 },
      ],
    ).mappings.length,
    0,
  );
});

test('Copied Canvas sections rebind included system executors and remove outside source identities', () => {
  const source = imageGraph(1);
  source.graph.nodes[0]!.params = {
    description: 'keep this label',
    cutoutSourceId: 'source',
    extractDetectId: 'source',
    extractSplitId: 'source',
    multiviewSourceId: 'outside',
  };
  const before = structuredClone(source);
  const result = editCanvas(source, [
    { action: 'duplicate', node_ids: ['parent'], offset: { x: 24, y: 24 }, keep_inbound: true },
  ]);
  const ids = object(object(object(result.receipts[0]).result).node_ids);
  const group = result.state.graph.nodes.find((node) => node.id === ids.parent)!;
  assert.deepEqual(group.params, {
    description: 'keep this label',
    cutoutSourceId: ids.source,
    extractDetectId: ids.source,
    extractSplitId: ids.source,
  });
  assert.equal(result.state.graph.nodes.find((node) => node.id === ids.source)!.pid, ids.parent);
  assert.deepEqual(editCanvas(result.state, [{ action: 'undo' }]).state.graph, source.graph);
  assert.deepEqual(source, before);
});

test('Isolated system image results become detached uploads and unfinished results are excluded from copies', () => {
  const original = imageGraph(1);
  original.graph.nodes = [
    {
      id: 'group',
      type: 'NODE_TYPE_SECTION',
      params: { multiviewSourceId: 'views' },
      ui: { position: { x: 700, y: 300 } },
    },
    {
      id: 'views',
      pid: 'group',
      type: 'NODE_TYPE_MULTIVIEW',
      params: {},
      ui: { position: { x: 10, y: 20 } },
    },
    {
      id: 'ready',
      pid: 'group',
      type: 'NODE_TYPE_MULTIVIEW_RESULT',
      params: {},
      name: 'side',
      batchId: 'original',
      ui: { position: { x: 400, y: 20 } },
      nodeAssets: [
        { assetId: 'chosen', kind: 'ASSET_KIND_IMAGE', url: 'https://example.test/side.png', selected: true },
      ],
    },
    { id: 'pending', pid: 'group', type: 'NODE_TYPE_MULTIVIEW_RESULT', params: {} },
  ];
  original.graph.edges = [];
  const before = structuredClone(original);
  const result = editCanvas(original, [
    { action: 'duplicate', node_ids: ['ready', 'pending'], offset: { x: 24, y: 24 }, keep_inbound: true },
  ]);
  const receipt = object(object(result.receipts[0]).result);
  const copy = result.state.graph.nodes.at(-1)!;
  assert.equal(copy.type, 'NODE_TYPE_UPLOAD_CARD');
  assert.equal(copy.pid, undefined);
  assert.equal(copy.nodeAssets, undefined);
  assert.equal(copy.batchId, undefined);
  assert.deepEqual(copy.params, { assetType: 'image' });
  assert.deepEqual(copy.ui!.position, { x: 1124, y: 344 });
  assert.deepEqual(copy.inputMount, [
    { assetId: 'chosen', kind: 'ASSET_KIND_IMAGE', url: 'https://example.test/side.png' },
  ]);
  assert.deepEqual(receipt.excluded_node_ids, ['pending']);
  assert.deepEqual(receipt.detached_upload_ids, [copy.id]);
  assert.deepEqual(original, before);
  const whole = editCanvas(original, [
    { action: 'duplicate', node_ids: ['group'], offset: { x: 24, y: 24 }, keep_inbound: true },
  ]);
  assert.equal(
    whole.state.graph.nodes.filter((node) => node.type === 'NODE_TYPE_MULTIVIEW_RESULT').length,
    4,
  );
});

test('Canvas copies retain UploadCard mounts while dropping external Lab edges and resetting copied Lab contexts', () => {
  const original = imageGraph(1);
  original.graph.nodes = [
    {
      id: 'lab',
      type: 'NODE_TYPE_AI_3D_LAB',
      params: { sessionId: 'old' },
      ui: { position: { x: 0, y: 0 }, size: { width: 800, height: 900 } },
    },
    {
      id: 'upload',
      type: 'NODE_TYPE_UPLOAD_CARD',
      params: { assetType: 'image' },
      inputMount: [{ assetId: 'attachment', kind: 'ASSET_KIND_IMAGE' }],
    },
  ];
  original.graph.edges = [
    { id: 'to-lab', source: { nodeId: 'upload', port: 'image' }, target: { nodeId: 'lab', port: 'input' } },
  ];
  const labOnly = editCanvas(original, [
    { action: 'duplicate', node_ids: ['lab'], offset: { x: 24, y: 24 }, keep_inbound: true },
  ]);
  assert.equal(labOnly.state.graph.edges.length, 1);
  assert.deepEqual(labOnly.state.graph.nodes.at(-1)!.params, {});
  assert.equal(labOnly.state.graph.nodes.at(-1)!.ui!.size, undefined);
  const uploadOnly = editCanvas(original, [
    { action: 'duplicate', node_ids: ['upload'], offset: { x: 24, y: 24 }, keep_inbound: true },
  ]);
  assert.deepEqual(uploadOnly.state.graph.nodes.at(-1)!.inputMount, original.graph.nodes[1]!.inputMount);
});

test('Canvas save only refreshes copied node asset identities and retains its successful receipt when that read fails', async (t) => {
  const resource = canvasResources.find((entry) => entry.name === 'save')!;
  for (const fail of [false, true]) {
    const original = imageGraph(1);
    original.graph.nodes[2]!.nodeAssets = [{ assetId: 'old', nodeId: 'source', kind: 'ASSET_KIND_IMAGE' }];
    const edited = editCanvas(original, [
      { action: 'duplicate', node_ids: ['source'], offset: { x: 24, y: 24 }, keep_inbound: true },
    ]);
    const copyId = String(object(object(object(edited.receipts[0]).result).node_ids).source);
    const f = await fixture(t, (method, body) => {
      if (method === 'SaveCanvas') return { revision: '9', violations: [] };
      assert.equal(method, 'ListNodesAssets');
      assert.deepEqual(body, { nodeIds: [copyId] });
      if (fail) throw new Error('read unavailable');
      return {
        nodes: [{ nodeId: copyId, assets: [{ assetId: 'new', nodeId: copyId, kind: 'ASSET_KIND_IMAGE' }] }],
      };
    });
    const ordinary = object(await callCanvas(f.client, resource, original.graph));
    assert.equal(ordinary.asset_rebindings, undefined);
    assert.deepEqual(f.calls, ['SaveCanvas']);
    const result = object(await callCanvas(f.client, resource, edited.state.graph));
    assert.equal(result.revision, '9');
    assert.equal(f.calls.filter((method) => method === 'SaveCanvas').length, 2);
    if (fail) {
      assert.equal(object(result.asset_rebinding_error).code, 'ASSET_READBACK_FAILED');
      assert.deepEqual(result.asset_rebindings, []);
    } else {
      assert.deepEqual(result.asset_rebindings, [
        { node_id: copyId, from_asset_id: 'old', to_asset_id: 'new' },
      ]);
      assert.deepEqual(result.asset_rebinding_unresolved, []);
    }
    assert.equal(edited.state.graph.nodes.at(-1)!.nodeAssets![0]!.assetId, 'old');
  }
});
const asset = (status: string, kind = 'MODEL') => ({
  assetId: 'input-asset',
  kind: `ASSET_KIND_${kind}`,
  status: `INPUT_ASSET_STATUS_${status}`,
});
async function fixture(
  t: TestContext,
  handler: (method: string, body: Record<string, unknown>, init: RequestInit) => unknown | Promise<unknown>,
  fileBytes = tinyGlb(),
  extension = 'glb',
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tripo-live17-web-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, `original.${extension}`);
  await writeFile(file, fileBytes);
  const uploaded: Buffer[] = [];
  t.mock.method(S3Client.prototype, 'send', async (command: PutObjectCommand) => {
    uploaded.push(Buffer.from(command.input.Body as Buffer));
    return {};
  });
  const calls: string[] = [];
  const bearer =
    'eyJhbGciOiJIUzI1NiJ9.' +
    Buffer.from(JSON.stringify({ sub: 'test-account', exp: Math.floor(Date.now() / 1000) + 3600 })).toString(
      'base64url',
    ) +
    '.fixture';
  const client = new StudioClient(
    new MemoryCredentials({ accountRef: 'test-account', bearer, deviceId: 'device', importedAt: '' }),
    async (url, init) => {
      const body = object(JSON.parse(String(init.body)));
      if (url.endsWith('/temporary_token')) {
        calls.push('temporary_token');
        return Response.json({
          code: 0,
          data: {
            sts_ak: 'fixture',
            sts_sk: 'fixture',
            session_token: 'fixture',
            resource_bucket: 'test',
            resource_uri: 'resources/input',
          },
        });
      }
      assert.equal(url, 'https://msapi.tripo3d.ai/ms/web/api');
      const method = String(object(init.headers)['x-micro-method']).split('/').at(-1)!;
      calls.push(method);
      return Response.json({ error: { code: 0, message: '' }, ...object(await handler(method, body, init)) });
    },
  );
  return { client, file, uploaded, calls };
}

test('Canvas model upload forwards rotation/UV/format then waits for the same accepted asset', async (t) => {
  let reads = 0;
  const transform = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1];
  const f = await fixture(t, (method, body) => {
    if (method === 'ImportInputAssets') {
      assert.deepEqual(body, {
        projectId: 'project',
        objectRefs: [
          {
            resourceUri: 'resources/input',
            originalFilename: 'original.glb',
            sizeBytes: String(tinyGlb().length),
            contentType: 'application/octet-stream',
            format: 'glb',
            transformMatrix: transform,
            useOriginalUv: false,
          },
        ],
      });
      return { assets: [asset('PROCESSING')] };
    }
    assert.equal(method, 'BatchGetInputAssets');
    assert.deepEqual(body, { projectId: 'project', assetIds: ['input-asset'] });
    reads++;
    return { assets: [asset('READY')] };
  });
  const result = object(
    await uploadCanvasFile(f.client, 'project', f.file, [], {
      transformation: transform,
      use_original_uv: false,
      wait_seconds: 3,
    }),
  );
  assert.equal(result.ready, true);
  assert.equal(result.state, 'ready');
  assert.deepEqual(result.input_mount, [{ assetId: 'input-asset' }]);
  assert.deepEqual(object(result.node_params).uploadSource, {
    assetId: 'input-asset',
    format: 'glb',
    transformMatrix: transform,
  });
  assert.equal(result.remote_saved, false);
  assert.equal(object(result.model_face_check).verified, false);
  assert.equal(object(result.model_face_check).face_count, null);
  assert.equal(reads, 1);
  assert.deepEqual(f.calls, ['temporary_token', 'ImportInputAssets', 'BatchGetInputAssets']);
  assert.deepEqual(f.uploaded, [tinyGlb()]);
});

test('Canvas model upload exposes the webpage face precheck without changing original model bytes', async (t) => {
  const bytes = Buffer.from('v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n');
  const f = await fixture(
    t,
    (method, body) => {
      assert.equal(method, 'ImportInputAssets');
      assert.equal(object((body.objectRefs as unknown[])[0]).format, 'obj');
      return { assets: [asset('READY')] };
    },
    bytes,
    'obj',
  );
  const result = object(await uploadCanvasFile(f.client, 'project', f.file, []));
  assert.deepEqual(result.model_face_check, {
    limit: 3_000_000,
    face_count: 2,
    verified: true,
    method: 'web_obj_triangulated_faces',
  });
  assert.deepEqual(f.uploaded, [bytes]);
  assert.equal(result.ready, true);
});

test('Canvas default model registration preserves UVs and reports processing without inventing READY', async (t) => {
  const f = await fixture(t, (method, body) => {
    assert.equal(method, 'ImportInputAssets');
    const ref = object((body.objectRefs as unknown[])[0]);
    assert.deepEqual(ref.transformMatrix, identity);
    assert.equal(ref.useOriginalUv, true);
    return { assets: [asset('PROCESSING')] };
  });
  const result = object(await uploadCanvasFile(f.client, 'project', f.file, []));
  assert.equal(result.state, 'processing');
  assert.equal(result.ready, false);
  assert.equal(result.wait_timed_out, false);
  assert.equal(f.calls.filter((x) => x === 'ImportInputAssets').length, 1);
});

test('Canvas waiting preserves the accepted asset after read errors or mismatched identity without reimport', async (t) => {
  for (const mismatch of [false, true]) {
    const f = await fixture(t, (method) => {
      if (method === 'ImportInputAssets') return { assets: [asset('PROCESSING')] };
      if (mismatch) return { assets: [{ ...asset('READY'), assetId: 'other' }] };
      throw new Error('Connection lost');
    });
    const result = object(await uploadCanvasFile(f.client, 'project', f.file, [], { wait_seconds: 3 }));
    assert.equal(result.state, 'processing');
    assert.equal(object((result.assets as unknown[])[0]).assetId, 'input-asset');
    assert.equal(object(result.poll_error).code, mismatch ? 'CONTRACT_CHANGED' : 'NETWORK_ERROR');
    assert.equal(f.calls.filter((x) => x === 'ImportInputAssets').length, 1);
  }
});

test('Canvas processing wait bounds a slow read and returns the original asset for later polling', async (t) => {
  const f = await fixture(t, async (method, _body, init) => {
    if (method === 'ImportInputAssets') return { assets: [asset('PROCESSING')] };
    await new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    });
  });
  const started = performance.now();
  const result = object(await uploadCanvasFile(f.client, 'project', f.file, [], { wait_seconds: 1 }));
  assert.ok(performance.now() - started < 2500);
  assert.equal(result.wait_timed_out, true);
  assert.equal(result.state, 'processing');
  assert.equal(result.ready, false);
});

test('Canvas failed input and malformed import receipts remain distinct from a successful ready input', async (t) => {
  const f = await fixture(t, () => ({ assets: [{ ...asset('FAILED'), failCode: 'unsupported_model' }] }));
  const result = object(await uploadCanvasFile(f.client, 'project', f.file, [], { wait_seconds: 2 }));
  assert.equal(result.state, 'failed');
  assert.equal(result.ready, false);
  assert.equal(result.wait_timed_out, false);
  for (const receipt of [
    { assets: [] },
    { assets: [asset('READY'), asset('READY')] },
    { assets: [asset('READY', 'IMAGE')] },
  ]) {
    const g = await fixture(t, () => receipt);
    await assert.rejects(uploadCanvasFile(g.client, 'project', g.file, []), {
      code: 'CONTRACT_CHANGED',
      certainty: 'unknown',
    });
  }
});

test('Canvas model-only options reject images and invalid matrices before storage credentials are requested', async (t) => {
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('fixtureIEND')]);
  const f = await fixture(
    t,
    () => {
      assert.fail('No registration expected');
    },
    png,
    'png',
  );
  for (const options of [{ transformation: identity }, { use_original_uv: false }, { transformation: [1] }])
    await assert.rejects(uploadCanvasFile(f.client, 'project', f.file, [], options));
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.uploaded, []);
  assert.throws(() => canvasUploadOptionsSchema.parse({ wait_seconds: 121 }));
});

test('Canvas image registration keeps its image-only request shape and requires the returned actual status', async (t) => {
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('fixtureIEND')]);
  const f = await fixture(
    t,
    (method, body) => {
      assert.equal(method, 'ImportInputAssets');
      const ref = object((body.objectRefs as unknown[])[0]);
      assert.equal(ref.contentType, 'image/png');
      for (const key of ['format', 'transformMatrix', 'useOriginalUv'])
        assert.equal(Object.hasOwn(ref, key), false);
      return { assets: [asset('READY', 'IMAGE')] };
    },
    png,
    'png',
  );
  assert.equal(object(await uploadCanvasFile(f.client, 'project', f.file, [])).state, 'ready');
});

test('Canvas self-contained glTF registration describes the converted GLB bytes rather than the original JSON length', async (t) => {
  const positions = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
  const bytes = Buffer.from(
    JSON.stringify({
      asset: { version: '2.0' },
      buffers: [
        {
          byteLength: positions.length,
          uri: `data:application/octet-stream;base64,${positions.toString('base64')}`,
        },
      ],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.length }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
      scene: 0,
    }),
  );
  let size = 0;
  const f = await fixture(
    t,
    (_method, body) => {
      const ref = object((body.objectRefs as unknown[])[0]);
      assert.equal(ref.format, 'glb');
      size = Number(ref.sizeBytes);
      return { assets: [asset('READY')] };
    },
    bytes,
    'gltf',
  );
  const result = object(await uploadCanvasFile(f.client, 'project', f.file, []));
  assert.equal(f.uploaded[0]!.toString('ascii', 0, 4), 'glTF');
  assert.equal(size, f.uploaded[0]!.length);
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.uploaded_sha256, createHash('sha256').update(f.uploaded[0]!).digest('hex'));
  assert.equal(result.uploaded_format, 'glb');
});

test('Canvas Lab video upload registers original bytes and MIME without model fields and waits for VIDEO readiness', async (t) => {
  const atom = (name: string, content: string) => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(content.length + 8);
    header.write(name, 4, 'ascii');
    return Buffer.concat([header, Buffer.from(content)]);
  };
  const video = Buffer.concat([atom('ftyp', 'isom'), atom('moov', ''), atom('mdat', 'media-fixture')]);
  const f = await fixture(
    t,
    (method, body) => {
      if (method === 'ImportInputAssets') {
        const ref = object((body.objectRefs as unknown[])[0]);
        assert.equal(ref.originalFilename, 'original.mp4');
        assert.equal(ref.contentType, 'video/mp4');
        assert.equal(ref.sizeBytes, String(video.length));
        for (const key of ['format', 'transformMatrix', 'useOriginalUv'])
          assert.equal(Object.hasOwn(ref, key), false);
        return { assets: [asset('PROCESSING', 'VIDEO')] };
      }
      assert.equal(method, 'BatchGetInputAssets');
      return { assets: [asset('READY', 'VIDEO')] };
    },
    video,
    'mp4',
  );
  const result = object(await uploadCanvasFile(f.client, 'project', f.file, [], { wait_seconds: 2 }));
  assert.equal(result.ready, true);
  assert.equal(result.uploaded_format, 'mp4');
  assert.equal(result.lab_asset_id, 'input-asset');
  assert.equal(result.node_params, undefined);
  assert.deepEqual(f.uploaded, [video]);
  assert.equal(result.sha256, result.uploaded_sha256);
  assert.throws(() => validateCanvasVideo(video.subarray(0, -1), 'mp4'));
  assert.throws(() => validateCanvasVideo(video, 'avi'));
  assert.throws(() => validateCanvasVideo(Buffer.from('<html>this is not media</html>'), 'mp4'));
  const calls = [...f.calls];
  await assert.rejects(uploadCanvasFile(f.client, 'project', f.file, [], { use_original_uv: false }), {
    code: 'INVALID_INPUT',
  });
  assert.deepEqual(f.calls, calls);
});

test('historical lightweight export reads and authorizes only the fixed original operator', async () => {
  for (const mismatch of ['none', 'operator', 'project']) {
    const requests: { route: string; body: unknown }[] = [];
    const client = new StudioClient(
      new MemoryCredentials({
        accountRef: 'test-account',
        cookie: 'fixture',
        deviceId: 'device',
        importedAt: '',
      }),
      async (url, init) => {
        const route = new URL(url).pathname + new URL(url).search;
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({ route, body });
        if (init.method === 'GET') {
          assert.equal(route, '/v2/studio/project/detail/v3/project?operator_id=historical');
          return Response.json({
            code: 0,
            data: {
              id: mismatch === 'project' ? 'other' : 'project',
              is_owner: true,
              operator: {
                operator_id: mismatch === 'operator' ? 'latest' : 'historical',
                is_latest_operator: false,
              },
            },
          });
        }
        assert.equal(route, '/v2/studio/operation/export-lite');
        assert.deepEqual(body, {
          project_id: 'project',
          operator_id: 'historical',
          is_owner: true,
          format: 'gltf',
        });
        return Response.json({ code: 0, data: {} });
      },
    );
    const job: Job = {
      job_id: 'job',
      account_ref: 'test-account',
      request_id: 'request',
      input_hash: 'input',
      operation: 'export_lite',
      input: { project_id: 'project', operator_id: 'historical', format: 'glb' },
      contract_version: 'test',
      state: 'submitting',
      remote_ids: {},
      quote,
      progress: 0,
      artifacts: [],
      created_at: '',
      updated_at: '',
      lease_until: 0,
    };
    if (mismatch === 'none') {
      const result = await submitServiceAction(client, job);
      assert.equal(result.status.state, 'succeeded');
      assert.deepEqual(result.status.artifacts, []);
      assert.equal(requests.length, 2);
    } else {
      await assert.rejects(submitServiceAction(client, job), {
        code: mismatch === 'operator' ? 'PROJECT_CHANGED' : 'CONTRACT_CHANGED',
      });
      assert.equal(requests.length, 1);
    }
    assert.equal(
      requests.some((request) => request.route === '/v2/studio/operation/export'),
      false,
    );
  }
});

test('Canvas video references cannot be mistaken for image inputs to a model generator', () => {
  const upload = {
    id: 'video',
    type: 'NODE_TYPE_UPLOAD_CARD',
    inputMount: [
      {
        assetId: 'clip',
        kind: 'ASSET_KIND_VIDEO',
        filename: 'clip.mp4',
        url: 'https://example.test/clip.mp4',
      },
    ],
  };
  const target = { id: 'model', type: 'NODE_TYPE_GENERATE_HD_MODEL' };
  const edge = {
    id: 'edge',
    source: { nodeId: 'video', port: 'image' },
    target: { nodeId: 'model', port: 'image' },
  };
  assert.ok(canvasGraphIssues([upload, target], [edge]).length > 0);
});

test('Lab input selection preserves multiview slot order and honors selected Studio outputs and applied animation state', () => {
  const images = [
    { assetId: 'back', slotIndex: 2, role: 'ASSET_ROLE_CURRENT', kind: 'ASSET_KIND_IMAGE' },
    { assetId: 'front', slotIndex: 0, role: 'ASSET_ROLE_CURRENT', kind: 'ASSET_KIND_IMAGE' },
    { assetId: 'old', slotIndex: 1, role: 'ASSET_ROLE_SUPERSEDED', kind: 'ASSET_KIND_IMAGE' },
  ];
  assert.deepEqual(
    selectLabUpstream({ type: 'NODE_TYPE_MULTIVIEW', nodeAssets: images }, {}).map((x) => x.asset_id),
    ['front', 'back'],
  );
  const labs = [
    {
      assetId: 'old',
      role: 'ASSET_ROLE_SUPERSEDED',
      source: 'ASSET_SOURCE_STUDIO',
      kind: 'ASSET_KIND_MODEL',
      selected: true,
    },
    {
      assetId: 'generated-file',
      role: 'ASSET_ROLE_CURRENT',
      source: 'ASSET_SOURCE_LAB',
      kind: 'ASSET_KIND_MODEL',
      selected: true,
    },
    {
      assetId: 'chosen',
      role: 'ASSET_ROLE_CURRENT',
      source: 'ASSET_SOURCE_STUDIO',
      kind: 'ASSET_KIND_MODEL',
      selected: true,
    },
    { assetId: 'other', role: 'ASSET_ROLE_CURRENT', source: 'ASSET_SOURCE_STUDIO', kind: 'ASSET_KIND_MODEL' },
  ];
  assert.deepEqual(
    selectLabUpstream({ type: 'NODE_TYPE_AI_3D_LAB', nodeAssets: labs }, {}).map((x) => x.asset_id),
    ['chosen'],
  );
  const animation = { type: 'NODE_TYPE_ANIMATION', params: { animation_applied: true }, nodeAssets: labs };
  assert.deepEqual(selectLabUpstream(animation, { status: 'NODE_STATUS_RUNNING' }), []);
  assert.equal(selectLabUpstream(animation, { status: 'NODE_STATUS_DONE' }).length, 1);
});

test('Lab input resolver combines new upstream assets and explicit attachments after reading historical inputs without submitting a job', async (t) => {
  const nodes = [
    { id: 'lab', type: 'NODE_TYPE_AI_3D_LAB' },
    { id: 'upstream', type: 'NODE_TYPE_MULTIVIEW' },
    {
      id: 'upload',
      type: 'NODE_TYPE_UPLOAD_CARD',
      params: { assetType: 'image' },
      inputMount: [{ assetId: 'attached' }],
    },
  ];
  const f = await fixture(t, (method, body) => {
    if (method === 'GetCanvas')
      return {
        canvas: { canvasId: 'canvas', projectId: 'project', revision: '8' },
        nodes,
        edges: [
          { source: { nodeId: 'upstream' }, target: { nodeId: 'lab' } },
          { source: { nodeId: 'upload' }, target: { nodeId: 'lab' } },
          { source: { nodeId: 'upstream' }, target: { nodeId: 'lab' } },
        ],
      };
    if (method === 'ListNodesAssets') {
      assert.deepEqual(body.nodeIds, ['upstream']);
      return {
        nodes: [
          {
            nodeId: 'upstream',
            assets: [
              {
                nodeId: 'upstream',
                assetId: 'used',
                slotIndex: 0,
                kind: 'ASSET_KIND_IMAGE',
                role: 'ASSET_ROLE_CURRENT',
              },
              {
                nodeId: 'upstream',
                assetId: 'fresh',
                slotIndex: 1,
                kind: 'ASSET_KIND_IMAGE',
                role: 'ASSET_ROLE_CURRENT',
              },
            ],
          },
        ],
      };
    }
    if (method === 'BatchGetInputAssets')
      return {
        assets: [{ assetId: 'attached', status: 'INPUT_ASSET_STATUS_READY', kind: 'ASSET_KIND_IMAGE' }],
      };
    if (method === 'ListLabJobs') return { jobs: [{ jobId: 'history' }] };
    assert.equal(method, 'GetLabJob');
    return { jobId: 'history', nodeId: 'lab', inputs: [{ assetId: 'used' }] };
  });
  const result = object(
    await resolveLabInputs(f.client, {
      canvasId: 'canvas',
      nodeId: 'lab',
      revision: '8',
      assetIds: ['used', 'video-explicit', 'fresh'],
    }),
  );
  assert.deepEqual(result.asset_ids, ['fresh', 'attached', 'used', 'video-explicit']);
  assert.deepEqual(result.already_used_asset_ids, ['used']);
  assert.equal(result.missing, false);
  assert.equal(result.history_complete, null);
  assert.equal(result.observed_history_complete, true);
  assert.equal(result.history_scope, 'returned_jobs_only');
  assert.equal(result.history_query_limit, null);
  assert.equal(result.execution_started, false);
  assert.equal(f.calls.includes('CreateLabJob'), false);
  assert.equal(f.calls.includes('SaveCanvas'), false);
  const before = f.calls.length;
  await assert.rejects(resolveLabInputs(f.client, { canvasId: 'canvas', nodeId: 'lab', revision: '7' }), {
    code: 'CANVAS_CHANGED',
  });
  assert.equal(f.calls.length, before + 1);
});

test('Lab input resolver exposes missing current-project inputs and unreadable history instead of claiming complete preparation', async (t) => {
  const f = await fixture(t, (method) => {
    if (method === 'GetCanvas')
      return {
        canvas: { canvasId: 'canvas', projectId: 'project', revision: '8' },
        nodes: [
          { id: 'lab', type: 'NODE_TYPE_AI_3D_LAB' },
          { id: 'upload', type: 'NODE_TYPE_UPLOAD_CARD', inputMount: [{ assetId: 'foreign' }] },
        ],
        edges: [{ source: { nodeId: 'upload' }, target: { nodeId: 'lab' } }],
      };
    if (method === 'BatchGetInputAssets') return { assets: [] };
    if (method === 'ListLabJobs') return { jobs: [{ jobId: 'history' }] };
    throw new Error('History unavailable');
  });
  const result = object(await resolveLabInputs(f.client, { canvasId: 'canvas', nodeId: 'lab' }));
  assert.equal(result.missing, true);
  assert.equal(result.history_complete, false);
  assert.equal(result.observed_history_complete, false);
  assert.deepEqual(result.asset_ids, []);
  assert.deepEqual(result.unresolved_history_job_ids, ['history']);
  assert.ok(
    (result.missing_inputs as unknown[]).some((x) => object(x).reason === 'input_asset_not_ready_in_project'),
  );
});

test('Lab history limits and pagination markers never claim exhaustive historical input coverage', async (t) => {
  const f = await fixture(t, (method, body) => {
    if (method === 'GetCanvas')
      return {
        canvas: { canvasId: 'canvas', projectId: 'project', revision: '8' },
        nodes: [{ id: 'lab', type: 'NODE_TYPE_AI_3D_LAB' }],
        edges: [],
      };
    if (method === 'ListLabJobs') {
      assert.equal(body.limit, 1);
      return { jobs: [{ jobId: 'observed' }], hasMore: true, nextPageToken: 'opaque' };
    }
    assert.equal(method, 'GetLabJob');
    return { jobId: 'observed', nodeId: 'lab', inputs: [] };
  });
  const result = object(
    await resolveLabInputs(f.client, { canvasId: 'canvas', nodeId: 'lab', historyLimit: 1 }),
  );
  assert.equal(result.observed_history_complete, true);
  assert.equal(result.history_complete, false);
  assert.equal(result.history_truncated, true);
  assert.equal(result.history_query_limit, 1);
  assert.equal(result.history_scope, 'returned_jobs_only');
  assert.equal(JSON.stringify(result).includes('opaque'), false);
});

test('Lab UploadCard input kind follows its verified asset and never infers unknown media as image', () => {
  for (const [kind, params, expected] of [
    ['ASSET_KIND_MODEL', {}, 'model'],
    ['ASSET_KIND_IMAGE', { assetType: 'model' }, 'image'],
    ['ASSET_KIND_VIDEO', { assetType: 'image' }, ''],
    ['ASSET_KIND_FILE', { assetType: 'image' }, ''],
    ['ASSET_KIND_UNSPECIFIED', { assetType: 'model' }, 'model'],
    ['', {}, ''],
  ] as const) {
    const values = selectLabUpstream(
      { type: 'NODE_TYPE_UPLOAD_CARD', params, inputMount: [{ assetId: 'asset', kind }] },
      {},
    );
    assert.deepEqual(
      values.map((value) => value.kind),
      expected ? [expected] : [],
    );
  }
});

test('Canvas multi-request uploads and saved asset reads stay bound to their initial account', async (t) => {
  const upload = await fixture(t, () => assert.fail('Import must not use a different account'));
  const session = upload.client.credentials.load()!;
  t.mock.method(S3Client.prototype, 'send', async () => {
    upload.client.credentials.save({ ...session, accountRef: 'different-account' });
    return {};
  });
  await assert.rejects(uploadCanvasFile(upload.client, 'project', upload.file, []), {
    code: 'ACCOUNT_MISMATCH',
  });
  assert.deepEqual(upload.calls, ['temporary_token']);
  const original = imageGraph(1);
  original.graph.nodes[2]!.nodeAssets = [
    { assetId: 'old', nodeId: 'original-source', kind: 'ASSET_KIND_IMAGE' },
  ];
  const saved = await fixture(t, (method) => {
    assert.equal(method, 'SaveCanvas');
    const active = saved.client.credentials.load()!;
    saved.client.credentials.save({ ...active, accountRef: 'different-account' });
    return { revision: '9', violations: [] };
  });
  const result = object(
    await callCanvas(
      saved.client,
      canvasResources.find((x) => x.name === 'save')!,
      original.graph,
    ),
  );
  assert.equal(result.revision, '9');
  assert.equal(object(result.asset_rebinding_error).code, 'ACCOUNT_MISMATCH');
  assert.deepEqual(saved.calls, ['SaveCanvas']);
});
