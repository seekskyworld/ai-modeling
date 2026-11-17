/** 保存/进程重启后仍隐藏旧清单；只有同源同参数的真实 Detect 回执能够准备解除失效标志。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ExtractionFileMemory, extractionMemory } from '../cli/storage/extraction.ts';
import type { TaskService } from '../cli/core/service.ts';
import { extractionPlan, extractionPlanSchema } from '../studio/api/canvas-extraction-plan.ts';
import {
  extractionContext,
  withExtractionMemory,
  type DetectionReceipt,
} from '../studio/api/canvas-extraction-memory.ts';
import { array, object } from '../studio/contracts/errors.ts';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { StudioClient } from '../studio/api/client.ts';
import { prepareCanvasRun, submitCanvasRun } from '../studio/api/canvas-run.ts';
import type { Job } from '../studio/contracts/types.ts';

function fixture() {
  const graph: Record<string, unknown> = {
    canvas: { canvasId: 'canvas', projectId: 'project', revision: '5' },
    nodes: [
      {
        id: 'image',
        type: 'NODE_TYPE_UPLOAD_CARD',
        params: { assetType: 'image' },
        inputMount: [
          { assetId: 'source', url: 'https://cdn.tripo3d.ai/source.png?sig=secret', transform: [1, 0] },
        ],
      },
      {
        id: 'split',
        type: 'NODE_TYPE_SEMANTIC_SPLIT',
        params: { split_mode: 'auto', amount: 2 },
        extraction: { detectedParts: ['old head', 'old body'], detectionStale: false },
      },
    ],
    edges: [
      { id: 'edge', source: { nodeId: 'image', port: 'image' }, target: { nodeId: 'split', port: 'image' } },
    ],
    nodeRuns: [
      {
        nodeId: 'split',
        status: 'NODE_STATUS_DONE',
        runId: 'old-run',
        currentStepId: 'old-step',
        selectedAssetId: 'old-asset',
      },
    ],
  };
  const asset = (id: string, title: string) => ({
    nodeId: 'split',
    assetId: id,
    role: 'ASSET_ROLE_CURRENT',
    factsJson: JSON.stringify({ candidates: [{ title }] }),
  });
  return { graph, assets: [asset('old-asset', 'old head')], asset };
}
function saved(graph: Record<string, unknown>, plan: Record<string, unknown>) {
  const params = object(array(plan.actions)[0]).params;
  assert.ok(params);
  object(array(graph.nodes)[1]).params = params;
  object(graph.canvas).revision = String(Number(object(graph.canvas).revision) + 1);
}
async function prepare(
  memory: ExtractionFileMemory,
  graph: Record<string, unknown>,
  assets: unknown[],
  values: Record<string, unknown> = {},
  account = 'account',
) {
  const input = extractionPlanSchema.parse({ canvasId: 'canvas', nodeId: 'split', ...values });
  return await withExtractionMemory(memory, account, graph, assets, input, (accepted) =>
    extractionPlan(graph, assets, input, accepted),
  );
}

test('amount/save/restart remains stale until a new successful, verified Detect produces a current asset', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tripo-extraction-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const f = fixture();
  let verified = false;
  let memory = new ExtractionFileMemory(dir, () => verified);
  const invalid = await prepare(memory, f.graph, f.assets, { amount: 3 });
  saved(f.graph, invalid);
  assert.equal(object(object(array(invalid.actions)[0]).params).detect_list_stale, true);
  memory = new ExtractionFileMemory(dir, () => verified);
  let plan = await prepare(memory, f.graph, f.assets, { action: 'generate' });
  assert.equal(plan.blocked, 'detection_stale');
  assert.deepEqual(object(plan.state).parts, []);
  plan = await prepare(memory, f.graph, f.assets, { action: 'detect' });
  assert.equal(object(plan.state).stale, true);
  assert.deepEqual(plan.actions, []);
  assert.equal(object(plan.run_parameters).action, 'detect');
  const run = object(array(f.graph.nodeRuns)[0]);
  Object.assign(run, { runId: 'new-run', currentStepId: 'new-step', selectedAssetId: 'new-asset' });
  f.assets = [f.asset('new-asset', 'new head')];
  verified = true;
  for (const status of ['NODE_STATUS_RUNNING', 'NODE_STATUS_FAILED']) {
    run.status = status;
    assert.equal(object((await prepare(memory, f.graph, f.assets)).state).stale, true);
  }
  run.status = 'NODE_STATUS_DONE';
  verified = false;
  assert.equal(object((await prepare(memory, f.graph, f.assets)).state).stale, true);
  verified = true;
  plan = await prepare(memory, f.graph, f.assets, { action: 'generate' });
  assert.equal(plan.blocked, null);
  assert.deepEqual(object(plan.state).parts, ['new head']);
  assert.equal(object(plan.detection_memory).fresh_detection_verified, true);
  assert.equal(object(plan.run_parameters).revision, undefined);
  assert.equal(object(object(array(plan.actions)[0]).params).detect_list_stale, undefined);
  saved(f.graph, plan);
  assert.deepEqual((await prepare(memory, f.graph, f.assets)).actions, []);
  const file = path.join(
    dir,
    (await readdir(dir)).find((file) => file.endsWith('.json'))!,
  );
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const raw = await readFile(file, 'utf8');
  assert.doesNotMatch(raw, /secret|https:|source\.png/);
});

test('unsaved plans, alternate parameter plans and account/source changes cannot inherit a fresh detection', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tripo-extraction-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const memory = new ExtractionFileMemory(dir, () => true),
    f = fixture();
  const three = await prepare(memory, f.graph, f.assets, { amount: 3 });
  await prepare(memory, f.graph, f.assets, { amount: 4 });
  assert.equal(object((await prepare(memory, f.graph, f.assets)).state).stale, false);
  saved(f.graph, three);
  Object.assign(object(array(f.graph.nodeRuns)[0]), {
    runId: 'new-run',
    currentStepId: 'new-step',
    selectedAssetId: 'new-asset',
  });
  f.assets = [f.asset('new-asset', 'new')];
  for (const kind of ['account', 'transform', 'asset', 'params']) {
    const changed = structuredClone(f.graph);
    const source = object(array(changed.nodes)[0]),
      node = object(array(changed.nodes)[1]);
    if (kind === 'transform') object(array(source.inputMount)[0]).transform = [0, 1];
    if (kind === 'asset') object(array(source.inputMount)[0]).assetId = 'another';
    if (kind === 'params') object(node.params).model_version = 'other-model';
    const plan = await prepare(
      memory,
      changed,
      f.assets,
      {},
      kind === 'account' ? 'other-account' : 'account',
    );
    assert.equal(object(plan.state).stale, true, kind);
    assert.equal(object(plan.detection_memory).fresh_detection_verified, false, kind);
  }
  const signature = structuredClone(f.graph);
  object(array(object(array(signature.nodes)[0]).inputMount)[0]).url =
    'https://cdn.tripo3d.ai/source.png?sig=renewed';
  assert.equal(extractionContext(signature, 'split'), extractionContext(f.graph, 'split'));
  assert.equal(object((await prepare(memory, signature, f.assets)).state).stale, false);
});

test('concurrent local updates fail closed and corrupt state cannot silently become an empty baseline', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tripo-extraction-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const memory = new ExtractionFileMemory(dir, () => false);
  const scope = { account: 'account', canvasId: 'canvas', nodeId: 'node' };
  const epoch = { assetIds: [], runId: '', stepId: '', revision: '1' };
  const results = await Promise.allSettled([
    memory.transact(scope, (states) => {
      states['a'.repeat(64)] = epoch;
    }),
    memory.transact(scope, (states) => {
      states['b'.repeat(64)] = epoch;
    }),
  ]);
  assert.ok(results.some((result) => result.status === 'fulfilled'));
  for (const result of results)
    if (result.status === 'rejected') assert.equal(result.reason.code, 'EXTRACTION_STATE_BUSY');
  const file = path.join(
    dir,
    (await readdir(dir)).find((file) => file.endsWith('.json'))!,
  );
  assert.equal(
    Object.keys(object(JSON.parse(await readFile(file, 'utf8'))).epochs as object).length,
    results.filter((result) => result.status === 'fulfilled').length,
  );
  await writeFile(file, '{broken');
  await assert.rejects(
    memory.transact(scope, () => null),
    { code: 'EXTRACTION_STATE_INVALID' },
  );
  assert.equal(await readFile(file, 'utf8'), '{broken');
});

test('fresh detection requires the original task action, account, revision and prepared input fingerprint', () => {
  const receipt: DetectionReceipt = {
    account: 'account',
    canvasId: 'canvas',
    nodeId: 'split',
    runId: 'new-run',
    revision: '6',
    context: 'proof',
  };
  const job = {
    operation: 'canvas_run',
    remote_ids: { task_id: 'new-run' },
    input: {
      action: 'detect',
      canvas_id: 'canvas',
      node_ids: ['split'],
      revision: '6',
      _canvas_quotes: [{ node_id: 'split', extraction_context: 'proof' }],
    },
  };
  const service = {
    config: { dataDir: '/unused' },
    jobs: { list: (account: string) => (account === 'account' ? [job] : []) },
  } as unknown as TaskService;
  const memory = extractionMemory(service);
  assert.equal(memory.isDetection(receipt), true);
  for (const change of [
    { account: 'other' },
    { revision: '7' },
    { context: 'other-source' },
    { nodeId: 'other' },
    { canvasId: 'other' },
  ])
    assert.equal(memory.isDetection({ ...receipt, ...change }), false);
  job.input.action = 'generate';
  assert.equal(memory.isDetection(receipt), false);
});

test('Detect submission rejects same-revision input swaps and never sends local proof metadata', async () => {
  const f = fixture(),
    posts: Record<string, unknown>[] = [];
  const credentials = new MemoryCredentials({
    accountRef: 'account',
    deviceId: 'test',
    importedAt: new Date().toISOString(),
    bearer:
      'eyJhbGciOiJIUzI1NiJ9.' +
      Buffer.from(JSON.stringify({ sub: 'account', exp: Math.floor(Date.now() / 1000) + 3600 })).toString(
        'base64url',
      ) +
      '.fixture',
  });
  const studio = new StudioClient(credentials, async (_url, init) => {
    const method = new Headers(init.headers).get('x-micro-method')!;
    if (method.endsWith('/GetCanvas')) return Response.json({ error: { code: 0 }, ...f.graph });
    assert.ok(method.endsWith('/CreateRun'));
    posts.push(JSON.parse(String(init.body)));
    return Response.json({ error: { code: 0 }, runId: 'accepted-run' });
  });
  const input = await prepareCanvasRun(studio, {
    canvas_id: 'canvas',
    revision: '5',
    node_ids: ['split'],
    action: 'detect',
  });
  const job = { job_id: 'stable-job', input } as unknown as Job;
  const source = object(array(object(array(f.graph.nodes)[0]).inputMount)[0]);
  source.transform = [0, 1];
  await assert.rejects(submitCanvasRun(studio, job), { code: 'CANVAS_CHANGED' });
  assert.equal(posts.length, 0);
  source.transform = [1, 0];
  source.url = 'https://cdn.tripo3d.ai/source.png?sig=renewed';
  assert.deepEqual(await submitCanvasRun(studio, job), { remote_ids: { task_id: 'accepted-run' } });
  assert.equal(posts[0]!.action, 'RUN_ACTION_DETECT');
  assert.doesNotMatch(JSON.stringify(posts), /extraction_context|_canvas_quotes|proof|secret/);
});
