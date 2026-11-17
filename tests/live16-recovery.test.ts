/** 新一轮组合回归仅使用临时数据库与受控上游，不访问本人任务或真实服务。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fixture, tinyGlb, quote } from './helpers.ts';
import { loadBatch, runBatch } from '../cli/compat/batch.ts';
import { waitTask, type Application } from '../cli/compat/runtime.ts';
import { array, object, text, TripoError } from '../studio/contracts/errors.ts';
import { StudioGateway } from '../studio/api/gateway.ts';
import { StudioClient } from '../studio/api/client.ts';
import { MemoryLinks } from '../studio/auth/artifact-links.ts';
import { exportBatchStatus, batchChild } from '../studio/api/export-batch.ts';
import {
  expectedModelCount,
  modelResults,
  modelResultChild,
  modelResultsStatus,
  reconcileModelResults,
} from '../studio/api/model-results.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import type { Job, RemoteStatus } from '../studio/contracts/types.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const appFor = (f: Awaited<ReturnType<typeof fixture>>): Application =>
  ({ service: f.service, studio: f.gateway, close: () => {} }) as unknown as Application;

test('batch validates every local input before allowing any prior valid item to submit', async () => {
  const f = await fixture();
  const file = path.join(f.dir, 'preflight.json');
  try {
    await writeFile(
      file,
      JSON.stringify({
        concurrency: 1,
        jobs: [
          { name: 'valid', input: 'a blue cube' },
          { name: 'missing', input: path.join(f.dir, 'missing.png') },
        ],
      }),
    );
    await assert.rejects(async () => runBatch(appFor(f), await loadBatch(file), { download: false }), {
      code: 'INVALID_INPUT',
    });
    assert.equal(f.gateway.posts, 0);
    assert.equal(f.jobs.list('test-account').length, 0);
    // URL 只入计划，清单预检不能偷偷下载远程输入。
    await writeFile(file, JSON.stringify({ jobs: [{ input: 'https://example.invalid/cube.png' }] }));
    assert.equal((await loadBatch(file)).manifest.jobs.length, 1);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('batch preserves prototype-like legal names across state serialization and restart', async () => {
  const f = await fixture();
  const file = path.join(f.dir, 'names.json');
  const names = ['__proto__', 'constructor', 'toString'];
  try {
    await writeFile(
      file,
      JSON.stringify({
        concurrency: 1,
        defaults: { params: { texture: false } },
        jobs: names.map((name) => ({ name, input: 'a blue cube' })),
      }),
    );
    const batch = await loadBatch(file);
    const first = await runBatch(appFor(f), batch, { download: false });
    assert.equal(first.success, names.length);
    assert.equal(first.stopped, 0);
    assert.equal(f.gateway.posts, names.length);
    const saved = object(JSON.parse(await readFile(file + '.state.json', 'utf8')));
    assert.deepEqual(Object.keys(object(saved.jobs)), names);
    const second = await fixture(f.dir);
    try {
      const resumed = await runBatch(appFor(second), batch, { download: false });
      assert.equal(resumed.success, names.length);
      assert.equal(second.gateway.posts, 0);
      assert.deepEqual(JSON.parse(JSON.stringify(resumed.jobs)), JSON.parse(JSON.stringify(first.jobs)));
      assert.equal(object(JSON.parse(await readFile(file + '.state.json', 'utf8'))).run_id, saved.run_id);
      // 旧版普通对象可能已经丢掉 __proto__ 项；同一 run_id 必须从原任务恢复，不能另提一次。
      delete object(saved.jobs).__proto__;
      await writeFile(file + '.state.json', JSON.stringify(saved));
      const repaired = await runBatch(appFor(second), batch, { download: false });
      assert.equal(repaired.success, names.length);
      assert.equal(
        object(object(repaired.jobs).__proto__).task_id,
        object(object(first.jobs).__proto__).task_id,
      );
      assert.equal(second.gateway.posts, 0);
    } finally {
      second.jobs.close();
    }
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('AR batch recovery verifies the original generation delivery as well as the final export', async () => {
  const f = await fixture();
  const file = path.join(f.dir, 'ar.json');
  let downloads = 0;
  let sourceReads = 0;
  Object.assign(f.gateway, {
    client: {
      request: async (method: string, route: string) => {
        assert.equal(method, 'GET');
        assert.equal(route, '/v2/studio/project/detail/v3/controlled-project');
        const source = f.jobs.list('test-account', 100).find((job) => job.operation === 'texture');
        assert.ok(source);
        sourceReads++;
        return {
          id: 'controlled-project',
          is_owner: true,
          operator: { operator_id: source.remote_ids.operator_id, is_rigged: false, retarget: [] },
        };
      },
    },
  });
  f.gateway.submit = async (job) => {
    f.gateway.posts++;
    return { remote_ids: { project_id: 'controlled-project', operator_id: job.job_id } };
  };
  f.gateway.status = async () => ({
    state: 'succeeded',
    progress: 100,
    artifacts: [{ artifact_id: 'model', kind: 'model', format: 'glb', index: 0 }],
  });
  f.service.download = async (id, artifactId, destination) => {
    downloads++;
    const bytes = tinyGlb();
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: 'wx' });
    const saved = {
      local_path: destination,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      format: 'glb',
    };
    f.jobs.saveArtifact(id, { ...f.jobs.get(id).artifacts[0]!, ...saved });
    return { job_id: id, artifact_id: artifactId, ...saved };
  };
  try {
    await writeFile(
      file,
      JSON.stringify({
        jobs: [{ name: 'ar', input: 'a cube', for: 'ar-web', out: path.join(f.dir, 'out') }],
      }),
    );
    const batch = await loadBatch(file);
    const first = await runBatch(appFor(f), batch, {});
    assert.equal(first.success, 1);
    const firstResult = object(object(first.jobs).ar);
    assert.deepEqual(
      array(firstResult.chain).map((step) => f.jobs.get(text(object(step).task_id)).operation),
      ['model', 'texture', 'export'],
    );
    const generation = object(array(firstResult.generation_downloads)[0]);
    assert.equal(generation.task_id, object(array(firstResult.chain)[1]).task_id);
    const generatedPath = text(object(array(generation.file_records)[0]).local_path);
    assert.equal(downloads, 2);
    await rm(generatedPath);
    const resumed = await runBatch(appFor(f), batch, {});
    assert.equal(resumed.success, 1);
    assert.deepEqual(await readFile(generatedPath), tinyGlb());
    assert.equal(downloads, 3);
    assert.equal(f.gateway.posts, 3);
    assert.equal(sourceReads, 1);
    const resumedResult = object(object(resumed.jobs).ar);
    assert.equal(resumedResult.task_id, firstResult.task_id);
    assert.deepEqual(
      array(resumedResult.chain).map((entry) => object(entry).task_id),
      array(firstResult.chain).map((entry) => object(entry).task_id),
    );
    await runBatch(appFor(f), batch, {});
    assert.equal(downloads, 3);
    assert.equal(f.gateway.posts, 3);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('mismatched processing and immediate export receipts remain unknown without saving foreign links', async () => {
  const f = await fixture();
  const links = new MemoryLinks();
  let posts = 0;
  const gateway = new StudioGateway(
    new StudioClient(f.service.credentials, async (_url, init) => {
      if (init.method === 'GET')
        return Response.json({ code: 0, data: { id: 'original', is_owner: true, operator: {} } });
      posts++;
      return Response.json({
        code: 0,
        data: {
          project_id: 'different-project',
          operator_id: 'different-operator',
          model_url: 'https://cdn.tripo3d.ai/different.glb',
        },
      });
    }),
    [],
    links,
  );
  gateway.account = () => f.gateway.account();
  f.service.gateway = gateway;
  try {
    for (const operation of ['texture', 'export'] as const) {
      const input = { project_id: 'original', ...(operation === 'texture' ? { prompt: 'blue' } : {}) };
      const created = await f.service.submit(operation, `mismatch-${operation}`, input, 10);
      assert.equal(created.state, 'outcome_unknown');
      assert.equal(object(created.error).certainty, 'unknown');
      assert.equal(object(created.error).code, 'CONTRACT_CHANGED');
      assert.deepEqual(created.remote_ids, {});
      assert.equal(links.get(text(created.job_id)), undefined);
      const recovered = await f.service.submit(operation, `mismatch-${operation}`, input, 10);
      assert.equal(recovered.job_id, created.job_id);
      assert.equal(recovered.state, 'outcome_unknown');
    }
    assert.equal(posts, 2);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('texture previews validate optional echoed identities without inventing absent server fields', async () => {
  const f = await fixture();
  let response: Record<string, unknown> = {};
  const gateway = new StudioGateway(
    new StudioClient(f.service.credentials, async () => Response.json({ code: 0, data: response })),
    [],
    new MemoryLinks(),
  );
  const job = f.jobs.prepare('test-account', 'preview', 'retexture', {}, quote);
  job.remote_ids = { project_id: 'original', operator_id: 'preview-operator' };
  const artifact = { artifact_id: 'model', kind: 'image' as const, format: 'image', index: 0 };
  const image = { url: 'https://cdn.tripo3d.ai/preview.png' };
  try {
    for (const identity of [{}, { project_id: 'original', operator_id: 'preview-operator' }]) {
      response = { image, ...identity };
      assert.equal(await gateway.artifactUrl(job, artifact), image.url);
    }
    for (const identity of [{ project_id: 'different' }, { operator_id: 'different' }]) {
      response = { image, ...identity };
      await assert.rejects(gateway.artifactUrl(job, artifact), { code: 'CONTRACT_CHANGED' });
    }
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('successful image status with delayed outputs remains queryable until real artifact URLs appear', async () => {
  const f = await fixture();
  let outputs: unknown[] = [];
  let reads = 0;
  const gateway = new StudioGateway(
    new StudioClient(f.service.credentials, async (_url, init) => {
      assert.equal(init.method, 'POST');
      reads++;
      return Response.json({
        code: 0,
        data: { asset_id: 'original-image', status: 'success', output: { data: outputs } },
      });
    }),
    [],
    new MemoryLinks(),
  );
  gateway.cost = async () => undefined;
  f.service.gateway = gateway;
  const job = f.jobs.prepare('test-account', 'delayed-image-output', 'image', { prompt: 'cube' }, quote);
  f.jobs.update(job.job_id, 'submitted', { remote_ids: { asset_id: 'original-image' } });
  try {
    for (const delayed of [[], [{}], [{ url: 'https://cdn.tripo3d.ai/ready.png' }, {}]]) {
      outputs = delayed;
      const pending = await f.service.get(job.job_id);
      assert.equal(pending.state, 'submitted');
      assert.equal(object(pending.poll_error).code, 'ARTIFACT_NOT_READY');
      assert.equal(array(pending.artifacts).length, 0);
    }
    outputs = [{ url: 'https://cdn.tripo3d.ai/ready.png' }, { url: 'https://cdn.tripo3d.ai/ready-2.jpeg' }];
    const completed = await f.service.get(job.job_id);
    assert.equal(completed.state, 'succeeded');
    assert.deepEqual(
      array(completed.artifacts).map((item) => object(item).format),
      ['png', 'jpeg'],
    );
    assert.equal(reads, 4);
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

const projects = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const exportReady = (): RemoteStatus => ({
  state: 'succeeded',
  progress: 100,
  artifacts: [{ artifact_id: 'model', kind: 'model', format: 'glb', index: 0 }],
});
function exportFixture(f: Awaited<ReturnType<typeof fixture>>): Job {
  const job = f.jobs.prepare(
    'test-account',
    'batch-original',
    'export_batch',
    normalize('export_batch', { projects }),
    quote,
  );
  return f.jobs.update(job.job_id, 'submitted', {
    remote_ids: {
      batch: projects.map((project_id, index) => ({ project_id, operator_id: `operator-${index}`, code: 0 })),
    },
  });
}

test('export batch read failures retain successful siblings, known cached artifacts and login requirements', async () => {
  const f = await fixture();
  const job = exportFixture(f);
  const originalIds = structuredClone(job.remote_ids);
  try {
    for (const code of ['UPSTREAM_ERROR', 'AUTH_REQUIRED']) {
      const status = await exportBatchStatus(job, async (child) => {
        if (child.remote_ids.operator_id === 'operator-1') throw new TripoError(code, 'controlled', 'read');
        return exportReady();
      });
      assert.equal(status.state, code === 'AUTH_REQUIRED' ? 'requires_login' : 'running');
      assert.deepEqual(
        status.artifacts.map((item) => item.artifact_id),
        ['batch-0'],
      );
      const errors = array(status.error?.poll_errors).map(object);
      assert.equal(errors[0]?.index, 1);
      assert.equal(object(errors[0]?.error).code, code);
      assert.deepEqual(job.remote_ids, originalIds);
    }
    const cache = {
      ...exportReady().artifacts[0]!,
      artifact_id: 'batch-1',
      index: 1,
      local_path: '/cached/same-task.glb',
      sha256: 'a'.repeat(64),
      bytes: 123,
    };
    const cached = await exportBatchStatus({ ...job, artifacts: [cache] }, async (child) => {
      if (child.remote_ids.operator_id === 'operator-1')
        throw new TripoError('UPSTREAM_ERROR', 'controlled', 'read');
      return exportReady();
    });
    assert.deepEqual(cached.artifacts[1], cache);
    const completed = await exportBatchStatus(job, async () => exportReady());
    assert.equal(completed.state, 'succeeded');
    assert.equal(completed.artifacts.length, 2);
    assert.equal(f.gateway.posts, 0);
    assert.throws(
      () => batchChild({ ...job, remote_ids: { batch: [...job.remote_ids.batch!].reverse() } }, 0),
      { code: 'CONTRACT_CHANGED' },
    );
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('partial export reconciliation cannot attach an unverified operator after a sibling succeeds', async () => {
  const f = await fixture();
  const job = exportFixture(f);
  const originalIds = { batch: [job.remote_ids.batch![0]!, { project_id: projects[1]!, code: -1 }] };
  f.jobs.update(job.job_id, 'failed', {
    remote_ids: originalIds,
    error: { code: 'PARTIAL_RECEIPT_UNKNOWN' },
  });
  let unavailable = true;
  f.gateway.status = (pending) =>
    exportBatchStatus(pending, async (child) => {
      if (unavailable && child.remote_ids.operator_id === 'recovered-operator')
        throw new TripoError('UPSTREAM_ERROR', 'controlled unverified operator', 'read');
      return exportReady();
    });
  try {
    const supplied = { batch: [{ project_id: projects[1], operator_id: 'recovered-operator' }] };
    await assert.rejects(f.service.reconcile(job.job_id, supplied));
    assert.deepEqual(f.jobs.get(job.job_id).remote_ids, originalIds);
    assert.equal(f.jobs.get(job.job_id).state, 'failed');
    unavailable = false;
    const recovered = await f.service.reconcile(job.job_id, supplied);
    assert.equal(recovered.state, 'succeeded');
    assert.equal(array(recovered.artifacts).length, 2);
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('real MCP wait cancellation and server restart preserve original submitted and unknown tasks', async () => {
  const f = await fixture();
  const active = f.jobs.prepare('test-account', 'mcp-active', 'image', { prompt: 'active' }, quote);
  f.jobs.update(active.job_id, 'submitted', { remote_ids: { asset_id: 'original-image' } });
  const unknown = f.jobs.prepare('test-account', 'mcp-unknown', 'image', { prompt: 'unknown' }, quote);
  f.jobs.update(unknown.job_id, 'outcome_unknown');
  const cli = path.join(f.dir, 'controlled-cli.mjs');
  const server = path.join(f.dir, 'controlled-mcp.mjs');
  await writeFile(
    cli,
    `
import { fixture } from ${JSON.stringify(new URL('./helpers.ts', import.meta.url).href)};
import { callTool, toolRegistry } from ${JSON.stringify(new URL('../cli/commands.ts', import.meta.url).href)};
import { z } from ${JSON.stringify(new URL('../node_modules/zod/index.js', import.meta.url).href)};
const f = await fixture(${JSON.stringify(f.dir)});
f.gateway.status = async () => ({state:'running',progress:25,artifacts:[]});
f.gateway.submit = async () => { throw new Error('No submissions allowed during recovery verification'); };
const toolset = process.argv[process.argv.indexOf('--toolset') + 1];
const definitions = toolRegistry(f.service,{assets:async()=>({assets:[]}),client:{request:async()=>({})}},toolset);
try {
 if (process.argv[2] === 'tools') process.stdout.write(JSON.stringify(definitions.map(d=>({name:d.name,description:d.description,inputSchema:d.jsonSchema??z.toJSONSchema(d.schema)}))));
 else {
  const chunks=[];for await(const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const result=await callTool(definitions,process.argv[3],JSON.parse(Buffer.concat(chunks).toString()));
  process.stdout.write(JSON.stringify(result.structuredContent));if(result.isError)process.exitCode=2;
 }
}finally{f.jobs.close()}
`,
  );
  await writeFile(
    server,
    `import { serve } from ${JSON.stringify(new URL('../mcp/server.ts', import.meta.url).href)}; await serve({command:process.execPath,args:[${JSON.stringify(cli)}]},'full');\n`,
  );
  const connect = async (): Promise<Client> => {
    const client = new Client({ name: 'live16-recovery', version: '1' });
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [server], stderr: 'pipe' }),
    );
    return client;
  };
  let client: Client | undefined;
  try {
    client = await connect();
    const invalid = await client.callTool({
      name: 'ai_modeling_task_wait',
      arguments: { task_id: active.job_id, timeout_seconds: 0 },
    });
    assert.equal(invalid.isError, true);
    assert.equal(object(object(invalid.structuredContent).error).code, 'INVALID_INPUT');
    const waiting = await client.callTool({
      name: 'ai_modeling_task_wait',
      arguments: { task_id: unknown.job_id },
    });
    assert.equal(object(waiting.structuredContent).status, 'outcome_unknown');
    assert.match(text(object(waiting.structuredContent).next), /reconcile.*do not resubmit/);
    const controller = new AbortController();
    const pending = client.callTool(
      { name: 'ai_modeling_task_wait', arguments: { task_id: active.job_id, timeout_seconds: 5 } },
      undefined,
      { signal: controller.signal },
    );
    const timer = setTimeout(() => controller.abort(), 150);
    try {
      await assert.rejects(pending);
    } finally {
      clearTimeout(timer);
    }
    await client.close();
    client = await connect();
    const resumed = await client.callTool({
      name: 'ai_modeling_task_status',
      arguments: { task_id: active.job_id },
    });
    assert.equal(object(resumed.structuredContent).task_id, active.job_id);
    assert.equal(object(resumed.structuredContent).status, 'running');
    assert.deepEqual(object(resumed.structuredContent).studio, { asset_id: 'original-image' });
    assert.equal(f.jobs.get(unknown.job_id).state, 'outcome_unknown');
    assert.equal(f.jobs.list('test-account').length, 2);
  } finally {
    await client?.close();
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('wait backoff respects the remaining deadline when polling repeatedly fails', async () => {
  let reads = 0;
  const app = {
    service: {
      get: async () => {
        reads++;
        return { state: 'running', poll_error: { code: 'UPSTREAM_ERROR' } };
      },
    },
  } as unknown as Application;
  const started = performance.now();
  const waited = await waitTask(app, 'original-task-only', 0.05);
  assert.equal(waited.wait_timed_out, true);
  assert.equal(waited.state, 'running');
  assert.ok(performance.now() - started < 800, 'Read-error backoff exceeded the requested wait budget');
  assert.ok(reads >= 1);
});

function modelFixture(f: Awaited<ReturnType<typeof fixture>>): Job {
  const job = f.jobs.prepare(
    'test-account',
    'model-original',
    'model',
    { mode: 'batch', image_assets: [{ asset_id: 'source-0' }, { asset_id: 'source-1' }] },
    quote,
  );
  return f.jobs.update(job.job_id, 'submitted', {
    remote_ids: {
      models: projects.map((project_id, index) => ({
        project_id,
        operator_id: `model-operator-${index}`,
        accepted: true,
      })),
    },
  });
}

test('model receipt count and partial identity remain tied to the original request slots', async () => {
  const f = await fixture();
  const job = modelFixture(f);
  try {
    for (const key of ['image_paths', 'image_assets', 'image_sources'])
      assert.equal(expectedModelCount({ ...job, input: { mode: 'batch', [key]: ['first', 'second'] } }), 2);
    assert.equal(
      expectedModelCount({
        ...job,
        input: { mode: 'text', variations: [{ face_limit: 100 }, { face_limit: 200 }] },
      }),
      2,
    );
    const partial = {
      ...job,
      remote_ids: { models: [job.remote_ids.models![0]!, { accepted: null, project_id: projects[1] }] },
    };
    assert.throws(
      () =>
        reconcileModelResults(partial, [{ index: 1, project_id: 'replacement', operator_id: 'recovered' }]),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    const resolved = reconcileModelResults(partial, [
      { index: 1, project_id: projects[1], operator_id: 'recovered' },
    ]);
    assert.equal(resolved.models?.[1]?.operator_id, 'recovered');
    const operatorOnly = {
      ...job,
      remote_ids: { models: [job.remote_ids.models![0]!, { accepted: null, operator_id: 'known-partial' }] },
    };
    assert.throws(
      () =>
        reconcileModelResults(operatorOnly, [
          { index: 1, project_id: projects[1], operator_id: 'replacement' },
        ]),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    for (const models of [
      [job.remote_ids.models![0]!],
      [...job.remote_ids.models!, { accepted: null }],
      [job.remote_ids.models![0]!, job.remote_ids.models![0]!],
    ]) {
      const inconsistent = { ...job, remote_ids: { models } };
      assert.throws(() => modelResultChild(inconsistent, 0), { code: 'CONTRACT_CHANGED' });
      assert.throws(
        () =>
          reconcileModelResults(inconsistent, [
            { index: 0, project_id: projects[0], operator_id: 'model-operator-0' },
          ]),
        { code: 'CONTRACT_CHANGED' },
      );
    }
    assert.throws(
      () =>
        modelResults(
          [
            { project_id: projects[0], operator_id: 'operator-0' },
            { project_id: projects[1], operator_id: 'operator-1' },
            {
              project_id: 'unexpected',
              operator_id: 'operator-2',
              model_url: 'https://cdn.tripo3d.ai/private?signature=not-for-storage',
            },
          ],
          2,
        ),
      (error: unknown) => {
        assert.ok(error instanceof TripoError);
        assert.equal(error.code, 'CONTRACT_CHANGED');
        assert.equal(error.certainty, 'unknown');
        assert.equal(error.details.received_count, 3);
        const receipts = array(error.details.observed_receipts).map(object);
        assert.equal(receipts[2]?.operator_id, 'operator-2');
        assert.equal(receipts[2]?.model_url, undefined);
        return true;
      },
    );
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('model polling checks later siblings after a first read error and preserves exact cached results', async () => {
  const f = await fixture();
  const job = modelFixture(f);
  try {
    for (const code of ['UPSTREAM_ERROR', 'AUTH_REQUIRED']) {
      const seen: string[] = [];
      const cached = {
        ...exportReady().artifacts[0]!,
        artifact_id: 'model-0',
        index: 0,
        local_path: '/cached/first.glb',
        bytes: 123,
        sha256: 'a'.repeat(64),
      };
      const result = await modelResultsStatus({ ...job, artifacts: [cached] }, async (child) => {
        seen.push(text(child.remote_ids.operator_id));
        if (child.remote_ids.operator_id === 'model-operator-0')
          throw new TripoError(code, 'controlled', 'read');
        return exportReady();
      });
      assert.deepEqual(seen, ['model-operator-0', 'model-operator-1']);
      assert.equal(result.state, code === 'AUTH_REQUIRED' ? 'requires_login' : 'running');
      assert.deepEqual(result.artifacts[0], cached);
      assert.equal(result.artifacts[1]?.artifact_id, 'model-1');
      assert.equal(object(array(result.error?.poll_errors)[0]).index, 0);
    }
    const completed = await modelResultsStatus(job, async () => exportReady());
    assert.equal(completed.state, 'succeeded');
    assert.equal(completed.artifacts.length, 2);
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('model reconciliation refuses new IDs until every supplied receipt can be verified', async () => {
  const f = await fixture();
  const job = modelFixture(f);
  const originalIds = { models: [job.remote_ids.models![0]!, { accepted: null, project_id: projects[1] }] };
  f.jobs.update(job.job_id, 'failed', {
    remote_ids: originalIds,
    error: { code: 'PARTIAL_RECEIPT_UNKNOWN' },
  });
  let unavailable = true;
  f.gateway.status = (pending) =>
    modelResultsStatus(pending, async (child) => {
      if (unavailable && child.remote_ids.operator_id === 'recovered-operator')
        throw new TripoError('UPSTREAM_ERROR', 'controlled', 'read');
      return exportReady();
    });
  try {
    const supplied = { models: [{ index: 1, project_id: projects[1], operator_id: 'recovered-operator' }] };
    await assert.rejects(f.service.reconcile(job.job_id, supplied));
    assert.deepEqual(f.jobs.get(job.job_id).remote_ids, originalIds);
    unavailable = false;
    const recovered = await f.service.reconcile(job.job_id, supplied);
    assert.equal(recovered.state, 'succeeded');
    assert.equal(array(recovered.artifacts).length, 2);
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('multi-result downloads use each immutable receipt and reject a mismatched echoed source', async () => {
  const f = await fixture();
  const model = modelFixture(f);
  const exported = exportFixture(f);
  let mismatch = false;
  const requested: string[] = [];
  const gateway = new StudioGateway(
    new StudioClient(f.service.credentials, async (url, init) => {
      const body = init.body ? object(JSON.parse(String(init.body))) : {};
      const operator =
        init.method === 'GET' ? new URL(url).searchParams.get('operator_id')! : text(body.operator_id);
      requested.push(operator);
      const index = Number(operator.at(-1));
      return Response.json({
        code: 0,
        data:
          init.method === 'GET'
            ? {
                id: projects[index],
                operator: { operator_id: mismatch ? 'different' : operator },
                model_url: `https://cdn.tripo3d.ai/model-${index}.glb`,
              }
            : {
                project_id: projects[index],
                operator_id: mismatch ? 'different' : operator,
                model_url: `https://cdn.tripo3d.ai/export-${index}.glb`,
              },
      });
    }),
    [],
    new MemoryLinks(),
  );
  try {
    for (const index of [1, 0]) {
      const artifact = { artifact_id: `model-${index}`, kind: 'model' as const, format: 'glb', index };
      assert.equal(await gateway.artifactUrl(model, artifact), `https://cdn.tripo3d.ai/model-${index}.glb`);
      assert.equal(
        await gateway.artifactUrl(exported, artifact),
        `https://cdn.tripo3d.ai/export-${index}.glb`,
      );
    }
    assert.deepEqual(requested, ['model-operator-1', 'operator-1', 'model-operator-0', 'operator-0']);
    mismatch = true;
    for (const job of [model, exported])
      await assert.rejects(
        gateway.artifactUrl(job, { artifact_id: 'model-1', kind: 'model', format: 'glb', index: 1 }),
        { code: 'CONTRACT_CHANGED' },
      );
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
