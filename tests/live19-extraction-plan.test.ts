/** 真实网页状态链的控制测试；计划不得保存、提交或把过期部件带入报价。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import { resourceOptions, resourceInput } from '../cli/compat/resource-options.ts';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { StudioClient } from '../studio/api/client.ts';
import { object } from '../studio/contracts/errors.ts';
import {
  extractionPlan,
  extractionPlanSchema,
  resolveCanvasExtractionPlan,
} from '../studio/api/canvas-extraction-plan.ts';
import { canvasAction, canvasNodeQuote } from '../studio/api/canvas-pricing.ts';

function graph() {
  return {
    canvas: { canvasId: 'canvas', projectId: 'project', revision: '5' },
    nodes: [
      {
        id: 'split',
        type: 'NODE_TYPE_SEMANTIC_SPLIT',
        params: {
          split_mode: 'auto',
          amount: 2,
          granularity: 'auto',
          model_version: 'gemini_3.1_flash_image_preview',
        },
        extraction: { detectedParts: ['head', 'body'], detectionStale: false, currentBatchId: 'batch' },
      },
      {
        id: 'child',
        type: 'NODE_TYPE_SPLIT_RESULT',
        batchId: 'batch',
        name: 'head',
        params: { prompt: 'Extract head' },
      },
    ] as Record<string, unknown>[],
    edges: [{ id: 'edge', source: { nodeId: 'split', port: '' }, target: { nodeId: 'child', port: '' } }],
    nodeRuns: [
      { nodeId: 'split', status: 'NODE_STATUS_DONE' },
      { nodeId: 'child', status: 'NODE_STATUS_DONE' },
    ],
  };
}
const input = (value: Record<string, unknown> = {}) =>
  extractionPlanSchema.parse({ canvasId: 'canvas', nodeId: 'split', ...value });

test('named amount accepts plain auto or a numeric value while structured parts still require JSON', () => {
  const parse = (args: string[]) => {
    const command = new Command().exitOverride();
    resourceOptions(command, extractionPlanSchema);
    command.parse(['--canvas-id', 'canvas', '--node-id', 'split', ...args], { from: 'user' });
    return extractionPlanSchema.parse(resourceInput(command.opts(), extractionPlanSchema));
  };
  assert.equal(parse(['--amount', 'auto']).amount, 'auto');
  assert.equal(parse(['--amount', '"auto"']).amount, 'auto');
  assert.equal(parse(['--amount', '3']).amount, 3);
  assert.deepEqual(parse(['--parts', '["head","body"]']).parts, ['head', 'body']);
  assert.throws(() => parse(['--amount', 'automatic']), /expects JSON/);
  assert.throws(() => parse(['--parts', 'head,body']), /expects JSON/);
});
function fixture(
  handler?: (
    method: string,
    count: number,
    value: ReturnType<typeof graph>,
    credentials: MemoryCredentials,
  ) => unknown,
) {
  const credentials = new MemoryCredentials({
    accountRef: 'fixture',
    bearer:
      'eyJhbGciOiJIUzI1NiJ9.' +
      Buffer.from(JSON.stringify({ sub: 'fixture', exp: Math.floor(Date.now() / 1000) + 3600 })).toString(
        'base64url',
      ) +
      '.fixture',
    deviceId: 'fixture',
    importedAt: new Date().toISOString(),
  });
  const calls: string[] = [];
  const studio = new StudioClient(credentials, async (_url, init) => {
    const method = new Headers(init.headers).get('x-micro-method')!.split('/').at(-1)!;
    calls.push(method);
    const fallback = method === 'GetCanvas' ? graph() : { nodes: [{ nodeId: 'split', assets: [] }] };
    const data = handler?.(method, calls.length, graph(), credentials) ?? fallback;
    return new Response(JSON.stringify({ error: { code: 0 }, ...object(data) }), { status: 200 });
  });
  return { studio, calls };
}

test('saved detection becomes explicit billable part intent without a hidden save or run', async () => {
  const f = fixture();
  const plan = object(
    await resolveCanvasExtractionPlan(f.studio, input({ action: 'generate', revision: '5' })),
  );
  assert.deepEqual(plan.actions, []);
  assert.deepEqual(plan.run_parameters, {
    canvas_id: 'canvas',
    revision: '5',
    node_ids: ['split'],
    action: 'generate',
    parts: ['head', 'body'],
  });
  assert.deepEqual(f.calls, ['GetCanvas', 'ListNodesAssets', 'GetCanvas']);
  assert.equal(plan.remote_saved, false);
  assert.equal(plan.execution_started, false);
  const quote = canvasNodeQuote(graph().nodes[0]!, object(plan.run_parameters));
  assert.equal(object(quote.parameters).amount, 2);
});

test('mode changes preserve separate automatic and manual lists and remove legacy granularity', () => {
  const g = graph();
  const plan = extractionPlan(
    g,
    [],
    input({ splitMode: 'manual', parts: ['head only'], action: 'generate' }),
  );
  const action = object((plan.actions as unknown[])[0]);
  assert.deepEqual(object(action.params), {
    split_mode: 'manual',
    model_version: 'gemini_3.1_flash_image_preview',
    auto_titles: ['head', 'body'],
    candidate_titles: ['head only'],
    manual_titles: ['head only'],
  });
  assert.equal(object(plan.run_parameters).revision, undefined);
  assert.equal(plan.run_requires_saved_revision, true);
  g.nodes[0]!.params = action.params;
  const restored = extractionPlan(g, [], input({ splitMode: 'auto' }));
  assert.deepEqual(object(object((restored.actions as unknown[])[0]).params).candidate_titles, [
    'head',
    'body',
  ]);
  assert.deepEqual(object(g.nodes[0]!.params).candidate_titles, ['head only']);
});

test('quantity changes require a fresh detection and never reuse stale receipt candidates', () => {
  const plan = extractionPlan(graph(), [], input({ amount: 3, action: 'generate' }));
  assert.equal(plan.blocked, 'detection_stale');
  assert.equal(plan.run_parameters, null);
  const g = graph();
  g.nodes[0]!.extraction = { detectionStale: true, detectedParts: ['old'] };
  const stale = extractionPlan(
    g,
    [{ factsJson: JSON.stringify({ candidates: [{ title: 'older' }] }) }],
    input({ action: 'generate' }),
  );
  assert.equal(stale.blocked, 'detection_stale');
  assert.equal(stale.run_parameters, null);
});

test('Detect clears selected auto titles and manual mode does not take the Detect branch', () => {
  const g = graph();
  g.nodes[0]!.params = { ...object(g.nodes[0]!.params), candidate_titles: ['old'], auto_titles: ['older'] };
  const plan = extractionPlan(g, [], input({ action: 'detect' }));
  assert.equal(object(object((plan.actions as unknown[])[0]).params).candidate_titles, undefined);
  assert.equal(object(plan.run_parameters).action, 'detect');
  assert.equal(object(plan.run_parameters).parts, undefined);
  assert.throws(
    () => extractionPlan(g, [], input({ action: 'detect', splitMode: 'manual' })),
    /without Detect/,
  );
});

test('only current detection facts can fill an absent stored list', () => {
  const g = graph();
  g.nodes[0]!.extraction = {};
  const plan = extractionPlan(
    g,
    [
      { role: 'ASSET_ROLE_SUPERSEDED', factsJson: JSON.stringify({ candidates: [{ title: 'old' }] }) },
      { role: 'ASSET_ROLE_CURRENT', factsJson: JSON.stringify({ candidates: [{ title: 'new' }] }) },
    ],
    input({ action: 'generate' }),
  );
  assert.deepEqual(object(plan.run_parameters).parts, ['new']);
});

test('per-result prompt edits prepare a direct run and wait for their parent', () => {
  const g = graph();
  const plan = extractionPlan(
    g,
    [],
    input({ nodeId: 'child', prompt: 'Extract the blue head', action: 'regenerate' }),
  );
  assert.deepEqual(object(object((plan.actions as unknown[])[0]).params), {
    prompt: 'Extract the blue head',
  });
  assert.equal(object(plan.run_parameters).action, 'generate');
  assert.equal(canvasAction([g.nodes[1]!], object(plan.run_parameters)), undefined);
  g.nodeRuns[0]!.status = 'NODE_STATUS_RUNNING';
  assert.equal(extractionPlan(g, [], input({ nodeId: 'child', action: 'generate' })).blocked, 'running');
});

test('retry targets failed current results and parent actions never leak into children', () => {
  const g = graph();
  assert.equal(extractionPlan(g, [], input({ action: 'retry' })).blocked, 'no_failed_results');
  g.nodeRuns[1]!.status = 'NODE_STATUS_FAILED';
  assert.equal(object(extractionPlan(g, [], input({ action: 'retry' })).run_parameters).action, 'retry');
  assert.equal(canvasAction([g.nodes[0]!], { action: 'retry' }), 'RUN_ACTION_RETRY_FAILED');
  for (const action of ['detect', 'retry']) assert.throws(() => canvasAction([g.nodes[1]!], { action }));
  assert.throws(() => canvasAction([g.nodes[1]!], { action: 'generate', parts: ['head'] }));
});

test('explicit titles enforce webpage Unicode bounds without truncating caller intent', () => {
  assert.deepEqual(input({ parts: ['😀'.repeat(200)] }).parts, ['😀'.repeat(200)]);
  for (const parts of [
    ['😀'.repeat(201)],
    ['head', ' head '],
    Array.from({ length: 13 }, (_, i) => String(i)),
    [' '],
  ])
    assert.throws(() => input({ parts }));
  assert.throws(() => input({ splitMode: 'manual', amount: 2 }));
  for (const action of ['detect', 'retry'])
    assert.throws(() => input({ action, parts: ['head'] }), /Explicit parts/);
  assert.throws(() => input({ amount: 2, parts: ['head'] }), /automatic amount or explicit parts/);
});

test('read-only extraction plans reject changed revisions, node identities and account swaps', async () => {
  const changed = fixture((method, count, g) => {
    if (method === 'GetCanvas' && count === 3) {
      g.nodes[0]!.extraction = { detectedParts: ['changed'] };
      return g;
    }
  });
  await assert.rejects(resolveCanvasExtractionPlan(changed.studio, input({ action: 'generate' })), {
    code: 'CANVAS_CHANGED',
  });
  const revision = fixture();
  await assert.rejects(resolveCanvasExtractionPlan(revision.studio, input({ revision: '4' })), {
    code: 'CANVAS_CHANGED',
  });
  assert.deepEqual(revision.calls, ['GetCanvas']);
  const foreign = fixture((method) =>
    method === 'ListNodesAssets'
      ? { nodes: [{ nodeId: 'split', assets: [{ nodeId: 'foreign' }] }] }
      : undefined,
  );
  await assert.rejects(resolveCanvasExtractionPlan(foreign.studio, input()), { code: 'CONTRACT_CHANGED' });
  const account = fixture((method, _count, _graph, credentials) => {
    if (method === 'ListNodesAssets') credentials.save({ ...credentials.load()!, accountRef: 'other' });
  });
  await assert.rejects(resolveCanvasExtractionPlan(account.studio, input()), { code: 'ACCOUNT_MISMATCH' });
});

test('read consistency ignores fresh URL signatures, ETA and row order but keeps source identity', async () => {
  const f = fixture((method, count, g) => {
    if (method !== 'GetCanvas') return;
    g.nodes[0]!.nodeAssets = [
      { assetId: 'asset', url: `https://cdn.tripo3d.ai/image.png?signature=${count}` },
    ];
    Object.assign(g.nodeRuns[0]!, { etaS: count });
    if (count === 3) {
      g.nodes.reverse();
      g.nodeRuns.reverse();
    }
    return { ...g, requestId: String(count) };
  });
  const plan = object(await resolveCanvasExtractionPlan(f.studio, input({ action: 'generate' })));
  assert.equal(plan.blocked, null);
  const changed = fixture((method, count, g) => {
    if (method !== 'GetCanvas') return;
    g.nodes[0]!.nodeAssets = [
      { assetId: 'asset', url: `https://cdn.tripo3d.ai/${count === 3 ? 'different' : 'original'}.png` },
    ];
    return g;
  });
  await assert.rejects(resolveCanvasExtractionPlan(changed.studio, input()), { code: 'CANVAS_CHANGED' });
});
