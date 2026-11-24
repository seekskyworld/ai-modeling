/** 使用真实网页形状回归画布协议、运行归属和图版本边界，避免下载后一次生成的结果。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { fixture, quote } from './helpers.ts';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { MemoryLinks } from '../studio/auth/artifact-links.ts';
import { StudioClient } from '../studio/api/client.ts';
import { StudioGateway } from '../studio/api/gateway.ts';
import { canvasSaveSchema, canvasResources, callCanvas } from '../studio/api/canvas.ts';
import { canvasNodeQuote } from '../studio/api/canvas-pricing.ts';
import { PricingService } from '../studio/api/pricing.ts';
import { reviewedPrices } from '../studio/api/reviewed-prices.ts';
import { object } from '../studio/contracts/errors.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import { canvasInputIssues } from '../studio/api/canvas-graph.ts';
import { existingArtifact, existingArtifactSchema } from '../studio/api/existing-artifact.ts';

function canvasClient(
  handler: (method: string, body: Record<string, unknown>) => unknown,
  transactions: unknown[] = [],
): StudioClient {
  const bearer =
    'eyJhbGciOiJIUzI1NiJ9.' +
    Buffer.from(JSON.stringify({ sub: 'test-account', exp: Math.floor(Date.now() / 1000) + 3600 })).toString(
      'base64url',
    ) +
    '.fixture';
  return new StudioClient(
    new MemoryCredentials({
      accountRef: 'test-account',
      bearer,
      deviceId: 'device',
      importedAt: new Date().toISOString(),
    }),
    async (url, init) => {
      if (url.includes('/txn/records')) return Response.json({ code: 0, data: { records: transactions } });
      if (url.endsWith('/operation/download_with_name'))
        return Response.json({
          code: 0,
          data: handler('download_with_name', object(JSON.parse(String(init.body)))),
        });
      assert.equal(url, 'https://msapi.tripo3d.ai/ms/web/api');
      const headers = object(init.headers);
      assert.equal(headers.cookie, undefined);
      assert.equal(headers.authorization, undefined);
      assert.equal(headers['x-uid'], 'test-account');
      return Response.json({
        error: { code: 0, message: '' },
        ...object(handler(String(headers['x-micro-method']), object(JSON.parse(String(init.body))))),
      });
    },
  );
}
test('template creation snapshots a nonempty saved graph and stops on revision or ownership mismatch', async () => {
  let projectId = 'project',
    revision = '4',
    creates = 0;
  const nodes = [
    { id: 'text', type: 'NODE_TYPE_GENERATE_IMAGE', params: { prompt: 'keep this' } },
    { id: 'model', type: 'NODE_TYPE_GENERATE_HD_MODEL' },
  ];
  const edges = [
    { id: 'edge', source: { nodeId: 'text', port: 'image' }, target: { nodeId: 'model', port: 'image' } },
  ];
  const client = canvasClient((method, body) => {
    if (method.endsWith('/GetCanvas'))
      return { canvas: { canvasId: 'canvas', projectId, revision }, nodes, edges };
    assert.ok(method.endsWith('/CreateTemplate'));
    creates++;
    assert.deepEqual(
      body.nodes,
      canvasSaveSchema.parse({
        canvasId: 'canvas',
        projectId: 'project',
        revision: '4',
        clientId: 'test',
        nodes,
        edges,
      }).nodes,
    );
    assert.deepEqual(body.edges, edges);
    assert.equal(body.revision, undefined);
    return { id: 'template' };
  });
  const spec = canvasResources.find((s) => s.name === 'template_create')!;
  const input = {
    sourceProjectId: 'project',
    sourceCanvasId: 'canvas',
    scenarioId: 'scenario',
    revision: '4',
  };
  assert.equal(object(await callCanvas(client, spec, input)).source_revision, '4');
  revision = '5';
  await assert.rejects(callCanvas(client, spec, input), { code: 'CANVAS_CHANGED' });
  revision = '4';
  projectId = 'other';
  await assert.rejects(callCanvas(client, spec, input), { code: 'CONTRACT_CHANGED' });
  assert.equal(creates, 1);
});
test('template model download preserves FBX format and rejects a mismatched or unfinished asset', async () => {
  let assetId = 'asset',
    status = 'success';
  const client = canvasClient((method, body) => {
    assert.ok(method.endsWith('/GetTemplateAssetDetail'));
    assert.equal(body.templateId, 'template');
    return {
      assetId,
      provider: 'studio',
      detail: {
        status,
        model_url: 'https://example.org/original.FBX?label=wrong.glb',
        operator_id: 'original',
      },
    };
  });
  const input = existingArtifactSchema.parse({
    kind: 'template_model',
    id: 'asset',
    template_id: 'template',
    destination_path: '/tmp/template.fbx',
  });
  assert.equal((await existingArtifact(client, input)).format, 'fbx');
  assetId = 'other';
  await assert.rejects(existingArtifact(client, input), { code: 'CONTRACT_CHANGED' });
  assetId = 'asset';
  status = 'running';
  await assert.rejects(existingArtifact(client, input), { code: 'ARTIFACT_NOT_READY' });
});
test('review checkpoint saves only its decision at the current revision and starts no generation', async () => {
  const nodes = [
    { id: 'review', type: 'NODE_TYPE_REVIEW', params: { instruction: 'Check image', approved: false } },
    { id: 'downstream', type: 'NODE_TYPE_GENERATE_HD_MODEL', params: { face_limit: 4000 } },
  ];
  const edges = [
    {
      id: 'edge',
      source: { nodeId: 'review', port: 'image' },
      target: { nodeId: 'downstream', port: 'image' },
    },
  ];
  const requests: string[] = [];
  const client = canvasClient((method, body) => {
    requests.push(method);
    if (method.endsWith('/GetCanvas')) return { canvas: { revision: '3' }, nodes, edges };
    assert.ok(method.endsWith('/SaveCanvas'));
    const saved = body.nodes as typeof nodes;
    assert.deepEqual(saved[1], nodes[1]);
    assert.equal(saved[0]?.params.approved, true);
    assert.equal(body.revision, '3');
    return { canvas: { revision: '4' } };
  });
  const spec = canvasResources.find((s) => s.name === 'review')!;
  const result = object(
    await callCanvas(client, spec, { canvasId: 'canvas', revision: '3', nodeId: 'review', approved: true }),
  );
  assert.equal(result.execution_started, false);
  assert.deepEqual(result.downstream_node_ids, ['downstream']);
  assert.equal(nodes[0]?.params.approved, false);
  await assert.rejects(
    callCanvas(client, spec, { canvasId: 'canvas', revision: '2', nodeId: 'review', approved: true }),
    { code: 'CANVAS_CHANGED' },
  );
  assert.equal(requests.filter((m) => m.endsWith('/SaveCanvas')).length, 1);
});
test('Canvas ordinary generation omits action and downloads only its own run asset', async () => {
  const f = await fixture();
  let submissions = 0;
  let newer = false;
  const links = new MemoryLinks();
  const client = canvasClient((method, body) => {
    if (method.endsWith('/GetCanvas'))
      return {
        canvas: { canvasId: 'canvas', revision: '2' },
        nodes: [
          {
            id: 'node',
            type: 'NODE_TYPE_GENERATE_IMAGE',
            params: { model_version: 'gpt_image_2', amount: 1, prompt: 'A toy robot' },
          },
        ],
      };
    if (method.endsWith('/CreateRun')) {
      submissions++;
      assert.equal(body.action, undefined);
      assert.match(String(body.idempotencyKey), /^[a-f\d-]{36}$/);
      return { runId: 'run' };
    }
    if (method.endsWith('/GetRun'))
      return {
        run: {
          runId: 'run',
          canvasId: 'canvas',
          nodeIds: ['node'],
          status: 'RUN_STATUS_SUCCEEDED',
          steps: [{ nodeId: 'node', taskId: 'original-task', status: 'RUN_STEP_STATUS_DONE' }],
        },
      };
    return {
      nodes: [
        {
          nodeId: 'node',
          assets: newer
            ? [
                {
                  nodeId: 'node',
                  assetId: 'new',
                  kind: 'ASSET_KIND_IMAGE',
                  url: 'https://cdn.tripo3d.ai/other-task/image.png',
                },
              ]
            : [
                {
                  nodeId: 'node',
                  assetId: 'original',
                  kind: 'ASSET_KIND_IMAGE',
                  url: 'https://cdn.tripo3d.ai/original-task/image.png',
                },
                {
                  nodeId: 'node',
                  assetId: 'wrong',
                  kind: 'ASSET_KIND_IMAGE',
                  url: 'https://cdn.tripo3d.ai/other-task/image.png',
                },
              ],
        },
      ],
    };
  });
  const gateway = new StudioGateway(client, [], links);
  try {
    const input = await gateway.prepareInput(
      'canvas_run',
      normalize('canvas_run', { canvas_id: 'canvas', revision: '2', node_ids: ['node'] }),
    );
    const job = f.jobs.prepare('test-account', 'canvas-1', 'canvas_run', input, quote);
    const receipt = await gateway.submit(job);
    const saved = f.jobs.update(job.job_id, 'submitted', receipt);
    const status = await gateway.status(saved);
    assert.equal(submissions, 1);
    assert.equal(status.state, 'succeeded');
    assert.equal(status.artifacts.length, 1);
    assert.equal(status.artifacts[0]!.artifact_id, 'original');
    newer = true;
    assert.equal(
      await gateway.artifactUrl(saved, status.artifacts[0]!),
      'https://cdn.tripo3d.ai/original-task/image.png',
    );
    await assert.rejects(gateway.status(saved), { code: 'ARTIFACT_NOT_READY' });
    await assert.rejects(gateway.prepareInput('canvas_run', { ...input, revision: '1' }), {
      code: 'CANVAS_CHANGED',
    });
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
test('creative replies preserve waiting states and Lab billing; submitted asset IDs reach the service', async () => {
  const f = await fixture();
  let waiting = true;
  const client = canvasClient((method, body) => {
    if (method.endsWith('/CreateLabJob')) {
      assert.deepEqual(body.assetIds, ['model-asset']);
      assert.match(String(body.idempotencyKey), /^[a-f\d-]{36}$/);
      return { jobId: 'lab', status: 'queued' };
    }
    if (method.endsWith('/GetLabJob'))
      return { jobId: 'lab', status: 'completed', artifacts: [], billing: { chargedCredits: '9' } };
    return {
      turn: {
        turnId: 'turn',
        sessionId: 'session',
        status: waiting ? 'TURN_STATUS_WAITING_FOR_USER' : 'TURN_STATUS_DONE',
      },
      messages: [],
    };
  });
  const gateway = new StudioGateway(client, [], new MemoryLinks());
  try {
    const turn = f.jobs.prepare(
      'test-account',
      'turn-input',
      'canvas_turn',
      { session_id: 'session' },
      quote,
    );
    const running = { ...turn, remote_ids: { task_id: 'turn' } };
    assert.equal((await gateway.status(running)).state, 'waiting_input');
    waiting = false;
    assert.equal((await gateway.status(running)).state, 'succeeded');
    const lab = f.jobs.prepare(
      'test-account',
      'lab-input',
      'canvas_lab',
      { node_id: 'node', prompt: 'inspect', asset_ids: ['model-asset'], accept_variable_cost: true },
      quote,
    );
    const receipt = await gateway.submit(lab);
    const saved = { ...lab, ...receipt };
    assert.equal((await gateway.status(saved)).state, 'succeeded');
    assert.equal((await gateway.cost(saved))?.credits, 9);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
test('Canvas cost matches underlying tasks and marks incomplete billing as partial', async () => {
  const f = await fixture();
  const client = canvasClient(
    () => ({
      run: {
        runId: 'run',
        canvasId: 'canvas',
        nodeIds: ['a', 'b'],
        steps: [{ taskId: 'bill-a' }, { taskId: 'bill-b' }],
      },
    }),
    [
      { operator_id: 'bill-a', txn_type: 'charge', direction: 'sub', status: 'fulfilled', amount: 15 },
      { operator_id: 'unrelated', txn_type: 'charge', direction: 'sub', status: 'fulfilled', amount: 100 },
    ],
  );
  try {
    const job = f.jobs.prepare(
      'test-account',
      'cost',
      'canvas_run',
      { canvas_id: 'canvas', node_ids: ['a', 'b'] },
      quote,
    );
    const cost = await new StudioGateway(client, [], new MemoryLinks()).cost({
      ...job,
      remote_ids: { task_id: 'run' },
    });
    assert.equal(cost?.credits, 15);
    assert.equal(cost?.status, 'partial');
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
test('Canvas graph round-trips derived fields and rejects cycles or missing nodes', () => {
  const nodes = [
    {
      id: 'a',
      type: 'NODE_TYPE_GENERATE_IMAGE',
      params: { prompt: 'robot' },
      ui: { position: { x: 0, y: 0 }, size: null },
      inputMount: [],
      nodeAssets: [],
      displayNo: '#1',
      batchId: '',
      extraction: null,
      taskInstructions: null,
    },
    { id: 'b', type: 'NODE_TYPE_GENERATE_HD_MODEL', params: {} },
  ];
  const graph = {
    canvasId: 'canvas',
    clientId: 'client',
    revision: '4',
    nodes,
    edges: [{ id: 'edge1', source: { nodeId: 'a', port: 'image' }, target: { nodeId: 'b', port: 'image' } }],
  };
  assert.deepEqual(canvasSaveSchema.parse(graph).nodes, nodes);
  assert.throws(() =>
    canvasSaveSchema.parse({
      ...graph,
      edges: [
        ...graph.edges,
        { id: 'edge2', source: { nodeId: 'b', port: 'model' }, target: { nodeId: 'a', port: 'image' } },
      ],
    }),
  );
  assert.throws(() => canvasSaveSchema.parse({ ...graph, nodes: nodes.slice(0, 1) }));
});
test('Canvas prices follow Smart Mesh and 8K texture formulas without inventing defaults', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(reviewedPrices.reviewed_at) });
  const pricing = new PricingService('/missing-prices.json', reviewedPrices);
  const model = canvasNodeQuote(
    {
      type: 'NODE_TYPE_GENERATE_SM_MODEL',
      params: {
        model_version: 'Nexus-v2.0-20260801',
        quad: true,
        texture: true,
        pbr: true,
        texture_quality: 'extreme',
      },
    },
    {},
  );
  assert.equal((await pricing.quote('model', object(model.parameters))).credits, 100);
  const texture = canvasNodeQuote({ type: 'NODE_TYPE_TEXTURE', params: { texture_quality: 'extreme' } }, {});
  assert.equal((await pricing.quote('texture', object(texture.parameters))).credits, 30);
  assert.throws(() => canvasNodeQuote({ type: 'NODE_TYPE_GENERATE_HD_MODEL', params: {} }, {}), {
    code: 'PRICE_UNKNOWN',
  });
});
test('Canvas rejects nested sections, incompatible ports and unavailable generation inputs', () => {
  const base = { canvasId: 'canvas', clientId: 'client', revision: '1', edges: [] };
  assert.throws(() =>
    canvasSaveSchema.parse({ ...base, nodes: [{ id: 'group', type: 'NODE_TYPE_SECTION', pid: 'group' }] }),
  );
  assert.throws(() =>
    canvasSaveSchema.parse({
      ...base,
      nodes: [
        { id: 'a', type: 'NODE_TYPE_SECTION', pid: 'b' },
        { id: 'b', type: 'NODE_TYPE_SECTION', pid: 'a' },
      ],
    }),
  );
  const nodes = [
    { id: 'source', type: 'NODE_TYPE_GENERATE_IMAGE', params: { prompt: 'A toy robot' } },
    { id: 'target', type: 'NODE_TYPE_GENERATE_HD_MODEL', params: {} },
  ];
  assert.ok(canvasInputIssues(nodes, [], ['target']).length);
  const edges = [
    { id: 'edge', source: { nodeId: 'source', port: 'image' }, target: { nodeId: 'target', port: 'image' } },
  ];
  assert.ok(canvasInputIssues(nodes, edges, ['target']).length);
  assert.deepEqual(canvasInputIssues(nodes, edges, ['source', 'target']), []);
  assert.throws(() =>
    canvasSaveSchema.parse({
      ...base,
      nodes,
      edges: [{ ...edges[0], target: { nodeId: 'target', port: 'nonexistent' } }],
    }),
  );
});
test('variable creative billing remains unknown and requires explicit acceptance without weakening fixed-price guards', async () => {
  const f = await fixture();
  try {
    f.service.pricing = new PricingService('/missing-prices.json', reviewedPrices);
    const parameters = { session_id: 'session', text: 'Plan a small robot', accept_variable_cost: true };
    assert.throws(() => normalize('canvas_turn', { ...parameters, accept_variable_cost: false }));
    const quoted = await f.service.quote('canvas_turn', parameters);
    assert.equal(quoted.known, false);
    assert.equal(quoted.credits, undefined);
    assert.equal(quoted.variable, true);
    const submitted = await f.service.submit('canvas_turn', 'creative-1', parameters, 0);
    const duplicate = await f.service.submit('canvas_turn', 'creative-1', parameters, 0);
    assert.equal(submitted.job_id, duplicate.job_id);
    assert.equal(f.gateway.posts, 1);
    f.service.pricing = { quote: async () => quoted };
    await assert.rejects(f.service.submit('image', 'ordinary', { prompt: 'robot' }, 0), {
      code: 'PRICE_UNKNOWN',
    });
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('extraction child assets follow the original batch and reject later executions', async () => {
  const { canvasArtifacts, readCanvasRun } = await import('../studio/api/canvas-artifacts.ts');
  const f = await fixture();
  let replaced = false;
  const run = {
    runId: 'run',
    canvasId: 'canvas',
    scope: 'RUN_SCOPE_SEGMENT',
    createTime: '2026-11-13T01:00:00Z',
    nodeIds: ['extract', 'child'],
    steps: [{ nodeId: 'child', stepId: 'step', taskId: 'internaltask-one', status: 'RUN_STEP_STATUS_DONE' }],
  };
  const asset = {
    nodeId: 'child',
    assetId: 'original',
    kind: 'ASSET_KIND_IMAGE',
    url: 'https://cdn.tripo3d.ai/generated-image/image.png',
  };
  const client = canvasClient((method) => {
    if (method.endsWith('/GetRun')) return { run };
    if (method.endsWith('/ListNodeBatches'))
      return { batches: [{ createTime: run.createTime, items: [{ nodeId: 'child', asset }] }] };
    if (method.endsWith('/GetCanvas'))
      return {
        nodeRuns: [
          {
            nodeId: 'child',
            runId: replaced ? 'later' : 'run',
            currentStepId: 'step',
            selectedAssetId: 'original',
            status: 'NODE_STATUS_DONE',
          },
        ],
      };
    return { nodes: [{ nodeId: 'child', assets: [asset] }] };
  });
  try {
    const prepared = f.jobs.prepare(
      'test-account',
      'extract',
      'canvas_run',
      { canvas_id: 'canvas', action: 'generate', node_ids: ['extract'] },
      quote,
    );
    const job = f.jobs.update(prepared.job_id, 'submitted', { remote_ids: { task_id: 'run' } });
    const verified = await readCanvasRun(client, job);
    assert.deepEqual(
      (await canvasArtifacts(client, job, verified, new MemoryLinks())).map((a) => a.artifact_id),
      ['original'],
    );
    replaced = true;
    await assert.rejects(canvasArtifacts(client, job, verified, new MemoryLinks()), {
      code: 'ARTIFACT_NOT_READY',
    });
    run.nodeIds.push('unrelated');
    await assert.rejects(readCanvasRun(client, job), { code: 'CONTRACT_CHANGED' });
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('Canvas animation returns the matching motion separately from its rigged model', async () => {
  const { canvasArtifacts } = await import('../studio/api/canvas-artifacts.ts');
  const f = await fixture();
  const asset = {
    nodeId: 'animated',
    assetId: 'result',
    kind: 'ASSET_KIND_MODEL',
    url: 'https://cdn.tripo3d.ai/rig/model.glb',
  };
  const client = canvasClient((method) =>
    method.endsWith('/GetNodeAssetDetail')
      ? {
          assetId: 'result',
          detail: {
            retarget: [
              { operator_id: 'wrong', status: 'success', model_url: 'https://cdn.tripo3d.ai/wrong.glb' },
              {
                operator_id: 'motion',
                status: 'success',
                model_url: 'https://cdn.tripo3d.ai/motion/animation.glb',
              },
            ],
          },
        }
      : { nodes: [{ nodeId: 'animated', assets: [asset] }] },
  );
  try {
    const job = f.jobs.prepare('test-account', 'animation', 'canvas_run', {}, quote);
    const assets = await canvasArtifacts(
      client,
      job,
      { steps: [{ nodeId: 'animated', taskId: 'motion', status: 'RUN_STEP_STATUS_DONE' }] },
      new MemoryLinks(),
    );
    assert.deepEqual(
      assets.map((a) => a.kind),
      ['model', 'animation'],
    );
    assert.equal(assets[1]?.artifact_id, 'result-animation-motion');
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('Canvas recovers the original operation when downstream work replaces a node model URL', async () => {
  const { canvasArtifacts } = await import('../studio/api/canvas-artifacts.ts');
  const f = await fixture();
  const taskId = '74449e22-c48b-4208-8d71-f8997da11faf';
  const originalUrl = `https://cdn.tripo3d.ai/${taskId}/model.glb`;
  let wrongIdentity = false;
  const client = canvasClient((method, body) => {
    if (method === 'download_with_name') {
      assert.equal(body.operator_id, taskId);
      return { model_url: wrongIdentity ? 'https://cdn.tripo3d.ai/other/model.glb' : originalUrl };
    }
    if (method.endsWith('/GetNodeAssetDetail')) return { assetId: 'asset', detail: { retarget: [] } };
    return {
      nodes: [
        {
          nodeId: 'segment',
          assets: [
            {
              nodeId: 'segment',
              assetId: 'asset',
              kind: 'ASSET_KIND_MODEL',
              url: 'https://cdn.tripo3d.ai/downstream/model.glb',
            },
          ],
        },
      ],
    };
  });
  try {
    const job = f.jobs.prepare('test-account', 'segment-original', 'canvas_run', {}, quote);
    const run = { steps: [{ nodeId: 'segment', taskId, status: 'RUN_STEP_STATUS_DONE' }] };
    const links = new MemoryLinks();
    const assets = await canvasArtifacts(client, job, run, links);
    assert.equal(assets.length, 1);
    assert.equal(links.get(`${job.job_id}:asset`), originalUrl);
    wrongIdentity = true;
    await assert.rejects(canvasArtifacts(client, job, run, new MemoryLinks()), { code: 'CONTRACT_CHANGED' });
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('continuation uses a new persisted answer key and stopped runs are terminal', async () => {
  const { submitCreativeTask } = await import('../studio/api/canvas-agent.ts');
  const { canvasRunStatus } = await import('../studio/api/canvas-run.ts');
  const f = await fixture();
  let sent = 0;
  const client = canvasClient((method, body) => {
    if (method.endsWith('/GetTurnDetail'))
      return {
        turn: { turnId: 'turn', requestId: 'original-create', status: 'TURN_STATUS_WAITING_FOR_USER' },
      };
    if (method.endsWith('/ContinueTurn')) {
      sent++;
      assert.notEqual(body.requestId, 'original-create');
      return {};
    }
    return {
      run: { runId: 'run', canvasId: 'canvas', nodeIds: ['node'], status: 'RUN_STATUS_STOPPED', steps: [] },
    };
  });
  try {
    const job = f.jobs.prepare(
      'test-account',
      'choice',
      'canvas_continue',
      { turn_id: 'turn', selected_option_ids: ['cat'] },
      quote,
    );
    await submitCreativeTask(client, job);
    assert.equal(sent, 1);
    await assert.rejects(
      submitCreativeTask(client, { ...job, input: { ...job.input, request_id: 'original-create' } }),
      { code: 'INVALID_INPUT' },
    );
    assert.equal(sent, 1);
    const state = await canvasRunStatus(
      client,
      { ...job, remote_ids: { task_id: 'run' }, input: { canvas_id: 'canvas', node_ids: ['node'] } },
      new MemoryLinks(),
    );
    assert.equal(state.state, 'failed');
    assert.equal(state.error?.remote_status, 'stopped');
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('completed Canvas queries add late original assets without dropping download records or resubmitting', async () => {
  const f = await fixture();
  try {
    const job = f.jobs.prepare('test-account', 'completed-canvas', 'canvas_run', {}, quote);
    f.jobs.update(job.job_id, 'succeeded', {
      artifacts: [
        { artifact_id: 'saved', kind: 'model', format: 'glb', index: 0, local_path: '/caller/model.glb' },
      ],
    });
    const result = await f.service.get(job.job_id);
    assert.deepEqual(object((result.artifacts as unknown[])[0]), {
      artifact_id: 'saved',
      kind: 'model',
      format: 'glb',
      index: 0,
      local_path: '/caller/model.glb',
    });
    assert.equal((result.artifacts as unknown[]).length, 2);
    assert.equal((await f.service.get(job.job_id)).state, 'succeeded');
    assert.equal(f.jobs.get(job.job_id).artifacts.length, 2);
    assert.equal(f.gateway.posts, 0);
    f.gateway.failPoll = new Error('offline');
    const cached = await f.service.get(job.job_id);
    assert.equal((cached.artifacts as unknown[]).length, 2);
    assert.ok(cached.poll_error);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
