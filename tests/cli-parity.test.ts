/** 新增兼容边界用真实解析器和可控网页回执验证，不用帮助文案充当功能验收。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generation, processingPlan, orderViews } from '../cli/compat/planning.ts';
import { fullToolPlan } from '../cli/compat/full-tools.ts';
import { submitExportBatch, exportBatchStatus } from '../studio/api/export-batch.ts';
import { exportBatchSchema } from '../studio/contracts/export-batch.ts';
import { StudioClient } from '../studio/api/client.ts';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import type { Job } from '../studio/contracts/types.ts';
import { JobStore } from '../cli/storage/jobs.ts';
import { quote } from './helpers.ts';
const exec = promisify(execFile);
test('P2 face budgets use its actual triangle/quad windows; P1 and HD retain their own limits', () => {
  assert.equal(
    generation('text-to-model', ['cube'], { model: 'P2-20260801', param: { face_limit: 48 } }).parameters
      .face_limit,
    48,
  );
  assert.throws(() => generation('text-to-model', ['cube'], { param: { face_limit: 47 } }));
  assert.throws(() => generation('text-to-model', ['cube'], { param: { face_limit: 25001, quad: true } }));
  assert.equal(
    generation('text-to-model', ['cube'], { model: 'tripo-p1', param: { face_limit: 50 } }).parameters
      .face_limit,
    50,
  );
  assert.throws(() =>
    generation('text-to-model', ['cube'], { model: 'tripo-v3.1', param: { face_limit: 100 } }),
  );
});
test('convert remesh and export are separate validated steps; unsupported flags fail before submission', () => {
  const plan = processingPlan('convert', '@example', { format: 'FBX', faceLimit: 1000, quad: true });
  assert.deepEqual(
    plan.steps.map((step) => step.operation),
    ['remesh', 'export'],
  );
  assert.equal(plan.steps[0]?.parameters.face_limit, 1000);
  assert.equal(plan.steps[1]?.source, 'upstream');
  assert.equal(plan.steps[1]?.parameters.face_limit, undefined);
  assert.throws(() => processingPlan('convert', '@example', { format: 'GLTF', textureFormat: 'OPEN_EXR' }));
});
test('named multiviews retain missing slots, including explicit MCP front/back inputs', () => {
  assert.deepEqual(orderViews(['back.png', 'front.png']), ['front.png', null, 'back.png', null]);
  const plan = fullToolPlan('ai_modeling_multiview_to_3d', {
    front: '/tmp/a.png',
    back: '/tmp/b.png',
    dry_run: true,
  });
  assert.deepEqual(plan.steps[0]?.parameters.image_paths, ['/tmp/a.png', null, '/tmp/b.png', null]);
});
test('headless CLI emits exactly one JSON line, and full MCP routes generation through the same planner', async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'ai-modeling-cli-parity-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const env = {
    ...process.env,
    AI_MODELING_DATA_DIR: path.join(temporary, 'data'),
    AI_MODELING_OUTPUT_DIR: path.join(temporary, 'output'),
    AI_MODELING_PROFILE: 'parity-isolated',
    MODELING_TEST_SANDBOX: temporary,
    NODE_OPTIONS: `--import=${new URL('./isolation-hook.ts', import.meta.url).href}`,
  };
  const { stdout } = await exec(
    process.execPath,
    [
      'cli/main.ts',
      'generate',
      'text-to-model',
      'cube',
      '--model',
      'tripo-p2',
      '-p',
      'face_limit=100',
      '--dry-run',
      '--json',
    ],
    { env, timeout: 30000 },
  );
  assert.equal(stdout.trim().split('\n').length, 1);
  assert.equal(JSON.parse(stdout).steps[0].parameters.face_limit, 100);
  const result = await exec(
    process.execPath,
    [
      'cli/main.ts',
      'call',
      'ai_modeling_text_to_3d',
      '--input',
      JSON.stringify({ prompt: 'cube', face_limit: 100, dry_run: true }),
      '--toolset',
      'full',
    ],
    { env, timeout: 30000 },
  );
  assert.equal(JSON.parse(result.stdout).result.steps[0].parameters.face_limit, 100);
});
test('pipeline membership is explicit and isolated even with similar request IDs', () => {
  const store = new JobStore(':memory:');
  try {
    const a = store.prepare('a', 'intent-0', 'model', {}, quote);
    const b = store.prepare('a', 'intent-1', 'export', {}, quote);
    const c = store.prepare('b', 'intent-1', 'export', {}, quote);
    store.linkStep('a', 'run', 0, a.job_id);
    store.linkStep('a', 'run', 1, b.job_id);
    assert.deepEqual(
      store.pipeline('a', b.job_id).map((j) => j.job_id),
      [a.job_id, b.job_id],
    );
    assert.deepEqual(store.pipeline('b', b.job_id), []);
    assert.throws(() => store.linkStep('a', 'run', 1, c.job_id), { code: 'ACCOUNT_MISMATCH' });
    assert.throws(() => store.linkStep('a', 'run', 1, a.job_id), { code: 'IDEMPOTENCY_CONFLICT' });
  } finally {
    store.close();
  }
});
test('native batch submits once and retains accepted items when another receipt is missing', async () => {
  const ids = ['797542b3-f4a1-4c20-8f42-77a9fcaef359', '92225f11-b0e4-4201-b9a8-33ff81a29e09'];
  const requests: { url: string; body: unknown }[] = [];
  const client = new StudioClient(
    new MemoryCredentials({ accountRef: 'a', cookie: 'fixture', deviceId: 'test', importedAt: '' }),
    async (url, init) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ url, body });
      const data = url.includes('detail/v3')
        ? { id: url.split('/').at(-1), is_owner: true, operator: { is_owner: true } }
        : { result: [{ project_id: ids[0], operator_id: 'operator-1', code: 0 }] };
      return new Response(JSON.stringify({ code: 0, data }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  );
  const job: Job = {
    job_id: 'local-batch',
    account_ref: 'a',
    request_id: 'batch-test',
    input_hash: 'fixture',
    operation: 'export_batch',
    input: exportBatchSchema.parse({ projects: ids }),
    remote_ids: {},
    contract_version: 'test',
    state: 'submitting',
    quote,
    progress: 0,
    artifacts: [],
    created_at: '2026-11-12T00:00:00Z',
    updated_at: '2026-11-12T00:00:00Z',
    lease_until: 0,
  };
  const accepted = await submitExportBatch(client, [], job);
  assert.equal(requests.filter((r) => r.url.endsWith('export-batch')).length, 1);
  assert.deepEqual(
    accepted.remote_ids.batch?.map((r) => r.code),
    [0, -1],
  );
  const status = await exportBatchStatus({ ...job, ...accepted }, async (child) => {
    assert.equal(child.remote_ids.operator_id, 'operator-1');
    return {
      state: 'succeeded',
      progress: 100,
      artifacts: [{ artifact_id: 'model-0', kind: 'model', format: 'glb', index: 0 }],
    };
  });
  assert.equal(status.state, 'failed');
  assert.equal(status.error?.code, 'PARTIAL_RECEIPT_UNKNOWN');
  assert.equal(status.artifacts[0]?.artifact_id, 'batch-0');
});
