/** 显式纹理版本必须在真实回执角色上验收；不通过换质量或更换收到的结果满足参数。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { fixture } from './helpers.ts';
import { generationPlan, processingPlan } from '../cli/compat/planning.ts';
import { executePlan, type Application } from '../cli/compat/runtime.ts';
import { readTextureModel } from '../cli/core/texture-version-policy.ts';
import type { Job } from '../studio/contracts/types.ts';
import { object, text } from '../studio/contracts/errors.ts';

test('v3.5 explicit generation splits only requested texture and preserves PBR and original quality', () => {
  for (const model of ['tripo-v3.1', 'tripo-p1', 'tripo-p2']) {
    const plan = generationPlan('text-to-model', ['blue cube'], {
      model,
      param: { texture_version: 'v3.5', texture_quality: 'detailed', pbr: true },
    });
    assert.deepEqual(
      plan.steps.map((step) => step.operation),
      ['model', 'texture', 'texture'],
    );
    assert.equal(plan.steps[0]!.parameters.texture, false);
    assert.equal(plan.steps[0]!.requireTextureModel, undefined);
    assert.equal(plan.steps[1]!.requireTextureModel, 'v3.5-20260815');
    assert.equal(plan.steps[1]!.parameters.texture_quality, 'detailed');
    assert.equal(plan.steps[2]!.requireTextureModel, undefined);
    assert.ok(plan.steps.every((step) => step.parameters.texture_version === undefined));
  }
  const bare = generationPlan('text-to-model', ['cube'], {
    model: 'tripo-v3.1',
    param: { texture: false, texture_version: 'v3.5' },
  });
  assert.equal(bare.steps.length, 1);
  assert.equal(bare.steps[0]!.requireTextureModel, undefined);
  for (const texture_version of ['v3.0', 'v2.5'])
    assert.throws(
      () => generationPlan('text-to-model', ['cube'], { model: 'tripo-v3.1', param: { texture_version } }),
      { code: 'STUDIO_CAPABILITY_UNAVAILABLE' },
    );
  assert.equal(
    processingPlan('texture', '@model', { model: 'v3.5' }).steps[0]!.requireTextureModel,
    'v3.5-20260815',
  );
});

test('texture engine mismatch stops an unsubmitted PBR tail and recovery never creates another texture', async () => {
  const f = await fixture(),
    submissions: Job[] = [];
  let actual = 'v3.0-20250812';
  let reads = 0;
  f.gateway.submit = async (job) => {
    submissions.push(job);
    return { remote_ids: { project_id: 'project', operator_id: `op-${job.job_id}` } };
  };
  f.gateway.status = async () => ({
    state: 'succeeded',
    progress: 100,
    artifacts: [{ artifact_id: 'model', kind: 'model', format: 'glb', index: 0 }],
  });
  f.service.gateway.modelVersion = async (job) => {
    assert.equal(job.operation, 'texture');
    assert.equal(job.input.action, 'generate');
    reads++;
    return actual;
  };
  const app = { service: f.service } as Application;
  const plan = generationPlan('text-to-model', ['cube'], {
    model: 'tripo-v3.1',
    param: { texture_version: 'v3.5', pbr: true },
  });
  try {
    const first = await executePlan(app, plan, { requestId: 'texture-version', download: false });
    assert.equal(first.status, 'needs_attention');
    assert.equal(submissions.length, 2);
    assert.equal(object(first.error).code, 'NATIVE_OUTPUT_REQUIREMENT_FAILED');
    const texture = f.jobs.get(text(first.task_id));
    assert.equal(texture.state, 'succeeded');
    assert.equal(readTextureModel(f.jobs, texture), 'v3.5-20260815');
    await executePlan(app, plan, { requestId: 'texture-version', download: false });
    assert.equal(submissions.length, 2);
    actual = 'v3.5-20260815';
    const verified = await f.service.get(texture.job_id);
    assert.equal(object(verified.native_output_validation).texture_model, 'v3.5-20260815');
    const before = reads;
    await f.service.get(texture.job_id);
    assert.equal(reads, before);
    const finished = await executePlan(app, plan, { requestId: 'texture-version', download: false });
    assert.equal(finished.status, 'success');
    assert.equal(submissions.length, 3);
    const omitted = generationPlan('text-to-model', ['cube'], {
      model: 'tripo-v3.1',
      param: { texture: false },
    });
    await assert.rejects(executePlan(app, omitted, { requestId: 'texture-version', download: false }), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    assert.equal(submissions[2]!.input.action, 'pbr');
    const changed = generationPlan('text-to-model', ['cube'], { model: 'tripo-v3.1', param: { pbr: true } });
    await assert.rejects(executePlan(app, changed, { requestId: 'texture-version', download: false }), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    assert.equal(submissions.length, 3);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
