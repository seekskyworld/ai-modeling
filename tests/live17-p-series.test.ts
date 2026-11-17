/** P 系列自动贴图覆盖真实服务边界：意图冲突、旧布局、未知回执和多候选不得造成额外付费。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture } from './helpers.ts';
import { generation, generationPlan, makePlan, processingPlan, type Plan } from '../cli/compat/planning.ts';
import { executePlan, type Application } from '../cli/compat/runtime.ts';
import {
  dryRunPlan,
  executeCandidates,
  executionPreview,
  validateExecution,
} from '../cli/compat/run-plan.ts';
import { redoPlan } from '../cli/compat/redo.ts';
import { candidateGeneration } from '../cli/compat/p-series-generation.ts';
import { Operations } from '../studio/api/operations.ts';
import { prepareInput } from '../studio/api/preparation.ts';
import { StudioClient } from '../studio/api/client.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import { TripoError } from '../studio/contracts/errors.ts';
import type { Job } from '../studio/contracts/types.ts';

const p2 = 'Nexus-v2.0-20260801';
async function runtime(calls: Job[], dir?: string) {
  const f = await fixture(dir);
  f.gateway.submit = async (job) => {
    calls.push(job);
    return {
      remote_ids: {
        project_id: job.operation === 'model' ? `project-${job.job_id}` : String(job.input.project_id),
        operator_id: `operator-${job.job_id}`,
      },
    };
  };
  f.gateway.status = async () => ({ state: 'succeeded', progress: 100, artifacts: [] });
  const app = {
    service: f.service,
    studio: {
      client: {
        request: async (method: string, route: string) => {
          if (method !== 'GET' || !route.startsWith('/v2/studio/project/detail/v3/'))
            throw new Error('Unexpected live query in controlled test');
          const project = decodeURIComponent(route.split('/').at(-1)!);
          const source = calls
            .filter(
              (job) =>
                job.operation !== 'export' &&
                (job.operation === 'model' ? `project-${job.job_id}` : job.input.project_id) === project,
            )
            .at(-1);
          if (!source) throw new Error('Unexpected source in controlled test');
          return {
            id: project,
            is_owner: true,
            operator: { operator_id: `operator-${source.job_id}`, is_rigged: false, retarget: [] },
          };
        },
      },
    },
  } as unknown as Application;
  return { ...f, app };
}

test('P1/P2 default texturing preserves quality, seed and optional PBR in separate native tasks', async () => {
  for (const model of ['tripo-p1', 'tripo-p2']) {
    const plan = generationPlan('text-to-model', ['blue robot'], {
      model,
      param: {
        texture: false,
        pbr: true,
        texture_quality: 'extreme',
        texture_alignment: 'geometry',
        delight: false,
        texture_seed: 0,
      },
    });
    assert.deepEqual(
      plan.steps.map((step) => step.operation),
      ['model', 'texture', 'texture'],
    );
    const [geometry, texture, pbr] = plan.steps;
    assert.equal(geometry!.parameters.texture, false);
    assert.equal(geometry!.parameters.pbr, false);
    assert.equal(geometry!.parameters.texture_seed, undefined);
    assert.deepEqual(
      ['texture_quality', 'texture_alignment', 'delight', 'texture_seed'].map(
        (key) => texture!.parameters[key],
      ),
      ['ultra', 'geometry', false, 0],
    );
    assert.equal(texture!.source, 'upstream');
    assert.equal(pbr!.parameters.action, 'pbr');
    assert.equal(plan.generationLayout!.original.parameters.texture, true);
    assert.equal(plan.generationSteps, 3);
    assert.ok(plan.warnings.some((warning) => warning.includes('separate PBR task')));
    const dry = await dryRunPlan(plan, {});
    assert.equal(dry.valid, true);
  }
  assert.equal(generationPlan('text-to-model', ['cube'], { param: { texture: false } }).steps.length, 1);
  assert.equal(generationPlan('text-to-model', ['cube'], { model: 'H3.1' }).steps.length, 1);
  assert.throws(
    () => generationPlan('image-to-model', ['photo.png'], { param: { enable_image_autofix: true } }),
    { code: 'STUDIO_CAPABILITY_UNAVAILABLE' },
  );
  assert.throws(
    () =>
      generationPlan('text-to-model', ['cube'], {
        param: { variations: [{ face_limit: 100 }, { face_limit: 200 }] },
      }),
    { code: 'STUDIO_CAPABILITY_UNAVAILABLE' },
  );
});

test('P-series payload omits HD fields and raw texturing fails before upload, precheck or quote preparation', async () => {
  let requests = 0;
  const client = {
    request: async () => {
      requests++;
      throw new Error('No request expected');
    },
  } as unknown as StudioClient;
  const operations = new Operations(client, []);
  const input = normalize('model', { mode: 'text', prompt: 'cube', model_version: p2 });
  const submission = await operations.build({ operation: 'model', input } as Job);
  assert.equal(submission.body.symmetry, false);
  for (const key of [
    'texture',
    'pbr',
    'smart_poly',
    'generate_parts',
    'texture_quality',
    'texture_alignment',
    'delight',
    'enable_image_autofix',
  ])
    assert.equal(Object.hasOwn(submission.body, key), false, key);
  for (const extra of [
    { texture: true },
    { enable_image_autofix: true },
    { smart_poly: true },
    { texture_seed: 1 },
  ]) {
    const raw: Record<string, unknown> = { ...input, ...extra };
    await assert.rejects(prepareInput(client, 'model', raw), { code: 'STUDIO_CAPABILITY_UNAVAILABLE' });
    await assert.rejects(operations.build({ operation: 'model', input: raw } as Job), {
      code: 'STUDIO_CAPABILITY_UNAVAILABLE',
    });
  }
  assert.equal(requests, 0);
});

test('P2 single-image budgets follow the verified website minimum without clamping or changing text generation', async () => {
  for (const face_limit of [48, 100, 499]) {
    assert.throws(
      () => generationPlan('image-to-model', ['https://example.org/input.png'], { param: { face_limit } }),
      /500/,
    );
    assert.throws(
      () =>
        normalize('model', {
          mode: 'image',
          model_version: p2,
          image_asset: { asset_id: 'image' },
          face_limit,
        }),
      /500/,
    );
  }
  assert.equal(
    generationPlan('image-to-model', ['https://example.org/input.png'], { param: { face_limit: 500 } })
      .steps[0]!.parameters.face_limit,
    500,
  );
  assert.equal(
    generationPlan('text-to-model', ['cube'], { param: { face_limit: 100 } }).steps[0]!.parameters.face_limit,
    100,
  );
  assert.throws(
    () =>
      generationPlan('image-to-model', ['https://example.org/input.png'], {
        param: { texture: false, variations: [{ face_limit: 100 }, { face_limit: 1000 }] },
      }),
    /500/,
  );
  await assert.rejects(
    promisify(execFile)(process.execPath, [
      'cli/main.ts',
      '--json',
      'generate',
      'image-to-model',
      'https://example.org/input.png',
      '-p',
      'face_limit=100',
      '--no-download',
    ]),
    (error: unknown) => {
      const failure = error as { code?: number; stdout?: string };
      assert.equal(failure.code, 2);
      assert.match(failure.stdout ?? '', /face_limit.*500/);
      assert.doesNotMatch(failure.stdout ?? '', /AUTH_REQUIRED/);
      return true;
    },
  );
});

test('P2 chain resumes after a process restart and changing only texture intent conflicts before another quote', async () => {
  const calls: Job[] = [];
  let f = await runtime(calls);
  const plan = generationPlan('text-to-model', ['cube'], { param: { pbr: true } });
  const flags = { requestId: 'p2-resume', download: false };
  try {
    const first = await executePlan(f.app, plan, flags);
    assert.equal(first.status, 'success');
    assert.deepEqual(
      calls.map((call) => call.operation),
      ['model', 'texture', 'texture'],
    );
    assert.equal(calls[1]!.input.project_id, calls[2]!.input.project_id);
    assert.equal(calls[1]!.input.expected_operator_id, `operator-${calls[0]!.job_id}`);
    assert.equal(calls[2]!.input.expected_operator_id, `operator-${calls[1]!.job_id}`);
    const dir = f.dir;
    f.jobs.close();
    f = await runtime(calls, dir);
    const resumed = await executePlan(f.app, plan, flags);
    assert.equal(resumed.task_id, first.task_id);
    assert.equal(calls.length, 3);
    let quotes = 0;
    f.service.pricing.quote = async () => {
      quotes++;
      throw new Error('No quote expected');
    };
    await assert.rejects(
      executePlan(f.app, generationPlan('text-to-model', ['cube'], { param: { texture: false } }), flags),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    await assert.rejects(
      executePlan(f.app, makePlan(['cube'], { param: { pbr: true }, then: 'convert:fbx' }), flags),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    assert.equal(quotes, 0);
    assert.equal(calls.length, 3);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('legacy generation plus export keeps original indexes and never inserts billed texturing on recovery', async () => {
  const calls: Job[] = [];
  const f = await runtime(calls);
  const flags = { requestId: 'legacy-tail', download: false };
  const original: Plan = {
    steps: [
      generation('text-to-model', ['cube'], {}),
      ...processingPlan('convert', 'upstream', { format: 'fbx' }).steps,
    ],
    pending_uploads: [],
    warnings: [],
  };
  try {
    const first = await executePlan(f.app, original, flags);
    const result = await executePlan(f.app, makePlan(['cube'], { then: 'convert:fbx' }), flags);
    assert.equal(result.task_id, first.task_id);
    assert.deepEqual(
      calls.map((call) => [call.request_id, call.operation]),
      [
        ['legacy-tail-0', 'model'],
        ['legacy-tail-1', 'export'],
      ],
    );
    assert.match(String(result.warnings), /legacy P-series/);
    assert.equal(f.jobs.list('test-account', 10).length, 2);
    await assert.rejects(executePlan(f.app, makePlan(['cube'], { then: 'convert:fbx,texture' }), flags), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    // 错误重用 legacy request 不得保存错误策略，以免随后正确恢复也被锁死。
    await assert.rejects(executePlan(f.app, generationPlan('text-to-model', ['different cube'], {}), flags), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    assert.equal(
      (await executePlan(f.app, makePlan(['cube'], { then: 'convert:fbx' }), flags)).task_id,
      first.task_id,
    );
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('unknown geometry or texture receipts stop downstream work and resume without resubmitting', async () => {
  for (const lostAt of ['legacy', 'model', 'texture']) {
    const calls: Job[] = [];
    const f = await runtime(calls);
    const submit = f.gateway.submit.bind(f.gateway);
    f.gateway.submit = async (job) => {
      const result = await submit(job);
      if (job.operation === (lostAt === 'texture' ? 'texture' : 'model'))
        throw new TripoError('NETWORK_ERROR', 'Controlled lost receipt', 'unknown');
      return result;
    };
    const flags = { requestId: `unknown-${lostAt}`, download: false };
    const plan = generationPlan('text-to-model', ['cube'], { param: { pbr: true } });
    try {
      if (lostAt === 'legacy')
        await f.service.submit(
          'model',
          `${flags.requestId}-0`,
          plan.generationLayout!.original.parameters,
          10,
        );
      const first = await executePlan(f.app, plan, flags);
      const resumed = await executePlan(f.app, plan, flags);
      assert.equal(first.status, 'outcome_unknown');
      assert.equal(resumed.task_id, first.task_id);
      assert.equal(calls.length, lostAt === 'texture' ? 2 : 1);
      assert.ok(!calls.some((call) => call.input.action === 'pbr'));
    } finally {
      f.jobs.close();
      await rm(f.dir, { recursive: true, force: true });
    }
  }
});

test('every candidate includes texturing/PBR and export; implicit generation work does not require interactive selection', async () => {
  const calls: Job[] = [];
  const f = await runtime(calls);
  const plan = generationPlan('text-to-model', ['cube'], { param: { pbr: true, export_orientation: '+x' } });
  const flags = { requestId: 'textured-candidates', candidates: 2, download: false };
  try {
    assert.equal(validateExecution(plan, flags, false), 2);
    assert.equal(plan.generationSteps, 4);
    const result = await executeCandidates(f.app, plan, flags);
    assert.equal(result.status, 'success');
    assert.equal(calls.length, 8);
    for (const candidate of [0, 1]) {
      const own = calls.filter((call) => call.request_id.startsWith(`${flags.requestId}-${candidate}-`));
      assert.deepEqual(
        own.map((call) => call.operation),
        ['model', 'texture', 'texture', 'export'],
      );
      assert.equal(own[3]!.input.export_orientation, '+x');
    }
    await executeCandidates(f.app, plan, flags);
    assert.equal(calls.length, 8);
    const withTail = makePlan(['cube'], { then: 'convert:fbx' });
    assert.throws(() => validateExecution(withTail, flags, false), { code: 'INVALID_INPUT' });
    const candidate = candidateGeneration(withTail, 42);
    assert.deepEqual(
      candidate.steps.map((step) => step.operation),
      ['model', 'texture'],
    );
    assert.equal(candidate.generationLayout!.original.parameters.model_seed, 42);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('no-wait and invalid downstream inputs fail before upload or pricing for the entire new chain', async () => {
  const calls: Job[] = [];
  const f = await runtime(calls);
  let quotes = 0;
  f.service.pricing.quote = async () => {
    quotes++;
    throw new Error('No quote expected');
  };
  try {
    for (const candidates of [1, 2])
      await assert.rejects(
        executeCandidates(f.app, generationPlan('image-to-model', ['https://example.org/image.png'], {}), {
          wait: false,
          candidates,
          download: false,
        }),
        { code: 'INVALID_INPUT' },
      );
    await assert.rejects(
      executePlan(f.app, makePlan(['cube'], { then: 'texture:image=/missing/texture-reference.png' }), {
        download: false,
      }),
      { code: 'INVALID_INPUT' },
    );
    assert.equal(quotes, 0);
    assert.equal(calls.length, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('legacy no-wait preview restores only the same original intention, while new multi-step requests still stop', async () => {
  const calls: Job[] = [];
  const f = await runtime(calls);
  const flags = { requestId: 'legacy-no-wait', wait: false, download: false };
  try {
    const original = generation('text-to-model', ['cube'], {});
    const first = await f.service.submit('model', `${flags.requestId}-0`, original.parameters, 10);
    const plan = makePlan(['cube'], flags);
    assert.equal(executionPreview(f.app, plan, flags).steps.length, 1);
    assert.equal((await executeCandidates(f.app, plan, flags)).task_id, first.job_id);
    assert.equal(calls.length, 1);
    for (const change of [{ texture: false }, { face_limit: 1234 }])
      await assert.rejects(executeCandidates(f.app, makePlan(['cube'], { ...flags, param: change }), flags), {
        code: 'IDEMPOTENCY_CONFLICT',
      });
    assert.throws(() => executionPreview(f.app, plan, { ...flags, requestId: 'new-no-wait' }), {
      code: 'INVALID_INPUT',
    });
    await assert.rejects(dryRunPlan(plan, flags), { code: 'INVALID_INPUT' });
    assert.equal(calls.length, 1);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('redo of legacy P-series intent expands once and reuses its automatic seed and source version', async () => {
  const calls: Job[] = [];
  const f = await runtime(calls);
  const flags = { requestId: 'p2-redo', download: false };
  const original: Job = {
    job_id: 'original',
    operation: 'model',
    state: 'succeeded',
    input: generation('text-to-model', ['cube'], {}).parameters,
    remote_ids: { project_id: 'original-project', operator_id: 'original-op' },
  } as Job;
  try {
    const first = await executePlan(f.app, redoPlan(original), flags);
    const prior = f.jobs.find('test-account', `${flags.requestId}-0`)!;
    const again = await executePlan(f.app, redoPlan(original, undefined, prior), flags);
    assert.equal(again.task_id, first.task_id);
    assert.deepEqual(
      calls.map((call) => call.operation),
      ['model', 'texture'],
    );
    await assert.rejects(
      executePlan(f.app, redoPlan(original, Number(prior.input.model_seed) + 1, prior), flags),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    const texture = f.jobs.get(String(first.task_id));
    const repeated = redoPlan(texture, 0);
    assert.equal(repeated.steps.length, 1);
    assert.equal(repeated.steps[0]!.parameters.expected_operator_id, texture.remote_ids.operator_id);
    assert.equal(repeated.steps[0]!.parameters.texture_seed, 0);
    const failedTexture = redoPlan({ ...texture, state: 'failed', remote_ids: {} }, 0);
    assert.equal(failedTexture.steps[0]!.parameters.expected_operator_id, texture.input.expected_operator_id);
    for (const state of ['submitted', 'outcome_unknown'] as const)
      assert.throws(() => redoPlan({ ...original, state }), { code: 'INPUT_NOT_READY' });
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
