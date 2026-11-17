/** 真实两步封口返回形状的边界：原分割不能冒充最终件，后续重跑/历史编辑不能偷换旧任务。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fixture, quote } from './helpers.ts';
import { StudioClient } from '../studio/api/client.ts';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { MemoryLinks } from '../studio/auth/artifact-links.ts';
import { canvasArtifacts, canvasArtifactUrl } from '../studio/api/canvas-artifacts.ts';
import { canvasRunStatus } from '../studio/api/canvas-run.ts';
import { canvasResultView } from '../studio/contracts/canvas-result.ts';
import { taskResult, downloadTask } from '../cli/compat/runtime.ts';
import { assertCanvasBytes, assertCanvasSnapshot } from '../cli/core/canvas-output.ts';
import { object } from '../studio/contracts/errors.ts';
import type { Artifact } from '../studio/contracts/types.ts';

const ids = {
  canvas: 'canvas-1',
  run: 'run-1',
  node: 'node-1',
  step: 'step-1',
  task: 'task-1',
  asset: 'asset-1',
  project: 'project-1',
  segment: 'segment-1',
  final: 'final-1',
};
const file = (id: string, name = 'model.glb') => `https://cdn.tripo3d.ai/${id}/${name}`;
async function setup(quickCap: boolean | 'omitted' = true) {
  const f = await fixture();
  const prepared = f.jobs.prepare(
    'test-account',
    'cap',
    'canvas_run',
    {
      canvas_id: ids.canvas,
      node_ids: [ids.node],
      _canvas_quotes: [
        {
          node_id: ids.node,
          node_type: 'SEGMENTATION',
          parameters: quickCap === 'omitted' ? {} : { quick_cap: quickCap },
        },
      ],
    },
    quote,
  );
  let job = f.jobs.update(prepared.job_id, 'succeeded', { remote_ids: { task_id: ids.run } });
  const run = {
    runId: ids.run,
    canvasId: ids.canvas,
    nodeIds: [ids.node],
    status: 'RUN_STATUS_SUCCEEDED',
    steps: [{ nodeId: ids.node, stepId: ids.step, taskId: ids.task, status: 'RUN_STEP_STATUS_DONE' }],
  };
  const asset = {
    nodeId: ids.node,
    assetId: ids.asset,
    source: 'ASSET_SOURCE_STUDIO',
    kind: 'ASSET_KIND_MODEL',
    role: 'ASSET_ROLE_CURRENT',
    studioState: 'STUDIO_ASSET_STATE_READY',
    selected: false,
    thumbnailUrl: file(ids.task, 'preview.webp'),
    url: file(ids.final),
  };
  const graph = {
    canvas: { canvasId: ids.canvas, revision: '20' },
    nodeRuns: [
      {
        nodeId: ids.node,
        runId: ids.run,
        currentStepId: ids.step,
        selectedAssetId: '',
        status: 'NODE_STATUS_DONE',
      },
    ],
  };
  const history = [
    { operator_id: ids.final, type: 'mesh_fill' },
    { operator_id: ids.segment, type: 'ai_segmentation' },
  ];
  const ops = new Map<string, Record<string, unknown>>([
    [ids.final, { operator_id: ids.final, type: 'mesh_fill', status: 'success', model_url: file(ids.final) }],
    [
      ids.segment,
      {
        operator_id: ids.segment,
        type: 'ai_segmentation',
        status: 'success',
        model_url: file(ids.task),
        segmentation_map_url: file(ids.task, 'map.png'),
      },
    ],
  ]);
  const state = {
    assets: [asset],
    graph,
    history,
    ops,
    detail: { id: ids.project, is_owner: true, ...ops.get(ids.final) },
    owner: true,
    graphReads: 0,
    historyReads: 0,
    afterGraph: (() => {}) as () => void,
    afterHistory: (() => {}) as () => void,
  };
  const calls: string[] = [];
  const bearer =
    'eyJhbGciOiJIUzI1NiJ9.' +
    Buffer.from(JSON.stringify({ sub: 'test-account', exp: Math.floor(Date.now() / 1000) + 3600 })).toString(
      'base64url',
    ) +
    '.fixture';
  const client = new StudioClient(
    new MemoryCredentials({
      accountRef: 'test-account',
      bearer,
      deviceId: 'test',
      importedAt: new Date().toISOString(),
    }),
    async (url, init) => {
      const method = String(object(init.headers)['x-micro-method'] ?? url);
      calls.push(method);
      if (url.includes('/txn/records')) return Response.json({ code: 0, data: { records: [] } });
      if (url.includes('/project/detail/v3/')) {
        const id = new URL(url).searchParams.get('operator_id')!;
        const operator = state.ops.get(id);
        assert.ok(operator, 'only exact saved operators can be read');
        return Response.json({
          code: 0,
          data: { id: ids.project, is_owner: state.owner, model_url: operator.model_url, operator },
        });
      }
      if (url.includes('/project/history/')) {
        if (++state.historyReads === 2) state.afterHistory();
        return Response.json({ code: 0, data: { history: state.history } });
      }
      let data: unknown;
      if (method.endsWith('/GetRun')) data = { run };
      else if (method.endsWith('/ListNodesAssets'))
        data = { nodes: [{ nodeId: ids.node, assets: state.assets }] };
      else if (method.endsWith('/GetCanvas')) {
        if (++state.graphReads === 2) state.afterGraph();
        data = state.graph;
      } else if (method.endsWith('/GetNodeAssetDetail'))
        data = { assetId: ids.asset, provider: 'studio', detail: state.detail };
      else throw new Error('Unexpected route: ' + method);
      return Response.json({ error: { code: 0 }, ...object(data) });
    },
  );
  const links = new MemoryLinks();
  const read = () => canvasArtifacts(client, job, run, links);
  const freeze = async () => {
    job = f.jobs.update(job.job_id, 'succeeded', { artifacts: await read() });
    return job;
  };
  const close = async () => {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  };
  return { ...f, job, run, state, client, links, calls, read, freeze, close };
}

test('empty selection with a unique ready asset binds the capped model, never the raw operation', async () => {
  const s = await setup();
  try {
    const [a] = await s.read();
    assert.equal(a?.artifact_id, `${ids.asset}-cap-${ids.final}`);
    assert.equal(a?.canvas_result?.task_id, ids.task);
    assert.equal(s.links.get(`${s.job.job_id}:${a!.artifact_id}`), file(ids.final));
    assert.equal(
      s.calls.some((c) => c.includes('download_with_name')),
      false,
    );
    assert.equal(s.state.graphReads, 2);
    assert.equal(s.state.historyReads, 2);
  } finally {
    await s.close();
  }
});
test('omitted quick_cap retains the observed webpage true default while explicit false disables it', async () => {
  const s = await setup('omitted');
  try {
    assert.equal(canvasResultView(s.job).state, 'needs_attention');
    const job = await s.freeze();
    assert.equal(job.artifacts[0]!.canvas_result?.stage, 'segmentation_quick_cap');
    assert.equal(canvasResultView(job).state, undefined);
  } finally {
    await s.close();
  }
  const disabled = await setup(false);
  try {
    assert.deepEqual(canvasResultView(disabled.job), {});
  } finally {
    await disabled.close();
  }
});

test('capped model identity permits renewed signatures but retains business query parameters', async () => {
  const s = await setup();
  try {
    s.state.assets[0]!.url = file(ids.final) + '?variant=capped&Signature=old&Expires=1';
    Object.assign(s.state.detail, { model_url: file(ids.final) + '?Expires=2&variant=capped&Signature=new' });
    s.state.ops.get(ids.final)!.model_url = file(ids.final) + '?Signature=next&variant=capped&Expires=3';
    assert.equal((await s.read()).length, 1);
    Object.assign(s.state.detail, { model_url: file(ids.final) + '?variant=raw&Signature=new&Expires=2' });
    await assert.rejects(s.read(), { code: 'CANVAS_FINAL_ARTIFACT_UNVERIFIED' });
  } finally {
    await s.close();
  }
});

for (const scenario of [
  'extra-history',
  'foreign-owner',
  'wrong-source',
  'wrong-preview',
  'duplicate-asset',
  'later-run',
  'different-selection',
  'later-step',
  'history-race',
  'run-race',
  'running-final',
] as const) {
  test(`capped model bootstrap rejects ${scenario} without falling back to the uncapped model`, async () => {
    const s = await setup();
    try {
      if (scenario === 'extra-history') s.state.history.push({ operator_id: 'later', type: 'mesh_fill' });
      if (scenario === 'foreign-owner') s.state.owner = false;
      if (scenario === 'wrong-source') s.state.ops.get(ids.segment)!.model_url = file('another-task');
      if (scenario === 'wrong-preview')
        s.state.assets[0]!.thumbnailUrl = file('another-task', 'preview.webp');
      if (scenario === 'duplicate-asset') s.state.assets.push({ ...s.state.assets[0]! });
      if (scenario === 'later-run') s.state.graph.nodeRuns[0]!.runId = 'later';
      if (scenario === 'different-selection') s.state.graph.nodeRuns[0]!.selectedAssetId = 'other-asset';
      if (scenario === 'later-step') s.state.graph.nodeRuns[0]!.currentStepId = 'later';
      if (scenario === 'history-race')
        s.state.afterHistory = () => {
          s.state.history.push({ operator_id: 'later', type: 'mesh_fill' });
        };
      if (scenario === 'run-race')
        s.state.afterGraph = () => {
          s.state.graph.nodeRuns[0]!.runId = 'later';
        };
      if (scenario === 'running-final') s.state.ops.get(ids.final)!.status = 'running';
      await assert.rejects(s.read(), { code: 'CANVAS_FINAL_ARTIFACT_UNVERIFIED' });
      assert.equal(
        s.calls.some((c) => c.includes('download_with_name')),
        false,
      );
    } finally {
      await s.close();
    }
  });
}

test('frozen results recover the exact operator after the graph is rerun and history is extended', async () => {
  const s = await setup();
  try {
    const job = await s.freeze(),
      a = job.artifacts[0]!;
    s.state.graph.nodeRuns[0]!.runId = 'later';
    s.state.history.unshift({ operator_id: 'later', type: 'mesh_fill' });
    s.state.assets.length = 0;
    s.calls.length = 0;
    assert.equal(await canvasArtifactUrl(s.client, job, a, new MemoryLinks()), file(ids.final));
    assert.equal(s.calls.length, 1);
    assert.match(s.calls[0]!, new RegExp(`operator_id=${ids.final}$`));
    const status = await canvasRunStatus(s.client, job, new MemoryLinks());
    assert.deepEqual(status.artifacts, [a]);
    assert.equal(
      s.calls.some((c) => /GetCanvas|ListNodesAssets|history\//.test(c)),
      false,
    );
  } finally {
    await s.close();
  }
});

test('old raw downloads stay persisted but task get/list/default download expose only the final model', async () => {
  const s = await setup();
  try {
    const raw: Artifact = {
      artifact_id: ids.asset,
      kind: 'model',
      format: 'glb',
      index: 0,
      local_path: '/caller/original-raw.glb',
      sha256: 'a'.repeat(64),
      bytes: 123,
    };
    s.jobs.update(s.job.job_id, 'succeeded', { artifacts: [raw] });
    assert.equal(s.service.summary(s.jobs.get(s.job.job_id)).state, 'needs_attention');
    s.gateway.status = (job) => canvasRunStatus(s.client, job, s.links);
    const view = await s.service.get(s.job.job_id);
    const persisted = s.jobs.get(s.job.job_id);
    assert.equal(view.state, 'succeeded');
    assert.equal((view.artifacts as Artifact[]).length, 1);
    assert.deepEqual(view.intermediate_artifacts, [raw]);
    assert.deepEqual(
      persisted.artifacts.find((a) => a.artifact_id === ids.asset),
      raw,
    );
    assert.deepEqual(taskResult(view).intermediate_artifacts, [raw]);
    await assert.rejects(s.service.download(s.job.job_id, ids.asset, '/caller/should-not-be-written.glb'), {
      code: 'CANVAS_FINAL_ARTIFACT_UNVERIFIED',
    });
    const list = s.service.summary(persisted);
    assert.deepEqual(list.artifacts, view.artifacts);
    // 调用方传入陈旧 artifacts 也不能利用本地缓存快路径下载 raw。
    await assert.rejects(
      downloadTask({ service: s.service } as never, { ...view, artifacts: [raw] }, { output: s.dir }),
      { code: 'CANVAS_FINAL_ARTIFACT_UNVERIFIED' },
    );
  } finally {
    await s.close();
  }
});

test('failed bootstrap retains remote success but prevents a success view with uncapped output', async () => {
  const s = await setup();
  try {
    s.jobs.update(s.job.job_id, 'succeeded', {
      artifacts: [{ artifact_id: ids.asset, kind: 'model', format: 'glb', index: 0 }],
    });
    s.state.history.push({ operator_id: 'later', type: 'mesh_fill' });
    s.gateway.status = (job) => canvasRunStatus(s.client, job, s.links);
    const view = await s.service.get(s.job.job_id);
    assert.equal(view.state, 'needs_attention');
    assert.equal(view.remote_state, 'succeeded');
    assert.deepEqual(view.artifacts, []);
    assert.equal(s.jobs.get(s.job.job_id).state, 'succeeded');
  } finally {
    await s.close();
  }
});

test('frozen node identity and first downloaded bytes cannot be changed by another reader', async () => {
  const s = await setup();
  try {
    const job = await s.freeze(),
      a = job.artifacts[0]!;
    const other = {
      ...a,
      canvas_result: { ...a.canvas_result!, final_operator_id: 'another-final' },
      artifact_id: `${ids.asset}-cap-another-final`,
    };
    assert.throws(() => s.jobs.update(job.job_id, 'succeeded', { artifacts: [other] }), {
      code: 'CANVAS_RESULT_IDENTITY_CHANGED',
    });
    const bytes = Buffer.from('first validated model bytes');
    const saved = {
      ...a,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      local_path: '/caller/final.glb',
    };
    assert.throws(() => s.jobs.saveArtifact(job.job_id, saved), { code: 'CANVAS_RESULT_CONTENT_UNVERIFIED' });
    s.jobs.freezeCanvasArtifactBytes(job, a, bytes);
    assert.equal(s.jobs.get(job.job_id).artifacts[0]!.local_path, undefined);
    assert.throws(() => s.jobs.freezeCanvasArtifactBytes(job, a, Buffer.from('different model')), {
      code: 'CANVAS_RESULT_CONTENT_CHANGED',
    });
    s.jobs.saveArtifact(job.job_id, saved);
    assert.throws(() => assertCanvasBytes(saved, Buffer.from('different bytes')), {
      code: 'CANVAS_RESULT_CONTENT_CHANGED',
    });
    assertCanvasBytes(saved, bytes);
    assert.throws(() => s.jobs.saveArtifact(job.job_id, { ...saved, sha256: 'b'.repeat(64) }), {
      code: 'CANVAS_RESULT_IDENTITY_CHANGED',
    });
    assert.equal(
      s.jobs.update(job.job_id, 'succeeded', { artifacts: [a] }).artifacts[0]!.local_path,
      '/caller/final.glb',
    );
    assert.throws(() => assertCanvasSnapshot(job, a, { ...job, remote_ids: { task_id: 'later' } }), {
      code: 'CANVAS_RESULT_IDENTITY_CHANGED',
    });
    assert.equal(canvasResultView({ ...job, input_hash: 'other' }).state, 'needs_attention');
  } finally {
    await s.close();
  }
});
