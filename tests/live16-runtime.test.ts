/** 自动骨架决策按原输入持久化，重启或建议变化不能产生不同的收费链。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, quote } from './helpers.ts';
import { makePlan, generationPlan, processingPlan } from '../cli/compat/planning.ts';
import { executePlan, type Application } from '../cli/compat/runtime.ts';
import { fullToolPlan } from '../cli/compat/full-tools.ts';
import { StudioClient } from '../studio/api/client.ts';

async function chainFixture(recommended: string) {
  const f = await fixture();
  const source = f.jobs.prepare(
    'test-account',
    'source',
    'model',
    { mode: 'text', prompt: 'creature' },
    quote,
  );
  f.jobs.update(source.job_id, 'submitting');
  f.jobs.update(source.job_id, 'submitted', {
    remote_ids: { project_id: 'project', operator_id: 'source-op' },
  });
  f.jobs.update(source.job_id, 'succeeded');
  const requests: Record<string, unknown>[] = [];
  let checks = 0;
  const configure = (current: typeof f) => {
    current.gateway.submit = async (job) => {
      requests.push({ operation: job.operation, ...job.input });
      return {
        remote_ids: {
          project_id: 'project',
          operator_id: `00000000-0000-4000-8000-${String(requests.length).padStart(12, '0')}`,
        },
      };
    };
    current.gateway.status = async () => ({ state: 'succeeded', progress: 100, artifacts: [] });
    return {
      service: current.service,
      studio: {
        client: new StudioClient(current.service.credentials, async () => {
          checks++;
          return Response.json({ code: 0, data: { riggable: true, rig_type: recommended } });
        }),
      },
      close: () => current.jobs.close(),
    } as unknown as Application;
  };
  return {
    f,
    source,
    requests,
    configure,
    setRecommendation: (v: string) => {
      recommended = v;
    },
    checks: () => checks,
  };
}

test('rig-check changes body and generic motion group and persists that choice across restart', async () => {
  const t = await chainFixture('quadruped');
  let app = t.configure(t.f);
  const flags = { download: false, requestId: 'animal' };
  const plan = () =>
    makePlan([t.source.job_id], { then: 'rig-check,rig,retarget:animations=["preset:idle","preset:walk"]' });
  try {
    const result = await executePlan(app, plan(), flags);
    assert.equal(result.status, 'success');
    assert.deepEqual(
      t.requests.map((x) => x.operation),
      ['rig', 'animate', 'export'],
    );
    assert.equal(t.requests[0]?.rig_type, 'quadruped');
    assert.equal(t.requests[1]?.animation, 'preset:quadruped:walk');
    app.close();
    app = t.configure(await fixture(t.f.dir));
    t.setRecommendation('avian');
    await executePlan(app, plan(), flags);
    assert.equal(t.checks(), 1);
    assert.equal(t.requests.length, 3);
    await assert.rejects(
      executePlan(app, makePlan([t.source.job_id], { then: 'rig-check,rig,retarget:preset:run' }), flags),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    assert.equal(t.requests.length, 3);
  } finally {
    app.close();
  }
});

test('avian recommendation keeps the rig and never submits the following animation or export', async () => {
  const t = await chainFixture('avian');
  const app = t.configure(t.f);
  try {
    const result = await executePlan(
      app,
      makePlan([t.source.job_id], { then: 'rig-check,rig,retarget:preset:walk' }),
      { download: false, requestId: 'bird' },
    );
    assert.equal(result.status, 'success');
    assert.deepEqual(
      t.requests.map((x) => x.operation),
      ['rig'],
    );
    assert.equal(t.requests[0]?.rig_type, 'avian');
    assert.match(JSON.stringify(result.warnings), /skip retarget/);
  } finally {
    app.close();
  }
});

test('explicit rig type overrides a different live recommendation', async () => {
  const t = await chainFixture('aquatic');
  const app = t.configure(t.f);
  try {
    await executePlan(
      app,
      makePlan([t.source.job_id], { then: 'rig-check,rig:biped,retarget:preset:walk' }),
      { download: false, requestId: 'explicit' },
    );
    assert.equal(t.requests[0]?.rig_type, 'biped');
    assert.equal(t.requests[1]?.animation, 'preset:biped:walk');
  } finally {
    app.close();
  }
});

test('public convert requires format while internal generation orientation can use GLB', () => {
  assert.throws(() => makePlan(['cube'], { then: 'convert' }), { code: 'INVALID_INPUT' });
  assert.throws(() => fullToolPlan('ai_modeling_convert', { input: 'source' }), { code: 'INVALID_INPUT' });
  assert.equal(
    generationPlan('text-to-model', ['cube'], { exportOrientation: '+y' }).steps.at(-1)?.parameters.format,
    'glb',
  );
  assert.equal(
    processingPlan('rig-check', 'source', { param: { model: 'v2.5' } }).steps[0]?.parameters.model_version,
    'v2.5-20260210',
  );
  assert.throws(() => processingPlan('rig-check', 'source', { param: { unknown: 1 } }));
});

test('configured output roots isolate tasks and saved downloads override later directory defaults', async () => {
  const { mkdtemp, mkdir, writeFile, rm, realpath } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { outputDirectory } = await import('../cli/compat/output-directory.ts');
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'ai-modeling-output-policy-')));
  const cwd = process.cwd(),
    data = process.env.AI_MODELING_DATA_DIR;
  try {
    process.env.AI_MODELING_DATA_DIR = path.join(dir, 'settings');
    await mkdir(process.env.AI_MODELING_DATA_DIR);
    await writeFile(
      path.join(process.env.AI_MODELING_DATA_DIR, 'settings.json'),
      JSON.stringify({ default_output_dir: path.join(dir, 'global') }),
    );
    await mkdir(path.join(dir, '.ai-modeling'));
    await mkdir(path.join(dir, 'nested'));
    process.chdir(path.join(dir, 'nested'));
    const a = { job_id: '12345678-a', artifacts: [] },
      b = { job_id: '87654321-b', artifacts: [] };
    assert.equal(outputDirectory(a, {}), path.join(dir, 'global/ai-modeling-out/task-12345678'));
    await writeFile(path.join(dir, '.ai-modeling/context.json'), JSON.stringify({ output_dir: 'assets' }));
    assert.equal(outputDirectory(a, {}), path.join(dir, 'assets/ai-modeling-out/task-12345678'));
    assert.notEqual(outputDirectory(a, {}), outputDirectory(b, {}));
    const saved = { ...a, artifacts: [{ local_path: path.join(dir, 'original/image.png') }] };
    assert.equal(outputDirectory(saved, {}), path.join(dir, 'original'));
    assert.equal(outputDirectory(saved, { out: './explicit' }), path.join(dir, 'nested/explicit'));
    assert.equal(
      outputDirectory(saved, { out: './root', outIsRoot: true }),
      path.join(dir, 'nested/root/ai-modeling-out/task-12345678'),
    );
    assert.equal(
      outputDirectory(a, { name: '../../asset' }).startsWith(path.join(dir, 'assets/ai-modeling-out')),
      true,
    );
  } finally {
    process.chdir(cwd);
    if (data === undefined) delete process.env.AI_MODELING_DATA_DIR;
    else process.env.AI_MODELING_DATA_DIR = data;
    await rm(dir, { recursive: true, force: true });
  }
});

test('negative rig verdict stops the chain while preserving and downloading the successful generated model', async () => {
  const f = await fixture();
  let submissions = 0,
    downloads = 0;
  f.gateway.submit = async () => {
    submissions++;
    return { remote_ids: { project_id: 'project', operator_id: 'source-op' } };
  };
  f.gateway.status = async () => ({
    state: 'succeeded',
    progress: 100,
    artifacts: [{ artifact_id: 'model', kind: 'model', format: 'glb', index: 0 }],
  });
  f.service.download = async (_job, _artifact, destination) => {
    downloads++;
    return { local_path: destination };
  };
  const app = {
    service: f.service,
    studio: {
      client: new StudioClient(f.service.credentials, async () =>
        Response.json({ code: 0, data: { riggable: false, check_success: true } }),
      ),
    },
    close: () => f.jobs.close(),
  } as unknown as Application;
  try {
    const result = await executePlan(app, makePlan(['an unriggable shape'], { then: 'rig-check,rig' }), {
      requestId: 'stop-keep-model',
      out: f.dir + '/kept',
    });
    assert.equal(result.status, 'success');
    assert.equal(result.riggable, false);
    assert.equal(result.stopped_early, true);
    assert.equal(submissions, 2);
    assert.equal(downloads, 1);
    assert.equal(
      result.model_file,
      `${f.dir}/kept/ai-modeling-out/an-unriggable-shape-${String(result.task_id).slice(0, 8)}/model.glb`,
    );
  } finally {
    app.close();
  }
});
