/** 未封口分割的来源身份边界：解析只读、显式意图、前后图一致及签名/业务查询分离。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StudioClient } from '../studio/api/client.ts';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { object } from '../studio/contracts/errors.ts';
import type { Job } from '../studio/contracts/types.ts';
import { resolveUncappedCanvasModelSource } from '../studio/api/canvas-model-source.ts';
import { validUncappedCanvasModelSource } from '../studio/contracts/canvas-model-source.ts';
import { quote } from './helpers.ts';

function fixture() {
  const url = 'https://cdn.tripo3d.ai/task-1/model.glb?variant=original';
  const job: Job = {
    job_id: 'job-1',
    account_ref: 'account-1',
    request_id: 'request-1',
    input_hash: 'hash-1',
    operation: 'canvas_run',
    state: 'succeeded',
    remote_ids: { task_id: 'run-1' },
    input: {
      canvas_id: 'canvas-1',
      node_ids: ['node-1'],
      _canvas_quotes: [{ node_id: 'node-1', node_type: 'SEGMENTATION', parameters: { quick_cap: false } }],
    },
    contract_version: 'test',
    quote,
    progress: 100,
    artifacts: [{ artifact_id: 'asset-1', kind: 'model', format: 'glb', index: 0 }],
    created_at: '',
    updated_at: '',
    lease_until: 0,
  };
  const run = {
    runId: 'run-1',
    canvasId: 'canvas-1',
    nodeIds: ['node-1'],
    status: 'RUN_STATUS_SUCCEEDED',
    steps: [{ stepId: 'step-1', nodeId: 'node-1', taskId: 'task-1', status: 'RUN_STEP_STATUS_DONE' }],
  };
  const asset = {
    nodeId: 'node-1',
    assetId: 'asset-1',
    source: 'ASSET_SOURCE_STUDIO',
    kind: 'ASSET_KIND_MODEL',
    role: 'ASSET_ROLE_CURRENT',
    studioState: 'STUDIO_ASSET_STATE_READY',
    url,
  };
  const graph = {
    canvas: { canvasId: 'canvas-1', revision: '3' },
    nodes: [
      {
        id: 'node-1',
        type: 'NODE_TYPE_SEGMENTATION',
        nodeAssets: [{ assetId: 'asset-1', studioState: 'STUDIO_ASSET_STATE_READY', url }],
      },
    ],
    nodeRuns: [
      {
        nodeId: 'node-1',
        runId: 'run-1',
        currentStepId: 'step-1',
        selectedAssetId: '',
        status: 'NODE_STATUS_DONE',
      },
    ],
  };
  const operator = {
    operator_id: 'task-1',
    type: 'ai_segmentation',
    status: 'success',
    is_owner: true,
    model_url: url,
  };
  const detail = { id: 'project-1', ...operator };
  const state = {
    run,
    graph,
    assets: [asset],
    detail,
    project: { id: 'project-1', is_owner: true, model_url: url, operator },
    graphReads: 0,
    onSecondGraph: () => {},
  };
  const calls: string[] = [];
  const bearer =
    'eyJhbGciOiJIUzI1NiJ9.' +
    Buffer.from(JSON.stringify({ sub: 'account-1', exp: Math.floor(Date.now() / 1000) + 3600 })).toString(
      'base64url',
    ) +
    '.fixture';
  const credentials = new MemoryCredentials({
    accountRef: 'account-1',
    bearer,
    deviceId: 'test',
    importedAt: new Date().toISOString(),
  });
  const studio = new StudioClient(credentials, async (request, init) => {
    const method = String(object(init.headers)['x-micro-method'] ?? request);
    calls.push(method);
    if (request.includes('/project/detail/v3/')) {
      assert.equal(init.method, 'GET');
      assert.ok(request.endsWith('/project-1?operator_id=task-1'));
      return Response.json({ code: 0, data: state.project });
    }
    assert.equal(init.method, 'POST');
    const body = JSON.parse(String(init.body));
    if (method.endsWith('/GetRun')) {
      assert.deepEqual(body, { runId: 'run-1' });
      return Response.json({ run: state.run });
    }
    if (method.endsWith('/GetCanvas')) {
      assert.deepEqual(body, { canvasId: 'canvas-1' });
      if (++state.graphReads === 2) state.onSecondGraph();
      return Response.json(state.graph);
    }
    if (method.endsWith('/ListNodesAssets')) {
      assert.deepEqual(body, { nodeIds: ['node-1'] });
      return Response.json({ nodes: [{ nodeId: 'node-1', assets: state.assets }] });
    }
    if (method.endsWith('/GetNodeAssetDetail')) {
      assert.deepEqual(body, { assetId: 'asset-1' });
      return Response.json({ assetId: 'asset-1', provider: 'studio', detail: state.detail });
    }
    throw Error('Unexpected network route: ' + method);
  });
  return { job, state, calls, studio, credentials };
}

test('explicit false resolves stable source identity with six read-only calls and no mutable fields', async () => {
  const f = fixture(),
    proof = await resolveUncappedCanvasModelSource(f.studio, f.job);
  assert.equal(validUncappedCanvasModelSource(f.job, proof), true);
  assert.equal(proof.operator_id, 'task-1');
  assert.equal(proof.artifact_id, 'asset-1');
  assert.equal(proof.task_type, 'mesh_segmentation');
  assert.equal(f.calls.length, 6);
  assert.equal(/https|observed_at|revision/.test(JSON.stringify(proof)), false);
  assert.equal(validUncappedCanvasModelSource({ ...f.job, input_hash: 'other' }, proof), false);
  assert.equal(validUncappedCanvasModelSource({ ...f.job, account_ref: 'other' }, proof), false);
  assert.equal(validUncappedCanvasModelSource(f.job, { ...proof, operator_id: 'other' }), false);
  assert.equal(validUncappedCanvasModelSource(f.job, { ...proof, artifact_id: 'other' }), false);
});

for (const value of [undefined, true, null, 'false'])
  test(`uncapped source rejects frozen quick_cap=${String(value)} before reads`, async () => {
    const f = fixture();
    object(object((f.job.input._canvas_quotes as unknown[])[0]).parameters).quick_cap = value;
    await assert.rejects(resolveUncappedCanvasModelSource(f.studio, f.job), {
      code: 'CANVAS_MODEL_SOURCE_UNVERIFIED',
    });
    assert.equal(f.calls.length, 0);
  });

for (const mode of [
  'multiple-local-models',
  'multiple-assets',
  'wrong-step',
  'wrong-operator',
  'not-owned',
  'different-business-query',
  'stale-role',
  'not-ready',
])
  test(`uncapped source rejects ${mode}`, async () => {
    const f = fixture();
    if (mode === 'multiple-local-models')
      f.job.artifacts.push({ artifact_id: 'other', kind: 'model', format: 'glb', index: 1 });
    if (mode === 'multiple-assets') f.state.assets.push({ ...f.state.assets[0]!, assetId: 'other' });
    if (mode === 'wrong-step') f.state.graph.nodeRuns[0]!.currentStepId = 'new-step';
    if (mode === 'wrong-operator') f.state.detail.operator_id = 'new-task';
    if (mode === 'not-owned') f.state.detail.is_owner = false;
    if (mode === 'different-business-query') f.state.detail.model_url += '&variant=changed';
    if (mode === 'stale-role') f.state.assets[0]!.role = 'ASSET_ROLE_HISTORY';
    if (mode === 'not-ready') f.state.assets[0]!.studioState = 'STUDIO_ASSET_STATE_PROCESSING';
    await assert.rejects(resolveUncappedCanvasModelSource(f.studio, f.job), {
      code: 'CANVAS_MODEL_SOURCE_UNVERIFIED',
    });
  });

for (const change of ['rerun', 'revision', 'asset-url', 'job-input', 'account'])
  test(`uncapped source rejects concurrent ${change}`, async () => {
    const f = fixture();
    f.state.onSecondGraph = () => {
      if (change === 'rerun') f.state.graph.nodeRuns[0]!.runId = 'new-run';
      if (change === 'revision') f.state.graph.canvas.revision = '4';
      if (change === 'asset-url') f.state.graph.nodes[0]!.nodeAssets[0]!.url += '&purpose=other';
      if (change === 'job-input') f.job.input_hash = 'changed';
      if (change === 'account') f.credentials.save({ ...f.credentials.load()!, accountRef: 'other' });
    };
    await assert.rejects(resolveUncappedCanvasModelSource(f.studio, f.job), {
      code: change === 'account' ? 'ACCOUNT_MISMATCH' : 'CANVAS_MODEL_SOURCE_UNVERIFIED',
    });
    assert.equal(f.calls.length, 6);
  });

test('temporary URL authorization can rotate while business query and stable proof remain equal', async () => {
  const f = fixture();
  f.state.detail.model_url += '&Signature=first&Expires=1&Key-Pair-Id=key';
  f.state.project.operator.model_url += '&Signature=second&Expires=2&Key-Pair-Id=key';
  f.state.onSecondGraph = () => {
    f.state.graph.nodes[0]!.nodeAssets[0]!.url += '&Signature=third&Expires=3&Key-Pair-Id=key';
  };
  const proof = await resolveUncappedCanvasModelSource(f.studio, f.job);
  assert.equal(validUncappedCanvasModelSource(f.job, proof), true);
  const other = fixture();
  assert.deepEqual(await resolveUncappedCanvasModelSource(other.studio, other.job), proof);
});
