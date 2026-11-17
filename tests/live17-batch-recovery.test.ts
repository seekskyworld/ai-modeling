/** 默认 P2 多步生成链必须跨批次重启保留每一步，交付检查始终绑定真实输出任务。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, tinyGlb } from './helpers.ts';
import { loadBatch, runBatch } from '../cli/compat/batch.ts';
import type { Application } from '../cli/compat/runtime.ts';
import type { Job } from '../studio/contracts/types.ts';
import { array, object, text, TripoError } from '../studio/contracts/errors.ts';

function runtime(
  f: Awaited<ReturnType<typeof fixture>>,
  calls: Job[],
  downloads: string[],
  loseTexture = false,
): Application {
  f.gateway.submit = async (job) => {
    calls.push(structuredClone(job));
    if (loseTexture && job.operation === 'texture' && job.input.action === 'generate')
      throw new TripoError('NETWORK_ERROR', 'Controlled lost texture receipt', 'unknown');
    return {
      remote_ids: {
        project_id: job.operation === 'model' ? `project-${job.job_id}` : text(job.input.project_id),
        operator_id: `operator-${job.job_id}`,
      },
    };
  };
  f.gateway.status = async (job) => ({
    state: 'succeeded',
    progress: 100,
    artifacts: [
      {
        artifact_id:
          job.operation === 'model'
            ? 'geometry'
            : job.operation === 'texture'
              ? `texture-${job.input.action}`
              : 'model',
        kind: 'model',
        format: 'glb',
        index: 0,
      },
    ],
  });
  f.service.download = async (id, artifactId, destination) => {
    downloads.push(id);
    const bytes = tinyGlb();
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: 'wx' });
    const saved = {
      local_path: destination,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      format: 'glb',
    };
    const artifact = f.jobs.get(id).artifacts.find((item) => item.artifact_id === artifactId)!;
    assert.ok(artifact);
    f.jobs.saveArtifact(id, { ...artifact, ...saved });
    return { job_id: id, artifact_id: artifactId, ...saved };
  };
  return {
    service: f.service,
    studio: {
      client: {
        request: async (method: string, route: string) => {
          if (method !== 'GET' || !route.startsWith('/v2/studio/project/detail/v3/'))
            throw new Error('Unexpected external query');
          const project = decodeURIComponent(route.split('/').at(-1)!);
          const source = calls
            .filter(
              (job) =>
                job.operation !== 'export' &&
                (job.operation === 'model' ? `project-${job.job_id}` : text(job.input.project_id)) ===
                  project,
            )
            .at(-1);
          if (!source) throw new Error('Unexpected export source');
          return {
            id: project,
            is_owner: true,
            operator: { operator_id: `operator-${source.job_id}`, is_rigged: false, retarget: [] },
          };
        },
      },
    },
  } as unknown as Application;
}

test('default textured and explicit PBR batch chains survive restart and download recovery without new submissions', async () => {
  const f = await fixture(),
    calls: Job[] = [],
    downloads: string[] = [];
  const app = runtime(f, calls, downloads);
  const file = path.join(f.dir, 'default-p2.json');
  try {
    await writeFile(
      file,
      JSON.stringify({
        concurrency: 2,
        defaults: { out: path.join(f.dir, 'out') },
        jobs: [
          { name: '__proto__', input: 'a blue cube' },
          { name: 'pbr', input: 'a red ball', params: { pbr: true } },
        ],
      }),
    );
    const batch = await loadBatch(file);
    const first = await runBatch(app, batch, { download: false });
    assert.equal(first.success, 2);
    assert.equal(calls.length, 5);
    assert.equal(downloads.length, 0);
    const state = object(JSON.parse(await readFile(file + '.state.json', 'utf8')));
    const identities = Object.fromEntries(
      Object.entries(object(first.jobs)).map(([name, item]) => [
        name,
        array(object(item).chain).map((step) => text(object(step).task_id)),
      ]),
    );
    for (const [name, ids] of Object.entries(identities)) {
      const jobs = ids.map((id) => f.jobs.get(id));
      assert.deepEqual(
        jobs.map((job) => job.operation),
        name === 'pbr' ? ['model', 'texture', 'texture'] : ['model', 'texture'],
      );
      assert.equal(jobs[0]!.input.texture, false);
      assert.equal(jobs[1]!.input.action, 'generate');
      if (name === 'pbr') assert.equal(jobs[2]!.input.action, 'pbr');
      for (let index = 1; index < jobs.length; index++)
        assert.equal(jobs[index]!.input.expected_operator_id, jobs[index - 1]!.remote_ids.operator_id);
    }
    const restarted = await fixture(f.dir),
      after: Job[] = [];
    const next = runtime(restarted, after, downloads);
    try {
      assert.equal((await runBatch(next, await loadBatch(file), { download: false })).success, 2);
      assert.equal(after.length, 0);
      const delivered = await runBatch(next, batch, {});
      assert.equal(delivered.success, 2);
      assert.equal(downloads.length, 2);
      assert.equal(after.length, 0);
      for (const [name, item] of Object.entries(object(delivered.jobs)))
        assert.deepEqual(
          array(object(item).chain).map((step) => text(object(step).task_id)),
          identities[name],
        );
      const missing = text(object(object(delivered.jobs).pbr).model_file);
      await rm(missing);
      assert.equal((await runBatch(next, batch, {})).success, 2);
      assert.equal(downloads.length, 3);
      assert.deepEqual(await readFile(missing), tinyGlb());
      assert.equal((await runBatch(next, batch, {})).success, 2);
      assert.equal(downloads.length, 3);
      assert.equal(after.length, 0);
      assert.equal(restarted.jobs.list('test-account').length, 5);
      assert.equal(object(JSON.parse(await readFile(file + '.state.json', 'utf8'))).run_id, state.run_id);
    } finally {
      restarted.jobs.close();
    }
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('batch restart preserves an unknown middle texture and submits PBR only after explicit reconciliation', async () => {
  const f = await fixture(),
    calls: Job[] = [],
    downloads: string[] = [];
  const file = path.join(f.dir, 'unknown-texture.json');
  try {
    await writeFile(
      file,
      JSON.stringify({ jobs: [{ name: 'cube', input: 'blue cube', params: { pbr: true } }] }),
    );
    const batch = await loadBatch(file);
    const first = await runBatch(runtime(f, calls, downloads, true), batch, { download: false });
    const unknown = object(object(first.jobs).cube);
    assert.equal(unknown.status, 'outcome_unknown');
    assert.equal(calls.length, 2);
    const originalIds = f.jobs
      .list('test-account')
      .map((job) => job.job_id)
      .sort();
    const restarted = await fixture(f.dir),
      after: Job[] = [];
    const next = runtime(restarted, after, downloads);
    try {
      const resumed = object(
        object((await runBatch(next, batch, { download: false, retries: 3 })).jobs).cube,
      );
      assert.equal(resumed.task_id, unknown.task_id);
      assert.equal(resumed.status, 'outcome_unknown');
      assert.equal(after.length, 0);
      assert.deepEqual(
        restarted.jobs
          .list('test-account')
          .map((job) => job.job_id)
          .sort(),
        originalIds,
      );
      const lost = restarted.jobs.get(text(unknown.task_id));
      await restarted.service.reconcile(lost.job_id, {
        project_id: lost.input.project_id,
        operator_id: `original-${lost.job_id}`,
      });
      const completed = await runBatch(next, batch, { download: false });
      assert.equal(completed.success, 1);
      assert.equal(after.length, 1);
      assert.equal(after[0]!.input.action, 'pbr');
      assert.equal(after[0]!.input.expected_operator_id, `original-${lost.job_id}`);
      assert.equal(array(object(object(completed.jobs).cube).chain).length, 3);
      assert.equal((await runBatch(next, batch, { download: false })).success, 1);
      assert.equal(after.length, 1);
    } finally {
      restarted.jobs.close();
    }
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('AR generation delivery is tied to the last textured task and old unidentified receipts recover only original work', async () => {
  const f = await fixture(),
    calls: Job[] = [],
    downloads: string[] = [];
  const app = runtime(f, calls, downloads);
  const file = path.join(f.dir, 'ar-prefix.json');
  try {
    await writeFile(
      file,
      JSON.stringify({
        jobs: [{ name: 'ar', input: 'blue cube', for: 'ar-web', out: path.join(f.dir, 'out') }],
      }),
    );
    const batch = await loadBatch(file);
    const first = await runBatch(app, batch, {});
    assert.equal(first.success, 1);
    assert.equal(calls.length, 3);
    assert.equal(downloads.length, 2);
    const result = object(object(first.jobs).ar);
    const chain = array(result.chain).map(object);
    const delivery = object(array(result.generation_downloads)[0]);
    assert.equal(delivery.task_id, chain[1]!.task_id);
    assert.notEqual(
      object(array(chain[0]!.artifacts)[0]).artifact_id,
      object(array(chain[1]!.artifacts)[0]).artifact_id,
    );
    let reads = 0;
    const get = f.service.get.bind(f.service);
    f.service.get = async (...args) => {
      reads++;
      return get(...args);
    };
    assert.equal((await runBatch(app, batch, {})).success, 1);
    assert.equal(reads, 0);
    const saved = object(JSON.parse(await readFile(file + '.state.json', 'utf8')));
    delete object(array(object(object(saved.jobs).ar).generation_downloads)[0]).task_id;
    await writeFile(file + '.state.json', JSON.stringify(saved));
    const rebuilt = await runBatch(app, batch, {});
    assert.equal(rebuilt.success, 1);
    assert.ok(reads > 0);
    assert.equal(calls.length, 3);
    assert.equal(downloads.length, 2);
    const restored = object(array(object(object(rebuilt.jobs).ar).generation_downloads)[0]);
    assert.equal(restored.task_id, delivery.task_id);
    const beforeReads = reads;
    await runBatch(app, batch, {});
    assert.equal(reads, beforeReads);
    const missing = text(object(array(restored.file_records)[0]).local_path);
    await rm(missing);
    assert.equal((await runBatch(app, batch, {})).success, 1);
    assert.equal(calls.length, 3);
    assert.equal(downloads.length, 3);
    assert.deepEqual(await readFile(missing), tinyGlb());
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
