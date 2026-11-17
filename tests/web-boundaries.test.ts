/** 网页实际参数边界和导出回执恢复；受控上游验证无静默忽略、无重复付费提交。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { generationPlan } from '../cli/compat/planning.ts';
import { StudioClient } from '../studio/api/client.ts';
import { exportBatchStatus, reconcileExportBatch, submitExportBatch } from '../studio/api/export-batch.ts';
import { Operations } from '../studio/api/operations.ts';
import { prepareInput } from '../studio/api/preparation.ts';
import { textureSubmission } from '../studio/api/texture.ts';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import type { Job, RemoteStatus } from '../studio/contracts/types.ts';
import { fixture, quote } from './helpers.ts';

const projects = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const batchJob = (): Job => ({
  job_id: 'j',
  account_ref: 'test-account',
  request_id: 'r',
  input_hash: 'h',
  operation: 'export_batch',
  input: normalize('export_batch', { projects }),
  contract_version: 'test',
  state: 'failed',
  remote_ids: {
    batch: [
      { project_id: projects[0]!, operator_id: 'accepted', code: 0 },
      { project_id: projects[1]!, code: -1 },
    ],
  },
  quote,
  progress: 0,
  artifacts: [],
  error: { code: 'PARTIAL_RECEIPT_UNKNOWN' },
  created_at: '',
  updated_at: '',
  lease_until: 0,
});
const credentials = (): MemoryCredentials =>
  new MemoryCredentials({
    cookie: 'fixture',
    deviceId: 'test',
    accountRef: 'test-account',
    importedAt: '',
  });
const completed: RemoteStatus = {
  state: 'succeeded',
  progress: 100,
  artifacts: [{ artifact_id: 'model', kind: 'model', format: 'glb', index: 0 }],
};

test('image postprocessing rejects unavailable model overrides before planning or submission', () => {
  for (const action of ['multiview', 'split', 'upscale', 'regenerate_multiview'])
    assert.throws(
      () => normalize('image_process', { action, asset_id: 'asset', model_version: 'other-engine' }),
      /Only regenerate accepts model_version/,
    );
  assert.throws(
    () => generationPlan('image-to-multiview', ['image.png'], { param: { model_version: 'other-engine' } }),
    { code: 'STUDIO_CAPABILITY_UNAVAILABLE' },
  );
});

test('image selection applies only to asset-based per-image processing', () => {
  for (const action of ['multiview', 'split', 'upscale'])
    assert.equal(normalize('image_process', { action, asset_id: 'asset', output_index: 1 }).output_index, 1);
  for (const action of ['regenerate', 'regenerate_multiview']) {
    assert.throws(
      () => normalize('image_process', { action, asset_id: 'asset', output_index: 1 }),
      /nonzero output_index/,
    );
    assert.equal(normalize('image_process', { action, asset_id: 'asset' }).output_index, 0);
  }
  assert.throws(
    () => normalize('image_process', { action: 'multiview', image_path: 'image.png', output_index: 1 }),
    /nonzero output_index/,
  );
  assert.equal(normalize('image_process', { action: 'multiview', image_path: 'image.png' }).output_index, 0);
});

test('image regeneration preserves the original model assertion and full-asset pricing', async () => {
  const calls: string[] = [];
  const client = new StudioClient(credentials(), async (url) => {
    calls.push(url);
    assert.ok(url.endsWith('/image/get_image_asset'));
    return new Response(
      JSON.stringify({
        code: 0,
        data: {
          asset_id: 'asset',
          type: 'image',
          input: { model_version: 'original-engine', amount: 3, resolution: '4K' },
        },
      }),
    );
  });
  const input = normalize('image_process', {
    action: 'regenerate',
    asset_id: 'asset',
    model_version: 'original-engine',
  });
  const prepared = await prepareInput(client, 'image_process', input);
  assert.deepEqual(prepared._image_source, { model_version: 'original-engine', amount: 3, resolution: '4K' });
  await assert.rejects(prepareInput(client, 'image_process', { ...input, model_version: 'other-engine' }), {
    code: 'INVALID_INPUT',
  });
  assert.equal(calls.length, 2);
});

test('model generation rejects parameters that do not enter the chosen webpage branch', () => {
  const inputs: Record<string, unknown>[] = [
    { mode: 'image', image_path: 'image.png', prompt: 'red' },
    { mode: 'multiview', image_paths: ['front.png', 'back.png'], prompt: 'red' },
    { mode: 'text', prompt: 'cube', enable_image_autofix: true },
    { mode: 'multiview', image_paths: ['front.png', 'back.png'], enable_image_autofix: true },
    { mode: 'text', prompt: 'cube', model_version: 'Nexus-v2.0-20260801', geometry_quality: 'detailed' },
    { mode: 'text', prompt: 'cube', texture_quality: 'ultra' },
    { mode: 'text', prompt: 'cube', texture_alignment: 'geometry' },
    { mode: 'text', prompt: 'cube', delight: false },
    { mode: 'text', prompt: 'cube', generate_parts_level: 'fine' },
  ];
  for (const input of inputs) assert.throws(() => normalize('model', input), { name: 'ZodError' });
});

test('valid generation defaults and supported conditional settings still build their webpage requests', async () => {
  const operations = new Operations(
    new StudioClient(credentials(), async () => {
      throw new Error('Unexpected network request');
    }),
    [],
  );
  operations.imageReference = async () => ({
    bucket: 'fixture',
    key: 'fixture',
    image_audit_result: 'pass',
    image_source: 'generate',
  });
  for (const model_version of ['v3.1-20260211', 'v3.0-20250812', 'v2.5-20250123', 'Nexus-v2.0-20260801']) {
    const input = normalize('model', { mode: 'text', prompt: 'cube', model_version });
    const request = await operations.build({ ...batchJob(), operation: 'model', input });
    assert.equal(request.body.model_version, model_version);
  }
  const textured = normalize('model', {
    mode: 'text',
    prompt: 'cube',
    geometry_quality: 'detailed',
    texture: true,
    texture_quality: 'ultra',
    texture_alignment: 'geometry',
    delight: false,
  });
  const request = await operations.build({ ...batchJob(), operation: 'model', input: textured });
  assert.equal(request.body.geometry_quality, 'detailed');
  assert.equal(request.body.texture_quality, 'extreme');
  assert.equal(request.body.texture_alignment, 'geometry');
  assert.equal(request.body.delight, false);
  const parts = await operations.build({
    ...batchJob(),
    operation: 'model',
    input: normalize('model', {
      mode: 'text',
      prompt: 'cube',
      generate_parts: true,
      generate_parts_level: 'fine',
    }),
  });
  assert.equal(parts.body.segmentation_granularity, 'detailed');
  for (const source of [
    { mode: 'image', image_path: 'image.png' },
    { mode: 'batch', image_paths: ['one.png', 'two.png'] },
  ]) {
    const input = normalize('model', { ...source, enable_image_autofix: true });
    const request = await operations.build({ ...batchJob(), operation: 'model', input });
    assert.equal(request.body.enable_image_autofix, true);
  }
});

test('PBR and upscale reject ignored generation settings without rejecting their defaults', async () => {
  const reference = async () => {
    throw new Error('Unexpected image upload');
  };
  for (const action of ['pbr', 'upscale']) {
    for (const option of [{ delight: false }, { texture_alignment: 'geometry' }])
      assert.throws(() => normalize('texture', { project_id: 'project', action, ...option }), {
        name: 'ZodError',
      });
    const input = normalize('texture', { project_id: 'project', action });
    const request = await textureSubmission(input, reference);
    assert.equal(
      request.route,
      `/v2/studio/operation/${action === 'pbr' ? 'pbr_generate' : 'texture_upscaler'}`,
    );
  }
  assert.throws(
    () => normalize('texture', { project_id: 'project', action: 'pbr', texture_quality: 'ultra' }),
    /fixed engine/,
  );
  const upscale = await textureSubmission(
    normalize('texture', { project_id: 'project', action: 'upscale', texture_quality: 'ultra' }),
    reference,
  );
  assert.equal(upscale.body.texture_quality, 'extreme');
  const generated = await textureSubmission(
    normalize('texture', {
      project_id: 'project',
      action: 'generate',
      texture_quality: 'ultra',
      delight: false,
      texture_alignment: 'geometry',
    }),
    reference,
  );
  assert.equal(generated.body.texture_quality, 'extreme');
  assert.equal(generated.body.delight, false);
  assert.equal(generated.body.texture_alignment, 'geometry');
});

test('batch reconciliation fills unknown results by original project and preserves confirmed receipts', () => {
  const job = batchJob();
  const before = structuredClone(job);
  const remote = reconcileExportBatch(job, [
    { project_id: projects[1], operator_id: 'recovered' },
    { project_id: projects[0], operator_id: 'accepted' },
  ]);
  assert.deepEqual(remote.batch, [
    { project_id: projects[0], operator_id: 'accepted', code: 0 },
    { project_id: projects[1], operator_id: 'recovered', code: 0 },
  ]);
  assert.deepEqual(job, before);
});

test('batch reconciliation rejects unrelated, duplicate and replacement identities', () => {
  const job = batchJob();
  for (const supplied of [
    [{ project_id: 'unrelated', operator_id: 'other' }],
    [
      { project_id: projects[1], operator_id: 'recovered' },
      { project_id: projects[1], operator_id: 'recovered' },
    ],
  ])
    assert.throws(() => reconcileExportBatch(job, supplied), { code: 'INVALID_INPUT' });
  for (const supplied of [
    [{ project_id: projects[0], operator_id: 'replacement' }],
    [{ project_id: projects[1], operator_id: 'accepted' }],
  ])
    assert.throws(() => reconcileExportBatch(job, supplied), { code: 'IDEMPOTENCY_CONFLICT' });
  for (const supplied of [undefined, [], [{ project_id: projects[1] }]])
    assert.throws(() => reconcileExportBatch(job, supplied), { code: 'REMOTE_ID_MISSING' });
  job.remote_ids.batch![1]!.code = 400;
  assert.throws(() => reconcileExportBatch(job, [{ project_id: projects[1], operator_id: 'recovered' }]), {
    code: 'IDEMPOTENCY_CONFLICT',
  });
});

test('fully unknown batches preserve unresolved items and cannot reuse an operator', () => {
  const job = { ...batchJob(), remote_ids: {}, state: 'outcome_unknown' as const };
  const supplied = [{ project_id: projects[1], operator_id: 'recovered' }];
  assert.deepEqual(reconcileExportBatch(job, supplied).batch, [
    { project_id: projects[0], code: -1 },
    { project_id: projects[1], operator_id: 'recovered', code: 0 },
  ]);
  assert.throws(
    () => reconcileExportBatch(job, [...supplied, { project_id: projects[0], operator_id: 'recovered' }]),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
});

test('batch reconciliation refuses stored receipts inconsistent with original projects', () => {
  const job = batchJob();
  job.remote_ids.batch!.reverse();
  assert.throws(() => reconcileExportBatch(job, [{ project_id: projects[1], operator_id: 'recovered' }]), {
    code: 'CONTRACT_CHANGED',
  });
});

test('batch status retains successful artifacts while one receipt remains unknown', async () => {
  const polled: string[] = [];
  const status = await exportBatchStatus(batchJob(), async (child) => {
    polled.push(String(child.remote_ids.operator_id));
    return completed;
  });
  assert.deepEqual(polled, ['accepted']);
  assert.equal(status.state, 'failed');
  assert.equal(status.error?.code, 'PARTIAL_RECEIPT_UNKNOWN');
  assert.equal(status.artifacts[0]?.artifact_id, 'batch-0');
  assert.equal(status.artifacts.length, 1);
});

test('duplicate server operator identities remain unknown instead of binding two export projects', async () => {
  let writes = 0;
  const client = new StudioClient(credentials(), async (url, init) => {
    if (init.method === 'POST') {
      assert.ok(url.endsWith('/operation/export-batch'));
      writes++;
      return new Response(
        JSON.stringify({
          code: 0,
          data: { result: projects.map((project_id) => ({ project_id, operator_id: 'duplicate', code: 0 })) },
        }),
      );
    }
    return new Response(JSON.stringify({ code: 0, data: { is_owner: true, operator: {} } }));
  });
  const receipt = await submitExportBatch(client, [], batchJob());
  assert.equal(writes, 1);
  assert.deepEqual(
    receipt.remote_ids.batch,
    projects.map((project_id) => ({ project_id, code: -1 })),
  );
});

test('service reconciles batch receipts by polling only and does not commit unverifiable IDs', async () => {
  const f = await fixture();
  try {
    const source = batchJob();
    const job = f.jobs.prepare('test-account', 'export-reconcile', 'export_batch', source.input, quote);
    f.jobs.update(job.job_id, 'failed', { remote_ids: source.remote_ids, error: source.error });
    f.gateway.status = async () => {
      throw new Error('unverified remote receipt');
    };
    await assert.rejects(
      f.service.reconcile(job.job_id, { batch: [{ project_id: projects[1], operator_id: 'recovered' }] }),
      /unverified remote receipt/,
    );
    assert.deepEqual(f.jobs.get(job.job_id).remote_ids, source.remote_ids);
    const polled: string[] = [];
    f.gateway.status = (pending) =>
      exportBatchStatus(pending, async (child) => {
        polled.push(String(child.remote_ids.operator_id));
        return completed;
      });
    await f.service.reconcile(job.job_id, {
      batch: [{ project_id: projects[1], operator_id: 'recovered' }],
    });
    const saved = f.jobs.get(job.job_id);
    assert.equal(saved.state, 'succeeded');
    assert.deepEqual(
      saved.artifacts.map((a) => a.artifact_id),
      ['batch-0', 'batch-1'],
    );
    assert.deepEqual(polled, ['accepted', 'recovered']);
    assert.equal(f.gateway.posts, 0);
    assert.deepEqual(saved.remote_ids.batch?.[0], source.remote_ids.batch?.[0]);
    assert.equal(saved.remote_ids.batch?.[1]?.operator_id, 'recovered');
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
