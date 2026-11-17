/** 纹理参考准备跨图、素材详情和历史版本；读一致性及不隐式写入是关键边界。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { StudioClient } from '../studio/api/client.ts';
import { object } from '../studio/contracts/errors.ts';
import { resolveCanvasTextureReference } from '../studio/api/canvas-texture-reference.ts';
import { parseModelReference } from '../studio/api/canvas-model-reference.ts';

const types = {
  texture: 'NODE_TYPE_TEXTURE',
  model: 'NODE_TYPE_GENERATE_HD_MODEL',
  image: 'NODE_TYPE_GENERATE_IMAGE',
  upload: 'NODE_TYPE_UPLOAD_CARD',
  result: 'NODE_TYPE_MULTIVIEW_RESULT',
  lab: 'NODE_TYPE_AI_3D_LAB',
};
const port = (portId: string, type: string) => ({ portId, valueType: 'PORT_VALUE_TYPE_' + type });
const catalog = {
  nodeDefinitionsVersion: 'fixture-version',
  nodeDefinitions: [
    {
      nodeType: types.texture,
      inputPorts: [
        port('model', 'MODEL'),
        ...['image', 'front', 'left', 'back', 'right'].map((p) => port(p, 'IMAGE')),
      ],
      outputPorts: [port('model', 'MODEL')],
    },
    { nodeType: types.model, inputPorts: [port('image', 'IMAGE')], outputPorts: [port('model', 'MODEL')] },
    { nodeType: types.image, inputPorts: [], outputPorts: [port('image', 'IMAGE')] },
    { nodeType: types.upload, inputPorts: [], outputPorts: [port('output', 'ANY')] },
    { nodeType: types.result, inputPorts: [], outputPorts: [port('image', 'IMAGE')] },
    { nodeType: types.lab, inputPorts: [port('model', 'MODEL')], outputPorts: [port('output', 'ANY')] },
  ],
};
function baseline() {
  return {
    canvas: { canvasId: 'canvas', projectId: 'canvas-project', revision: '7' },
    nodes: [
      {
        id: 'model',
        type: types.model,
        params: {},
        nodeAssets: [{ assetId: 'model-asset', selected: true }],
      },
      { id: 'texture', type: types.texture, params: { texture_quality: 'standard' } },
    ] as Record<string, unknown>[],
    edges: [
      {
        id: 'model-edge',
        source: { nodeId: 'model', port: 'model' },
        target: { nodeId: 'texture', port: 'model' },
      },
    ],
  };
}
const image = {
  bucket: 'tripo-data',
  key: 'source.png',
  image_source: 'generate',
  image_audit_result: 'pass',
};
function project() {
  return {
    id: 'source-project',
    operator: {
      operator_id: 'historical-operator',
      image_to_model: { generate_image_object: [{ ...image, key: 'original.png' }] },
      texture_generation: {
        generate_image_object: [{ ...image, url: 'https://cdn.tripo3d.ai/source.png?secret=fixture' }],
      },
    },
  };
}
type Handler = (method: string, body: Record<string, unknown>, readIndex: number) => unknown;
function fixture(handler?: Handler) {
  const credentials = new MemoryCredentials({
    accountRef: 'test-account',
    bearer:
      'eyJhbGciOiJIUzI1NiJ9.' +
      Buffer.from(
        JSON.stringify({ sub: 'test-account', exp: Math.floor(Date.now() / 1000) + 3600 }),
      ).toString('base64url') +
      '.fixture',
    deviceId: 'test-device',
    importedAt: new Date().toISOString(),
  });
  let readIndex = 0;
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const client = new StudioClient(credentials, async (url, init) => {
    const micro = url === 'https://msapi.tripo3d.ai/ms/web/api';
    const method = micro ? String(object(init.headers)['x-micro-method']).split('/').at(-1)! : url;
    const body = init.body ? object(JSON.parse(String(init.body))) : {};
    calls.push({ method, body });
    if (method === 'GetCanvas') readIndex++;
    const customized = handler?.(method, body, readIndex);
    const value =
      customized ??
      (method === 'GetCanvas'
        ? baseline()
        : method === 'ListTools'
          ? catalog
          : method === 'GetNodeAssetDetail'
            ? {
                assetId: 'model-asset',
                provider: 'studio',
                detail: { id: 'source-project', operator_id: 'historical-operator' },
              }
            : project());
    return Response.json(micro ? { error: { code: 0 }, ...object(value) } : { code: 0, data: value });
  });
  return { client, calls, credentials };
}
const input = { canvasId: 'canvas', nodeId: 'texture', revision: '7' };
const route =
  'https://api.tripo3d.ai/v2/studio/project/detail/v3/source-project?operator_id=historical-operator';

test('Texture inheritance uses the exact historical operator, prefers its texture source, and only returns save actions', async () => {
  const { client, calls } = fixture();
  const result = object(await resolveCanvasTextureReference(client, input));
  assert.equal(result.decision, 'inherit_image');
  assert.equal(result.source_operator_id, 'historical-operator');
  assert.deepEqual(result.actions, [
    { action: 'params', node_id: 'texture', params: { texture_quality: 'standard', image } },
  ]);
  assert.equal(result.remote_saved, false);
  assert.equal(result.execution_started, false);
  assert.equal(JSON.stringify(result).includes('secret='), false);
  assert.deepEqual(
    calls.map((x) => x.method),
    ['GetCanvas', 'ListTools', 'GetNodeAssetDetail', route, 'GetCanvas'],
  );
  assert.deepEqual(calls[2]!.body, { assetId: 'model-asset' });
});

test('nearest generated images connect with same-depth front preference, without querying model source or saving', async () => {
  const graph = baseline();
  graph.nodes.push(
    {
      id: 'left',
      type: types.result,
      params: { view: 'left' },
      nodeAssets: [{ assetId: 'left-result', url: 'https://cdn.tripo3d.ai/left.png' }],
    },
    {
      id: 'front',
      type: types.result,
      params: { view: 'front' },
      nodeAssets: [{ assetId: 'front-result', url: 'https://cdn.tripo3d.ai/front.png' }],
    },
  );
  for (const nodeId of ['left', 'front'])
    graph.edges.push({
      id: nodeId + '-edge',
      source: { nodeId, port: 'image' },
      target: { nodeId: 'model', port: 'image' },
    });
  const { client, calls } = fixture((method) => (method === 'GetCanvas' ? graph : undefined));
  const result = object(await resolveCanvasTextureReference(client, input));
  assert.equal(result.decision, 'connect_image');
  assert.equal(result.source_node_id, 'front');
  const action = object((result.actions as unknown[])[0]);
  assert.equal(action.action, 'connect');
  assert.deepEqual(object(action.edge).source, { nodeId: 'front', port: 'image' });
  assert.deepEqual(object(action.edge).target, { nodeId: 'texture', port: 'image' });
  assert.deepEqual(
    calls.map((x) => x.method),
    ['GetCanvas', 'ListTools', 'GetCanvas'],
  );
});

test('UploadCard images remain explicit inputs but are not automatically selected as ANY catalog ancestors', async () => {
  for (const direct of [false, true]) {
    const graph = baseline();
    graph.nodes.push({
      id: 'upload',
      type: types.upload,
      params: {},
      inputMount: [
        { assetId: 'input-image', kind: 'ASSET_KIND_IMAGE', url: 'https://cdn.tripo3d.ai/input.png' },
      ],
    });
    graph.edges.push({
      id: 'upload-edge',
      source: { nodeId: 'upload', port: 'output' },
      target: { nodeId: direct ? 'texture' : 'model', port: 'image' },
    });
    const { client, calls } = fixture((method) => (method === 'GetCanvas' ? graph : undefined));
    const result = object(await resolveCanvasTextureReference(client, input));
    assert.equal(result.decision, direct ? 'unchanged' : 'inherit_image');
    assert.equal(
      calls.some((x) => x.method === 'GetNodeAssetDetail'),
      !direct,
    );
    if (direct) assert.equal(result.reason, 'image_connection_present');
  }
});

test('locked, existing prompt, and explicit reference conditions remain read-only and never load model details', async () => {
  for (const params of [
    { texture_reference_locked: true },
    { prompt_text: 'keep this prompt' },
    { image },
    { images: { front: image } },
    { input_mode: 'multi', images: [image] },
  ]) {
    const graph = baseline();
    graph.nodes[1]!.params = params;
    const { client, calls } = fixture((method) => (method === 'GetCanvas' ? graph : undefined));
    const result = object(await resolveCanvasTextureReference(client, input));
    assert.equal(result.decision, 'unchanged');
    assert.deepEqual(result.actions, []);
    assert.deepEqual(
      calls.map((x) => x.method),
      ['GetCanvas', 'ListTools', 'GetCanvas'],
    );
    assert.deepEqual(graph.nodes[1]!.params, params);
  }
});

test('Lab model ancestry blocks reference inheritance even when the downstream model has a usable result', async () => {
  const graph = baseline();
  graph.nodes[0]!.type = types.texture;
  graph.nodes.push({
    id: 'lab',
    type: types.lab,
    params: {},
    nodeAssets: [
      {
        assetId: 'lab-model',
        kind: 'ASSET_KIND_MODEL',
        role: 'ASSET_ROLE_CURRENT',
        source: 'ASSET_SOURCE_STUDIO',
        selected: true,
      },
    ],
  });
  graph.edges.push({
    id: 'lab-edge',
    source: { nodeId: 'lab', port: 'model' },
    target: { nodeId: 'model', port: 'model' },
  });
  const { client, calls } = fixture((method) => (method === 'GetCanvas' ? graph : undefined));
  const result = object(await resolveCanvasTextureReference(client, input));
  assert.equal(result.reason, 'lab_model_ancestor');
  assert.deepEqual(result.actions, []);
  assert.equal(calls.length, 3);
});

test('changed revision, selected result or graph params invalidate an otherwise resolved plan', async () => {
  for (const change of ['revision', 'asset', 'params']) {
    const { client } = fixture((method, _body, readIndex) => {
      if (method !== 'GetCanvas') return;
      const graph = baseline();
      if (readIndex === 2) {
        if (change === 'revision') graph.canvas.revision = '8';
        if (change === 'asset') graph.nodes[0]!.nodeAssets = [{ assetId: 'new-model-asset', selected: true }];
        if (change === 'params') graph.nodes[1]!.params = { prompt_text: 'changed concurrently' };
      }
      return graph;
    });
    await assert.rejects(resolveCanvasTextureReference(client, input), { code: 'CANVAS_CHANGED' });
  }
});

test('signed URL refresh alone does not invalidate stable selected asset identity', async () => {
  const { client } = fixture((method, _body, readIndex) => {
    if (method !== 'GetCanvas') return;
    const graph = baseline();
    graph.nodes[0]!.nodeAssets = [
      {
        assetId: 'model-asset',
        selected: true,
        url: 'https://cdn.tripo3d.ai/model.glb?signature=' + readIndex,
      },
    ];
    return graph;
  });
  assert.equal(object(await resolveCanvasTextureReference(client, input)).decision, 'inherit_image');
});

test('image availability and source metadata changes invalidate an automatic connection without revision changes', async () => {
  for (const change of ['url', 'source', 'slotIndex']) {
    const { client } = fixture((method, _body, readIndex) => {
      if (method !== 'GetCanvas') return;
      const graph = baseline();
      const asset = {
        assetId: 'generated-image',
        url: readIndex === 2 && change === 'url' ? '' : 'https://cdn.tripo3d.ai/image.png',
        source: readIndex === 2 && change === 'source' ? 'ASSET_SOURCE_INPUT' : 'ASSET_SOURCE_STUDIO',
        slotIndex: readIndex === 2 && change === 'slotIndex' ? 1 : 0,
      };
      graph.nodes.push({ id: 'image', type: types.image, params: {}, nodeAssets: [asset] });
      graph.edges.push({
        id: 'image-edge',
        source: { nodeId: 'image', port: 'image' },
        target: { nodeId: 'model', port: 'image' },
      });
      return graph;
    });
    await assert.rejects(resolveCanvasTextureReference(client, input), { code: 'CANVAS_CHANGED' });
  }
});

test('wrong asset, provider, project or historical operator is rejected instead of inheriting another model', async () => {
  for (const mismatch of ['asset', 'provider', 'project', 'operator']) {
    const { client } = fixture((method) => {
      if (method === 'GetNodeAssetDetail')
        return {
          assetId: mismatch === 'asset' ? 'other' : 'model-asset',
          provider: mismatch === 'provider' ? 'other' : 'studio',
          detail: { id: 'source-project', operator_id: 'historical-operator' },
        };
      if (method === route) {
        const value = project();
        if (mismatch === 'project') value.id = 'other';
        if (mismatch === 'operator') value.operator.operator_id = 'current-newer-operator';
        return value;
      }
    });
    await assert.rejects(resolveCanvasTextureReference(client, input), { code: 'CONTRACT_CHANGED' });
  }
});

test('multiple source views, text or no reference never degrade to the first image', async () => {
  for (const source of [{ generate_image_object: [image, null, image, null] }, { prompt: 'a robot' }, {}]) {
    const { client } = fixture((method) =>
      method === route
        ? { id: 'source-project', operator: { operator_id: 'historical-operator', image_to_model: source } }
        : undefined,
    );
    const result = object(await resolveCanvasTextureReference(client, input));
    assert.equal(result.decision, 'unchanged');
    assert.equal(result.reason, 'source_is_not_single_image');
    assert.deepEqual(result.actions, []);
  }
});

test('account switching during source resolution cannot send the next request as the new user', async () => {
  const value = fixture((method) => {
    if (method === 'GetNodeAssetDetail')
      value.credentials.save({ ...value.credentials.load()!, accountRef: 'another-account' });
  });
  await assert.rejects(resolveCanvasTextureReference(value.client, input), { code: 'ACCOUNT_MISMATCH' });
  assert.deepEqual(
    value.calls.map((x) => x.method),
    ['GetCanvas', 'ListTools', 'GetNodeAssetDetail'],
  );
});

test('malformed reference data and stale caller revisions fail before returning editable actions', async () => {
  const { client, calls } = fixture();
  await assert.rejects(resolveCanvasTextureReference(client, { ...input, revision: '6' }), {
    code: 'CANVAS_CHANGED',
  });
  assert.equal(calls.length, 1);
  for (const badImage of [
    { bucket: 7, key: 'a' },
    { ...image, image_source: 'unknown' },
    { ...image, image_audit_result: 'unknown' },
  ]) {
    assert.throws(
      () =>
        parseModelReference(
          { id: 'p', operator: { operator_id: 'o', image_to_model: { generate_image_object: [badImage] } } },
          'p',
          'o',
        ),
      { code: 'CONTRACT_CHANGED' },
    );
  }
});
