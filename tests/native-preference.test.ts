/** 接口优先回归覆盖动作身份恢复、网页分割请求和官方参数映射，防止静默丢参数。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { processingPlan } from '../cli/compat/planning.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import { resolveExportAnimations } from '../studio/api/discovery.ts';
import { Operations } from '../studio/api/operations.ts';
import type { StudioClient } from '../studio/api/client.ts';
import type { Job } from '../studio/contracts/types.ts';
import { executePlan, type Application } from '../cli/compat/runtime.ts';
import { fixture } from './helpers.ts';
const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';

test('native static export preserves format/orientation and removes only the native edit parameters', () => {
  const plan = processingPlan('convert', 'project', {
    format: 'fbx',
    fbxPreset: 'mixamo',
    exportOrientation: '+x',
    scaleFactor: 2,
    param: { part_names: ['head'] },
  });
  assert.deepEqual(
    plan.steps.map((step) => step.operation),
    ['copy', 'project_edit', 'export'],
  );
  assert.deepEqual(plan.steps[1]!.exportEdits, { part_names: ['head'], scale_factor: 2 });
  const final = plan.steps[2]!.parameters;
  assert.equal(final.part_names, undefined);
  assert.equal(final.scale_factor, undefined);
  assert.equal(final.fbx_preset, 'mixamo');
  assert.equal(final.export_orientation, '+x');
  assert.throws(() => processingPlan('convert', 'project', { scaleFactor: -1 }));
});

test('default image orientation preserves the ordinary web request without claiming view alignment', async () => {
  const { generationPlan } = await import('../cli/compat/planning.ts');
  for (const name of ['image-to-model', 'multiview-to-model']) {
    const inputs = name === 'multiview-to-model' ? ['front.png', 'back.png'] : ['front.png'];
    const plain = generationPlan(name, inputs, {});
    const defaulted = generationPlan(name, inputs, { param: { orientation: 'default' } });
    assert.deepEqual(defaulted.steps[0]!.parameters, plain.steps[0]!.parameters);
    assert.ok(defaulted.warnings.some((message) => message.includes('orientation=default')));
    assert.throws(() => generationPlan(name, inputs, { param: { orientation: 'align_image' } }));
  }
});

test('automatic animation intent keeps strict submission validation and resumes the original selection', async () => {
  const plan = processingPlan('convert', 'project', { format: 'glb', param: { with_animation: true } });
  assert.equal(plan.steps[0]!.animationsFromSource, true);
  assert.deepEqual(normalize('export', plan.steps[0]!.parameters).animations, []);
  assert.throws(() =>
    processingPlan('convert', 'project', { param: { with_animation: true, flatten_bottom: true } }),
  );
  const f = await fixture();
  let motions = [first];
  let operator = 'base',
    reads = 0;
  const client = {
    request: async () => {
      reads++;
      return {
        id: 'project',
        is_owner: true,
        operator: {
          operator_id: operator,
          retarget: motions.map((id) => ({
            operator_id: id,
            status: 'success',
            model_url: 'https://example.org/model.glb',
          })),
        },
      };
    },
  } as unknown as StudioClient;
  const app = { service: f.service, studio: { client } } as Application;
  try {
    const flags = { requestId: 'export-intent', wait: false, download: false };
    const initial = await executePlan(app, plan, flags);
    const initialReads = reads;
    motions = [first, second];
    operator = 'changed-current-model';
    const resumed = await executePlan(app, plan, flags);
    assert.equal(initial.task_id, resumed.task_id);
    assert.equal(f.gateway.posts, 1);
    assert.deepEqual(f.jobs.get(String(initial.task_id)).input.animations, [first]);
    assert.equal(f.jobs.get(String(initial.task_id)).input.expected_operator_id, 'base');
    assert.equal(reads, initialReads);
    await assert.rejects(
      executePlan(
        app,
        processingPlan('convert', 'project', {
          format: 'glb',
          param: { with_animation: true, expected_operator_id: 'changed-current-model' },
        }),
        flags,
      ),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    assert.equal(f.gateway.posts, 1);
    await assert.rejects(resolveExportAnimations(client, 'project', ['foreign']), {
      code: 'ANIMATION_NOT_READY',
    });
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('segmentation plans positive affine transfers and rejects invalid matrices while mapping v2 hints', () => {
  const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const plan = processingPlan('smartsegment', 'model.glb', {
    param: { hint: 'head, body and limbs', transform },
  });
  assert.deepEqual(
    plan.steps.map((step) => step.operation),
    ['import_model', 'segment'],
  );
  assert.deepEqual(plan.steps[0]!.parameters.transform_matrix, transform);
  assert.equal(plan.steps[1]!.parameters.prompt, 'head, body and limbs');
  assert.equal(plan.steps[1]!.parameters.model_version, 'v2.0-20260430');
  assert.equal(
    processingPlan('segment', 'project', { param: { segmentation_granularity: 'detailed' } }).steps[0]!
      .parameters.model_version,
    'v2.0-20260430',
  );
  const existing = processingPlan('smartsegment', 'project', { param: { transform } });
  assert.equal(existing.steps[0]!.operation, 'segment');
  // 正行列式的组合剪切有独立纯R导入三步；反射、奇异和投影仍在导入前拒绝。
  const affine = transform.map((v, i) => (i === 1 || i === 4 ? 0.2 : v));
  for (const source of ['project', 'model.glb']) {
    const selected = processingPlan('smartsegment', source, {
      param: { transform: affine, hint: 'two parts' },
    });
    assert.deepEqual(
      selected.steps.map((step) => step.operation),
      ['import_model', 'project_edit', 'segment'],
    );
    assert.deepEqual(selected.smartSegmentAffine?.matrix, affine);
    assert.equal(selected.smartSegmentScale, undefined);
    assert.equal(selected.steps[2]!.parameters.prompt, 'two parts');
    for (const rejected of [
      transform.map((v, i) => (i === 0 ? -1 : v)),
      transform.map((v, i) => (i === 0 ? 0 : v)),
      transform.map((v, i) => (i === 3 ? 0.1 : v)),
    ])
      assert.throws(() => processingPlan('smartsegment', source, { param: { transform: rejected } }), {
        code: 'SMARTSEGMENT_TRANSFORM_UNVERIFIED',
      });
  }
  assert.throws(() =>
    processingPlan('smartsegment', 'image.png', { param: { seg_type: 'image', hint: 'head', transform } }),
  );
  assert.throws(() =>
    normalize('segment', { project_id: 'p', prompt: 'head', model_version: 'v1.0-20250506' }),
  );
  assert.throws(() => normalize('segment', { project_id: 'p', prompt: '🙂'.repeat(1001) }));
  assert.equal(
    normalize('segment', { project_id: 'p', prompt: '🙂'.repeat(1000) }).prompt,
    '🙂'.repeat(1000),
  );
});

test('resegment verifies current operator and sends the native prompt contract', async () => {
  const client = {
    request: async () => ({
      id: 'p',
      is_owner: true,
      operator: { operator_id: 'current', status: 'success', is_rigged: false },
    }),
  } as unknown as StudioClient;
  const input = normalize('resegment', { project_id: 'p', operator_id: 'current', prompt: 'head and body' });
  const operations = new Operations(client, []);
  const submission = await operations.build({ operation: 'resegment', input } as Job);
  assert.equal(submission.route, '/v2/studio/operation/ai_segmentation/resegment');
  assert.equal(submission.body.prompt, 'head and body');
  const segmented = {
    request: async () => ({
      is_owner: true,
      operator: { operator_id: 'current', status: 'success', is_segmented: true },
    }),
  } as unknown as StudioClient;
  const repeated = await new Operations(segmented, []).build({
    operation: 'segment',
    input: normalize('segment', {
      project_id: 'p',
      prompt: 'head and body',
      expected_operator_id: 'current',
    }),
  } as Job);
  assert.equal(repeated.route, '/v2/studio/operation/ai_segmentation/resegment');
  assert.equal(repeated.body.operator_id, 'current');
  await assert.rejects(
    operations.build({ operation: 'resegment', input: { ...input, operator_id: 'old' } } as unknown as Job),
    { code: 'PROJECT_CHANGED' },
  );
});

test('generation and UV orientation share native export plans and validate before billed work', async () => {
  const { generationPlan, makePlan } = await import('../cli/compat/planning.ts');
  const { fullToolPlan } = await import('../cli/compat/full-tools.ts');
  const { validateExecution } = await import('../cli/compat/run-plan.ts');
  for (const direction of ['+x', '-x', '+y', '-y']) {
    const generated = generationPlan('text-to-model', ['asymmetric block'], {
      param: { export_orientation: direction },
    });
    assert.deepEqual(
      generated.steps.map((s) => s.operation),
      ['model', 'texture', 'export'],
    );
    assert.equal(generated.steps[0]!.parameters.export_orientation, undefined);
    assert.equal(generated.steps.at(-1)!.parameters.export_orientation, direction);
    assert.deepEqual(
      fullToolPlan('ai_modeling_text_to_3d', {
        prompt: 'asymmetric block',
        export_orientation: direction,
      }),
      generated,
    );
    assert.equal(
      makePlan(['asymmetric block'], {
        param: { export_orientation: direction },
      }).steps.at(-1)!.parameters.export_orientation,
      direction,
    );
    assert.equal(validateExecution(generated, { candidates: 2 }, false), 2);
    assert.throws(() => validateExecution(generated, { wait: false }), { code: 'INVALID_INPUT' });
    const uv = processingPlan('uv', 'project', { param: { export_orientation: direction } });
    assert.deepEqual(
      uv.steps.map((s) => s.operation),
      ['uv_generate', 'uv_commit', 'export'],
    );
    assert.equal(uv.steps[2]!.parameters.export_orientation, direction);
  }
  assert.throws(() => generationPlan('text-to-model', ['block'], { param: { export_orientation: '+z' } }));
  assert.throws(() => processingPlan('uv', 'project', { param: { export_orientation: '+z' } }));
  assert.throws(() => generationPlan('text-to-image', ['block'], { param: { export_orientation: '+x' } }));
});

test('native orientation chain resumes completed generation and rejects changed export intent', async () => {
  const { generationPlan } = await import('../cli/compat/planning.ts');
  const f = await fixture();
  const posts: Job[] = [];
  f.gateway.submit = async (job) => {
    posts.push(job);
    return {
      remote_ids: { project_id: 'project', operator_id: job.operation === 'model' ? 'original' : 'exported' },
    };
  };
  f.gateway.status = async () => ({ state: 'succeeded', progress: 100, artifacts: [] });
  const app = {
    service: f.service,
    studio: {
      client: {
        request: async () => {
          return {
            id: 'project',
            is_owner: true,
            operator: { operator_id: 'exported', is_rigged: false, retarget: [] },
          };
        },
      },
    },
  } as unknown as Application;
  try {
    const plan = generationPlan('text-to-model', ['block'], { param: { export_orientation: '+x' } });
    const flags = { requestId: 'orientation-chain', wait: true, download: false };
    const first = await executePlan(app, plan, flags);
    const resumed = await executePlan(app, plan, flags);
    assert.equal(first.task_id, resumed.task_id);
    assert.equal(posts.length, 3);
    assert.equal(posts[2]!.input.project_id, 'project');
    assert.equal(posts[2]!.input.export_orientation, '+x');
    await assert.rejects(
      executePlan(
        app,
        generationPlan('text-to-model', ['block'], {
          param: { export_orientation: '-x' },
        }),
        flags,
      ),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    assert.equal(posts.length, 3);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
