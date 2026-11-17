/** 原生多结果、游标恢复和本地文件真实边界；不以命令数量证明功能可用。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { modelSchema } from '../studio/contracts/schemas.ts';
import { modelResults, modelResultsStatus } from '../studio/api/model-results.ts';
import { readCanvasEvents, eventFrames } from '../studio/api/canvas-events.ts';
import { StudioClient } from '../studio/api/client.ts';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { JobStore } from '../cli/storage/jobs.ts';
import { quote } from './helpers.ts';
import { localOperations, runLocal } from '../cli/local/operations.ts';
import { submitServiceAction } from '../studio/api/service-actions.ts';
import type { Job } from '../studio/contracts/types.ts';

const credentials = (): MemoryCredentials =>
  new MemoryCredentials({
    accountRef: 'a',
    deviceId: 'test',
    cookie: 'fixture',
    importedAt: '',
    bearer: `eyJ0eXAiOiJKV1QifQ.${Buffer.from(JSON.stringify({ sub: 'fixture', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.fixture`,
  });
const job = (input: Record<string, unknown> = {}): Job => ({
  job_id: 'j',
  account_ref: 'a',
  request_id: 'r',
  input_hash: 'h',
  operation: 'model',
  input,
  contract_version: 'test',
  state: 'submitting',
  remote_ids: {},
  quote,
  progress: 0,
  artifacts: [],
  created_at: '',
  updated_at: '',
  lease_until: 0,
});

test('native model batches and P2 variations enforce distinct modes and geometry ranges', () => {
  assert.equal(modelSchema.parse({ mode: 'batch', image_paths: ['a.png', 'b.png'] }).mode, 'batch');
  assert.throws(() => modelSchema.parse({ mode: 'batch', image_paths: ['a.png', null] }));
  assert.throws(() => modelSchema.parse({ mode: 'multiview', image_paths: ['a', 'b', 'c', 'd', 'e'] }));
  assert.throws(() =>
    modelSchema.parse({
      mode: 'text',
      prompt: 'cube',
      variations: [{ face_limit: 100 }, { face_limit: 200 }],
    }),
  );
  assert.throws(() =>
    modelSchema.parse({
      mode: 'text',
      prompt: 'cube',
      model_version: 'Nexus-v2.0-20260801',
      quad: true,
      variations: [{ face_limit: 100 }, { face_limit: 26000 }],
    }),
  );
});
test('missing and rejected model receipts preserve accepted downloadable results without inferring input order', async () => {
  const remote = modelResults(
    {
      variations: [
        { accepted: true, project_id: 'p', operator_id: 'o', face_limit: 100 },
        { accepted: false, code: 6102 },
      ],
    },
    3,
  );
  assert.deepEqual(
    remote.models?.map((x) => x.accepted),
    [true, false, null],
  );
  const status = await modelResultsStatus(
    { ...job({ mode: 'batch', image_paths: ['one', 'two', 'three'] }), remote_ids: remote },
    async (child) => {
      assert.deepEqual(child.remote_ids, { project_id: 'p', operator_id: 'o' });
      return {
        state: 'succeeded',
        progress: 100,
        artifacts: [{ artifact_id: 'model', kind: 'model', format: 'glb', index: 0 }],
      };
    },
  );
  assert.equal(status.error?.code, 'PARTIAL_RECEIPT_UNKNOWN');
  assert.equal(status.artifacts[0]?.artifact_id, 'model-0');
  assert.equal(
    modelResults(
      [
        { project_id: 'p', operator_id: 'o' },
        { project_id: 'q', operator_id: 'o' },
      ],
      2,
    ).models?.[1]?.accepted,
    null,
  );
});
test('SSE frames support CRLF fragmentation and multiline data', () => {
  const first = eventFrames('event: message\r\ndata: {"x":\r\ndata: 1}\r');
  assert.equal(first.frames.length, 0);
  assert.deepEqual(eventFrames(first.rest + '\n\r\n').frames, [{ event: 'message', payload: '{"x":\n1}' }]);
});
test('event subscriptions reconnect from the last ID, deduplicate replay and redact event payloads', async () => {
  const calls: Record<string, unknown>[] = [];
  const client = new StudioClient(credentials(), async (url, init) => {
    assert.equal(url, 'https://msapi.tripo3d.ai/ms/web/sse');
    const body = JSON.parse(String(init.body));
    calls.push(body);
    const frames =
      calls.length === 1
        ? [{ id: '1', eventType: 'delta', data: JSON.stringify({ token: 'private', delta: 'ok' }) }]
        : [
            { id: '1', data: '{}' },
            { id: '2', eventType: 'finish', final: true, data: '{}' },
          ];
    return new Response(frames.map((x) => 'data: ' + JSON.stringify(x) + '\n\n').join(''), {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  const result = await readCanvasEvents(client, { kind: 'lab', id: 'test-job', wait_seconds: 3 });
  assert.equal(result.complete, true);
  assert.equal(result.count, 2);
  assert.equal(calls[1]?.afterId, '1');
  assert.ok(!JSON.stringify(result).includes('private'));
});
test('history name resolution preserves duplicate names, case-sensitive fuzzy matches, and account isolation', () => {
  const store = new JobStore(':memory:');
  try {
    const a = store.prepare('a', 'r1', 'model', {}, quote),
      b = store.prepare('a', 'r2', 'model', {}, quote),
      c = store.prepare('b', 'r1', 'model', {}, quote);
    store.setAlias('a', 'blue-robot', a.job_id);
    store.setAlias('b', 'blue-robot', c.job_id);
    assert.equal(store.alias('a', 'blue'), a.job_id);
    assert.equal(store.alias('a', 'BLUE'), undefined);
    store.setAlias('a', 'blue-robot', b.job_id);
    assert.throws(() => store.alias('a', 'blue-robot'), { code: 'AMBIGUOUS_REFERENCE' });
    assert.equal(store.alias('b', 'blue'), c.job_id);
  } finally {
    store.close();
  }
});
test('crop produces exact requested pixels and refuses bounds errors or overwriting', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tripo-crop-test-'));
  const config = { dataDir: directory, outputDir: '', inputRoots: [], keyringAccount: 'test' };
  const input = path.join(directory, 'input.png'),
    output = path.join(directory, 'output.png');
  try {
    await writeFile(
      input,
      await sharp({ create: { width: 20, height: 10, channels: 4, background: '#336699' } })
        .png()
        .toBuffer(),
    );
    const spec = localOperations.find((x) => x.name === 'image_crop')!;
    const args = { image_path: input, destination_path: output, left: 2, top: 3, width: 7, height: 4 };
    await runLocal(config, spec, args);
    const meta = await sharp(await readFile(output)).metadata();
    assert.equal(meta.width, 7);
    assert.equal(meta.height, 4);
    const resized = path.join(directory, 'resized.png');
    await runLocal(config, spec, {
      ...args,
      destination_path: resized,
      width: 8,
      height: 4,
      aspect_ratio: 2,
      output_width: 40,
      output_height: 20,
    });
    const resizedMeta = await sharp(await readFile(resized)).metadata();
    assert.equal(resizedMeta.width, 40);
    assert.equal(resizedMeta.height, 20);
    await assert.rejects(
      runLocal(config, spec, {
        ...args,
        destination_path: path.join(directory, 'ratio.png'),
        aspect_ratio: 4,
      }),
    );
    await assert.rejects(
      runLocal(config, spec, {
        ...args,
        destination_path: path.join(directory, 'one-size.png'),
        output_width: 40,
      }),
    );
    await assert.rejects(runLocal(config, spec, args), { code: 'OUTPUT_EXISTS' });
    await assert.rejects(
      runLocal(config, spec, { ...args, destination_path: path.join(directory, 'bad.png'), width: 100 }),
      { code: 'INVALID_INPUT' },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('light export pins the expected model version and never returns the original generation as a new artifact', async () => {
  let writes = 0;
  const client = new StudioClient(credentials(), async (url, init) => {
    if (url.includes('export-lite')) {
      writes++;
      assert.deepEqual(JSON.parse(String(init.body)), {
        project_id: 'p',
        operator_id: 'o',
        is_owner: true,
        format: 'gltf',
      });
    }
    return new Response(
      JSON.stringify({
        code: 0,
        data: url.includes('detail') ? { id: 'p', is_owner: true, operator: { operator_id: 'o' } } : {},
      }),
    );
  });
  const result = await submitServiceAction(client, {
    ...job({ project_id: 'p', operator_id: 'o', format: 'glb' }),
    operation: 'export_lite',
  });
  assert.equal(writes, 1);
  assert.deepEqual(result.status.artifacts, []);
  await assert.rejects(
    submitServiceAction(client, {
      ...job({ project_id: 'p', operator_id: 'changed', format: 'glb' }),
      operation: 'export_lite',
    }),
    { code: 'PROJECT_CHANGED' },
  );
  assert.equal(writes, 1);
});
test('human refinement does not automatically share private projects or submit orders after preflight failure', async () => {
  let writes = 0;
  const client = new StudioClient(credentials(), async (_url, init) => {
    if (init.method === 'POST') writes++;
    return new Response(
      JSON.stringify({
        code: 0,
        data: { id: 'p', is_owner: true, visibility: 'private', operator: { operator_id: 'o' } },
      }),
    );
  });
  await assert.rejects(
    submitServiceAction(client, {
      ...job({ project_id: 'p', requirement: 'details', accept_variable_cost: true }),
      operation: 'refine_submit',
    }),
    { code: 'PROJECT_NOT_SHAREABLE' },
  );
  assert.equal(writes, 0);
});

test('partial multi-result reconciliation fills only unknown receipts and never repeats submission', async () => {
  const { fixture } = await import('./helpers.ts');
  const { reconcileModelResults } = await import('../studio/api/model-results.ts');
  const f = await fixture();
  try {
    const original = f.jobs.prepare(
      'test-account',
      'partial',
      'model',
      { mode: 'batch', image_paths: ['one', 'two'] },
      quote,
    );
    f.jobs.update(original.job_id, 'failed', {
      remote_ids: { models: [{ accepted: true, project_id: 'p1', operator_id: 'o1' }, { accepted: null }] },
      error: { code: 'PARTIAL_RECEIPT_UNKNOWN' },
    });
    await f.service.reconcile(original.job_id, {
      models: [{ index: 1, project_id: 'p2', operator_id: 'o2' }],
    });
    assert.equal(f.gateway.posts, 0);
    assert.equal(f.jobs.get(original.job_id).remote_ids.models?.[1]?.operator_id, 'o2');
    assert.throws(
      () =>
        reconcileModelResults(f.jobs.get(original.job_id), [
          { index: 0, project_id: 'other', operator_id: 'o3' },
        ]),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
test('official-style names are normalized, unique, account scoped, and stable on replay', () => {
  const store = new JobStore(':memory:');
  try {
    const a = store.prepare('a', 'a', 'model', {}, quote),
      b = store.prepare('a', 'b', 'model', {}, quote);
    assert.equal(store.assignName('a', 'Blue Robot.png', a.job_id), 'blue-robot');
    assert.equal(store.assignName('a', 'Blue Robot.png', b.job_id), 'blue-robot-2');
    assert.equal(store.assignName('a', 'different', b.job_id), 'blue-robot-2');
    assert.equal(store.alias('a', 'blue-robot'), a.job_id);
  } finally {
    store.close();
  }
});
test('idle SSE streams terminate at the bounded deadline even if a transport ignores abort', async () => {
  let cancelled = false;
  const client = new StudioClient(
    credentials(),
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  );
  const keepAlive = setTimeout(() => undefined, 2000);
  try {
    const result = await readCanvasEvents(client, { kind: 'lab', id: 'idle', wait_seconds: 1 });
    assert.equal(result.timed_out, true);
    assert.equal(cancelled, true);
  } finally {
    clearTimeout(keepAlive);
  }
});
test('UV compatibility applies the generated candidate, verifies model versions and handles an already applied result', async () => {
  const { processingPlan } = await import('../cli/compat/planning.ts');
  const { StudioGateway } = await import('../studio/api/gateway.ts');
  assert.deepEqual(
    processingPlan('uv', 'project', {}).steps.map((s) => s.operation),
    ['uv_generate', 'uv_commit'],
  );
  let current = 'old',
    writes = 0;
  const client = new StudioClient(credentials(), async (url, init) => {
    if (url.endsWith('/apply')) {
      writes++;
      current = 'candidate';
      return new Response(
        JSON.stringify({
          code: 0,
          data: { project_id: 'p', previous_operator_id: 'old', current_operator_id: current },
        }),
      );
    }
    assert.equal(init.method, 'GET');
    return new Response(
      JSON.stringify({ code: 0, data: { id: 'p', is_owner: true, operator: { operator_id: current } } }),
    );
  });
  const gateway = new StudioGateway(client, [], { get: () => undefined, set: () => undefined });
  const input = {
    ...job({ project_id: 'p', current_operator_id: 'old', candidate_operator_id: 'candidate' }),
    operation: 'uv_commit' as const,
  };
  assert.equal((await gateway.submit(input)).status?.state, 'succeeded');
  assert.equal((await gateway.submit(input)).status?.state, 'succeeded');
  assert.equal(writes, 1);
});
test('human refinement receipt reports payment requirement without exposing checkout secrets', async () => {
  const client = new StudioClient(credentials(), async (url, init) => {
    const data = url.includes('detail')
      ? { id: 'p', is_owner: true, visibility: 'shareable' }
      : { if_need_payment: true, checkout_url: 'https://payment.example/secret-order' };
    if (init.method === 'POST') {
      const body = JSON.parse(String(init.body));
      assert.equal(body.success_url, 'https://studio.tripo3d.ai/?refine_success=true');
    }
    return new Response(JSON.stringify({ code: 0, data }));
  });
  const result = await submitServiceAction(client, {
    ...job({ project_id: 'p', requirement: 'Actual supplied specification', accept_variable_cost: true }),
    operation: 'refine_submit',
  });
  assert.equal(result.remote_ids.refinement?.payment_required, true);
  assert.equal(JSON.stringify(result).includes('secret-order'), false);
  assert.deepEqual(result.status.artifacts, []);
});
test('Magic Brush projects onto front UVs, preserves back UVs, and blends opacity', async () => {
  const { Document } = await import('@gltf-transform/core');
  const { bakePart } = await import('../cli/local/brush-raster.ts');
  const document = new Document(),
    buffer = document.createBuffer();
  const attribute = (array: number[], type: 'VEC2' | 'VEC3') =>
    document.createAccessor().setType(type).setArray(new Float32Array(array)).setBuffer(buffer);
  const primitive = document
    .createPrimitive()
    .setAttribute('POSITION', attribute([-1, -1, 0, 1, -1, 0, 0, 1, 0], 'VEC3'))
    .setAttribute('NORMAL', attribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 'VEC3'))
    .setAttribute('TEXCOORD_0', attribute([0, 0, 1, 0, 0.5, 1], 'VEC2'));
  const node = document.createNode().setMesh(document.createMesh().addPrimitive(primitive));
  const base = { data: Buffer.alloc(16 * 16 * 4, 255), width: 16, height: 16 };
  const camera = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 3, 1];
  const input = { camera_matrix: camera, fov: 50, color: '#ff0000', opacity: 0.5, strokes: [] };
  const front = bakePart(node, primitive, base, undefined, input);
  assert.ok(front.changed_pixels > 30);
  assert.deepEqual([...front.data.subarray((4 * 16 + 8) * 4, (4 * 16 + 8) * 4 + 4)], [255, 128, 128, 255]);
  primitive.setAttribute('NORMAL', attribute([0, 0, -1, 0, 0, -1, 0, 0, -1], 'VEC3'));
  const back = bakePart(node, primitive, base, undefined, input);
  assert.equal(back.changed_pixels, 0);
  assert.deepEqual(back.data, base.data);
});
test('AI producer and specialist plans are locally validated before any execution', async () => {
  const { buildExpertPlan } = await import('../cli/compat/ai-plan.ts');
  let calls = 0;
  const result = await buildExpertPlan('robot at 500 faces', async () =>
    ++calls === 1
      ? { prompt: 'robot', scenario: 'game-mobile', params: { face_limit: 500 } }
      : { prompt: 'robot', params: { face_limit: 10000 }, then: 'convert:glb' },
  );
  assert.equal(calls, 2);
  assert.equal(result.params?.face_limit, 500);
  await assert.rejects(
    buildExpertPlan('robot', async () => ({ prompt: 'robot', params: { invented_field: true } })),
  );
});

test('temporary PBR previews preserve geometry and maps, disable only PBR channels, and never mutate the source', async () => {
  const { Document, NodeIO } = await import('@gltf-transform/core');
  const { previewMaterialModel } = await import('../cli/local/preview-material.ts');
  const io = new NodeIO(),
    document = new Document(),
    buffer = document.createBuffer();
  const pixels = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#4080c0' } })
    .png()
    .toBuffer();
  const texture = document.createTexture().setImage(pixels).setMimeType('image/png');
  const material = document
    .createMaterial()
    .setBaseColorTexture(texture)
    .setMetallicRoughnessTexture(texture)
    .setMetallicFactor(0.2)
    .setRoughnessFactor(0.7);
  const positions = document
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setBuffer(buffer);
  const primitive = document.createPrimitive().setAttribute('POSITION', positions).setMaterial(material);
  document
    .createScene()
    .addChild(
      document
        .createNode()
        .setMesh(
          document.createMesh().addPrimitive(primitive).addPrimitive(primitive.clone().setMaterial(null)),
        ),
    );
  const source = Buffer.from(await io.writeBinary(document)),
    original = Buffer.from(source);
  const preview = await io.readBinary(
    previewMaterialModel(source, 'glb', { pbr: true, metalness: 0.8, roughness: 0.1 }),
  );
  for (const m of preview.getRoot().listMaterials()) {
    assert.equal(m.getMetallicFactor(), 0.8);
    assert.equal(m.getRoughnessFactor(), 0.1);
  }
  assert.deepEqual(
    Buffer.from(preview.getRoot().listMaterials()[0]!.getMetallicRoughnessTexture()!.getImage()!),
    pixels,
  );
  assert.deepEqual(
    preview.getRoot().listMeshes()[0]!.listPrimitives()[0]!.getAttribute('POSITION')!.getArray(),
    positions.getArray(),
  );
  const disabled = await io.readBinary(previewMaterialModel(source, 'glb', { pbr: false, metalness: 1 }));
  const m = disabled.getRoot().listMaterials()[0]!;
  assert.equal(m.getMetallicFactor(), 0);
  assert.equal(m.getRoughnessFactor(), 0);
  assert.equal(m.getMetallicRoughnessTexture(), null);
  assert.deepEqual(Buffer.from(m.getBaseColorTexture()!.getImage()!), pixels);
  assert.deepEqual(source, original);
  assert.equal(previewMaterialModel(source, 'glb', {}), source);
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, meshes: [{ primitives: [{}] }] }));
  const jsonResult = JSON.parse(previewMaterialModel(json, 'gltf', { roughness: 0.3 }).toString());
  assert.equal(jsonResult.materials[0].pbrMetallicRoughness.roughnessFactor, 0.3);
  assert.throws(() =>
    localOperations
      .find((x) => x.name === 'snapshot')!
      .schema.parse({ model_path: 'x', destination_path: 'y', metalness: 2 }),
  );
});
