/** 批量恢复必须同时保留原任务和真实交付状态，不能因远端成功而永久跳过失败下载。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { fixture, tinyGlb, imageInput } from './helpers.ts';
import { loadBatch, runBatch } from '../cli/compat/batch.ts';
import type { Application } from '../cli/compat/runtime.ts';
import { download } from '../cli/artifacts/download.ts';
import { recoverDownload } from '../cli/artifacts/recover-download.ts';
import { object, text, TripoError } from '../studio/contracts/errors.ts';
import type { Artifact, Job } from '../studio/contracts/types.ts';
import { StudioClient } from '../studio/api/client.ts';
import { StudioGateway } from '../studio/api/gateway.ts';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { MemoryLinks } from '../studio/auth/artifact-links.ts';

async function batchFixture(): Promise<
  Awaited<ReturnType<typeof fixture>> & {
    app: Application;
    batch: Awaited<ReturnType<typeof loadBatch>>;
  }
> {
  const f = await fixture();
  f.gateway.status = async () => ({
    state: 'succeeded',
    progress: 100,
    artifacts: [{ artifact_id: 'model', kind: 'model', format: 'glb', index: 0 }],
  });
  const file = path.join(f.dir, 'batch.yaml');
  await writeFile(
    file,
    'defaults:\n  params:\n    texture: false\njobs:\n  - input: a blue cube\n    name: cube\n    out: ' +
      JSON.stringify(path.join(f.dir, 'output', 'cube')) +
      '\n',
  );
  return { ...f, app: { service: f.service } as Application, batch: await loadBatch(file) };
}
async function cacheModel(
  f: Awaited<ReturnType<typeof batchFixture>>,
  result: Record<string, unknown>,
): Promise<string> {
  const id = text(object(object(result.jobs).cube).task_id),
    bytes = tinyGlb();
  const source = path.join(f.dir, 'original.glb');
  await writeFile(source, bytes);
  f.jobs.saveArtifact(id, {
    ...f.jobs.get(id).artifacts[0]!,
    local_path: source,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  return id;
}

test('batch retries failed downloads for the original task and never counts them as completed', async () => {
  const f = await batchFixture();
  let reads = 0;
  f.gateway.artifactUrl = async () => {
    reads++;
    throw new TripoError('DOWNLOAD_FAILED', 'Controlled link failure', 'read');
  };
  try {
    const first = await runBatch(f.app, f.batch, {});
    assert.equal(first.success, 0);
    assert.equal(first.needs_attention, 1);
    const id = await cacheModel(f, first);
    const resumed = await runBatch(f.app, f.batch, {});
    assert.equal(resumed.success, 1);
    assert.equal(resumed.needs_attention, 0);
    assert.equal(object(object(resumed.jobs).cube).task_id, id);
    assert.equal(f.gateway.posts, 1);
    assert.equal(reads, 2);
    const completed = await runBatch(f.app, f.batch, {});
    assert.equal(completed.success, 1);
    assert.equal(reads, 2);
    const output = text(object(object(resumed.jobs).cube).model_file);
    await rm(output);
    const missing = await runBatch(f.app, f.batch, {});
    assert.equal(missing.success, 0);
    assert.equal(missing.needs_attention, 1);
    assert.equal(f.gateway.posts, 1);
    assert.equal(reads, 3);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('no-download batches finish without files and can later download the same original tasks', async () => {
  const f = await batchFixture();
  let reads = 0;
  f.gateway.artifactUrl = async () => {
    reads++;
    throw new TripoError('DOWNLOAD_FAILED', 'Controlled link failure', 'read');
  };
  try {
    const first = await runBatch(f.app, f.batch, { download: false });
    assert.equal(first.success, 1);
    assert.equal(reads, 0);
    assert.equal((await runBatch(f.app, f.batch, { download: false })).success, 1);
    const id = await cacheModel(f, first);
    const downloaded = await runBatch(f.app, f.batch, {});
    assert.equal(downloaded.success, 1);
    assert.equal(reads, 1);
    assert.equal(object(object(downloaded.jobs).cube).task_id, id);
    assert.equal(f.gateway.posts, 1);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('batch timeout and unknown receipts keep their original run and task IDs when resumed', async () => {
  for (const unknown of [false, true]) {
    const f = await batchFixture();
    if (unknown)
      f.gateway.failSubmit = new TripoError('NETWORK_ERROR', 'Controlled lost response', 'unknown');
    else f.gateway.status = async () => ({ state: 'running', progress: 25, artifacts: [] });
    try {
      const first = await runBatch(f.app, f.batch, { download: false, timeout: 0, retries: 3 });
      const firstJob = object(object(first.jobs).cube);
      const state = JSON.parse(await readFile(f.batch.file + '.state.json', 'utf8')) as { run_id: string };
      assert.equal(first.success, 0);
      assert.equal(first.needs_attention, 1);
      if (!unknown) f.gateway.status = async () => ({ state: 'succeeded', progress: 100, artifacts: [] });
      const resumed = await runBatch(f.app, f.batch, { download: false, timeout: 0, retries: 3 });
      const resumedJob = object(object(resumed.jobs).cube);
      assert.equal(resumedJob.task_id, firstJob.task_id);
      assert.equal(resumedJob.request_id, firstJob.request_id);
      assert.equal(
        (JSON.parse(await readFile(f.batch.file + '.state.json', 'utf8')) as { run_id: string }).run_id,
        state.run_id,
      );
      assert.equal(resumed.success, unknown ? 0 : 1);
      assert.equal(f.gateway.posts, 1);
      if (unknown) assert.equal(resumedJob.status, 'outcome_unknown');
    } finally {
      f.jobs.close();
      await rm(f.dir, { recursive: true, force: true });
    }
  }
});

test('verified JPEG cache restores either explicit JPEG suffix without replacing existing files', async () => {
  const f = await fixture();
  try {
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'blue' } })
      .jpeg()
      .toBuffer();
    const saved = await download(
      'https://cdn.tripo3d.ai/test',
      f.service.config.outputDir,
      'source.jpg',
      'image',
      async () => new Response(new Uint8Array(bytes)),
    );
    const artifact: Artifact = { artifact_id: 'image-0', kind: 'image', index: 0, ...saved };
    const job = { operation: 'image', input: {} } as Job;
    const error = new TripoError('DOWNLOAD_FAILED', 'Controlled link failure', 'read');
    for (const suffix of ['jpg', 'jpeg']) {
      const dest = { root: f.service.config.outputDir, relative: 'restored.' + suffix };
      const restored = await recoverDownload(job, artifact, dest, error);
      assert.equal(restored.format, 'jpeg');
      assert.equal(restored.restored_from_cache, true);
      assert.deepEqual(await readFile(text(restored.local_path)), bytes);
      await assert.rejects(recoverDownload(job, artifact, dest, error), { code: 'OUTPUT_EXISTS' });
    }
    await assert.rejects(
      recoverDownload(job, artifact, { root: f.service.config.outputDir, relative: 'wrong.png' }, error),
      { code: 'OUTPUT_EXTENSION' },
    );
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

function identityGateway(response: () => Record<string, unknown>): StudioGateway {
  const credentials = new MemoryCredentials({
    accountRef: 'fixture',
    cookie: 'fixture',
    deviceId: 'fixture',
    importedAt: '',
  });
  return new StudioGateway(
    new StudioClient(credentials, async () => Response.json({ code: 0, data: response() })),
    [],
    new MemoryLinks(),
  );
}
const originalJob = {
  job_id: 'identity-fixture',
  account_ref: 'fixture',
  operation: 'model',
  input: {},
  remote_ids: { project_id: 'original-project', operator_id: 'original-operator' },
} as Job;
const originalArtifact: Artifact = { artifact_id: 'model', kind: 'model', format: 'glb', index: 0 };

test('ordinary historical model downloads reject another project or operator instead of taking its URL', async () => {
  let detail: Record<string, unknown> = {};
  const gateway = identityGateway(() => detail);
  for (const operation of ['model', 'texture', 'segment', 'rig'] as const) {
    const job = { ...originalJob, operation };
    detail = {
      id: 'original-project',
      operator: { operator_id: 'original-operator' },
      model_url: 'https://cdn.tripo3d.ai/original.glb',
    };
    assert.equal(await gateway.artifactUrl(job, originalArtifact), 'https://cdn.tripo3d.ai/original.glb');
    detail = { ...detail, id: 'different-project' };
    await assert.rejects(gateway.artifactUrl(job, originalArtifact), { code: 'CONTRACT_CHANGED' });
    detail = { ...detail, id: 'original-project', operator: { operator_id: 'newer-operator' } };
    await assert.rejects(gateway.artifactUrl(job, originalArtifact), { code: 'CONTRACT_CHANGED' });
  }
});

test('animation selects its original retarget under the parent model and copy can learn its first operator', async () => {
  let detail: Record<string, unknown> = {
    id: 'original-project',
    operator: {
      operator_id: 'parent-model',
      retarget: [
        { operator_id: 'original-operator', model_url: 'https://cdn.tripo3d.ai/original-motion.glb' },
      ],
    },
  };
  const gateway = identityGateway(() => detail),
    animation = { ...originalJob, operation: 'animate' } as Job;
  assert.equal(
    await gateway.artifactUrl(animation, originalArtifact),
    'https://cdn.tripo3d.ai/original-motion.glb',
  );
  detail = {
    id: 'original-project',
    operator: {
      operator_id: 'parent-model',
      retarget: [{ operator_id: 'different-motion', model_url: 'https://cdn.tripo3d.ai/other.glb' }],
    },
  };
  await assert.rejects(gateway.artifactUrl(animation, originalArtifact), { code: 'ARTIFACT_NOT_READY' });
  detail = { id: 'original-project', operator: { operator_id: 'copied-model', status: 'success' } };
  const copy = { ...originalJob, operation: 'copy', remote_ids: { project_id: 'original-project' } } as Job;
  assert.deepEqual((await gateway.status(copy)).remote_ids, {
    project_id: 'original-project',
    operator_id: 'copied-model',
  });
  detail.id = 'wrong-copy';
  await assert.rejects(gateway.status(copy), { code: 'CONTRACT_CHANGED' });
});

test('export download validates echoed IDs but a URL-only receipt cannot independently prove its identity', async () => {
  let response: Record<string, unknown> = { model_url: 'https://cdn.tripo3d.ai/export.glb' };
  let requested: Record<string, unknown> = {};
  const credentials = new MemoryCredentials({
    accountRef: 'fixture',
    cookie: 'fixture',
    deviceId: 'fixture',
    importedAt: '',
  });
  const gateway = new StudioGateway(
    new StudioClient(credentials, async (_url, init) => {
      requested = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Response.json({ code: 0, data: response });
    }),
    [],
    new MemoryLinks(),
  );
  const job = { ...originalJob, operation: 'export' } as Job;
  assert.equal(await gateway.artifactUrl(job, originalArtifact), 'https://cdn.tripo3d.ai/export.glb');
  assert.equal(requested.operator_id, 'original-operator');
  for (const extra of [{ operator_id: 'another-export' }, { project_id: 'another-project' }]) {
    response = { model_url: 'https://cdn.tripo3d.ai/other.glb', ...extra };
    await assert.rejects(gateway.artifactUrl(job, originalArtifact), { code: 'CONTRACT_CHANGED' });
  }
});

test('concurrent single-result reconciliation cannot replace an already confirmed receipt', async () => {
  const f = await fixture();
  const releases: (() => void)[] = [];
  let bothEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    bothEntered = resolve;
  });
  try {
    f.gateway.failSubmit = new TripoError('NETWORK_ERROR', 'Controlled lost receipt', 'unknown');
    const created = await f.service.submit('image', 'reconcile-race', imageInput, 10);
    f.gateway.status = async () => {
      await new Promise<void>((resolve) => {
        releases.push(resolve);
        if (releases.length === 2) bothEntered();
      });
      return { state: 'succeeded', progress: 100, artifacts: [] };
    };
    const left = f.service.reconcile(text(created.job_id), { asset_id: 'first-receipt' });
    const right = f.service.reconcile(text(created.job_id), { asset_id: 'different-receipt' });
    await entered;
    releases[0]!();
    await left;
    releases[1]!();
    await assert.rejects(right, { code: 'RECONCILE_CONFLICT' });
    assert.equal(f.jobs.get(text(created.job_id)).remote_ids.asset_id, 'first-receipt');
    assert.equal(f.gateway.posts, 1);
  } finally {
    releases.forEach((release) => release());
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
