/** full MCP 的兼容字段按官方处理；普通 CLI 参数与真正生成提示词不得被一并吞掉。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fixture, quote } from './helpers.ts';
import { callTool, type StudioReads } from '../cli/commands.ts';
import { fullTools, fullToolPlan } from '../cli/compat/full-tools.ts';
import { generationPlan } from '../cli/compat/planning.ts';
import { object, array } from '../studio/contracts/errors.ts';
import { JobStore } from '../cli/storage/jobs.ts';
import { resolveJob, type Application } from '../cli/compat/runtime.ts';

const exec = promisify(execFile);

test('full MCP image and multiview dry runs ignore the compatibility prompt while preserving image slots', async () => {
  const f = await fixture();
  try {
    const studio: StudioReads = {
      assets: async () => ({}),
      client: {
        request: async () => {
          throw new Error('Dry-run must not request Studio');
        },
      },
    };
    const tools = fullTools(f.service, studio);
    for (const [name, views, expected] of [
      ['ai_modeling_image_to_3d', { input: 'https://example.invalid/front.png' }, undefined],
      [
        'ai_modeling_multiview_to_3d',
        { front: 'https://example.invalid/front.png', back: 'https://example.invalid/back.png' },
        ['https://example.invalid/front.png', null, 'https://example.invalid/back.png', null],
      ],
    ] as const) {
      const input = { ...views, model: 'tripo-v3.1', dry_run: true, prompt: 'make it red' };
      const response = await callTool(tools, name, input);
      assert.notEqual(response.isError, true);
      const result = object(response.structuredContent.result);
      assert.equal(result.valid, true);
      const parameters = object(object(array(result.steps)[0]).parameters);
      assert.equal(parameters.prompt, undefined);
      assert.equal(parameters.model_version, 'v3.1-20260211');
      if (expected) assert.deepEqual(parameters.image_paths, expected);
      else assert.equal(parameters.image_path, views.input);
      const baseline = await callTool(tools, name, { ...input, prompt: undefined });
      assert.deepEqual(response.structuredContent, baseline.structuredContent);
      assert.equal(input.prompt, 'make it red');
      for (const prompt of [123, 'x'.repeat(1025)]) {
        const invalid = await callTool(tools, name, { ...input, prompt });
        assert.equal(invalid.isError, true);
        assert.equal(object(invalid.structuredContent.error).code, 'INVALID_INPUT');
      }
    }
    assert.equal(f.gateway.posts, 0);
    assert.equal(f.jobs.list('test-account').length, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('full MCP compatibility stripping does not change CLI prompt policy or real text/image-edit prompts', () => {
  for (const [name, inputs] of [
    ['image-to-model', ['front.png']],
    ['multiview-to-model', ['front.png', 'back.png']],
  ] as const)
    assert.throws(
      () => generationPlan(name, [...inputs], { model: 'tripo-v3.1', param: { prompt: 'red' } }),
      /prompt requires text-to-model mode/,
    );
  assert.equal(
    fullToolPlan('ai_modeling_text_to_3d', { prompt: 'a red cube', model: 'tripo-v3.1' }).steps[0]?.parameters
      .prompt,
    'a red cube',
  );
  assert.equal(
    fullToolPlan('ai_modeling_generate_image', {
      input: 'front.png',
      prompt: 'make the shirt red',
      model: 'banana2',
    }).steps[0]?.parameters.prompt,
    'make the shirt red',
  );
});

test('quiet interactive output still delivers final task results and JSON stays a single line', async () => {
  const script = `
    import { printResult } from './cli/compat/presentation.ts';
    Object.defineProperty(process.stdout, 'isTTY', { value: true });
    process.argv.push('--quiet');
    printResult({ task_id: 'fixture-task', status: 'success', model_file: '/chosen/model.glb' });
  `;
  const human = await exec(process.execPath, ['--input-type=module', '-e', script]);
  assert.match(human.stdout, /success\s+fixture-task/);
  assert.match(human.stdout, /\/chosen\/model\.glb/);
  assert.equal(human.stderr, '');
  const json = await exec(process.execPath, [
    '--input-type=module',
    '-e',
    `process.argv.push('--json');${script}`,
  ]);
  assert.equal(json.stdout.trim().split('\n').length, 1);
  assert.equal(JSON.parse(json.stdout).model_file, '/chosen/model.glb');
  assert.equal(json.stderr, '');
});

test('same-millisecond history follows insertion order across restart and hides composite children', async () => {
  const f = await fixture();
  let jobs = f.jobs;
  try {
    const old = jobs.prepare('test-account', 'history-old', 'image', {}, quote);
    const root = jobs.prepare(
      'test-account',
      'history-root',
      'image_process',
      { _multiview_edit: { version: 1 } },
      quote,
    );
    const child = jobs.prepare('test-account', 'history-child', 'image', {}, quote);
    const failed = jobs.prepare('test-account', 'history-failed', 'image', {}, quote);
    for (const job of [old, root, child]) jobs.update(job.job_id, 'succeeded');
    jobs.update(failed.job_id, 'failed');
    jobs.prepare('another-account', 'history-other', 'image', {}, quote);
    const file = path.join(f.dir, 'jobs.sqlite');
    const db = new DatabaseSync(file);
    try {
      db.exec('BEGIN; PRAGMA defer_foreign_keys=ON');
      // 固定反向 UUID 和时间，必然复现旧按 UUID 排序的错误，而不依赖时钟或随机数。
      for (const [job, id] of [
        [old, 'ffffffff-ffff-4fff-8fff-ffffffffffff'],
        [root, '11111111-1111-4111-8111-111111111111'],
        [child, '22222222-2222-4222-8222-222222222222'],
        [failed, '33333333-3333-4333-8333-333333333333'],
      ] as const) {
        db.prepare('UPDATE jobs SET job_id=?,created_at=? WHERE job_id=?').run(
          id,
          '2026-11-14T00:00:00.000Z',
          job.job_id,
        );
        db.prepare('UPDATE job_events SET job_id=? WHERE job_id=?').run(id, job.job_id);
        job.job_id = id;
      }
      db.exec('COMMIT');
    } finally {
      db.close();
    }
    jobs.linkStep('test-account', 'history-run', 0, root.job_id);
    jobs.linkStep('test-account', 'history-run', 1, child.job_id);
    const verify = (): void => {
      const app = { service: { jobs, accountRef: () => 'test-account' } } as Application;
      assert.deepEqual(
        jobs.list('test-account', 10).map((job) => job.job_id),
        [failed.job_id, child.job_id, root.job_id, old.job_id],
      );
      assert.equal(jobs.list('test-account', 1, 1, 'succeeded')[0]!.job_id, root.job_id);
      assert.equal(resolveJob(app, '@last').job_id, root.job_id);
      assert.equal(resolveJob(app, '@2').job_id, old.job_id);
      assert.equal(resolveJob(app, '@last:any').job_id, failed.job_id);
    };
    verify();
    jobs.close();
    jobs = new JobStore(file);
    verify();
  } finally {
    jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('inactive valid texture versions keep bare generation identical but active or invalid requests still reject', () => {
  for (const [name, inputs] of [
    ['text-to-model', ['a cube']],
    ['image-to-model', ['front.png']],
    ['multiview-to-model', ['front.png', 'back.png']],
  ] as const) {
    const bare = generationPlan(name, [...inputs], { model: 'tripo-v3.1', param: { texture: false } });
    for (const texture_version of [
      'v3.5',
      'v3.5-20260815',
      'v3.0',
      'v3.0-20250812',
      'v2.5',
      'v2.5-20250123',
    ]) {
      const plan = generationPlan(name, [...inputs], {
        model: 'tripo-v3.1',
        param: { texture: false, texture_version },
      });
      assert.equal(plan.steps.length, 1);
      assert.deepEqual(plan.steps[0]!.parameters, bare.steps[0]!.parameters);
      assert.equal(plan.steps[0]!.requireTextureModel, undefined);
      assert.ok(plan.warnings.some((warning) => warning.includes('has no effect with texture=false')));
    }
    for (const param of [
      { texture: false, texture_version: 'v9' },
      { texture: false, texture_version: 'v3.0', pbr: true },
      { texture: false, texture_version: 'v2.5', texture_quality: 'fast' },
      { texture: false, texture_version: 'v3.5', texture_quality: 'unsupported-quality' },
    ])
      assert.throws(() => generationPlan(name, [...inputs], { model: 'tripo-v3.1', param }));
  }
  const parts = generationPlan('text-to-model', ['a cube'], {
    model: 'tripo-v3.1',
    param: { generate_parts: true, texture_version: 'v3.0' },
  });
  assert.equal(parts.steps.length, 1);
  assert.equal(parts.steps[0]!.parameters.texture, false);
  assert.equal(parts.steps[0]!.requireTextureModel, undefined);
});
