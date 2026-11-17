/** Canvas 最终件接入官方处理链：冻结真实模型来源，不把 run ID 冒充 operator。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { fixture, quote } from './helpers.ts';
import { canvasModelSource, bindCanvasModelSource } from '../cli/compat/canvas-source.ts';
import { canvasFinalId } from '../studio/contracts/canvas-result.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import { Operations } from '../studio/api/operations.ts';
import type { StudioClient } from '../studio/api/client.ts';
import type { Artifact, CanvasResultBinding, Job, Operation } from '../studio/contracts/types.ts';
import { executePlan, type Application } from '../cli/compat/runtime.ts';
import { processingPlan } from '../cli/compat/planning.ts';
import { redoPlan } from '../cli/compat/redo.ts';
import { applyDefaultExportAnimations } from '../cli/compat/export-animation-default.ts';

async function setup() {
  const f = await fixture();
  const prepared = f.jobs.prepare(
    'test-account',
    'canvas-source',
    'canvas_run',
    {
      canvas_id: 'canvas-original',
      node_ids: ['node-original'],
      _canvas_quotes: [
        { node_id: 'node-original', node_type: 'SEGMENTATION', parameters: { quick_cap: true } },
      ],
    },
    quote,
  );
  const binding: CanvasResultBinding = {
    version: 1,
    stage: 'segmentation_quick_cap',
    job_id: prepared.job_id,
    account_ref: prepared.account_ref,
    input_hash: prepared.input_hash,
    canvas_id: 'canvas-original',
    run_id: 'run-original',
    node_id: 'node-original',
    step_id: 'step-original',
    task_id: 'task-original',
    asset_id: 'asset-original',
    project_id: 'project-final',
    segment_operator_id: 'segment-original',
    final_operator_id: 'operator-final',
  };
  const final: Artifact = {
    artifact_id: canvasFinalId(binding),
    kind: 'model',
    format: 'glb',
    index: 1,
    canvas_result: binding,
  };
  const source = f.jobs.update(prepared.job_id, 'succeeded', {
    remote_ids: { task_id: 'run-original' },
    artifacts: [{ artifact_id: binding.asset_id, kind: 'model', format: 'glb', index: 0 }, final],
  });
  return {
    ...f,
    source,
    final,
    binding,
    close: async () => {
      f.jobs.close();
      await rm(f.dir, { recursive: true, force: true });
    },
  };
}

test('only the frozen final model becomes a source; run IDs and raw artifacts remain unchanged', async () => {
  const f = await setup();
  try {
    const before = structuredClone(f.source);
    assert.deepEqual(canvasModelSource(f.source), {
      artifact_id: f.final.artifact_id,
      project_id: 'project-final',
      operator_id: 'operator-final',
      task_type: 'mesh_completion',
    });
    assert.deepEqual(f.source, before);
    assert.deepEqual(f.jobs.get(f.source.job_id).remote_ids, { task_id: 'run-original' });
    assert.equal(canvasModelSource({ ...f.source, operation: 'model' }), undefined);
  } finally {
    await f.close();
  }
});

test('unfinished, raw-only, foreign or ambiguous Canvas outputs cannot become a model source', async () => {
  const f = await setup();
  try {
    for (const state of ['running', 'failed'] as const)
      assert.throws(() => canvasModelSource({ ...f.source, state }), { code: 'INPUT_NOT_READY' });
    assert.throws(() => canvasModelSource({ ...f.source, artifacts: [f.source.artifacts[0]!] }), {
      code: 'CANVAS_FINAL_ARTIFACT_UNVERIFIED',
    });
    for (const key of ['account_ref', 'input_hash', 'run_id', 'job_id'] as const) {
      const altered = structuredClone(f.source);
      altered.artifacts[1]!.canvas_result![key] = 'foreign';
      assert.throws(() => canvasModelSource(altered), { code: 'CANVAS_FINAL_ARTIFACT_UNVERIFIED' });
    }
    assert.throws(
      () =>
        canvasModelSource({
          ...f.source,
          artifacts: [
            ...f.source.artifacts,
            { ...f.final, artifact_id: 'another-model', canvas_result: undefined },
          ],
        }),
      { code: 'CANVAS_MODEL_SOURCE_AMBIGUOUS' },
    );
    const second = structuredClone(f.final);
    second.canvas_result!.node_id = 'node-second';
    second.canvas_result!.asset_id = 'asset-second';
    second.artifact_id = canvasFinalId(second.canvas_result!);
    const multiple = {
      ...f.source,
      input: {
        ...f.source.input,
        _canvas_quotes: [
          ...(f.source.input._canvas_quotes as unknown[]),
          { node_id: 'node-second', node_type: 'SEGMENTATION', parameters: { quick_cap: true } },
        ],
      },
      artifacts: [...f.source.artifacts, second],
    };
    assert.throws(() => canvasModelSource(multiple), { code: 'CANVAS_MODEL_SOURCE_AMBIGUOUS' });
  } finally {
    await f.close();
  }
});

test('source guards bind the final operator, reject conflicting versions, and let copy use history', async () => {
  const f = await setup();
  try {
    for (const operation of [
      'texture',
      'export',
      'rig',
      'remesh',
      'segment',
      'resegment',
      'complete',
      'local_edit',
      'uv_generate',
      'project_edit',
      'retexture',
      'retexture_apply',
    ] as Operation[]) {
      const input = { project_id: 'upstream', source_operator_id: 'upstream' };
      const bound = bindCanvasModelSource(f.source, operation, input)!;
      assert.equal(bound.parameters.project_id, 'project-final');
      assert.equal(bound.parameters.source_operator_id, 'operator-final');
      assert.equal(bound.parameters.expected_operator_id, 'operator-final');
      assert.deepEqual(input, { project_id: 'upstream', source_operator_id: 'upstream' });
    }
    for (const key of ['operator_id', 'expected_operator_id', 'current_operator_id', 'source_operator_id'])
      assert.throws(() => bindCanvasModelSource(f.source, 'remesh', { [key]: 'other' }), {
        code: 'CANVAS_SOURCE_CONFLICT',
      });
    assert.deepEqual(bindCanvasModelSource(f.source, 'copy', {})!.parameters, {
      project_id: 'project-final',
      operator_id: 'operator-final',
    });
    assert.throws(() => bindCanvasModelSource(f.source, 'image', {}), { code: 'INVALID_INPUT' });
  } finally {
    await f.close();
  }
});

const guardedInputs: [Operation, Record<string, unknown>][] = [
  ['remesh', { face_limit: 5000 }],
  ['rig', {}],
  ['complete', { completion_mode: 'quick_cap' }],
  [
    'local_edit',
    {
      source_operator_id: 'operator-final',
      face_limit: 5000,
      bbox: [
        [-1, -1, -1],
        [1, 1, 1],
      ],
    },
  ],
  ['uv_generate', { current_operator_id: 'operator-final' }],
];
for (const [operation, parameters] of guardedInputs)
  test(`${operation} keeps default request fields and blocks source drift before any preparation POST`, async () => {
    let current = 'operator-final';
    const calls: string[] = [];
    const client = {
      request: async (method: string, route: string) => {
        calls.push(`${method} ${route}`);
        if (route.endsWith('/pre_rig_check')) return { riggable: true, rig_type: 'biped' };
        assert.equal(method, 'GET');
        return {
          id: 'project-final',
          is_owner: true,
          operator: { operator_id: current, status: 'success', is_textured: true },
        };
      },
    } as unknown as StudioClient;
    const operations = new Operations(client, []);
    const ordinary = normalize(operation, { project_id: 'project-final', ...parameters });
    const guarded = normalize(operation, { ...ordinary, expected_operator_id: 'operator-final' });
    assert.deepEqual(
      Object.fromEntries(Object.entries(guarded).filter(([k]) => k !== 'expected_operator_id')),
      ordinary,
    );
    const before = await operations.build({ operation, input: ordinary } as Job);
    const after = await operations.build({ operation, input: guarded } as Job);
    assert.deepEqual(after, before);
    assert.equal(after.body.expected_operator_id, undefined);
    calls.length = 0;
    current = 'later-operator';
    await assert.rejects(operations.build({ operation, input: guarded } as Job), { code: 'PROJECT_CHANGED' });
    assert.deepEqual(calls, ['GET /v2/studio/project/detail/v3/project-final']);
  });

test('official decimate consumes the final model once; retries keep identity and redo rejects source drift', async () => {
  const f = await setup();
  try {
    let current = 'operator-final';
    const submissions: Job[] = [];
    const client = {
      request: async () => ({
        id: 'project-final',
        is_owner: true,
        operator: { operator_id: current, status: 'success' },
      }),
    } as unknown as StudioClient;
    const operations = new Operations(client, []);
    f.gateway.submit = async (job) => {
      const request = await operations.build(job);
      assert.equal(request.route, '/v2/studio/operation/remesh');
      assert.equal(request.body.expected_operator_id, undefined);
      submissions.push(structuredClone(job));
      return { remote_ids: { project_id: 'project-final', operator_id: 'remesh-original' } };
    };
    f.gateway.status = async () => ({ state: 'succeeded', progress: 100, artifacts: [] });
    const app = { service: f.service, studio: { client } } as Application;
    const plan = () => processingPlan('decimate', f.source.job_id, { model: 'default', faceLimit: 5000 });
    const flags = { requestId: 'from-canvas', download: false, open: false, yes: true };
    const first = await executePlan(app, plan(), flags);
    assert.equal(first.status, 'success');
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0]!.input.project_id, 'project-final');
    assert.equal(submissions[0]!.input.expected_operator_id, 'operator-final');
    current = 'later-project-edit';
    const restored = await executePlan(app, plan(), flags);
    assert.equal(restored.task_id, first.task_id);
    assert.equal(submissions.length, 1);
    assert.deepEqual(f.jobs.get(f.source.job_id).remote_ids, { task_id: 'run-original' });
    const result = f.jobs.get(String(first.task_id));
    const redo = redoPlan(result);
    assert.equal(redo.steps[0]!.parameters.expected_operator_id, 'operator-final');
    const refused = await executePlan(app, redo, { ...flags, requestId: 'canvas-redo' });
    assert.equal(refused.status, 'failed');
    assert.equal((refused.error as { code: string }).code, 'PROJECT_CHANGED');
    assert.equal(submissions.length, 1);
    assert.equal(f.jobs.find('test-account', 'canvas-redo-0')!.input.expected_operator_id, 'operator-final');
  } finally {
    await f.close();
  }
});

test('texture redo starts from the original texture result and preserves that source on retry', async () => {
  const f = await setup();
  try {
    const input = normalize('texture', {
      project_id: 'project-final',
      expected_operator_id: 'operator-final',
      action: 'generate',
      prompt: 'matte blue',
    });
    const prepared = f.jobs.prepare('test-account', 'texture-final', 'texture', input, quote);
    const result = f.jobs.update(prepared.job_id, 'succeeded', {
      remote_ids: { project_id: 'project-final', operator_id: 'texture-original' },
    });
    const redo = redoPlan(result, 24);
    assert.equal(redo.steps[0]!.parameters.expected_operator_id, 'texture-original');
    const saved = f.jobs.prepare('test-account', 'texture-redo', 'texture', redo.steps[0]!.parameters, quote);
    const retry = redoPlan(
      { ...result, remote_ids: { ...result.remote_ids, operator_id: 'later' } },
      undefined,
      saved,
    );
    assert.equal(retry.steps[0]!.parameters.expected_operator_id, 'texture-original');
    assert.equal(retry.steps[0]!.parameters.texture_seed, 24);
  } finally {
    await f.close();
  }
});

test('Canvas default export preflight checks the frozen final instead of silently checking a later model', async () => {
  const f = await setup();
  try {
    let current = 'operator-final';
    const client = {
      request: async () => ({
        id: 'project-final',
        is_owner: true,
        operator: { operator_id: current, is_rigged: false },
      }),
    } as unknown as StudioClient;
    const parameters = { project_id: 'project-final', operator_id: 'operator-final' };
    const accepted = await applyDefaultExportAnimations(
      client,
      parameters,
      'operator-final',
      f.source,
      undefined,
      true,
    );
    assert.equal(accepted.expected_operator_id, 'operator-final');
    assert.equal(accepted.with_animation, false);
    current = 'later-static-model';
    await assert.rejects(
      applyDefaultExportAnimations(client, parameters, 'operator-final', f.source, undefined, true),
      { code: 'PROJECT_CHANGED' },
    );
  } finally {
    await f.close();
  }
});

test('explicit static Canvas conversion still copies the exact historical final after current model drift', async () => {
  const f = await setup();
  try {
    const client = {
      request: async () => ({
        id: 'project-final',
        is_owner: true,
        operator: { operator_id: 'later-model', status: 'success', is_rigged: true },
      }),
    } as unknown as StudioClient;
    const ops = new Operations(client, []);
    let copied = 0;
    f.gateway.submit = async (job) => {
      assert.deepEqual(await ops.build(job), {
        route: '/v2/studio/operation/save_as_new',
        body: { project_id: 'project-final', operator_id: 'operator-final' },
      });
      copied++;
      return { remote_ids: { project_id: 'copy-project', operator_id: 'copy-operator' } };
    };
    const app = { service: f.service, studio: { client } } as Application;
    const plan = processingPlan('convert', f.source.job_id, {
      format: 'GLTF',
      scaleFactor: 2,
      param: { with_animation: false },
    });
    assert.equal(plan.steps[0]!.operation, 'copy');
    assert.equal(plan.steps[0]!.requireStaticExportSource, undefined);
    const result = await executePlan(
      app,
      { ...plan, steps: [plan.steps[0]!] },
      { requestId: 'historical-copy', wait: false, download: false, open: false },
    );
    assert.equal(result.status, 'queued');
    assert.equal(copied, 1);
    assert.deepEqual(f.jobs.get(f.source.job_id).remote_ids, { task_id: 'run-original' });
  } finally {
    await f.close();
  }
});
