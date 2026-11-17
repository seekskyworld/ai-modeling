/** 审计发现的真实误行为回归：校验与执行一致、错误隔离、预检停止、图片角色保持。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generation, makePlan, processingPlan } from '../cli/compat/planning.ts';
import { pipedTask } from '../cli/compat/input.ts';
import { executeCandidates } from '../cli/compat/run-plan.ts';
import {
  executePlan,
  queryTasks,
  taskResult,
  taskExitCode,
  type Application,
} from '../cli/compat/runtime.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import { Operations } from '../studio/api/operations.ts';
import { StudioClient } from '../studio/api/client.ts';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { TripoError } from '../studio/contracts/errors.ts';
import { fixture, quote } from './helpers.ts';
import type { Job } from '../studio/contracts/types.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { decode } from '@msgpack/msgpack';
import { modificationBytes } from '../studio/api/advanced-operations.ts';
const exec = promisify(execFile);

test('invalid candidate dry-runs and missing files fail before authentication', async () => {
  for (const args of [
    ['make', 'robot', '-n', '0'],
    ['make', 'robot', '-n', '5'],
    ['make', 'robot', '-n', '2', '--then', 'texture'],
    ['generate', 'image-to-model', '/missing/audit.png'],
  ]) {
    await assert.rejects(
      exec(process.execPath, ['cli/main.ts', ...args, '--dry-run', '--json'], {
        env: { ...process.env, AI_MODELING_PROFILE: 'offline-no-account', HTTPS_PROXY: 'http://127.0.0.1:1' },
      }),
      (error) => {
        assert.equal((error as { code: number }).code, 2);
        assert.equal(JSON.parse((error as { stdout: string }).stdout).code, 'INVALID_INPUT');
        return true;
      },
    );
  }
});

test('NDJSON keeps the last task and rejects a later failure instead of reusing earlier work', () => {
  assert.equal(pipedTask('{"task_id":"first"}\n{"progress":10}\n{"task_id":"last"}\n'), 'last');
  assert.equal(pipedTask('task_example'), 'task_example');
  assert.throws(() => pipedTask('{"task_id":"first"}\n{"error":"failed","code":"RATE_LIMITED"}'), {
    code: 'RATE_LIMITED',
  });
});

test('official aliases, linked options and scenario deliverables form executable plans', () => {
  assert.equal(
    generation('text-to-model', ['robot'], { model: 'P2.0 Preview' }).parameters.model_version,
    'Nexus-v2.0-20260801',
  );
  assert.equal(
    processingPlan('rig', '@robot', { model: 'rig-v2.0' }).steps[0]!.parameters.model_version,
    'v2.5-20260210',
  );
  assert.equal(
    generation('text-to-model', ['robot'], { param: { texture: false, pbr: true } }).parameters.texture,
    true,
  );
  const parts = generation('text-to-model', ['robot'], {
    model: 'H3.1',
    param: { generate_parts: true, texture: true, quad: true },
  });
  for (const key of ['texture', 'pbr', 'quad']) assert.equal(parts.parameters[key], false);
  const p2 = generation('text-to-model', ['robot'], { param: { generate_parts: true } });
  assert.equal(p2.parameters.texture, true);
  assert.equal(p2.parameters.generate_parts, false);
  assert.ok(p2.warnings?.some((w) => w.includes('generate_parts')));
  assert.equal(makePlan(['robot'], { for: 'print' }).steps.at(-1)!.parameters.flatten_bottom, true);
  assert.equal(makePlan(['robot'], { for: 'ar-web' }).downloadGeneration, true);
  for (const scenario of ['print', 'anim', 'ar-web'])
    assert.equal(makePlan(['/tmp/character.glb'], { for: scenario }).steps[0]!.operation, 'import_model');
  const anim = makePlan(['robot'], { for: 'anim' });
  assert.equal(anim.steps[anim.generationSteps!]!.preflight, 'rig');
  assert.deepEqual(
    anim.steps.filter((s) => s.operation === 'animate').map((s) => s.parameters.animation),
    ['preset:biped:idle', 'preset:biped:walk'],
  );
});

test('template editing omits prompt and preserves original + reference roles in the website request', async () => {
  const client = new StudioClient(
    new MemoryCredentials({ accountRef: 'test', cookie: 'fixture', deviceId: 'test', importedAt: '' }),
    async (url, init) => {
      const request = JSON.parse(String(init.body ?? '{}'));
      const data = url.endsWith('available_templates')
        ? { templates: [{ title: 'T Pose', template_id: 'live-template' }] }
        : {
            asset_id: request.asset_id,
            status: 'success',
            output: { data: [{ image_audit_result: 'pass', bucket: 'fixture', key: request.asset_id }] },
          };
      return new Response(JSON.stringify({ code: 0, data }), { status: 200 });
    },
  );
  const input = normalize('image', {
    image_asset: { asset_id: 'base' },
    image_assets: [{ asset_id: 'reference' }],
    template_name: 't_pose',
    sketch_to_render: true,
  });
  const submission = await new Operations(client, []).build({ operation: 'image', input } as Job);
  assert.equal(submission.body.prompt, '');
  assert.equal(submission.body.template_id, 'live-template');
  assert.equal(submission.body.sketch_to_render, true);
  assert.equal((submission.body.image as { key: string }).key, 'base');
  assert.equal((submission.body.images as { key: string }[])[0]!.key, 'reference');
  assert.throws(() => normalize('image', { sketch_to_render: true, prompt: 'robot' }));
});

test('candidate failure preserves successful sibling and distinct seeds', async () => {
  const f = await fixture();
  const seen: number[] = [];
  f.gateway.submit = async (job) => {
    if (job.operation === 'model') {
      seen.push(Number(job.input.model_seed));
      if (seen.length === 2)
        throw new TripoError('CONTENT_AUDIT_REJECTED', 'test rejection', 'not_submitted');
    }
    return { remote_ids: { project_id: 'model', operator_id: 'operator' } };
  };
  const app = {
    service: f.service,
    studio: f.gateway,
    close: () => f.jobs.close(),
  } as unknown as Application;
  try {
    const result = await executeCandidates(app, makePlan(['robot'], {}), {
      candidates: 2,
      requestId: 'candidate-regression',
      download: false,
    });
    assert.equal(result.status, 'success');
    assert.equal(result.partial, true);
    assert.equal(new Set(seen).size, 2);
    assert.equal((result.candidates as unknown[]).length, 2);
  } finally {
    app.close();
  }
});

test('no-wait candidates all reach remote submission and a resumed request keeps both seeds', async () => {
  const f = await fixture();
  const seeds: number[] = [];
  f.gateway.submit = async (job) => {
    seeds.push(Number(job.input.model_seed));
    await delay(30);
    return { remote_ids: { project_id: `project-${seeds.length}`, operator_id: 'operator' } };
  };
  const app = {
    service: f.service,
    studio: f.gateway,
    close: () => f.jobs.close(),
  } as unknown as Application;
  try {
    const flags = { candidates: 2, requestId: 'no-wait-regression', wait: false, download: false };
    const result = await executeCandidates(app, makePlan(['robot'], { param: { texture: false } }), flags);
    assert.equal(result.status, 'queued');
    assert.equal(seeds.length, 2);
    assert.equal(new Set(seeds).size, 2);
    await executeCandidates(app, makePlan(['robot'], { param: { texture: false } }), flags);
    assert.equal(seeds.length, 2);
  } finally {
    app.close();
  }
});

test('manual segmentation encodes one binary label per face rather than a MessagePack array', () => {
  const data = decode(
    modificationBytes({
      part_indices: { mesh: [0, 0, 1, 255] },
      part_indices_name: { 0: 'body', 1: 'head' },
    }),
  ) as { part_indices: Record<string, Uint8Array> };
  assert.ok(data.part_indices.mesh instanceof Uint8Array);
  assert.deepEqual([...data.part_indices.mesh!], [0, 0, 1, 255]);
  assert.throws(() =>
    normalize('modification', {
      project_id: 'project',
      part_indices: { mesh: [256] },
      part_indices_name: {},
    }),
  );
});

test('mixed task queries retain valid tasks and preflight rejection stops all downstream submissions', async () => {
  const f = await fixture();
  const job = f.jobs.prepare('test-account', 'source', 'model', { mode: 'text', prompt: 'fixture' }, quote);
  f.jobs.update(job.job_id, 'submitting');
  f.jobs.update(job.job_id, 'submitted', { remote_ids: { project_id: 'project', operator_id: 'operator' } });
  f.jobs.update(job.job_id, 'succeeded', { progress: 100 });
  const client = new StudioClient(
    new MemoryCredentials({ accountRef: 'test', cookie: 'fixture', deviceId: 'test', importedAt: '' }),
    async () => new Response(JSON.stringify({ code: 0, data: { riggable: false } }), { status: 200 }),
  );
  const app = {
    service: f.service,
    studio: { client },
    close: () => f.jobs.close(),
  } as unknown as Application;
  try {
    const tasks = await queryTasks(app, [job.job_id, 'missing']);
    assert.equal((tasks.tasks as unknown[]).length, 1);
    assert.deepEqual(tasks.missed, ['missing']);
    const result = await executePlan(app, makePlan([job.job_id], { then: 'check,rig,animate:preset:walk' }), {
      download: false,
    });
    assert.equal(result.status, 'success');
    assert.equal(result.riggable, false);
    assert.equal(result.stopped_early, true);
    assert.equal(f.gateway.posts, 0);
    assert.equal(taskExitCode(result), 0);
    const timeout = taskResult({ state: 'running', wait_timed_out: true });
    assert.equal(timeout.wait_timed_out, true);
    assert.equal(taskExitCode(timeout), 6);
  } finally {
    app.close();
  }
});
