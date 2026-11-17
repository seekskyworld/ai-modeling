/** 网页保骨骼导出允许零动作；不能把空 retarget 列表当成未绑定，也不能伪造动作。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { normalize } from '../studio/contracts/schemas.ts';
import { Operations } from '../studio/api/operations.ts';
import { resolveExportAnimations } from '../studio/api/discovery.ts';
import type { StudioClient } from '../studio/api/client.ts';
import { fixture, quote } from './helpers.ts';
import { applyDefaultExportAnimations } from '../cli/compat/export-animation-default.ts';
import { processingPlan } from '../cli/compat/planning.ts';
import { executePlan, type Application } from '../cli/compat/runtime.ts';
import type { Job } from '../studio/contracts/types.ts';

test('confirmed rigged source exports a skeleton without inventing motion clips', async () => {
  const f = await fixture();
  const reads: string[] = [];
  const client = {
    request: async (method: string) => {
      reads.push(method);
      return {
        id: 'project',
        is_owner: true,
        operator: { operator_id: 'rig', is_rigged: true, retarget: [] },
      };
    },
  } as unknown as StudioClient;
  try {
    const parameters = normalize('export', {
      project_id: 'project',
      expected_operator_id: 'rig',
      with_animation: true,
      animations: [],
    });
    const job = f.jobs.prepare('test-account', 'skeleton-export', 'export', parameters, quote);
    const built = await new Operations(client, []).build(job);
    assert.equal(built.route, '/v2/studio/operation/export');
    assert.equal(built.body.with_animation, true);
    assert.deepEqual(built.body.animations, []);
    assert.deepEqual(reads, ['GET']);
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('skeleton export rejects unconfirmed rig state and changed source before submission', async () => {
  const f = await fixture();
  try {
    const job = f.jobs.prepare(
      'test-account',
      'unconfirmed-skeleton',
      'export',
      normalize('export', { project_id: 'project', expected_operator_id: 'rig', with_animation: true }),
      quote,
    );
    for (const is_rigged of [false, undefined]) {
      const client = {
        request: async () => ({ id: 'project', is_owner: true, operator: { operator_id: 'rig', is_rigged } }),
      } as unknown as StudioClient;
      await assert.rejects(new Operations(client, []).build(job), { code: 'RIG_NOT_READY' });
    }
    const client = {
      request: async () => ({
        id: 'project',
        is_owner: true,
        operator: { operator_id: 'changed', is_rigged: true },
      }),
    } as unknown as StudioClient;
    await assert.rejects(new Operations(client, []).build(job), { code: 'PROJECT_CHANGED' });
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('automatic explicit animation selection can preserve a confirmed skeleton with zero clips', async () => {
  let rigged: boolean | undefined = true;
  const client = {
    request: async () => ({ id: 'project', is_owner: true, operator: { is_rigged: rigged, retarget: [] } }),
  } as unknown as StudioClient;
  assert.deepEqual(await resolveExportAnimations(client, 'project'), []);
  await assert.rejects(resolveExportAnimations(client, 'project', ['foreign']), {
    code: 'ANIMATION_NOT_READY',
  });
  for (rigged of [false, undefined])
    await assert.rejects(resolveExportAnimations(client, 'project'), { code: 'ANIMATION_NOT_READY' });
});

test('default preservation uses explicit rig metadata and source motion selection', async () => {
  const first = '11111111-1111-4111-8111-111111111111',
    second = '22222222-2222-4222-8222-222222222222';
  let rigged: boolean | undefined = true;
  const client = {
    request: async () => ({
      id: 'project',
      is_owner: true,
      operator: {
        operator_id: 'base',
        is_rigged: rigged,
        retarget: rigged
          ? [first, second].map((operator_id) => ({ operator_id, status: 'success', model_url: 'model.glb' }))
          : [],
      },
    }),
  } as unknown as StudioClient;
  const parameters = normalize('export', { project_id: 'project' });
  const motion = { operation: 'animate', input: {}, remote_ids: { operator_id: first } } satisfies Pick<
    Job,
    'operation' | 'input' | 'remote_ids'
  >;
  assert.deepEqual((await applyDefaultExportAnimations(client, parameters, 'base', motion)).animations, [
    first,
  ]);
  const staticSource = {
    operation: 'export',
    input: { with_animation: false, animations: [] },
    remote_ids: {},
  } satisfies Pick<Job, 'operation' | 'input' | 'remote_ids'>;
  const keptStatic = await applyDefaultExportAnimations(client, parameters, 'base', staticSource);
  assert.equal(keptStatic.with_animation, false);
  assert.deepEqual(keptStatic.animations, []);
  await assert.rejects(applyDefaultExportAnimations(client, parameters, 'base', undefined, undefined, true), {
    code: 'STUDIO_CAPABILITY_UNAVAILABLE',
  });
  await assert.rejects(applyDefaultExportAnimations(client, { ...parameters, bake: false }, 'base'), {
    code: 'STUDIO_CAPABILITY_UNAVAILABLE',
  });
  await assert.rejects(applyDefaultExportAnimations(client, parameters, 'changed'), {
    code: 'PROJECT_CHANGED',
  });
  rigged = false;
  const staticModel = await applyDefaultExportAnimations(client, parameters, 'base');
  assert.equal(staticModel.with_animation, false);
  assert.deepEqual(staticModel.animations, []);
  await assert.rejects(
    applyDefaultExportAnimations(client, parameters, 'base', {
      ...staticSource,
      input: { with_animation: true, animations: [] },
    }),
    { code: 'ANIMATION_SOURCE_UNVERIFIED' },
  );
  rigged = undefined;
  await assert.rejects(applyDefaultExportAnimations(client, parameters, 'base'), {
    code: 'ANIMATION_SOURCE_UNVERIFIED',
  });
});

test('default skeleton selection persists across retries without new motions or requests', async () => {
  const f = await fixture();
  let reads = 0;
  const client = {
    request: async () => {
      reads++;
      return {
        id: 'project',
        is_owner: true,
        operator: { operator_id: 'base', is_rigged: true, retarget: [] },
      };
    },
  } as unknown as StudioClient;
  const app = { service: f.service, studio: { client } } as Application;
  try {
    const plan = processingPlan('convert', 'project', { format: 'glb' });
    assert.ok(plan.steps[0]!.exportDefaults?.includes('with_animation'));
    const flags = { requestId: 'default-skeleton', wait: false, download: false };
    const first = await executePlan(app, plan, flags);
    const job = f.jobs.get(String(first.task_id));
    assert.equal(job.input.with_animation, true);
    assert.deepEqual(job.input.animations, []);
    assert.equal(job.input.expected_operator_id, 'base');
    assert.equal(job.input.texture_size, 4096);
    assert.equal(job.input.animate_in_place, false);
    assert.equal(job.input.export_orientation, '+x');
    const before = reads;
    const resumed = await executePlan(app, plan, flags);
    assert.equal(resumed.task_id, first.task_id);
    assert.equal(reads, before);
    assert.equal(f.gateway.posts, 1);
    await assert.rejects(
      executePlan(
        app,
        processingPlan('convert', 'project', { format: 'glb', param: { with_animation: false } }),
        flags,
      ),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    assert.equal(f.gateway.posts, 1);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('legacy static exports and explicitly static conversion keep their original intent', async () => {
  const f = await fixture();
  const client = {
    request: async () => {
      throw new Error('Legacy selection must not be rediscovered.');
    },
  } as unknown as StudioClient;
  const app = { service: f.service, studio: { client } } as Application;
  try {
    const plan = processingPlan('convert', 'project', { format: 'glb' });
    const job = f.jobs.prepare(
      'test-account',
      'legacy-static-0',
      'export',
      { ...plan.steps[0]!.parameters, project_id: 'project' },
      quote,
    );
    f.jobs.claim(job.job_id);
    f.jobs.update(job.job_id, 'submitted', { remote_ids: { project_id: 'project' } });
    const replay = await executePlan(app, plan, { requestId: 'legacy-static', wait: false, download: false });
    assert.equal(replay.task_id, job.job_id);
    assert.equal(f.jobs.get(job.job_id).input.with_animation, false);
    assert.equal(f.jobs.get(job.job_id).input.texture_size, 2048);
    assert.equal(f.jobs.get(job.job_id).input.animate_in_place, true);
    assert.equal(f.jobs.get(job.job_id).input.export_orientation, '-y');
    assert.equal(f.gateway.posts, 0);
    const explicit = processingPlan('convert', 'project', {
      format: 'glb',
      param: { with_animation: false },
    });
    assert.equal(explicit.steps[0]!.exportDefaults?.includes('with_animation'), false);
    const imported = processingPlan('convert', 'source.glb', { format: 'glb' });
    assert.match(imported.warnings.join(' '), /not guaranteed for arbitrary files or rigs/);
    const staticParts = processingPlan('convert', 'project', {
      format: 'glb',
      param: { part_names: ['head'] },
    });
    assert.equal(staticParts.steps[0]!.requireStaticExportSource, true);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('explicit sources cannot change identity while reusing a new default export request', async () => {
  const f = await fixture();
  const client = {
    request: async () => ({
      id: 'project',
      is_owner: true,
      operator: { operator_id: 'base', is_rigged: false, retarget: [] },
    }),
  } as unknown as StudioClient;
  const app = { service: f.service, studio: { client } } as Application;
  try {
    const sources = ['first', 'second'].map((request) => {
      const source = f.jobs.prepare(
        'test-account',
        request,
        'model',
        { mode: 'text', prompt: request },
        quote,
      );
      f.jobs.claim(source.job_id);
      f.jobs.update(source.job_id, 'submitted', {
        remote_ids: { project_id: 'project', operator_id: 'base' },
      });
      return f.jobs.update(source.job_id, 'succeeded');
    });
    const plan = processingPlan('convert', sources[0]!.job_id, { format: 'glb' });
    const flags = { requestId: 'frozen-named-default', wait: false, download: false };
    await executePlan(app, plan, flags);
    const changed = processingPlan('convert', sources[1]!.job_id, { format: 'glb' });
    await assert.rejects(executePlan(app, changed, flags), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.equal(f.gateway.posts, 1);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
