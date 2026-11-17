/** 用线上验收尺寸和请求语义防止兼容字段被静默忽略或转成本地缩放。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generationPlan, processingPlan } from '../cli/compat/planning.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import { Operations } from '../studio/api/operations.ts';
import type { StudioClient } from '../studio/api/client.ts';
import type { Job } from '../studio/contracts/types.ts';
import { rm } from 'node:fs/promises';
import { fixture } from './helpers.ts';
import { executePlan, type Application } from '../cli/compat/runtime.ts';
import { redoPlan } from '../cli/compat/redo.ts';

test('verified pixel sizes reach native resolution and scale for official image aliases', async () => {
  for (const [size, scale] of [
    ['1024x1024', '1:1'],
    ['864x1184', '3:4'],
    ['1184x864', '4:3'],
    ['768x1344', '9:16'],
    ['1344x768', '16:9'],
  ]) {
    for (const model of ['banana', 'gemini-2.5-flash']) {
      const step = generationPlan('text-to-image', ['cube'], { model, param: { size } }).steps[0]!;
      const request = await new Operations({} as StudioClient, []).build({
        operation: step.operation,
        input: step.parameters,
      } as unknown as Job);
      assert.equal(request.route, '/v2/studio/image/gen_image_v2');
      assert.equal(request.body.scale, scale);
      assert.equal(request.body.resolution, '1K');
      assert.equal(request.body.size, undefined);
    }
  }
  for (const model of ['banana_pro', 'gemini-3-pro']) {
    const p = generationPlan('text-to-image', ['cube'], { model, param: { size: '1024x1024' } });
    assert.equal(p.steps[0]!.parameters.resolution, '1K');
    assert.equal(p.steps[0]!.parameters.scale, '1:1');
    const large = generationPlan('text-to-image', ['cube'], { model, param: { size: '4096x4096' } });
    assert.equal(large.steps[0]!.parameters.resolution, '4K');
  }
  assert.equal(
    generationPlan('text-to-image', ['cube'], { model: 'banana2', param: { size: ' 1k ' } }).steps[0]!
      .parameters.resolution,
    '1K',
  );
});

test('unverified and conflicting sizes fail before uploads or billed submissions', () => {
  for (const param of [
    { size: '832x1248' },
    { size: '0.5K' },
    { size: '1024x1024', aspect_ratio: '16:9' },
    { size: '1024x1024', resolution: '4K' },
  ])
    assert.throws(() => generationPlan('text-to-image', ['cube'], { model: 'banana', param }));
  for (const scale of ['2:3', '3:2', '21:9'])
    assert.throws(() => normalize('image', { prompt: 'cube', scale }));
  for (const model of ['banana', 'banana2', 'banana_pro'])
    assert.throws(() => generationPlan('text-to-image', ['cube'], { model, param: { size: '2K' } }));
  assert.throws(() =>
    generationPlan('text-to-image', ['cube'], { model: 'chat_image_2', param: { size: '1536x1024' } }),
  );
  assert.throws(() =>
    generationPlan('text-to-image', ['cube'], { model: 'banana2', param: { size: '1024x1024' } }),
  );
});

test('official ignored image fields warn instead of claiming a native effect', () => {
  const plan = generationPlan('text-to-image', ['cube'], {
    model: 'banana',
    param: { watermark: true, quality: 'high', background: 'transparent' },
  });
  assert.equal(plan.warnings.length, 3);
  for (const key of ['watermark', 'quality', 'background'])
    assert.equal(plan.steps[0]!.parameters[key], undefined);
  const gpt = generationPlan('text-to-image', ['cube'], {
    model: 'chat_image_2',
    param: { aspect_ratio: '16:9' },
  });
  assert.equal(gpt.steps[0]!.parameters.scale, '1:1');
  assert.ok(gpt.warnings.some((w) => w.includes('aspect_ratio')));
  assert.throws(() =>
    generationPlan('text-to-image', ['cube'], {
      model: 'chat_image_2',
      param: { quality: 'high' },
    }),
  );
});

test('texture seeds including zero are sent only to native texture generation', async () => {
  const client = {
    request: async () => ({ is_owner: true, operator: { status: 'success' } }),
  } as unknown as StudioClient;
  for (const seed of [0, 42, 2147483647]) {
    const p = processingPlan('texture', 'project', { param: { texture_seed: seed } });
    assert.ok(p.warnings.some((w) => w.includes('deterministic reproduction')));
    const request = await new Operations(client, []).build({
      operation: 'texture',
      input: { ...p.steps[0]!.parameters, project_id: 'project' },
    } as unknown as Job);
    assert.equal(request.route, '/v2/studio/operation/texture_model');
    assert.equal(request.body.texture_seed, seed);
  }
  for (const seed of [-1, 0.5, 2147483648])
    assert.throws(() => normalize('texture', { project_id: 'project', texture_seed: seed }));
  for (const action of ['pbr', 'upscale'])
    assert.throws(() => normalize('texture', { project_id: 'project', action, texture_seed: 0 }));
});

test('fast is a native generation quality rather than an alias for standard or an upscale mode', async () => {
  const step = generationPlan('text-to-model', ['cube'], {
    model: 'tripo-v3.1',
    param: { texture: true, texture_quality: 'fast' },
  }).steps[0]!;
  const request = await new Operations({} as StudioClient, []).build({
    operation: 'model',
    input: step.parameters,
  } as Job);
  assert.equal(request.body.texture_quality, 'fast');
  const client = {
    request: async () => ({ is_owner: true, operator: { status: 'success' } }),
  } as unknown as StudioClient;
  const texture = normalize('texture', { project_id: 'project', texture_quality: 'fast' });
  assert.equal(
    (await new Operations(client, []).build({ operation: 'texture', input: texture } as Job)).body
      .texture_quality,
    'fast',
  );
  assert.throws(() =>
    normalize('texture', { project_id: 'project', texture_quality: 'fast', action: 'upscale' }),
  );
});

test('integer texture sizes preserve native exports without local transformations', () => {
  for (const textureSize of [1, 1023, 1536, 8192]) {
    const plan = processingPlan('convert', 'project', { textureSize });
    assert.deepEqual(
      plan.steps.map((s) => s.operation),
      ['export'],
    );
    assert.equal(plan.steps[0]!.parameters.texture_size, textureSize);
  }
  for (const textureSize of [0, 1.5, 8193])
    assert.throws(() => processingPlan('convert', 'project', { textureSize }));
});

test('UV maps explicit no-bake and rejects loss of existing textures before a billed request', async () => {
  const source = '11111111-1111-4111-8111-111111111111';
  const unbaked = processingPlan('uv', source, { param: { bake: false } });
  assert.equal(unbaked.steps[0]!.requireTextureBaking, false);
  assert.equal(unbaked.steps[0]!.parameters.bake, undefined);
  assert.ok(unbaked.warnings.some((w) => w.includes('removes existing textures')));
  const f = await fixture();
  const client = {
    request: async () => ({
      id: source,
      is_owner: true,
      operator: { operator_id: 'base', status: 'success', is_textured: true },
    }),
  } as unknown as StudioClient;
  const app = { service: f.service, studio: { client } } as Application;
  try {
    for (const param of [{}, { bake: true }]) {
      await assert.rejects(
        executePlan(app, processingPlan('uv', source, { param }), {
          requestId: 'uv-preservation',
          wait: true,
          download: false,
        }),
        { code: 'STUDIO_CAPABILITY_UNAVAILABLE', certainty: 'not_submitted' },
      );
    }
    assert.equal(f.gateway.posts, 0);
    assert.equal(f.jobs.list('test-account', 10).length, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('UV retries keep the original automatic source after commit without hiding changed input', async () => {
  const project = '11111111-1111-4111-8111-111111111111';
  const f = await fixture();
  const submitted: Job[] = [];
  let current = 'original';
  let unavailable = false;
  f.gateway.submit = async (job) => {
    submitted.push(job);
    if (job.operation === 'uv_commit') current = 'candidate';
    return { remote_ids: { project_id: project, operator_id: 'candidate' } };
  };
  f.gateway.status = async () => ({ state: 'succeeded', progress: 100, artifacts: [] });
  const client = {
    request: async (_method: string, route: string) => {
      if (unavailable) throw Error('Current project detail is temporarily unavailable');
      return {
        id: route.includes('22222222') ? '22222222-2222-4222-8222-222222222222' : project,
        operator: { operator_id: current, is_textured: true },
      };
    },
  } as unknown as StudioClient;
  const app = { service: f.service, studio: { client } } as Application;
  const flags = { requestId: 'uv-resume-original', download: false };
  try {
    const plan = processingPlan('uv', project, { param: { bake: false } });
    const first = await executePlan(app, plan, flags);
    unavailable = true;
    const resumed = await executePlan(app, plan, flags);
    unavailable = false;
    assert.equal(first.task_id, resumed.task_id);
    assert.equal(submitted.length, 2);
    assert.equal(submitted[0]!.input.current_operator_id, 'original');
    assert.equal(submitted[1]!.input.current_operator_id, 'original');
    assert.equal(submitted[1]!.input.candidate_operator_id, 'candidate');
    for (const changed of [
      processingPlan('uv', project, { param: { bake: false, current_operator_id: 'candidate' } }),
      processingPlan('uv', '22222222-2222-4222-8222-222222222222', { param: { bake: false } }),
      processingPlan('uv', project, { param: { bake: false, action: 'retry' } }),
    ])
      await assert.rejects(executePlan(app, changed, flags), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.equal(submitted.length, 2);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('texture redo uses the native seed and freezes automatic seeds across original-request recovery', async () => {
  const f = await fixture();
  const original = {
    operation: 'texture',
    state: 'succeeded',
    input: normalize('texture', { project_id: 'project', prompt: 'blue', texture_seed: 42 }),
  } as Job;
  const app = { service: f.service } as Application;
  try {
    assert.equal(redoPlan(original, 0).steps[0]!.parameters.texture_seed, 0);
    const planned = redoPlan(original);
    assert.ok(planned.warnings.some((warning) => warning.includes('deterministic reproduction')));
    const flags = { requestId: 'texture-redo', download: false };
    const first = await executePlan(app, planned, flags);
    const previous = f.jobs.get(String(first.task_id));
    const resumed = await executePlan(app, redoPlan(original, undefined, previous), flags);
    assert.equal(resumed.task_id, first.task_id);
    await assert.rejects(
      executePlan(app, redoPlan(original, Number(previous.input.texture_seed) + 1, previous), flags),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    assert.equal(f.gateway.posts, 1);
    for (const state of ['prepared', 'outcome_unknown', 'requires_login'] as const)
      assert.throws(() => redoPlan({ ...original, state }, 42), { code: 'INPUT_NOT_READY' });
    assert.throws(() => redoPlan({ ...original, input: { project_id: 'project', action: 'pbr' } }, 0), {
      code: 'STUDIO_CAPABILITY_UNAVAILABLE',
    });
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
