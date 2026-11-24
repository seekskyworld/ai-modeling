/** 网页 Lab 准备分支按真实返回形状复核；测试不访问真实账号、不提交远端任务。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import { resourceOptions, resourceInput } from '../cli/compat/resource-options.ts';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { StudioClient } from '../studio/api/client.ts';
import { array, object } from '../studio/contracts/errors.ts';
import { callCanvas, canvasResources } from '../studio/api/canvas.ts';
import { resolveLabInputs } from '../studio/api/canvas-lab-inputs.ts';
import { labPlanSchema, resolveCanvasLabPlan } from '../studio/api/canvas-lab-plan.ts';
import { canvasAgentSchemas } from '../studio/contracts/canvas-agent.ts';

function graph() {
  return {
    canvas: { canvasId: 'canvas', projectId: 'project', revision: '8' },
    nodes: [
      { id: 'lab', type: 'NODE_TYPE_AI_3D_LAB' },
      { id: 'upstream', type: 'NODE_TYPE_MULTIVIEW' },
    ],
    edges: [{ id: 'edge', source: { nodeId: 'upstream', port: '' }, target: { nodeId: 'lab', port: '' } }],
    nodeRuns: [],
  };
}
function fixture(
  handle?: (
    method: string,
    body: Record<string, unknown>,
    count: number,
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
    importedAt: '',
  });
  const calls: string[] = [];
  const client = new StudioClient(credentials, async (_url, init) => {
    const method = new Headers(init.headers).get('x-micro-method')!.split('/').at(-1)!;
    calls.push(method);
    const body = object(JSON.parse(String(init.body)));
    const defaults: Record<string, unknown> = {
      GetCanvas: graph(),
      ListLabJobs: { jobs: [{ jobId: 'history', status: 'completed' }] },
      GetLabJob: {
        jobId: 'history',
        status: 'completed',
        prompt: '  Describe image then video.  ',
        inputs: [
          { assetId: 'old-image', filename: 'image.png', kind: 'image' },
          { assetId: 'old-video', filename: 'video.mp4', kind: 'video' },
        ],
      },
      GetLabTaskInstructions: {
        taskInstructions: {
          saveStatus: 'LAB_TASK_INSTRUCTIONS_SAVE_STATUS_SAVED',
          saved: { nodeId: 'lab', version: '3', instructions: 'Inspect every attached view.' },
        },
      },
      BatchGetInputAssets: { assets: [{ assetId: 'uploaded', status: 'INPUT_ASSET_STATUS_READY' }] },
      ListNodesAssets: {
        nodes: [
          {
            nodeId: 'upstream',
            assets: [
              {
                nodeId: 'upstream',
                assetId: 'current-back',
                role: 'ASSET_ROLE_CURRENT',
                kind: 'ASSET_KIND_IMAGE',
                slotIndex: 1,
                version: 2,
              },
              {
                nodeId: 'upstream',
                assetId: 'current-front',
                role: 'ASSET_ROLE_CURRENT',
                kind: 'ASSET_KIND_IMAGE',
                slotIndex: 0,
                version: 1,
              },
            ],
          },
        ],
      },
    };
    assert.ok(Object.hasOwn(defaults, method), 'Only known read methods are allowed: ' + method);
    const result =
      handle?.(method, body, calls.filter((value) => value === method).length, credentials) ??
      defaults[method];
    return Response.json({ error: { code: 0 }, ...object(result) });
  });
  return { client, calls };
}
const reuse = { canvasId: 'canvas', nodeId: 'lab', mode: 'reuse_instructions' };
const again = { canvasId: 'canvas', nodeId: 'lab', mode: 'run_again', jobId: 'history' };

test('Lab plans reject duplicate source assets and unavailable selected outputs without guessing unknown states', async () => {
  for (const scenario of [
    'duplicate',
    'failed',
    'processing',
    'cancelled',
    'unknown',
    'missing-status',
    'old-failure',
  ]) {
    const f = fixture((method) => {
      if (method !== 'ListNodesAssets') return;
      const asset: Record<string, unknown> = {
        assetId: 'current',
        nodeId: 'upstream',
        role: 'ASSET_ROLE_CURRENT',
        kind: 'ASSET_KIND_IMAGE',
      };
      if (scenario === 'failed') asset.status = 'ASSET_STATUS_FAILED';
      if (scenario === 'processing') asset.studioState = 'STUDIO_ASSET_STATE_PROCESSING';
      if (scenario === 'cancelled') asset.status = 'ASSET_STATUS_CANCELED';
      if (scenario === 'unknown') asset.status = 'ASSET_STATUS_NOT_REPORTED';
      const assets = [asset];
      if (scenario === 'duplicate') assets.push(structuredClone(asset));
      if (scenario === 'old-failure')
        assets.push({
          ...asset,
          assetId: 'old',
          role: 'ASSET_ROLE_HISTORY',
          status: 'ASSET_STATUS_FAILED',
        });
      return { nodes: [{ nodeId: 'upstream', assets }] };
    });
    const ready = ['unknown', 'missing-status', 'old-failure'].includes(scenario),
      inputs = object(await resolveLabInputs(f.client, { canvasId: 'canvas', nodeId: 'lab' })),
      plan = object(await resolveCanvasLabPlan(f.client, reuse));
    assert.equal(inputs.missing, !ready);
    assert.equal(plan.ready, ready);
    assert.deepEqual(inputs.asset_ids, ready ? ['current'] : []);
    assert.equal(plan.parameters === null, !ready);
    if (!ready) assert.ok(array(plan.reasons).includes('upstream_input_unavailable'));
    if (scenario === 'duplicate')
      assert.ok(
        array(inputs.missing_inputs).some(
          (value) => object(value).reason === 'generated_asset_identity_unavailable',
        ),
      );
  }
});

test('Lab selection does not silently replace a failed selected image or drop one failed multiview slot', async () => {
  for (const type of ['NODE_TYPE_GENERATE_IMAGE', 'NODE_TYPE_MULTIVIEW']) {
    const f = fixture((method) => {
      if (method === 'GetCanvas') {
        const current = graph();
        current.nodes[1]!.type = type;
        return current;
      }
      if (method === 'ListNodesAssets')
        return {
          nodes: [
            {
              nodeId: 'upstream',
              assets: [
                {
                  assetId: 'failed-selected',
                  nodeId: 'upstream',
                  role: 'ASSET_ROLE_CURRENT',
                  selected: true,
                  kind: 'ASSET_KIND_IMAGE',
                  status: 'ASSET_STATUS_FAILED',
                  slotIndex: 0,
                },
                {
                  assetId: 'other-ready',
                  nodeId: 'upstream',
                  role: 'ASSET_ROLE_CURRENT',
                  selected: false,
                  kind: 'ASSET_KIND_IMAGE',
                  status: 'ASSET_STATUS_READY',
                  slotIndex: 1,
                },
              ],
            },
          ],
        };
    });
    const plan = object(await resolveCanvasLabPlan(f.client, reuse));
    assert.equal(plan.ready, false);
    assert.equal(plan.parameters, null);
    assert.ok(array(plan.reasons).includes('upstream_input_unavailable'));
  }
});

test('Lab input uploads must have one READY response in the current project', async () => {
  for (const scenario of ['ready', 'duplicate-ready', 'ready-and-pending']) {
    const f = fixture((method, body) => {
      if (method === 'GetCanvas')
        return {
          ...graph(),
          nodes: [
            { id: 'lab', type: 'NODE_TYPE_AI_3D_LAB' },
            {
              id: 'upstream',
              type: 'NODE_TYPE_UPLOAD_CARD',
              params: { assetType: 'image' },
              inputMount: [{ assetId: 'uploaded' }],
            },
          ],
        };
      if (method === 'BatchGetInputAssets') {
        assert.deepEqual(body, { projectId: 'project', assetIds: ['uploaded'] });
        return {
          assets: [
            { assetId: 'uploaded', status: 'INPUT_ASSET_STATUS_READY' },
            ...(scenario === 'ready'
              ? []
              : [
                  {
                    assetId: 'uploaded',
                    status:
                      scenario === 'duplicate-ready'
                        ? 'INPUT_ASSET_STATUS_READY'
                        : 'INPUT_ASSET_STATUS_PROCESSING',
                  },
                ]),
          ],
        };
      }
    });
    const inputs = object(await resolveLabInputs(f.client, { canvasId: 'canvas', nodeId: 'lab' })),
      plan = object(await resolveCanvasLabPlan(f.client, reuse));
    assert.equal(inputs.missing, scenario !== 'ready');
    assert.equal(plan.ready, scenario === 'ready');
    assert.deepEqual(inputs.asset_ids, scenario === 'ready' ? ['uploaded'] : []);
    if (scenario !== 'ready')
      assert.ok(
        array(inputs.missing_inputs).some(
          (value) => object(value).reason === 'input_asset_not_ready_in_project',
        ),
      );
  }
});

test('Lab input preparation rejects a duplicate graph source identity', async () => {
  const f = fixture((method) => {
    if (method !== 'GetCanvas') return;
    const current = graph();
    current.nodes.push(structuredClone(current.nodes[1]!));
    return current;
  });
  await assert.rejects(resolveLabInputs(f.client, { canvasId: 'canvas', nodeId: 'lab' }), {
    code: 'CONTRACT_CHANGED',
  });
  assert.deepEqual(f.calls, ['GetCanvas']);
});

test('Lab plan is exposed through the same Canvas resource and named CLI options', async () => {
  const spec = canvasResources.find((value) => value.name === 'lab_plan')!;
  assert.equal(spec.readOnly, true);
  const command = new Command().exitOverride();
  resourceOptions(command, spec.schema);
  command.parse(['--canvas-id', 'canvas', '--node-id', 'lab', '--mode', 'run_again', '--job-id', 'history'], {
    from: 'user',
  });
  const input = resourceInput(command.opts(), spec.schema);
  assert.deepEqual(labPlanSchema.parse(input), again);
  const f = fixture();
  const result = object(await callCanvas(f.client, spec, input));
  assert.equal(result.ready, true);
  assert.equal(result.execution_started, false);
  assert.equal(result.remote_saved, false);
  assert.deepEqual(result.quote, { known: false, variable: true });
  assert.equal(result.requires_accept_variable_cost, true);
  assert.equal(Object.hasOwn(object(result.parameters), 'accept_variable_cost'), false);
});

test('Lab instruction reads preserve the service payload and expose validation through the public Canvas route', async () => {
  const spec = canvasResources.find((value) => value.name === 'lab_instructions')!;
  assert.equal(spec.readOnly, true);
  for (const saveStatus of ['LAB_TASK_INSTRUCTIONS_SAVE_STATUS_SAVED', 'FUTURE_SAVED']) {
    const taskInstructions = {
      saveStatus,
      saved: { nodeId: 'lab', instructions: 'Inspect the current input.' },
      canSave: true,
      hasUpdates: true,
      futureField: 'retain',
    };
    const f = fixture((method, body) => {
      if (method !== 'GetLabTaskInstructions') return;
      assert.deepEqual(body, { nodeId: 'lab' });
      return { taskInstructions };
    });
    const result = object(await callCanvas(f.client, spec, { nodeId: 'lab' })),
      validation = object(result.validation),
      known = saveStatus === 'LAB_TASK_INSTRUCTIONS_SAVE_STATUS_SAVED';
    assert.deepEqual(f.calls, ['GetLabTaskInstructions']);
    assert.deepEqual(result.taskInstructions, taskInstructions);
    assert.equal(validation.valid, known);
    assert.equal(validation.saved_version, '0');
    assert.equal(validation.can_save, true);
    assert.equal(validation.has_updates, true);
    assert.equal(Object.hasOwn(result, 'ready'), false);
    assert.equal(object(result.cli_support).manual_save, false);
    assert.deepEqual(validation.reuse_blockers, known ? [] : ['instructions_state_invalid']);
  }
  const wrong = fixture((method) =>
    method === 'GetLabTaskInstructions'
      ? { taskInstructions: { saveStatus: 'SAVED', saved: { nodeId: 'other' } } }
      : undefined,
  );
  await assert.rejects(callCanvas(wrong.client, spec, { nodeId: 'lab' }), { code: 'CONTRACT_CHANGED' });
  assert.deepEqual(wrong.calls, ['GetLabTaskInstructions']);
});

test('Lab history rerun copies the exact original prompt and attachment order without current-input substitution', async () => {
  const f = fixture();
  const result = object(await resolveCanvasLabPlan(f.client, again));
  assert.deepEqual(result.parameters, {
    node_id: 'lab',
    prompt: 'Describe image then video.',
    asset_ids: ['old-image', 'old-video'],
  });
  assert.equal(f.calls.includes('ListNodesAssets'), false);
  assert.equal(f.calls.includes('GetLabTaskInstructions'), false);
  assert.equal(result.source_job_id, 'history');
  assert.equal(result.history_scope, 'returned_jobs_only');
});

test('Lab instruction reuse retains all upstream inputs including previously used ones in slot order', async () => {
  const f = fixture((method) =>
    method === 'GetLabJob' ? assert.fail('Reuse must not filter historical inputs') : undefined,
  );
  const result = object(await resolveCanvasLabPlan(f.client, reuse));
  assert.deepEqual(result.parameters, {
    node_id: 'lab',
    prompt: 'Inspect every attached view.',
    asset_ids: ['current-front', 'current-back'],
  });
  assert.equal(result.upstream_changed, null);
  assert.match(String(result.input_binding), /^[a-f0-9]{64}$/);
  const unchanged = object(
    await resolveCanvasLabPlan(f.client, { ...reuse, previousInputBinding: result.input_binding }),
  );
  assert.equal(unchanged.ready, false);
  assert.deepEqual(unchanged.reasons, ['upstream_inputs_unchanged']);
  assert.equal(unchanged.parameters, null);
});

test('Lab prepared binding detects a version change and belongs to its canvas and node', async () => {
  const old = object(await resolveCanvasLabPlan(fixture().client, reuse));
  const f = fixture((method) =>
    method === 'ListNodesAssets'
      ? {
          nodes: [
            {
              nodeId: 'upstream',
              assets: [
                {
                  nodeId: 'upstream',
                  assetId: 'current-front',
                  kind: 'ASSET_KIND_IMAGE',
                  slotIndex: 0,
                  version: 9,
                },
                {
                  nodeId: 'upstream',
                  assetId: 'current-back',
                  kind: 'ASSET_KIND_IMAGE',
                  slotIndex: 1,
                  version: 2,
                },
              ],
            },
          ],
        }
      : undefined,
  );
  const next = object(
    await resolveCanvasLabPlan(f.client, { ...reuse, previousInputBinding: old.input_binding }),
  );
  assert.equal(next.ready, true);
  assert.equal(next.upstream_changed, true);
  assert.notEqual(next.input_binding, old.input_binding);
});

test('Empty, failed, saving or wrongly owned instructions cannot be reported as ready', async () => {
  for (const [saved, state, reason] of [
    [{ nodeId: 'lab', version: '1', instructions: '  ' }, {}, 'saved_instructions_empty'],
    [{ nodeId: 'lab', version: '1', instructions: 'Inspect' }, { saving: true }, 'instructions_saving'],
    [
      { nodeId: 'lab', version: '1', instructions: 'Inspect' },
      { saveStatus: 'FAILED' },
      'instructions_save_failed',
    ],
    [{ version: '1', instructions: 'Inspect' }, {}, 'saved_instructions_identity_missing'],
  ] as const) {
    const f = fixture((method) =>
      method === 'GetLabTaskInstructions'
        ? { taskInstructions: { saveStatus: 'SAVED', saved, ...state } }
        : undefined,
    );
    const result = object(await resolveCanvasLabPlan(f.client, reuse));
    assert.equal(result.ready, false);
    assert.ok((result.reasons as string[]).includes(reason));
    assert.equal(result.parameters, null);
  }
  const f = fixture((method) =>
    method === 'GetLabTaskInstructions'
      ? { taskInstructions: { saved: { nodeId: 'different', version: '1', instructions: 'Inspect' } } }
      : undefined,
  );
  await assert.rejects(resolveCanvasLabPlan(f.client, reuse), { code: 'CONTRACT_CHANGED' });
});

test('Lab reuse refuses unknown or malformed instruction state while preserving diagnostic fields', async () => {
  for (const state of [
    { saveStatus: undefined },
    { saveStatus: 'FUTURE_SAVED' },
    { saveStatus: 'FUTURE_SAVING' },
    { saveStatus: 'FUTURE_FAILED' },
    { saveStatus: 'SAVED', saving: 'false' },
    { saveStatus: 'SAVED', canSave: 1 },
    { saveStatus: 'SAVED', hasUpdates: null },
    { saveStatus: 'SAVED', saveErrorMessage: {} },
  ]) {
    const f = fixture((method) =>
      method === 'GetLabTaskInstructions'
        ? { taskInstructions: { ...state, saved: { nodeId: 'lab', version: '1', instructions: 'Inspect' } } }
        : undefined,
    );
    const result = object(await resolveCanvasLabPlan(f.client, reuse));
    assert.equal(result.ready, false);
    assert.equal(result.parameters, null);
    assert.ok(array(result.reasons).includes('instructions_state_invalid'));
    assert.equal(object(result.instructions_validation).valid, false);
    assert.ok(array(object(result.instructions_validation).issues).length > 0);
  }
});

test('Lab reuse accepts webpage omitted version defaults and a valid empty idle response stays not ready', async () => {
  const withDefaults = fixture((method) =>
    method === 'GetLabTaskInstructions'
      ? { taskInstructions: { saveStatus: 'SAVED', saved: { nodeId: 'lab', instructions: 'Inspect' } } }
      : undefined,
  );
  const prepared = object(await resolveCanvasLabPlan(withDefaults.client, reuse));
  assert.equal(prepared.ready, true);
  assert.equal(prepared.instructions_version, '0');
  assert.deepEqual(prepared.instructions_validation, { valid: true, issues: [] });
  const idle = fixture((method) =>
    method === 'GetLabTaskInstructions' ? { taskInstructions: { saveStatus: 'IDLE' } } : undefined,
  );
  const empty = object(await resolveCanvasLabPlan(idle.client, reuse));
  assert.equal(empty.ready, false);
  assert.equal(empty.parameters, null);
  assert.deepEqual(empty.reasons, ['saved_instructions_empty']);
  assert.deepEqual(empty.instructions_validation, { valid: true, issues: [] });
});

test('History rerun requires original inputs, terminal status and membership in this node history', async () => {
  for (const [override, reason] of [
    [{ prompt: 'Inspect', status: 'completed' }, 'source_inputs_unavailable'],
    [{ prompt: 'Inspect', status: 'completed', inputs: [{}] }, 'source_input_identity_missing'],
    [{ prompt: 'Inspect', status: 'running', inputs: [] }, 'source_job_not_terminal'],
    [{ prompt: '', status: 'failed', inputs: [] }, 'source_prompt_empty'],
  ] as const) {
    const f = fixture((method) => (method === 'GetLabJob' ? { jobId: 'history', ...override } : undefined));
    const result = object(await resolveCanvasLabPlan(f.client, again));
    assert.equal(result.ready, false);
    assert.ok((result.reasons as string[]).includes(reason));
  }
  const absent = fixture((method) => (method === 'ListLabJobs' ? { jobs: [], hasMore: true } : undefined));
  const result = object(await resolveCanvasLabPlan(absent.client, again));
  assert.deepEqual(result.reasons, ['source_job_not_in_returned_node_history']);
  assert.equal(absent.calls.includes('GetLabJob'), false);
  const wrong = fixture((method) => (method === 'GetLabJob' ? { jobId: 'wrong', inputs: [] } : undefined));
  await assert.rejects(resolveCanvasLabPlan(wrong.client, again), { code: 'CONTRACT_CHANGED' });
});

test('Failed historical jobs with confirmed empty inputs can be prepared as a new explicit intent', async () => {
  const f = fixture((method) =>
    method === 'GetLabJob'
      ? { jobId: 'history', status: 'failed', prompt: 'Create a cube.', inputs: [] }
      : undefined,
  );
  const result = object(await resolveCanvasLabPlan(f.client, again));
  assert.equal(result.ready, true);
  assert.deepEqual(object(result.parameters).asset_ids, []);
});

test('An active Lab job blocks both new plan branches without cancelling it', async () => {
  for (const request of [reuse, again]) {
    const f = fixture((method) =>
      method === 'ListLabJobs'
        ? {
            jobs: [{ jobId: 'history', status: 'completed' }],
            activeJob: { jobId: 'active', status: 'running' },
          }
        : undefined,
    );
    const result = object(await resolveCanvasLabPlan(f.client, request));
    assert.equal(result.ready, false);
    assert.deepEqual(result.reasons, ['lab_job_active']);
    assert.equal(result.parameters, null);
  }
});

test('Changing graph, selected asset or saved instructions during preparation rejects a mixed snapshot', async () => {
  for (const changedMethod of ['GetCanvas', 'ListNodesAssets', 'GetLabTaskInstructions']) {
    const f = fixture((method, _body, count) => {
      if (method !== changedMethod || count < 2) return undefined;
      if (method === 'GetCanvas') return { ...graph(), canvas: { ...graph().canvas, revision: '9' } };
      if (method === 'ListNodesAssets')
        return {
          nodes: [
            {
              nodeId: 'upstream',
              assets: [{ nodeId: 'upstream', assetId: 'changed', kind: 'ASSET_KIND_IMAGE' }],
            },
          ],
        };
      return {
        taskInstructions: { saved: { nodeId: 'lab', version: '4', instructions: 'Changed instructions' } },
      };
    });
    await assert.rejects(resolveCanvasLabPlan(f.client, reuse), { code: 'CANVAS_CHANGED' });
  }
});

test('A revision mismatch or identity switch stops preparation before it returns usable parameters', async () => {
  const stale = fixture();
  await assert.rejects(resolveCanvasLabPlan(stale.client, { ...again, revision: '7' }), {
    code: 'CANVAS_CHANGED',
  });
  assert.deepEqual(stale.calls, ['GetCanvas']);
  const f = fixture((method, _body, _count, credentials) => {
    if (method === 'GetLabTaskInstructions')
      credentials.save({ ...credentials.load()!, accountRef: 'another-account' });
    return undefined;
  });
  await assert.rejects(resolveCanvasLabPlan(f.client, reuse), { code: 'ACCOUNT_MISMATCH' });
});

test('Lab applied animation uses the real nodeRuns array in both current-input and reuse plans', async () => {
  for (const status of ['NODE_STATUS_DONE', 'NODE_STATUS_RUNNING']) {
    const f = fixture((method) => {
      if (method === 'GetCanvas')
        return {
          ...graph(),
          nodes: [
            { id: 'lab', type: 'NODE_TYPE_AI_3D_LAB' },
            { id: 'upstream', type: 'NODE_TYPE_ANIMATION', params: { animation_applied: true } },
          ],
          nodeRuns: [
            { nodeId: 'unrelated', status: 'NODE_STATUS_DONE' },
            { nodeId: 'upstream', status },
          ],
        };
      if (method === 'ListNodesAssets')
        return {
          nodes: [
            {
              nodeId: 'upstream',
              assets: [
                {
                  nodeId: 'upstream',
                  assetId: 'animated-model',
                  kind: 'ASSET_KIND_MODEL',
                  role: 'ASSET_ROLE_CURRENT',
                },
              ],
            },
          ],
        };
      return undefined;
    });
    const current = object(await resolveLabInputs(f.client, { canvasId: 'canvas', nodeId: 'lab' }));
    const plan = object(await resolveCanvasLabPlan(f.client, reuse));
    const ready = status === 'NODE_STATUS_DONE';
    assert.deepEqual(current.asset_ids, ready ? ['animated-model'] : []);
    assert.equal(plan.ready, ready);
    assert.deepEqual(object(plan.parameters).asset_ids, ready ? ['animated-model'] : undefined);
  }
});

test('Invalid cross-mode options are rejected without a request or hidden fallback', async () => {
  for (const request of [
    { ...again, jobId: undefined },
    { ...reuse, jobId: 'history' },
    { ...again, previousInputBinding: 'a'.repeat(64) },
    { ...again, prompt: 'override' },
  ]) {
    const f = fixture();
    await assert.rejects(resolveCanvasLabPlan(f.client, request));
    assert.deepEqual(f.calls, []);
  }
});

test('Lab prompt admission follows the webpage trim and 200000 Unicode-code-point boundary', () => {
  const parse = (prompt: string) =>
    canvasAgentSchemas.canvas_lab.parse({
      node_id: 'lab',
      prompt,
      accept_variable_cost: true,
    }).prompt;
  assert.equal(parse('  first\n\nsecond \t'), 'first\n\nsecond');
  assert.equal(parse('a'.repeat(200000)).length, 200000);
  assert.equal(parse('😀'.repeat(200000)).length, 400000);
  assert.equal(
    parse(' \n' + '😀'.repeat(100000) + 'a'.repeat(100000) + '\t '),
    '😀'.repeat(100000) + 'a'.repeat(100000),
  );
  for (const prompt of [
    ' \n\t ',
    'a'.repeat(200001),
    '😀'.repeat(200001),
    '😀'.repeat(100000) + 'a'.repeat(100001),
  ])
    assert.throws(() => parse(prompt));
});
