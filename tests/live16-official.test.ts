/** live16 复现完整命令与组合语义，防止已接受的显式意图被默认值或拆步控制覆盖。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { generation, generationPlan, makePlan, processingPlan } from '../cli/compat/planning.ts';
import { adaptChainMotion } from '../cli/compat/chain-motion.ts';
import { validatePublicConversion } from '../cli/compat/processing-policy.ts';
import { listMotionPresets } from '../studio/contracts/motion-presets.ts';
import {
  planImageReferences,
  resolveImageReferences,
  type ImageReferenceResolver,
} from '../cli/compat/image-references.ts';
import { TripoError } from '../studio/contracts/errors.ts';
import type { Job } from '../studio/contracts/types.ts';
import { executePlan, downloadTask, type Application } from '../cli/compat/runtime.ts';
import { validatePlanFiles } from '../cli/compat/run-plan.ts';
import { fixture, quote, tinyGlb } from './helpers.ts';
import { checkedRigChain } from '../cli/compat/rig-chain.ts';
import { fullTools } from '../cli/compat/full-tools.ts';
import type { StudioReads } from '../cli/commands.ts';
import { freezePlanReferences } from '../cli/compat/source-policy.ts';
import { StudioClient } from '../studio/api/client.ts';

const exec = promisify(execFile);
const source = '11111111-1111-4111-8111-111111111111';

test('processing -p overrides command defaults and first-class options in the actual CLI', async () => {
  for (const [args, key, expected] of [
    [['mesh', 'decimate', source, '-p', 'bake=false'], 'bake', false],
    [['mesh', 'decimate', source, '--no-bake', '-p', 'bake=true'], 'bake', true],
    [['model', 'convert', source, '--format', 'FBX', '-p', 'format=OBJ'], 'format', 'obj'],
  ] as const) {
    const { stdout } = await exec(process.execPath, ['cli/main.ts', ...args, '--dry-run', '--json']);
    const plan = JSON.parse(stdout);
    assert.equal(plan.valid, true);
    assert.equal(plan.steps[0].parameters[key], expected);
  }
  const uv = processingPlan('uv', source, { bake: true, param: { bake: false } });
  assert.equal(uv.steps[0]?.requireTextureBaking, false);
});

test('processing overrides include model, skeleton, spec and split export controls', () => {
  const rig = processingPlan('rig', source, {
    model: 'v1.0',
    rigType: 'quadruped',
    spec: 'mixamo',
    outFormat: 'fbx',
    param: { model: 'v3.0', rig_type: 'biped', spec: 'unity', out_format: 'glb' },
  });
  assert.equal(rig.steps[0]?.parameters.model_version, 'v3.0-20260909');
  assert.equal(rig.steps[0]?.parameters.rig_type, 'biped');
  assert.equal(rig.steps[0]?.parameters.skeleton_preset, 'unity');
  assert.equal(rig.steps.at(-1)?.parameters.format, 'glb');
  const motion = processingPlan('retarget', source, {
    animation: ['preset:walk'],
    outFormat: 'fbx',
    animateInPlace: true,
    param: { out_format: 'glb', animate_in_place: false },
  });
  assert.equal(motion.steps.at(-1)?.parameters.format, 'glb');
  assert.equal(motion.steps.at(-1)?.parameters.animate_in_place, false);
  const generated = generation('text-to-model', ['a cube'], {
    model: 'H3.1',
    seed: 7,
    param: { model: 'P2', model_seed: 19 },
  });
  assert.equal(generated.parameters.model_version, 'v3.1-20260211');
  assert.equal(generated.parameters.model_seed, 7);
});

test('variadic animation options retain the official list and conflict semantics', () => {
  const overridden = processingPlan('retarget', source, {
    animation: ['preset:walk', 'preset:run'],
    param: { animations: ['preset:idle'], export_with_geometry: false },
  });
  assert.deepEqual(
    overridden.steps.map((step) => step.parameters.animation),
    ['preset:biped:walk', 'preset:biped:run'],
  );
  assert.throws(
    () =>
      processingPlan('retarget', source, {
        animation: ['preset:walk', 'preset:run'],
        param: { animation: 'preset:idle' },
      }),
    { code: 'INVALID_INPUT' },
  );
  assert.throws(
    () =>
      processingPlan('retarget', source, {
        animation: ['preset:walk'],
        param: { animations: ['preset:idle'] },
      }),
    { code: 'INVALID_INPUT' },
  );
});

test('invalid explicit processing models cannot select a different default engine', () => {
  for (const name of ['rig', 'texture', 'segment', 'edit'])
    for (const model of [null, false, 0, '', '   '])
      assert.throws(() => processingPlan(name, source, { param: { model } }), {
        code: 'INVALID_INPUT',
        certainty: 'not_submitted',
      });
  assert.throws(() => makePlan(['a cube'], { then: 'rig:model=null' }), { code: 'INVALID_INPUT' });
});

test('public conversion requires a target without removing internal Studio export defaults', () => {
  for (const supplied of [{}, { format: '' }, { format: 'FBX', param: { format: null } }])
    assert.throws(() => validatePublicConversion(supplied), { code: 'INVALID_INPUT' });
  validatePublicConversion({ param: { format: 'OBJ' } });
  assert.equal(processingPlan('convert', source, {}).steps[0]?.parameters.format, 'glb');
});

test('generic non-biped chain motions choose catalogued body presets without duplicating work', () => {
  const pairs = [
    ['quadruped', 'walk'],
    ['hexapod', 'walk'],
    ['octopod', 'walk'],
    ['aquatic', 'march'],
    ['serpentine', 'march'],
  ];
  for (const [rigType, motion] of pairs) {
    const selected = adaptChainMotion({ animations: ['preset:idle', 'preset:walk'] }, rigType);
    const expected = `preset:${rigType}:${motion}`;
    assert.deepEqual(selected.parameters.animations, [expected]);
    assert.equal(selected.stopBeforeRetarget, false);
    assert.ok(selected.warnings.length);
    const items = listMotionPresets({ rig_type: rigType }).items as { animation: string }[];
    assert.ok(items.some((item) => item.animation === expected));
  }
  for (const rigType of ['avian', 'others'])
    for (const animation of ['preset:walk', 'preset:avian:fly', 'custom-motion-id'])
      assert.equal(adaptChainMotion({ animation }, rigType, true).stopBeforeRetarget, true);
});

test('explicit body or custom motion selections are never replaced by generic recommendations', () => {
  for (const parameters of [
    { animation: 'preset:quadruped:walk' },
    { animations: ['preset:walk', 'preset:quadruped:walk'] },
    { animation: 'custom-motion-id' },
    { animation: 'preset:avian:fly' },
  ]) {
    const selected = adaptChainMotion(parameters, 'avian');
    assert.deepEqual(selected.parameters, parameters);
    assert.equal(selected.stopBeforeRetarget, false);
    assert.deepEqual(selected.warnings, []);
  }
  const generic = { animation: 'preset:walk' };
  assert.deepEqual(adaptChainMotion(generic, undefined).parameters, generic);
  assert.deepEqual(adaptChainMotion(generic, 'biped').parameters, generic);
});

test('composite image references retain order, multiview empty slots and separate edit-base roles', () => {
  assert.equal(planImageReferences(['@single']), undefined);
  assert.equal(planImageReferences(['front.png', 'back.png']), undefined);
  const views = planImageReferences(['@front', null, 'https://example.test/back.png', '@right'])!;
  assert.deepEqual(views.parameters.image_sources, [
    { asset_id: 'cli-reference-0', output_index: 0 },
    null,
    { image_path: 'https://example.test/back.png' },
    { asset_id: 'cli-reference-3', output_index: 0 },
  ]);
  assert.deepEqual(
    views.bindings.map((binding) => [binding.reference, binding.index]),
    [
      ['@front', 0],
      ['@right', 3],
    ],
  );
  const edited = planImageReferences(['@base', '@ref', 'https://example.test/file.png'], true)!;
  assert.deepEqual(edited.parameters.image_asset, { asset_id: 'cli-reference-0', output_index: 0 });
  assert.deepEqual(edited.bindings, [
    { reference: '@base', target: 'image_asset' },
    { reference: '@ref', target: 'image_sources', index: 0 },
  ]);
  assert.equal((edited.parameters.image_sources as unknown[]).length, 2);
});

const imageJob = (reference: string, patch: Partial<Job> = {}): Job =>
  ({
    job_id: reference,
    account_ref: 'account',
    operation: 'image',
    state: 'succeeded',
    remote_ids: { asset_id: `asset-${reference.slice(1)}` },
    ...patch,
  }) as Job;
const completeAsset = (assetId: string): Record<string, unknown> => ({
  asset_id: assetId,
  status: 'success',
  output: { data: [{ image_audit_result: 'pass', bucket: 'fixture', key: assetId }] },
});
const imageResolver = (patch: Partial<ImageReferenceResolver> = {}): ImageReferenceResolver => ({
  accountRef: 'account',
  findJob: (reference) => imageJob(reference),
  refreshJob: async (id) => imageJob(id),
  readAsset: async (id) => completeAsset(id),
  ...patch,
});

test('all composite sources resolve before an immutable parameter result is returned', async () => {
  const plan = planImageReferences(['@same', 'https://example.test/file.png', '@same'])!;
  let assetReads = 0,
    refreshed = 0;
  const resolved = await resolveImageReferences(
    plan.parameters,
    plan.bindings,
    imageResolver({
      findJob: (id) => imageJob(id, { state: 'running' }),
      refreshJob: async (id) => {
        refreshed++;
        return imageJob(id);
      },
      readAsset: async (id) => {
        assetReads++;
        return completeAsset(id);
      },
    }),
  );
  assert.equal(assetReads, 1);
  assert.equal(refreshed, 1);
  assert.deepEqual(resolved.image_sources, [
    { asset_id: 'asset-same', output_index: 0 },
    { image_path: 'https://example.test/file.png' },
    { asset_id: 'asset-same', output_index: 0 },
  ]);
  assert.equal((plan.parameters.image_sources as { asset_id?: string }[])[0]?.asset_id, 'cli-reference-0');
});

test('composite images reject failed, foreign, wrong-type, mismatched and unaudited sources', async () => {
  const plan = planImageReferences(['@one', '@two'])!;
  for (const [patch, code] of [
    [{ findJob: (id: string) => imageJob(id, { account_ref: 'other' }) }, 'ACCOUNT_MISMATCH'],
    [{ findJob: (id: string) => imageJob(id, { operation: 'model' }) }, 'INVALID_INPUT'],
    [
      {
        findJob: (id: string) => imageJob(id, { state: 'failed' }),
        refreshJob: async (id: string) => imageJob(id, { state: 'failed' }),
      },
      'INPUT_NOT_READY',
    ],
    [{ readAsset: async () => completeAsset('different-asset') }, 'CONTRACT_CHANGED'],
    [
      { readAsset: async (id: string) => ({ asset_id: id, status: 'success', output: { data: [] } }) },
      'CONTENT_AUDIT_REJECTED',
    ],
  ] as const)
    await assert.rejects(resolveImageReferences(plan.parameters, plan.bindings, imageResolver(patch)), {
      code,
    });
});

test('native asset IDs are checked remotely while missing history and official task IDs are not reinterpreted', async () => {
  const native = '11111111-1111-4111-8111-111111111111';
  const resolver = imageResolver({
    findJob: () => {
      throw new TripoError('JOB_NOT_FOUND', 'Fixture');
    },
  });
  const plan = planImageReferences([native, 'https://example.test/extra.png'])!;
  const resolved = await resolveImageReferences(plan.parameters, plan.bindings, resolver);
  assert.deepEqual((resolved.image_sources as unknown[])[0], { asset_id: native, output_index: 0 });
  for (const [reference, code] of [
    ['@missing', 'JOB_NOT_FOUND'],
    ['task_official', 'STUDIO_CAPABILITY_UNAVAILABLE'],
  ]) {
    const missing = planImageReferences([reference!, 'https://example.test/extra.png'])!;
    await assert.rejects(resolveImageReferences(missing.parameters, missing.bindings, resolver), { code });
  }
});

test('text generation takes an explicit prompt parameter without changing model and seed precedence', async () => {
  for (const command of ['text-to-model', 'text-to-image']) {
    const { stdout } = await exec(process.execPath, [
      'cli/main.ts',
      'generate',
      command,
      'positional prompt',
      '--model',
      command === 'text-to-model' ? 'H3.1' : 'banana2',
      '-p',
      'prompt=parameter prompt',
      '--dry-run',
      '--json',
    ]);
    assert.equal(JSON.parse(stdout).steps[0].parameters.prompt, 'parameter prompt');
  }
  for (const invalid of [null, '', false, 0])
    assert.throws(() => generation('text-to-model', ['fallback prompt'], { param: { prompt: invalid } }));
});

test('image model parameters override image flags while 3D model flags retain precedence', async () => {
  for (const command of ['text-to-image', 'image-to-image']) {
    const { stdout } = await exec(process.execPath, [
      'cli/main.ts',
      'generate',
      command,
      command === 'text-to-image' ? 'cube' : '@existing',
      '--model',
      'banana2',
      '-p',
      'model=banana',
      ...(command === 'image-to-image' ? ['--prompt', 'cube'] : []),
      '--dry-run',
      '--json',
    ]);
    assert.equal(JSON.parse(stdout).steps[0].parameters.model_version, 'gemini_2.5_flash_image_preview');
  }
  assert.throws(() => generation('text-to-image', ['cube'], { model: 'banana2', param: { model: null } }));
  assert.equal(
    generation('text-to-model', ['cube'], { model: 'H3.1', param: { model: 'P2' } }).parameters.model_version,
    'v3.1-20260211',
  );
});

const imageBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+juyQAAAAASUVORK5CYII=',
  'base64',
);

test('the source CLI retains mixed references and edit-base roles and rejects a final missing file before authentication', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tripo-mixed-cli-'));
  const file = path.join(dir, 'back.png');
  try {
    await writeFile(file, imageBytes);
    for (const editBase of [false, true]) {
      const { stdout } = await exec(process.execPath, [
        'cli/main.ts',
        'generate',
        'image-to-image',
        '@base',
        '@reference',
        file,
        '--model',
        'banana2',
        '--prompt',
        'keep the three references',
        ...(editBase ? ['--edit-base'] : []),
        '--dry-run',
        '--json',
      ]);
      const plan = JSON.parse(stdout),
        params = plan.steps[0].parameters;
      assert.equal(plan.valid, true);
      assert.deepEqual(plan.pending_uploads, [file]);
      assert.equal(params.image_sources.length, editBase ? 2 : 3);
      assert.equal(Boolean(params.image_asset), editBase);
      assert.deepEqual(params.image_sources.at(-1), { image_path: file });
      assert.equal(plan.steps[0].imageReferences.length, 2);
    }
    const { stdout } = await exec(process.execPath, [
      'cli/main.ts',
      'generate',
      'multiview-to-model',
      '@front',
      file,
      '--model',
      'H3.1',
      '--dry-run',
      '--json',
    ]);
    assert.deepEqual(JSON.parse(stdout).steps[0].parameters.image_sources, [
      { asset_id: 'cli-reference-0', output_index: 0 },
      null,
      { image_path: file },
      null,
    ]);
    await assert.rejects(
      exec(process.execPath, [
        'cli/main.ts',
        'generate',
        'image-to-image',
        '@base',
        file,
        path.join(dir, 'missing.png'),
        '--model',
        'banana2',
        '--prompt',
        'references',
        '--dry-run',
        '--json',
      ]),
      (error: unknown) => {
        const result = error as { code: number; stdout: string };
        assert.notEqual(result.code, 0);
        assert.match(result.stdout, /INVALID_INPUT/);
        assert.match(result.stdout, /missing\.png/);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('mixed image inputs execute through the real task service with stable slots and frozen local bytes', async () => {
  const f = await fixture();
  const file = path.join(f.dir, 'local.png');
  await writeFile(file, imageBytes);
  const seed = (alias: string, assetId: string) => {
    const job = f.jobs.prepare('test-account', `source-${alias}`, 'image', { prompt: alias }, quote);
    f.jobs.update(job.job_id, 'submitting');
    f.jobs.update(job.job_id, 'submitted', { remote_ids: { asset_id: assetId } });
    f.jobs.update(job.job_id, 'succeeded');
    f.jobs.assignName('test-account', alias, job.job_id);
  };
  seed('front', 'front-asset');
  seed('reference', 'reference-asset');
  const submitted: Job[] = [];
  const reads: string[] = [];
  f.gateway.submit = async (job) => {
    submitted.push(job);
    return { remote_ids: { asset_id: `result-${submitted.length}` } };
  };
  const app = {
    service: f.service,
    studio: {
      client: new StudioClient(f.service.credentials, async (url, init) => {
        assert.ok(new URL(url).pathname.endsWith('/get_image_asset'));
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        const assetId = String(body.asset_id);
        reads.push(assetId);
        return Response.json({ code: 0, data: completeAsset(assetId) });
      }),
    },
    close: () => f.jobs.close(),
  } as unknown as Application;
  try {
    const image = () =>
      generationPlan('image-to-image', ['@front', file, '@reference'], {
        model: 'banana2',
        prompt: 'restyle using all references',
        editBase: true,
      });
    await validatePlanFiles(image());
    const result = await executePlan(app, image(), { requestId: 'mixed-edit', download: false });
    assert.equal(result.status, 'success');
    const params = submitted[0]!.input;
    assert.deepEqual(params.image_asset, { asset_id: 'front-asset', output_index: 0 });
    assert.deepEqual(params.image_sources, [
      { image_path: file },
      { asset_id: 'reference-asset', output_index: 0 },
    ]);
    assert.deepEqual(params._input_files, { [file]: createHash('sha256').update(imageBytes).digest('hex') });
    assert.deepEqual(reads, ['front-asset', 'reference-asset']);
    await executePlan(app, image(), { requestId: 'mixed-edit', download: false });
    assert.equal(submitted.length, 1);
    const views = generationPlan('multiview-to-model', ['@front', file], {
      model: 'H3.1',
      viewSlots: ['@front', null, file, null],
    });
    await executePlan(app, views, { requestId: 'mixed-views', download: false });
    assert.deepEqual(submitted[1]!.input.image_sources, [
      { asset_id: 'front-asset', output_index: 0 },
      null,
      { image_path: file },
      null,
    ]);
    const missing = generationPlan('image-to-image', ['@front', path.join(f.dir, 'missing.png')], {
      model: 'banana2',
      prompt: 'never submit',
    });
    await assert.rejects(executePlan(app, missing, { requestId: 'missing', download: false }));
    assert.equal(submitted.length, 2);
    assert.equal(f.jobs.find('test-account', 'missing-0'), undefined);
  } finally {
    app.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('rig-check retains the prior body type when rig output included an internal export', async () => {
  const f = await fixture();
  let checks = 0;
  const app = {
    service: f.service,
    studio: {
      client: new StudioClient(f.service.credentials, async () => {
        checks++;
        return Response.json({ code: 0, data: { riggable: true, rig_type: 'aquatic' } });
      }),
    },
  } as unknown as Application;
  const createPlan = () =>
    makePlan(['cube'], {
      then: 'rig:quadruped;out_format=glb,rig-check,retarget:animations=["preset:idle","preset:walk"]',
    });
  const exported = f.jobs.prepare(
    'test-account',
    'previous-export',
    'export',
    { project_id: 'project' },
    quote,
  );
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const plan = createPlan();
      const index = plan.steps.findIndex((s) => s.preflight === 'rig');
      await checkedRigChain(app, plan, index, { project_id: 'project' }, 'keep-prior-rig', {
        job_id: exported.job_id,
      });
      assert.deepEqual(
        plan.steps
          .slice(index + 1)
          .filter((s) => s.operation === 'animate')
          .map((s) => s.parameters.animation),
        ['preset:quadruped:walk'],
      );
    }
    assert.equal(checks, 1);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('full MCP rig-check preserves request identity for its imported model across repeated calls', async () => {
  const f = await fixture();
  const file = path.join(f.dir, 'source.glb');
  await writeFile(file, tinyGlb());
  const requests: string[] = [];
  f.gateway.submit = async (job) => {
    requests.push(job.request_id);
    return { remote_ids: { project_id: 'project', operator_id: source } };
  };
  f.gateway.status = async () => ({ state: 'succeeded', progress: 100, artifacts: [] });
  const studio = {
    client: new StudioClient(f.service.credentials, async () =>
      Response.json({ code: 0, data: { riggable: true, rig_type: 'quadruped' } }),
    ),
  } as unknown as StudioReads;
  const tool = fullTools(f.service, studio).find((tool) => tool.name === 'ai_modeling_rig_check')!;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = (await tool.run({ input: file, request_id: 'check-file' })) as Record<string, unknown>;
      assert.equal(result.status, 'success');
    }
    assert.deepEqual(requests, ['check-file-0']);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('automatic source positions are immutable, account-bound and rejected for ambiguous legacy execution', async () => {
  const f = await fixture();
  const seed = (request: string) => {
    const job = f.jobs.prepare('test-account', request, 'model', { prompt: request }, quote);
    f.jobs.update(job.job_id, 'submitting');
    f.jobs.update(job.job_id, 'submitted');
    f.jobs.update(job.job_id, 'succeeded');
    return job;
  };
  const original = seed('original');
  const app = { service: f.service } as Application;
  try {
    const plan = () => makePlan(['@last'], { then: 'rig' });
    const first = freezePlanReferences(app, plan(), 'frozen-source');
    assert.equal(first.steps[0]?.source, original.job_id);
    assert.equal(first.sourceValidation?.reference, original.job_id);
    assert.equal(plan().steps[0]?.source, '@last');
    await new Promise((resolve) => setTimeout(resolve, 2));
    seed('newer-result');
    assert.deepEqual(freezePlanReferences(app, plan(), 'frozen-source'), first);
    assert.throws(() => freezePlanReferences(app, makePlan(['@1'], { then: 'rig' }), 'frozen-source'), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    assert.throws(
      () => freezePlanReferences(app, makePlan([original.job_id], { then: 'rig' }), 'frozen-source'),
      {
        code: 'IDEMPOTENCY_CONFLICT',
      },
    );
    f.jobs.prepare('test-account', 'prepared-0', 'rig', { project_id: 'project' }, quote);
    assert.ok(freezePlanReferences(app, plan(), 'prepared').steps[0]?.source);
    seed('legacy-0');
    assert.throws(() => freezePlanReferences(app, plan(), 'legacy'), { code: 'SOURCE_RECOVERY_REQUIRED' });
    assert.equal(f.jobs.requestPolicy('test-account', 'sources:legacy'), undefined);
    freezePlanReferences(app, makePlan([original.job_id], { then: 'rig' }), 'explicit');
    assert.equal(f.jobs.requestPolicy('test-account', 'sources:explicit'), undefined);
    const saved = f.jobs.requestPolicy('test-account', 'sources:frozen-source')!;
    assert.deepEqual(
      (saved.intent as Record<string, unknown>[]).map((row) => row.position),
      ['steps.0.source', 'sourceValidation.reference'],
    );
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('multiple automatic image references keep their original tasks across restart and cannot swap slots', async () => {
  let f = await fixture();
  const dir = f.dir;
  const seed = (alias: string) => {
    const job = f.jobs.prepare('test-account', `image-${alias}`, 'image', { prompt: alias }, quote);
    f.jobs.update(job.job_id, 'submitting');
    f.jobs.update(job.job_id, 'submitted', { remote_ids: { asset_id: alias } });
    f.jobs.update(job.job_id, 'succeeded');
    f.jobs.assignName('test-account', alias, job.job_id);
    return job;
  };
  seed('front');
  await new Promise((resolve) => setTimeout(resolve, 2));
  const initial = seed('second');
  let posts = 0;
  const inputs: Record<string, unknown>[] = [];
  const configure = () => {
    f.gateway.submit = async (job) => {
      inputs.push(job.input);
      posts++;
      return { remote_ids: { asset_id: `result-${posts}` } };
    };
    return {
      service: f.service,
      studio: {
        client: new StudioClient(f.service.credentials, async (_url, init) => {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          return Response.json({ code: 0, data: completeAsset(String(body.asset_id)) });
        }),
      },
    } as Application;
  };
  let app = configure();
  const make = (references = ['@last', '@front', '@1', '@last:any']) =>
    generationPlan('image-to-image', references, {
      model: 'banana2',
      prompt: 'combine the original images',
      editBase: true,
    });
  const flags = { requestId: 'automatic-images', download: false };
  try {
    const original = await executePlan(app, make(), flags);
    assert.equal(original.status, 'success');
    assert.deepEqual(inputs[0]?.image_asset, { asset_id: 'second', output_index: 0 });
    assert.deepEqual(inputs[0]?.image_sources, [
      { asset_id: 'front', output_index: 0 },
      { asset_id: 'second', output_index: 0 },
      { asset_id: 'second', output_index: 0 },
    ]);
    f.jobs.close();
    f = await fixture(dir);
    app = configure();
    const resumed = await executePlan(app, make(), flags);
    assert.equal(resumed.task_id, original.task_id);
    assert.equal(posts, 1);
    const frozen = freezePlanReferences(app, make(), 'automatic-images');
    assert.equal(frozen.steps[0]?.imageReferences?.[0]?.reference, initial.job_id);
    const role = generationPlan('image-to-image', ['@last', '@front'], { model: 'banana2', prompt: 'roles' });
    freezePlanReferences(app, role, 'role-change-before-submit');
    assert.throws(
      () =>
        freezePlanReferences(
          app,
          generationPlan('image-to-image', ['@last', '@front'], {
            model: 'banana2',
            prompt: 'roles',
            editBase: true,
          }),
          'role-change-before-submit',
        ),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    await assert.rejects(executePlan(app, make(['@front', '@last', '@1', '@last:any']), flags), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    assert.equal(posts, 1);
  } finally {
    f.jobs.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('full MCP validates a later texture file before importing or submitting the valid model', async () => {
  const f = await fixture();
  const file = path.join(f.dir, 'source.glb');
  await writeFile(file, tinyGlb());
  const studio = { client: { request: async () => ({}) } } as unknown as StudioReads;
  const tool = fullTools(f.service, studio).find((tool) => tool.name === 'ai_modeling_texture')!;
  try {
    const input = {
      input: file,
      texture_prompt: { style_image: path.join(f.dir, 'missing.png') },
      request_id: 'full-preflight',
    };
    tool.schema.parse(input);
    await assert.rejects(tool.run(input), { code: 'INVALID_INPUT' });
    assert.equal(f.gateway.posts, 0);
    assert.equal(f.jobs.list('test-account').length, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('generation output roots isolate tasks while standalone and full MCP downloads preserve exact destinations', async () => {
  const f = await fixture();
  const root = path.join(f.service.config.outputDir, 'generated-root');
  let posts = 0;
  let sourceReads = 0;
  f.gateway.submit = async () => ({
    remote_ids: {
      project_id: 'project',
      operator_id: `00000000-0000-4000-8000-${String(++posts).padStart(12, '0')}`,
    },
  });
  f.gateway.status = async () => ({ state: 'succeeded', progress: 100, artifacts: [] });
  const studio = {
    client: {
      request: async (method: string, route: string) => {
        assert.equal(method, 'GET');
        assert.equal(route, '/v2/studio/project/detail/v3/project');
        sourceReads++;
        return {
          id: 'project',
          is_owner: true,
          operator: {
            operator_id: `00000000-0000-4000-8000-${String(posts).padStart(12, '0')}`,
            is_rigged: false,
            retarget: [],
          },
        };
      },
    },
  } as unknown as StudioReads;
  const app = { service: f.service, studio } as Application;
  try {
    const results: Record<string, unknown>[] = [];
    for (const requestId of ['first', 'second']) {
      const result = await executePlan(app, makePlan(['AR cube'], { for: 'ar-web' }), {
        requestId,
        out: root,
      });
      assert.equal(result.status, 'success');
      assert.equal(result.download_error, undefined);
      const generation = (result.generation_downloads as Record<string, unknown>[])[0]!;
      assert.ok(String(generation.output_dir).startsWith(path.join(root, 'ai-modeling-out') + path.sep));
      assert.ok(String(result.output_dir).startsWith(path.join(root, 'ai-modeling-out') + path.sep));
      assert.notEqual(result.output_dir, generation.output_dir);
      results.push(result);
    }
    assert.notEqual(results[0]!.output_dir, results[1]!.output_dir);
    assert.equal(posts, 6);
    assert.equal(sourceReads, 2);
    const job = await f.service.get(String(results[0]!.task_id));
    const exact = await downloadTask(app, job, { out: path.join(f.dir, 'exact-download') });
    assert.equal(exact.output_dir, path.join(f.dir, 'exact-download'));
    const tool = fullTools(f.service, studio).find((tool) => tool.name === 'ai_modeling_download')!;
    const mcp = (await tool.run({
      task_id: job.job_id,
      output_dir: path.join(f.dir, 'mcp-exact'),
    })) as Record<string, unknown>;
    assert.equal(mcp.output_dir, path.join(f.dir, 'mcp-exact'));
    assert.equal(posts, 6);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('an explicit generation root relocates verified legacy bytes while an omitted root resumes the saved directory', async () => {
  const f = await fixture();
  let posts = 0;
  f.gateway.submit = async () => {
    posts++;
    return { remote_ids: { project_id: 'project', operator_id: source } };
  };
  f.gateway.status = async () => ({
    state: 'succeeded',
    progress: 100,
    artifacts: [{ artifact_id: 'model-0', kind: 'model', format: 'glb', index: 0 }],
  });
  const app = { service: f.service } as Application;
  const plan = () => generationPlan('text-to-model', ['kept cube'], { model: 'H3.1' });
  try {
    const first = await executePlan(app, plan(), { requestId: 'relocate-original', download: false });
    const bytes = tinyGlb(),
      old = path.join(f.dir, 'old-exact/model.glb');
    await mkdir(path.dirname(old));
    await writeFile(old, bytes);
    f.jobs.saveArtifact(String(first.task_id), {
      artifact_id: 'model-0',
      kind: 'model',
      format: 'glb',
      index: 0,
      local_path: old,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    f.gateway.artifactUrl = async () => {
      throw new TripoError('NETWORK_ERROR', 'Controlled original URL outage.', 'read');
    };
    const root = path.join(f.service.config.outputDir, 'requested-root');
    const resumed = await executePlan(app, plan(), { requestId: 'relocate-original', out: root });
    assert.equal(resumed.download_error, undefined);
    assert.equal(
      resumed.output_dir,
      path.join(root, 'ai-modeling-out', `kept-cube-${String(first.task_id).slice(0, 8)}`),
    );
    assert.deepEqual(await readFile(String(resumed.model_file)), bytes);
    assert.deepEqual(await readFile(old), bytes);
    const again = await executePlan(app, plan(), { requestId: 'relocate-original' });
    assert.equal(await realpath(String(again.output_dir)), await realpath(String(resumed.output_dir)));
    assert.equal(again.model_file, resumed.model_file);
    assert.equal(posts, 1);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('a completed single multiview task reference resumes without rereading a deleted source and rejects replacement', async () => {
  const f = await fixture();
  const seed = (request: string) => {
    const job = f.jobs.prepare('test-account', request, 'image_process', { action: 'multiview' }, quote);
    return f.jobs.update(job.job_id, 'succeeded', { remote_ids: { asset_id: request } });
  };
  const first = seed('four-views'),
    other = seed('different-views');
  let reads = 0,
    posts = 0,
    offline = false;
  f.gateway.submit = async () => {
    posts++;
    return { remote_ids: { project_id: 'project', operator_id: source } };
  };
  f.gateway.status = async () => ({ state: 'succeeded', progress: 100, artifacts: [] });
  const app = {
    service: f.service,
    studio: {
      client: {
        request: async (_method: string, _route: string, input: Record<string, unknown>) => {
          reads++;
          if (offline) throw new TripoError('NETWORK_ERROR', 'Controlled deleted multiview source.', 'read');
          return {
            asset_id: input.asset_id,
            type: 'multiview_images',
            status: 'success',
            output: { data: [{}, {}, {}, {}] },
          };
        },
      },
    },
  } as Application;
  const plan = (job = first.job_id) => generationPlan('multiview-to-model', [job], { model: 'H3.1' });
  try {
    const created = await executePlan(app, plan(), { requestId: 'old-multiview', download: false });
    assert.equal(created.status, 'success');
    assert.equal(reads, 1);
    offline = true;
    const resumed = await executePlan(app, plan(), { requestId: 'old-multiview', download: false });
    assert.equal(resumed.task_id, created.task_id);
    assert.equal(reads, 1);
    assert.equal(posts, 1);
    await assert.rejects(
      executePlan(app, plan(other.job_id), { requestId: 'old-multiview', download: false }),
      {
        code: 'IDEMPOTENCY_CONFLICT',
      },
    );
    assert.equal(reads, 1);
    await assert.rejects(executePlan(app, plan(), { requestId: 'new-multiview', download: false }), {
      code: 'NETWORK_ERROR',
    });
    assert.equal(reads, 2);
    assert.equal(posts, 1);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
