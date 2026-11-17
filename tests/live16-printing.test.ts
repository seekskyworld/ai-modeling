/** 打印验收只操作临时任务库并注入启动器；不启动本机切片器、不发布模型或提交付费任务。 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fixture, quote } from './helpers.ts';
import { object, array, text } from '../studio/contracts/errors.ts';
import type { Job, Artifact } from '../studio/contracts/types.ts';
import { StudioClient } from '../studio/api/client.ts';
import { StudioGateway } from '../studio/api/gateway.ts';
import { MemoryLinks } from '../studio/auth/artifact-links.ts';
import type { Application } from '../cli/compat/runtime.ts';
import {
  printPlatform,
  printDelivery,
  printProtocol,
  printExportSuggestion,
  printTargets,
  printTargetKeys,
  printShopAvailability,
  readPrintShop,
  type PrintPlatform,
  type PrintTarget,
} from '../studio/printing.ts';
import {
  openPrint,
  printShop,
  printingTools,
  listPrintTargets,
  printOpenInput,
  printPlanInput,
} from '../cli/compat/printing.ts';

const sourceUrl = 'https://cdn.tripo3d.ai/model.3mf?signature=controlled-not-a-secret&name=old#old';
const projectId = 'original-project';
const namedUrl =
  'https://cdn.tripo3d.ai/model.3mf?signature=controlled-not-a-secret&name=old&name=original-project.3mf#old';
const model: Artifact = { artifact_id: 'model', kind: 'model', format: '3mf', index: 0 };
const platforms: PrintPlatform[] = ['mac', 'windows', 'other'];

async function setup(t: TestContext) {
  const f = await fixture();
  t.after(async () => {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  });
  let sequence = 0;
  const create = (patch: Partial<Job> = {}) => {
    const job = f.jobs.prepare(
      patch.account_ref ?? 'test-account',
      `print-${sequence++}`,
      patch.operation ?? 'export',
      patch.input ?? { project_id: projectId, format: '3mf' },
      quote,
    );
    return f.jobs.update(job.job_id, patch.state ?? 'succeeded', {
      remote_ids: patch.remote_ids ?? { project_id: projectId, operator_id: 'original-export' },
      artifacts: patch.artifacts ?? [model],
    });
  };
  const app = { service: f.service, studio: f.gateway, close: () => {} } as unknown as Application;
  return { ...f, app, create };
}

test('Studio print target matrix preserves all eight targets and OS-specific download fallbacks', () => {
  const expected: Record<PrintTarget, string[]> = {
    local: ['download', 'download', 'download'],
    'bambu-studio': ['protocol', 'protocol', 'download'],
    'creality-print': ['download', 'protocol', 'protocol'],
    'orca-slicer': ['protocol', 'protocol', 'protocol'],
    'blueprint-studio': ['download', 'protocol', 'download'],
    'elegoo-slicer': ['protocol', 'protocol', 'protocol'],
    anycubic: ['download', 'download', 'download'],
    'lychee-slicer': ['download', 'download', 'download'],
  };
  assert.equal(printPlatform('darwin'), 'mac');
  assert.equal(printPlatform('win32'), 'windows');
  assert.equal(printPlatform('linux'), 'other');
  assert.equal(printTargetKeys.length, 8);
  for (const target of printTargetKeys)
    assert.deepEqual(
      platforms.map((platform) => printDelivery(target, platform)),
      expected[target],
    );
  for (const platform of platforms) {
    const targets = printTargets(platform);
    assert.equal(targets.length, 8);
    assert.ok(targets.every((item) => item.supported_by_print_open === true));
    assert.deepEqual(
      targets.filter((item) => item.requires_textured_model).map((item) => item.target),
      ['local'],
    );
  }
  assert.equal(listPrintTargets({}, 'win32').platform, 'windows');
});

test('native protocols match website strings, append names and isolate platform support', () => {
  const encoded = encodeURIComponent(namedUrl);
  const blueprint = `blueprint-studio://preprocess/create-project-with-assets?editor=3d&assets=${encodeURIComponent(JSON.stringify([{ extension: '3mf', name: `${projectId}.3mf`, url: namedUrl }]))}&source=tripo&source_ref=original-project`;
  const expected: Partial<Record<PrintTarget, Array<string | undefined>>> = {
    'bambu-studio': [`bambustudioopen://${encoded}`, `bambustudio://open?file=${encoded}`, undefined],
    'creality-print': [
      undefined,
      `crealityprintlink://open/?file=${encoded}`,
      `crealityprintlink://open/?file=${encoded}`,
    ],
    'orca-slicer': platforms.map(
      () => `orcaslicer://open/?file=${encodeURIComponent(namedUrl.replace('#old', '#/model.3mf'))}`,
    ),
    'blueprint-studio': [undefined, blueprint, undefined],
    'elegoo-slicer': platforms.map(() => `elegooslicer://open/?file=${encoded}`),
  };
  for (const target of printTargetKeys)
    assert.deepEqual(
      platforms.map((platform) => printProtocol(target, sourceUrl, projectId, platform)),
      expected[target] ?? [undefined, undefined, undefined],
    );
  for (const url of ['http://cdn.tripo3d.ai/test.3mf', 'https://user:pass@cdn.tripo3d.ai/test.3mf'])
    assert.throws(() => printProtocol('orca-slicer', url, projectId, 'mac'), { code: 'INVALID_INPUT' });
});

test('print export suggestions preserve website orientation, packaging and local vertex colors', () => {
  const base = {
    animate_in_place: false,
    animations: [],
    bake_animation_frame: 0,
    enable_bake_animation: false,
    export_orientation: '-y',
    export_vertex_colors: false,
    fbx_preset: 'blender',
    format: '3mf',
    model_version: 'default',
    name: projectId,
    pack_uv: false,
    project_id: projectId,
    texture_packaging: 'embedded',
    texture_size: 4096,
    with_animation: true,
  };
  assert.deepEqual(printExportSuggestion(projectId, 'bambu-studio', 'mac', 1024), base);
  assert.deepEqual(printExportSuggestion(projectId, 'bambu-studio', 'other', 1024), {
    ...base,
    texture_packaging: 'zip',
    texture_size: 1024,
  });
  assert.equal(printExportSuggestion(projectId, 'anycubic', 'mac', 8192).texture_size, 4096);
  const local = printExportSuggestion(projectId, 'local', 'windows');
  assert.equal(local.format, 'obj');
  assert.equal(local.export_vertex_colors, true);
  assert.equal(local.export_orientation, undefined);
  assert.equal(local.texture_packaging, 'embedded');
  assert.throws(() => printExportSuggestion(projectId, 'local', 'mac', 0), { code: 'INVALID_INPUT' });
});

test('planning only reads the original task and never resolves links, downloads or launches', async (t) => {
  const f = await setup(t);
  const job = f.create();
  f.service.gateway.artifactUrl = async () => {
    assert.fail('plan resolved a signed URL');
  };
  f.service.download = async () => {
    assert.fail('plan downloaded a file');
  };
  for (const target of printTargetKeys.filter((item) => item !== 'local')) {
    const plan = await openPrint(
      f.app,
      { task_id: job.job_id, target },
      { platform: 'darwin', launch: async () => assert.fail('plan launched an app') },
    );
    assert.equal(plan.dry_run, true);
    assert.equal(plan.handoff_requested, false);
    assert.equal(plan.print_started, false);
    assert.equal(plan.task_id, job.job_id);
    assert.equal(plan.operator_id, 'original-export');
    assert.ok(!JSON.stringify(plan).includes('signature'));
  }
  assert.equal(f.gateway.posts, 0);
  assert.equal(f.jobs.list('test-account').length, 1);
});

test('explicit protocol handoff passes only the original signed URL to the injected launcher', async (t) => {
  const f = await setup(t);
  const job = f.create();
  let reads = 0;
  f.service.gateway.artifactUrl = async (original, artifact) => {
    assert.equal(original.job_id, job.job_id);
    assert.equal(artifact.artifact_id, 'model');
    reads++;
    return sourceUrl;
  };
  f.service.download = async () => {
    assert.fail('protocol unexpectedly downloaded');
  };
  const launched: Array<{ protocol: string; platform: PrintPlatform }> = [];
  const result = await openPrint(
    f.app,
    { task_id: job.job_id, target: 'bambu-studio', execute: true },
    {
      platform: 'darwin',
      launch: async (protocol, platform) => {
        launched.push({ protocol, platform });
      },
    },
  );
  assert.deepEqual(launched, [
    { protocol: `bambustudioopen://${encodeURIComponent(namedUrl)}`, platform: 'mac' },
  ]);
  assert.equal(reads, 1);
  assert.equal(result.handoff_requested, true);
  assert.equal(result.print_started, false);
  assert.equal(result.dry_run, false);
  assert.ok(!JSON.stringify(result).includes('signature'));
  assert.equal(f.gateway.posts, 0);
});

test('unsupported protocol platforms download the original artifact with only local file metadata', async (t) => {
  const f = await setup(t);
  const job = f.create();
  f.service.gateway.artifactUrl = async () => {
    assert.fail('download branch resolved a protocol URL');
  };
  const downloads: unknown[][] = [];
  f.service.download = async (...args) => {
    downloads.push(args);
    return {
      job_id: args[0],
      artifact_id: args[1],
      local_path: args[2],
      format: '3mf',
      bytes: 123,
      sha256: 'controlled-digest',
      restored_from_cache: true,
      remote_download_error: { url: sourceUrl },
      url: sourceUrl,
    };
  };
  const result = await openPrint(
    f.app,
    { task_id: job.job_id, target: 'bambu-studio', execute: true, output_dir: f.dir },
    {
      platform: 'linux',
      launch: async () => assert.fail('unsupported platform launched an app'),
    },
  );
  assert.deepEqual(downloads, [[job.job_id, 'model', path.join(f.dir, `${projectId}.3mf`)]]);
  assert.equal(result.delivery, 'download');
  assert.equal(result.fallback, false);
  assert.equal(object(result.file).restored_from_cache, true);
  assert.equal(object(result.file).bytes, 123);
  assert.ok(!JSON.stringify(result).includes('signature'));
  await assert.rejects(openPrint(f.app, { task_id: job.job_id, target: 'anycubic', execute: true }), {
    code: 'INVALID_INPUT',
  });
});

test('launcher failures have a redacted error or download fallback and never recreate an export', async (t) => {
  const f = await setup(t);
  const job = f.create();
  f.service.gateway.artifactUrl = async () => sourceUrl;
  let downloads = 0;
  f.service.download = async () => {
    downloads++;
    return { format: '3mf', bytes: 456 };
  };
  const runtime = {
    platform: 'darwin',
    launch: async () => {
      throw new Error(`command failed ${sourceUrl}`);
    },
  };
  await assert.rejects(
    openPrint(f.app, { task_id: job.job_id, target: 'orca-slicer', execute: true }, runtime),
    (error: unknown) => {
      assert.equal(object(error).code, 'PRINT_HANDOFF_FAILED');
      assert.ok(!String(error).includes('signature'));
      return true;
    },
  );
  const result = await openPrint(
    f.app,
    { task_id: job.job_id, target: 'orca-slicer', execute: true, output_dir: f.dir },
    runtime,
  );
  assert.equal(result.fallback, true);
  assert.equal(result.delivery, 'download');
  assert.equal(downloads, 1);
  assert.equal(f.gateway.posts, 0);
});

test('print handoff rejects wrong task state, format, artifact, ownership and storage hosts', async (t) => {
  const f = await setup(t);
  const cases: Array<{ patch: Partial<Job>; code: string; artifact_id?: string }> = [
    { patch: { state: 'running' }, code: 'INPUT_NOT_READY' },
    { patch: { state: 'failed' }, code: 'INPUT_NOT_READY' },
    { patch: { operation: 'model' }, code: 'INVALID_INPUT' },
    { patch: { input: { format: 'glb' } }, code: 'INVALID_INPUT' },
    { patch: { artifacts: [model, { ...model, artifact_id: 'other', index: 1 }] }, code: 'INVALID_INPUT' },
    { patch: {}, artifact_id: 'unknown', code: 'ARTIFACT_NOT_FOUND' },
    { patch: { artifacts: [{ ...model, kind: 'image' }] }, code: 'ARTIFACT_NOT_FOUND' },
    { patch: { artifacts: [{ ...model, format: 'fbx' }] }, code: 'ARTIFACT_FORMAT_MISMATCH' },
    { patch: { remote_ids: {} }, code: 'REMOTE_ID_MISSING' },
    { patch: { account_ref: 'different-account' }, code: 'ACCOUNT_MISMATCH' },
  ];
  for (const item of cases) {
    const job = f.create(item.patch);
    await assert.rejects(
      openPrint(f.app, { task_id: job.job_id, target: 'orca-slicer', artifact_id: item.artifact_id }),
      { code: item.code },
    );
  }
  const job = f.create();
  f.service.gateway.artifactUrl = async () => 'https://foreign.invalid/model.3mf';
  await assert.rejects(
    openPrint(
      f.app,
      { task_id: job.job_id, target: 'orca-slicer', execute: true },
      {
        launch: async () => assert.fail('untrusted host launched an app'),
      },
    ),
    { code: 'DOWNLOAD_HOST_DENIED' },
  );
  assert.equal(f.gateway.posts, 0);
});

test('batch print selection preserves the artifact index and original child project identity', async (t) => {
  const f = await setup(t);
  const job = f.create({
    operation: 'export_batch',
    input: { format: '3mf', projects: ['first-project', 'second-project'] },
    remote_ids: {
      batch: [
        { project_id: 'first-project', operator_id: 'first-export', code: 0 },
        { project_id: 'second-project', operator_id: 'second-export', code: 0 },
      ],
    },
    artifacts: [
      { ...model, artifact_id: 'batch-0' },
      { ...model, artifact_id: 'batch-1', index: 1 },
    ],
  });
  f.service.gateway.artifactUrl = async (original, artifact) => {
    assert.equal(original.job_id, job.job_id);
    assert.equal(original.operation, 'export_batch');
    assert.equal(artifact.index, 1);
    return sourceUrl;
  };
  const result = await openPrint(
    f.app,
    { task_id: job.job_id, artifact_id: 'batch-1', target: 'elegoo-slicer', execute: true },
    {
      platform: 'darwin',
      launch: async (protocol) => assert.ok(decodeURIComponent(protocol).includes('name=second-project.3mf')),
    },
  );
  assert.equal(result.project_id, 'second-project');
  assert.equal(result.operator_id, 'second-export');
});

test('packaged 3MF exports download their original ZIP without handing the archive to a slicer', async (t) => {
  const f = await setup(t);
  const job = f.create({
    input: { format: '3mf', texture_packaging: 'zip' },
    artifacts: [{ ...model, format: 'zip' }],
  });
  f.service.gateway.artifactUrl = async () => {
    assert.fail('archive resolved a protocol URL');
  };
  let downloads = 0;
  f.service.download = async (id, artifact, destination) => {
    assert.equal(id, job.job_id);
    assert.equal(artifact, model.artifact_id);
    assert.equal(destination, path.join(f.dir, `${projectId}.zip`));
    downloads++;
    return { local_path: destination, format: 'zip' };
  };
  const input = { task_id: job.job_id, target: 'bambu-studio', output_dir: f.dir };
  const plan = await openPrint(f.app, input, { platform: 'darwin' });
  assert.equal(plan.delivery, 'download');
  assert.equal(plan.format, 'zip');
  assert.equal(plan.export_format, '3mf');
  assert.ok(text(plan.delivery_reason).includes('ZIP package'));
  assert.equal(downloads, 0);
  const result = await openPrint(
    f.app,
    { ...input, execute: true },
    {
      platform: 'darwin',
      launch: async () => assert.fail('archive handed to a slicer'),
    },
  );
  assert.equal(result.handoff_requested, false);
  assert.equal(downloads, 1);
});

test('locally processed export plans force file download instead of handing off raw remote bytes', async (t) => {
  const f = await setup(t);
  const job = f.create({ input: { project_id: projectId, format: '3mf', scale_factor: 2 } });
  f.service.gateway.artifactUrl = async () => {
    assert.fail('local transform resolved a raw protocol URL');
  };
  let downloads = 0;
  f.service.download = async (id) => {
    assert.equal(id, job.job_id);
    downloads++;
    return { format: '3mf', processing: 'local conversion', source_sha256: 'original-digest' };
  };
  const result = await openPrint(
    f.app,
    { task_id: job.job_id, target: 'bambu-studio', execute: true, output_dir: f.dir },
    {
      platform: 'darwin',
      launch: async () => assert.fail('unprocessed bytes handed off'),
    },
  );
  assert.equal(result.delivery, 'download');
  assert.ok(text(result.delivery_reason).includes('local processing'));
  assert.equal(object(result.file).source_sha256, 'original-digest');
  assert.equal(downloads, 1);
});

test('local target downloads existing OBJ or ZIP and never claims unverified multi-color output', async (t) => {
  const f = await setup(t);
  const destinations: string[] = [];
  f.service.gateway.artifactUrl = async () => {
    assert.fail('local target resolved a protocol URL');
  };
  f.service.download = async (_id, _artifact, destination) => {
    destinations.push(destination);
    return { local_path: destination };
  };
  for (const format of ['obj', 'zip']) {
    const job = f.create({
      input: { format: 'obj', project_id: projectId },
      artifacts: [{ ...model, format }],
    });
    const result = await openPrint(f.app, {
      task_id: job.job_id,
      target: 'local',
      execute: true,
      output_dir: f.dir,
    });
    assert.equal(result.format, format);
    assert.equal(result.vertex_colors_requested, false);
    assert.equal(result.colors_verified, false);
    assert.equal(array(result.warnings).length, 1);
    assert.equal(object(result.suggested_website_export).export_vertex_colors, true);
    assert.equal(destinations.at(-1), path.join(f.dir, `${projectId}.${format}`));
  }
  const colored = f.create({
    input: { format: 'obj', export_vertex_colors: true },
    artifacts: [{ ...model, format: 'zip' }],
  });
  const plan = await openPrint(f.app, { task_id: colored.job_id, target: 'local' });
  assert.equal(plan.vertex_colors_requested, true);
  assert.equal(plan.colors_verified, false);
  assert.equal(plan.warnings, undefined);
  assert.equal(destinations.length, 2);
  assert.equal(f.gateway.posts, 0);
});

test('print shop reads original visibility without publishing and strips unrelated project fields', async (t) => {
  const f = await setup(t);
  let response: Record<string, unknown> = {};
  const requests: string[] = [];
  const gateway = new StudioGateway(
    new StudioClient(f.service.credentials, async (url, init) => {
      assert.equal(init.method, 'GET');
      assert.equal(init.body, undefined);
      requests.push(new URL(url).pathname);
      return Response.json({ code: 0, data: response });
    }),
    [],
    new MemoryLinks(),
  );
  f.app.studio = gateway;
  for (const visibility of ['private', 'public', 'shareable']) {
    response = {
      id: projectId,
      visibility,
      model_url: sourceUrl,
      account_email: 'not-for-output@example.invalid',
    };
    const result = await printShop(f.app, { project_id: projectId });
    assert.equal(result.ready, visibility !== 'private');
    assert.equal(result.order_submitted, false);
    assert.equal(result.vendor_url, 'https://jujubit.ai/collections/tripo-jujubit');
    assert.equal(
      object(result.next).tool,
      visibility === 'private' ? 'ai_modeling_project_visibility' : undefined,
    );
    assert.ok(!JSON.stringify(result).includes('signature'));
    assert.ok(!JSON.stringify(result).includes('account_email'));
  }
  for (const risk of [
    { is_nsfw: true },
    { content_risk_level: 'nsfw' },
    { content_risk_level: 'sensitive' },
  ]) {
    response = { id: projectId, visibility: 'private', ...risk };
    const result = await printShop(f.app, { project_id: projectId });
    assert.equal(result.reason, 'content_not_shareable');
    assert.equal(result.next, undefined);
  }
  response = { id: 'foreign-project', visibility: 'public' };
  await assert.rejects(printShop(f.app, { project_id: projectId }), { code: 'CONTRACT_CHANGED' });
  response = { id: projectId, visibility: 'unexpected' };
  await assert.rejects(readPrintShop(gateway.client, projectId), { code: 'CONTRACT_CHANGED' });
  assert.equal(new Set(requests).size, 1);
  assert.equal(requests[0], `/v2/studio/project/detail/v3/${projectId}`);
  assert.deepEqual(printShopAvailability({ visibility: 'public', is_nsfw: true }), { ready: true });
});

test('print shop account binding rejects a session switched before the read', async (t) => {
  const f = await setup(t);
  const client = new StudioClient(f.service.credentials, async () => {
    assert.fail('different account reached the network');
  });
  const scoped = client.forAccount('test-account');
  const saved = f.service.credentials.load()!;
  f.service.credentials.save({ ...saved, accountRef: 'switched-account' });
  await assert.rejects(readPrintShop(scoped, projectId), { code: 'ACCOUNT_MISMATCH' });
});

test('printing tool schemas keep read-only plans separate from explicit execution', async (t) => {
  const f = await setup(t);
  const job = f.create();
  const tools = printingTools(f.service, f.app.studio);
  assert.deepEqual(
    tools.map((tool) => [tool.name, tool.readOnly]),
    [
      ['ai_modeling_print_targets', true],
      ['ai_modeling_print_plan', true],
      ['ai_modeling_print_open', false],
      ['ai_modeling_print_shop', true],
    ],
  );
  const input = { task_id: job.job_id, target: 'bambu-studio' };
  assert.equal(printOpenInput.parse(input).execute, false);
  assert.equal(printPlanInput.safeParse({ ...input, execute: true }).success, false);
  assert.equal(printOpenInput.safeParse({ ...input, target: 'local' }).success, true);
  assert.equal(printOpenInput.safeParse({ ...input, target: 'unregistered-slicer' }).success, false);
  f.service.gateway.artifactUrl = async () => {
    assert.fail('read-only tool resolved a URL');
  };
  const result = object(
    await tools.find((tool) => tool.name === 'ai_modeling_print_plan')!.run({ ...input, execute: true }),
  );
  assert.equal(result.dry_run, true);
});
