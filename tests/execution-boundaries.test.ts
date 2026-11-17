/** 付费前校验、候选异常传播及 UV 策略去重以受控上游验证，测试不访问真实账号。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './helpers.ts';
import { executePlan, taskExitCode, type Application } from '../cli/compat/runtime.ts';
import { executeCandidates, dryRunPlan } from '../cli/compat/run-plan.ts';
import { generationPlan, processingPlan, makePlan } from '../cli/compat/planning.ts';
import { candidateSummary } from '../cli/compat/execution-policy.ts';
import { fullTools } from '../cli/compat/full-tools.ts';
import { TripoError } from '../studio/contracts/errors.ts';
import type { Job } from '../studio/contracts/types.ts';
import type { StudioReads } from '../cli/commands.ts';

test('invalid execution controls fail before pricing, uploading, or submitting', async () => {
  const f = await fixture();
  let quoted = 0;
  const quote = f.service.pricing.quote;
  f.service.pricing.quote = async (...args) => {
    quoted++;
    return await quote(...args);
  };
  const app = { service: f.service } as Application;
  const plan = generationPlan('text-to-model', ['cube'], {});
  try {
    for (const key of ['timeout', 'maxCredits']) {
      for (const value of [-1, NaN, Infinity, 'invalid', ...(key === 'timeout' ? [7201] : [])]) {
        const flags = { [key]: value, download: false, requestId: 'invalid-control' };
        await assert.rejects(executeCandidates(app, plan, flags), { code: 'INVALID_INPUT' });
        await assert.rejects(executePlan(app, plan, flags), { code: 'INVALID_INPUT' });
        await assert.rejects(dryRunPlan(plan, flags), { code: 'INVALID_INPUT' });
      }
    }
    assert.equal(quoted, 0);
    assert.equal(f.gateway.posts, 0);
    assert.equal(f.jobs.list('test-account', 10).length, 0);
    assert.equal((await dryRunPlan(plan, { timeout: 0, maxCredits: 0 })).valid, true);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('unknown candidates remain unknown with nonzero exit and do not resubmit on resume', async () => {
  const f = await fixture();
  f.gateway.failSubmit = new TripoError('NETWORK_ERROR', 'Controlled lost receipt', 'unknown');
  const app = { service: f.service } as Application;
  const flags = { candidates: 2, requestId: 'candidate-unknown', download: false, wait: false };
  try {
    const plan = generationPlan('text-to-model', ['cube'], { param: { texture: false } });
    const result = await executeCandidates(app, plan, flags);
    assert.equal(result.status, 'outcome_unknown');
    assert.equal(taskExitCode(result), 6);
    await executeCandidates(app, plan, flags);
    assert.equal(f.gateway.posts, 2);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('candidate errors, timeout and continuation downloads cannot be hidden by sibling success', () => {
  assert.equal(taskExitCode(candidateSummary([{ status: 'success' }, { status: 'failed' }])), 6);
  assert.equal(
    taskExitCode(candidateSummary([{ status: 'success' }, { status: 'running', wait_timed_out: true }])),
    6,
  );
  assert.equal(
    taskExitCode(candidateSummary([{ status: 'success', download_error: { code: 'DOWNLOAD_FAILED' } }])),
    7,
  );
  assert.equal(taskExitCode({ status: 'success', continuation: { download_error: {} } }), 7);
  assert.equal(
    candidateSummary([{ status: 'success' }, { status: 'requires_login' }]).status,
    'requires_login',
  );
  assert.equal(candidateSummary([{ status: 'waiting_input' }]).status, 'waiting_input');
  assert.equal(taskExitCode(candidateSummary([{ status: 'queued' }, { status: 'running' }])), 0);
});

test('UV policies persist separately and changing bake on retry conflicts without a new POST', async () => {
  const f = await fixture();
  const project = '11111111-1111-4111-8111-111111111111';
  let current = 'original';
  f.gateway.submit = async (job: Job) => {
    f.gateway.posts++;
    if (job.operation === 'uv_commit') current = 'candidate';
    return { remote_ids: { project_id: project, operator_id: 'candidate' } };
  };
  f.gateway.status = async () => ({ state: 'succeeded', progress: 100, artifacts: [] });
  const app = {
    service: f.service,
    studio: {
      client: {
        request: async () => ({ id: project, operator: { operator_id: current, is_textured: true } }),
      },
    },
  } as unknown as Application;
  const flags = { requestId: 'uv-stable-policy', download: false };
  try {
    const first = await executePlan(app, processingPlan('uv', project, { param: { bake: false } }), flags);
    const resumed = await executePlan(app, processingPlan('uv', project, { param: { bake: false } }), flags);
    assert.equal(first.task_id, resumed.task_id);
    for (const param of [{}, { bake: true }])
      await assert.rejects(executePlan(app, processingPlan('uv', project, { param }), flags), {
        code: 'IDEMPOTENCY_CONFLICT',
      });
    assert.equal(f.gateway.posts, 2);
    assert.equal(f.jobs.find('test-account', 'uv-stable-policy-0')!.input.bake, undefined);
    const reopened = await fixture(f.dir);
    try {
      assert.equal(
        reopened.jobs.bindRequestPolicy('test-account', 'uv-stable-policy-0', {
          require_texture_baking: false,
        }),
        false,
      );
      assert.throws(
        () =>
          reopened.jobs.bindRequestPolicy('test-account', 'uv-stable-policy-0', {
            require_texture_baking: true,
          }),
        { code: 'IDEMPOTENCY_CONFLICT' },
      );
    } finally {
      reopened.jobs.close();
    }
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('full MCP gives a reconcile instruction for an unknown task rather than an endless wait', async () => {
  const f = await fixture();
  f.gateway.failSubmit = new TripoError('NETWORK_ERROR', 'Controlled lost receipt', 'unknown');
  try {
    const tools = fullTools(f.service, f.gateway as unknown as StudioReads);
    const generate = tools.find((tool) => tool.name === 'ai_modeling_text_to_3d')!;
    const first = (await generate.run({ prompt: 'cube', request_id: 'full-unknown' })) as Record<
      string,
      unknown
    >;
    assert.equal(first.status, 'outcome_unknown');
    assert.match(String(first.next), /reconcile.*do not resubmit/);
    const query = tools.find((tool) => tool.name === 'ai_modeling_task_status')!;
    const current = (await query.run({ task_id: first.task_id })) as Record<string, unknown>;
    assert.equal(current.next, first.next);
    assert.equal(f.gateway.posts, 1);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('schema 5 upgrade preserves legacy jobs and marks unrecorded UV policy without guessing', async () => {
  const f = await fixture();
  f.gateway.failSubmit = new TripoError('NETWORK_ERROR', 'Controlled lost receipt', 'unknown');
  const job = await f.service.submit('image', 'legacy-image', { prompt: 'cube' }, 10);
  const saved = f.jobs.get(String(job.job_id));
  f.jobs.close();
  const database = new DatabaseSync(path.join(f.dir, 'jobs.sqlite'));
  database.exec('DROP TABLE request_policies; PRAGMA user_version=5;');
  database.close();
  const upgraded = await fixture(f.dir);
  try {
    assert.deepEqual(upgraded.jobs.get(saved.job_id), saved);
    assert.equal(
      upgraded.jobs.bindRequestPolicy('test-account', 'legacy-image', { require_texture_baking: false }),
      true,
    );
    const resumed = await upgraded.service.submit('image', 'legacy-image', { prompt: 'cube' }, 10);
    assert.equal(resumed.state, 'outcome_unknown');
    assert.equal(upgraded.gateway.posts, 0);
  } finally {
    upgraded.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('model selection and segmentation combinations cannot silently change the requested engine', () => {
  for (const model of [42, '', ' ', false])
    assert.throws(() => generationPlan('text-to-model', ['cube'], { param: { model } }), {
      code: 'INVALID_INPUT',
    });
  assert.equal(
    generationPlan('text-to-model', ['cube'], { model: ' H3.1 ' }).steps[0]!.parameters.model_version,
    'v3.1-20260211',
  );
  assert.equal(
    generationPlan('text-to-model', ['cube'], { param: { model_version: 'v3.1-20260211' } }).steps[0]!
      .parameters.model_version,
    'v3.1-20260211',
  );
  assert.throws(
    () => generationPlan('image-to-multiview', ['front.png'], { param: { model_version: 'ignored' } }),
    { code: 'STUDIO_CAPABILITY_UNAVAILABLE' },
  );
  assert.throws(
    () =>
      processingPlan('segment', 'project', {
        model: 'v1.0-20250506',
        param: { segmentation_granularity: 'balanced' },
      }),
    { code: 'INVALID_INPUT' },
  );
});

test('scenario override and inherited texture PBR follow the explicit CLI intent', () => {
  assert.equal(makePlan(['cube'], { for: 'ar-web', then: 'convert:fbx' }).downloadGeneration, false);
  assert.equal(makePlan(['cube'], { for: 'ar-web' }).downloadGeneration, true);
  const pbr = makePlan(['cube'], { param: { pbr: true }, then: 'texture' });
  assert.equal(pbr.steps.slice(pbr.generationSteps).filter((step) => step.operation === 'texture').length, 2);
  const plain = makePlan(['cube'], { param: { pbr: true }, then: 'texture:pbr=false' });
  assert.equal(
    plain.steps.slice(plain.generationSteps).filter((step) => step.operation === 'texture').length,
    1,
  );
});

test('known task source type and unfinished sources are checked before another submission', async () => {
  const f = await fixture();
  const app = { service: f.service } as Application;
  try {
    const image = await f.service.submit('image', 'source-image', { prompt: 'cube' }, 10);
    await f.service.get(String(image.job_id));
    await assert.rejects(
      executePlan(app, makePlan([String(image.job_id)], { then: 'rig' }), { download: false }),
      { code: 'INVALID_INPUT' },
    );
    const pending = await f.service.submit('model', 'source-model', { prompt: 'cube', mode: 'text' }, 10);
    f.gateway.status = async () => ({ state: 'running', progress: 10, artifacts: [] });
    await assert.rejects(
      executePlan(app, processingPlan('texture', String(pending.job_id), {}), { download: false }),
      { code: 'INPUT_NOT_READY' },
    );
    assert.equal(f.gateway.posts, 2);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
