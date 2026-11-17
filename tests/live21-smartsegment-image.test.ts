/** 智能分割图片必须在导入前分流；不把文件URL、提示词或矩阵悄悄变成另一种付费任务。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { processingPlan } from '../cli/compat/planning.ts';
import { fullToolPlan } from '../cli/compat/full-tools.ts';
import { materializeInputs } from '../cli/artifacts/source.ts';
import { freezeSmartSegmentImage } from '../cli/compat/smartsegment-image.ts';
import { validateExecution } from '../cli/compat/run-plan.ts';
import { fixture } from './helpers.ts';
import { executePlan, type Application } from '../cli/compat/runtime.ts';
import { TripoError } from '../studio/contracts/errors.ts';
import type { Job } from '../studio/contracts/types.ts';

test('image smartsegment uses one native model task with all three explicit granularity levels', () => {
  for (const granularity of ['coarse', 'medium', 'fine']) {
    for (const input of [
      'front.PNG',
      'https://example.invalid/front.webp?version=1',
      'studio_file_image_x',
    ]) {
      const cli = processingPlan('smartsegment', input, { granularity });
      const mcp = fullToolPlan('ai_modeling_smart_segment', { input, granularity });
      assert.deepEqual(cli, mcp);
      assert.equal(cli.steps.length, 1);
      const step = cli.steps[0]!;
      assert.equal(step.operation, 'model');
      assert.equal(step.name, 'smartsegment');
      assert.equal(step.parameters.mode, 'image');
      assert.equal(step.parameters.generate_parts, true);
      assert.equal(step.parameters.generate_parts_level, granularity);
      assert.equal(step.parameters.model_version, 'v3.1-20260211');
      assert.equal(step.parameters.texture, false);
      assert.equal(step.parameters.pbr, false);
      assert.equal(step.parameters.quad, false);
      assert.equal(step.source, undefined);
      assert.match(cli.warnings.join('\n'), /not guaranteed to align.*semantic part-label.*not synthesized/);
    }
  }
  const defaultPlan = processingPlan('smartsegment', 'https://example.invalid/download', {
    segType: 'image',
  });
  assert.equal(defaultPlan.steps[0]!.parameters.generate_parts_level, 'medium');
  const overriding = processingPlan('smartsegment', 'image.png', {
    granularity: 'fine',
    param: { granularity: 'coarse' },
  });
  assert.equal(overriding.steps[0]!.parameters.generate_parts_level, 'coarse');
});

test('image transforms and unsupported controls cannot be silently ignored before submission', () => {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const param of [
    { hint: '🙂'.repeat(1001) },
    { transform: identity },
    { transform: [] },
    { transform: null },
    { granularity: 'high' },
    { seg_type: 'invalid' },
    { model: 'tripo-p2' },
    { texture: true },
  ])
    assert.throws(() => processingPlan('smartsegment', 'image.png', { param }));
  for (const input of ['@last', 'task_example', '00000000-0000-0000-0000-000000000000']) {
    const plan = fullToolPlan('ai_modeling_smart_segment', { input, seg_type: 'image' });
    assert.deepEqual(plan.pending_uploads, []);
    assert.deepEqual(plan.steps[0]!.imageReferences, [{ reference: input, target: 'image_asset' }]);
    assert.equal(plan.steps[0]!.parameters.image_path, undefined);
  }
  const model = processingPlan('smartsegment', 'model.glb', { param: { hint: 'head', transform: identity } });
  assert.deepEqual(
    model.steps.map((step) => step.operation),
    ['import_model', 'segment'],
  );
  assert.equal(model.steps[1]!.parameters.prompt, 'head');
  assert.equal(processingPlan('smartsegment', 'image.png', { hint: '  ' }).steps[0]!.operation, 'model');
});

test('image hints create a frozen model-to-segmentation chain and validate the tail before generation', async () => {
  const f = await fixture();
  try {
    const options = { hint: ' Separate head and body. ', granularity: 'medium' };
    const plan = processingPlan('smartsegment', 'image.png', options);
    assert.deepEqual(plan, fullToolPlan('ai_modeling_smart_segment', { input: 'image.png', ...options }));
    assert.deepEqual(
      plan.steps.map((step) => step.operation),
      ['model', 'segment'],
    );
    assert.equal(plan.steps[0]!.parameters.generate_parts, false);
    assert.equal(plan.steps[0]!.parameters.prompt, undefined);
    assert.equal(plan.steps[1]!.source, 'upstream');
    assert.equal(plan.steps[1]!.parameters.expected_operator_id, 'upstream');
    assert.equal(plan.steps[1]!.parameters.prompt, 'Separate head and body.');
    assert.equal(plan.steps[1]!.parameters.segmentation_granularity, 'balanced');
    assert.equal(plan.steps[1]!.parameters.model_version, 'v2.0-20260430');
    assert.throws(() => validateExecution(plan, { wait: false }), { code: 'INVALID_INPUT' });
    freezeSmartSegmentImage(f.jobs, 'test-account', plan, 'hint');
    freezeSmartSegmentImage(f.jobs, 'test-account', plan, 'hint');
    for (const changed of [
      processingPlan('smartsegment', 'image.png', { hint: 'Changed parts.' }),
      processingPlan('smartsegment', 'another.png', options),
      processingPlan('smartsegment', 'image.png', {}),
    ])
      assert.throws(() => freezeSmartSegmentImage(f.jobs, 'test-account', changed, 'hint'), {
        code: 'IDEMPOTENCY_CONFLICT',
      });
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('image smartsegment URLs materialize as frozen image bytes, never model imports', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tripo-smartsegment-'));
  try {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5X8AAAAASUVORK5CYII=',
      'base64',
    );
    let reads = 0;
    const plan = processingPlan('smartsegment', 'https://example.invalid/input.png', {});
    const fetcher = async () => {
      reads++;
      return new Response(png);
    };
    const first = await materializeInputs(plan, dir, 'one-intent', fetcher);
    const second = await materializeInputs(plan, dir, 'one-intent', fetcher);
    assert.deepEqual(first, second);
    assert.equal(reads, 1);
    assert.equal(first.steps[0]!.parameters.model_path, undefined);
    assert.match(String(first.steps[0]!.parameters.image_path), /input-cache/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('lost hinted segmentation receipt never repeats the completed model or the uncertain second request', async () => {
  const f = await fixture();
  try {
    const file = path.join(f.dir, 'input.png');
    await writeFile(
      file,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5X8AAAAASUVORK5CYII=',
        'base64',
      ),
    );
    const submitted: Job[] = [];
    f.gateway.submit = async (job) => {
      f.gateway.posts++;
      submitted.push(job);
      if (job.operation === 'segment')
        throw new TripoError('NETWORK_ERROR', 'Controlled lost segmentation receipt', 'unknown');
      return { remote_ids: { project_id: 'generated-project', operator_id: 'generated-model' } };
    };
    f.gateway.status = async () => ({
      state: 'succeeded',
      progress: 100,
      artifacts: [{ artifact_id: 'model', kind: 'model', format: 'glb', index: 0 }],
    });
    const app = { service: f.service } as unknown as Application;
    const create = () => processingPlan('smartsegment', file, { hint: 'head and body' });
    const flags = { requestId: 'hint-receipt', timeout: 1, download: false };
    const first = await executePlan(app, create(), flags);
    assert.equal(first.status, 'outcome_unknown');
    assert.deepEqual(
      submitted.map((job) => job.operation),
      ['model', 'segment'],
    );
    assert.equal(submitted[1]!.input.project_id, 'generated-project');
    assert.equal(submitted[1]!.input.expected_operator_id, 'generated-model');
    const again = await executePlan(app, create(), flags);
    assert.equal(again.task_id, first.task_id);
    assert.equal(again.status, 'outcome_unknown');
    assert.equal(f.gateway.posts, 2);
    await assert.rejects(
      executePlan(app, processingPlan('smartsegment', file, { hint: 'different parts' }), flags),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    assert.equal(f.gateway.posts, 2);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
