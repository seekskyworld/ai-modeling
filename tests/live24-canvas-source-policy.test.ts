/** 显式无封口来源冻结后不再读取会变化的画布；错误来源和并发写入不能替换原证据。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { fixture, quote } from './helpers.ts';
import type { Job } from '../studio/contracts/types.ts';
import { StudioClient } from '../studio/api/client.ts';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import type { UncappedCanvasModelSourceProof } from '../studio/contracts/canvas-model-source.ts';
import { canvasModelSource, bindCanvasModelSource } from '../cli/compat/canvas-source.ts';
import {
  canvasModelSourcePolicyKey,
  canvasModelSourceProof,
  prepareCanvasModelSource,
} from '../cli/compat/canvas-source-policy.ts';
import { executePlan, type Application } from '../cli/compat/runtime.ts';
import { processingPlan } from '../cli/compat/planning.ts';
import { Operations } from '../studio/api/operations.ts';

async function setup() {
  const f = await fixture();
  const prepared = f.jobs.prepare(
    'test-account',
    'uncapped-original',
    'canvas_run',
    {
      canvas_id: 'canvas-original',
      node_ids: ['node-original'],
      _canvas_quotes: [
        { node_id: 'node-original', node_type: 'SEGMENTATION', parameters: { quick_cap: false } },
      ],
    },
    quote,
  );
  const source = f.jobs.update(prepared.job_id, 'succeeded', {
    remote_ids: { task_id: 'run-original' },
    artifacts: [{ artifact_id: 'asset-original', kind: 'model', format: 'glb', index: 0 }],
  });
  const proof: UncappedCanvasModelSourceProof = {
    version: 1,
    job_id: source.job_id,
    account_ref: source.account_ref,
    input_hash: source.input_hash,
    canvas_id: 'canvas-original',
    run_id: 'run-original',
    node_id: 'node-original',
    step_id: 'step-original',
    task_id: 'segment-original',
    asset_id: 'asset-original',
    artifact_id: 'asset-original',
    project_id: 'project-original',
    operator_id: 'segment-original',
    task_type: 'mesh_segmentation',
  };
  const key = canvasModelSourcePolicyKey(source);
  return {
    ...f,
    source,
    proof,
    key,
    close: async () => {
      f.jobs.close();
      await rm(f.dir, { recursive: true, force: true });
    },
  };
}

function resolvingClient(proof: UncappedCanvasModelSourceProof, finished = () => {}) {
  let reads = 0;
  const url = `https://cdn.tripo3d.ai/${proof.task_id}/model.glb`;
  const asset = {
    assetId: proof.asset_id,
    nodeId: proof.node_id,
    url,
    kind: 'ASSET_KIND_MODEL',
    role: 'ASSET_ROLE_CURRENT',
    source: 'ASSET_SOURCE_STUDIO',
    studioState: 'STUDIO_ASSET_STATE_READY',
  };
  const detail = {
    id: proof.project_id,
    operator_id: proof.operator_id,
    is_owner: true,
    status: 'success',
    type: 'ai_segmentation',
    model_url: url,
  };
  const graph = {
    canvas: { canvasId: proof.canvas_id, revision: '4' },
    nodes: [{ id: proof.node_id, type: 'NODE_TYPE_SEGMENTATION', nodeAssets: [asset] }],
    nodeRuns: [
      {
        nodeId: proof.node_id,
        runId: proof.run_id,
        currentStepId: proof.step_id,
        status: 'NODE_STATUS_DONE',
        selectedAssetId: proof.asset_id,
      },
    ],
  };
  const bearer =
    'eyJhbGciOiJIUzI1NiJ9.' +
    Buffer.from(
      JSON.stringify({ sub: proof.account_ref, exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString('base64url') +
    '.fixture';
  const client = new StudioClient(
    new MemoryCredentials({ accountRef: proof.account_ref, bearer, deviceId: 'fixture', importedAt: '' }),
    async (url, init) => {
      reads++;
      const method = new Headers(init.headers).get('x-micro-method');
      if (method?.endsWith('/GetRun'))
        return Response.json({
          run: {
            runId: proof.run_id,
            canvasId: proof.canvas_id,
            nodeIds: [proof.node_id],
            status: 'RUN_STATUS_SUCCEEDED',
            steps: [
              {
                nodeId: proof.node_id,
                stepId: proof.step_id,
                taskId: proof.task_id,
                status: 'RUN_STEP_STATUS_DONE',
              },
            ],
          },
        });
      if (method?.endsWith('/GetCanvas')) {
        if (reads === 6) finished();
        return Response.json(graph);
      }
      if (method?.endsWith('/ListNodesAssets'))
        return Response.json({ nodes: [{ nodeId: proof.node_id, assets: [asset] }] });
      if (method?.endsWith('/GetNodeAssetDetail'))
        return Response.json({ assetId: proof.asset_id, provider: 'studio', detail });
      assert.equal(new URL(url).pathname, `/v2/studio/project/detail/v3/${proof.project_id}`);
      assert.equal(new URL(url).searchParams.get('operator_id'), proof.operator_id);
      return Response.json({
        code: 0,
        data: { id: proof.project_id, is_owner: true, model_url: detail.model_url, operator: detail },
      });
    },
  );
  return { client, reads: () => reads };
}

test('first source preparation freezes all six read proofs before any downstream submission', async () => {
  const f = await setup();
  try {
    const transport = resolvingClient(f.proof);
    await prepareCanvasModelSource(
      { jobs: f.jobs, client: transport.client, accountRef: () => 'test-account' },
      f.source,
    );
    assert.equal(transport.reads(), 6);
    assert.deepEqual(canvasModelSourceProof(f.jobs, f.source), f.proof);
    await prepareCanvasModelSource(
      { jobs: f.jobs, client: transport.client, accountRef: () => 'test-account' },
      f.source,
    );
    assert.equal(transport.reads(), 6);
    assert.equal(f.gateway.posts, 0);
  } finally {
    await f.close();
  }
});

for (const changed of ['account', 'source'] as const)
  test(`${changed} changes during initial resolution cannot be frozen`, async () => {
    const f = await setup();
    try {
      let account = 'test-account';
      const transport = resolvingClient(f.proof, () => {
        if (changed === 'account') account = 'other-account';
        else f.jobs.update(f.source.job_id, 'succeeded', { remote_ids: { task_id: 'different-run' } });
      });
      await assert.rejects(
        prepareCanvasModelSource(
          { jobs: f.jobs, client: transport.client, accountRef: () => account },
          f.source,
        ),
        {
          code: changed === 'account' ? 'ACCOUNT_MISMATCH' : 'CANVAS_MODEL_SOURCE_CONFLICT',
        },
      );
      assert.equal(f.jobs.requestPolicy('test-account', f.key), undefined);
      assert.equal(f.gateway.posts, 0);
    } finally {
      await f.close();
    }
  });

test('a frozen uncapped source restores without Canvas reads and binds actual segment identity', async () => {
  const f = await setup();
  try {
    f.jobs.bindRequestPolicy('test-account', f.key, { ...f.proof });
    let reads = 0;
    const client = {
      request: async () => {
        reads++;
        throw Error('Canvas has changed or is unavailable');
      },
    } as unknown as StudioClient;
    const context = { jobs: f.jobs, client, accountRef: () => 'test-account' };
    const source = await prepareCanvasModelSource(context, f.source);
    assert.deepEqual(source, {
      artifact_id: 'asset-original',
      project_id: 'project-original',
      operator_id: 'segment-original',
      task_type: 'mesh_segmentation',
    });
    assert.equal(reads, 0);
    const proof = canvasModelSourceProof(f.jobs, f.source);
    assert.deepEqual(bindCanvasModelSource(f.source, 'copy', {}, proof)?.parameters, {
      project_id: 'project-original',
      operator_id: 'segment-original',
    });
    assert.deepEqual(bindCanvasModelSource(f.source, 'remesh', {}, proof)?.parameters, {
      project_id: 'project-original',
      expected_operator_id: 'segment-original',
    });
    assert.throws(
      () => bindCanvasModelSource(f.source, 'remesh', { expected_operator_id: 'changed' }, proof),
      { code: 'CANVAS_SOURCE_CONFLICT' },
    );
    assert.deepEqual(f.jobs.get(f.source.job_id).remote_ids, { task_id: 'run-original' });
  } finally {
    await f.close();
  }
});

test('a saved source proof cannot migrate to another job, account, input, run or artifact', async () => {
  const f = await setup();
  try {
    for (const key of [
      'job_id',
      'account_ref',
      'input_hash',
      'canvas_id',
      'run_id',
      'artifact_id',
      'asset_id',
      'task_id',
    ] as const)
      assert.throws(
        () => canvasModelSource(f.source, { ...f.proof, [key]: 'different' }),
        { code: 'CANVAS_MODEL_SOURCE_CONFLICT' },
        key,
      );
    const altered = structuredClone(f.source);
    altered.input._canvas_quotes = [{ node_id: 'node-original', node_type: 'SEGMENTATION', parameters: {} }];
    assert.throws(() => canvasModelSource(altered, f.proof), { code: 'CANVAS_MODEL_SOURCE_CONFLICT' });
    const multiple = {
      ...f.source,
      artifacts: [
        ...f.source.artifacts,
        { artifact_id: 'another', kind: 'model' as const, format: 'glb', index: 1 },
      ],
    };
    assert.throws(() => canvasModelSource(multiple, f.proof), { code: 'CANVAS_MODEL_SOURCE_CONFLICT' });
  } finally {
    await f.close();
  }
});

test('foreign accounts and corrupted persisted source proofs fail before any remote lookup', async () => {
  const f = await setup();
  try {
    let reads = 0;
    const client = {
      request: async () => {
        reads++;
        throw Error('must not read');
      },
    } as unknown as StudioClient;
    await assert.rejects(
      prepareCanvasModelSource({ jobs: f.jobs, client, accountRef: () => 'other-account' }, f.source),
      { code: 'ACCOUNT_MISMATCH' },
    );
    f.jobs.bindRequestPolicy('test-account', f.key, { ...f.proof, artifact_id: 'foreign' });
    await assert.rejects(
      prepareCanvasModelSource({ jobs: f.jobs, client, accountRef: () => 'test-account' }, f.source),
      { code: 'CANVAS_MODEL_SOURCE_CONFLICT' },
    );
    assert.equal(reads, 0);
  } finally {
    await f.close();
  }
});

test('separate SQLite handles reject conflicting first bindings and retain the original source', async () => {
  const f = await setup();
  const other = await fixture(f.dir);
  try {
    f.jobs.bindRequestPolicy('test-account', f.key, { ...f.proof });
    assert.throws(
      () => other.jobs.bindRequestPolicy('test-account', f.key, { ...f.proof, project_id: 'other-project' }),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    assert.deepEqual(canvasModelSourceProof(other.jobs, f.source), f.proof);
  } finally {
    other.jobs.close();
    await f.close();
  }
});

test('ordinary CLI processing resumes the original uncapped source after the graph and current project change', async () => {
  const f = await setup();
  try {
    f.jobs.bindRequestPolicy('test-account', f.key, { ...f.proof });
    let current = 'segment-original';
    const calls: string[] = [],
      submissions: Job[] = [];
    const client = {
      request: async (method: string, route: string) => {
        calls.push(`${method} ${route}`);
        assert.equal(method, 'GET');
        assert.equal(route, '/v2/studio/project/detail/v3/project-original');
        return {
          id: 'project-original',
          is_owner: true,
          operator: { operator_id: current, status: 'success' },
        };
      },
    } as unknown as StudioClient;
    const operations = new Operations(client, []);
    f.gateway.submit = async (job) => {
      await operations.build(job);
      submissions.push(structuredClone(job));
      return { remote_ids: { project_id: 'project-original', operator_id: 'remesh-result' } };
    };
    f.gateway.status = async () => ({ state: 'succeeded', progress: 100, artifacts: [] });
    const app = { service: f.service, studio: { client } } as Application;
    const plan = () => processingPlan('decimate', f.source.job_id, { model: 'default', faceLimit: 5000 });
    const flags = { requestId: 'from-uncapped-canvas', download: false, open: false, yes: true };
    const result = await executePlan(app, plan(), flags);
    assert.equal(result.status, 'success');
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0]!.input.project_id, 'project-original');
    assert.equal(submissions[0]!.input.expected_operator_id, 'segment-original');
    current = 'project-after-edit';
    calls.length = 0;
    const restored = await executePlan(app, plan(), flags);
    assert.equal(restored.task_id, result.task_id);
    assert.equal(submissions.length, 1);
    assert.deepEqual(calls, []);
    assert.deepEqual(f.jobs.get(f.source.job_id).remote_ids, { task_id: 'run-original' });
  } finally {
    await f.close();
  }
});
