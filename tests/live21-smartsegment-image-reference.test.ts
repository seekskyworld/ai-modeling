/** 复用已审核网页图片身份，不把模型任务、跨账号来源或恢复时变化的历史引用误作输入。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rm } from 'node:fs/promises';
import { processingPlan } from '../cli/compat/planning.ts';
import { executePlan, resolveJob, type Application } from '../cli/compat/runtime.ts';
import { StudioClient } from '../studio/api/client.ts';
import { Operations } from '../studio/api/operations.ts';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import type { Job } from '../studio/contracts/types.ts';
import { object } from '../studio/contracts/errors.ts';
import { fixture, quote } from './helpers.ts';

const assetId = 'e6e58acc-3517-4b71-9ef9-f4dc9a4e5652';
const asset = () => ({
  asset_id: assetId,
  status: 'success',
  output: { data: [{ bucket: 'generated', key: 'exact/source.png' }] },
});
function clientFor(read: () => Record<string, unknown>, audit: string, requests: string[]): StudioClient {
  return new StudioClient(
    new MemoryCredentials({
      accountRef: 'test-account',
      cookie: 'fixture',
      deviceId: 'fixture',
      importedAt: '',
    }),
    async (url, init) => {
      const route = new URL(String(url)).pathname;
      requests.push(route);
      assert.equal(init?.method, 'POST');
      if (route === '/v2/studio/image/get_image_asset') return Response.json({ code: 0, data: read() });
      assert.equal(route, '/v2/studio/audit/image');
      assert.deepEqual(JSON.parse(String(init?.body)), {
        image: { bucket: 'generated', key: 'exact/source.png' },
      });
      return Response.json({ code: 0, data: { result: audit } });
    },
  );
}
function completedSource(f: Awaited<ReturnType<typeof fixture>>, request = 'source'): Job {
  const source = f.jobs.prepare('test-account', request, 'image', { prompt: 'source' }, quote);
  return f.jobs.update(source.job_id, 'succeeded', {
    remote_ids: { asset_id: assetId },
    artifacts: [{ artifact_id: 'image-0', kind: 'image', format: 'png', index: 0 }],
  });
}

test('image smartsegment task reference builds the native admitted-image body and restores frozen @last', async () => {
  const f = await fixture();
  try {
    const source = completedSource(f);
    const requests: string[] = [];
    const client = clientFor(asset, 'pass', requests);
    const app = { service: f.service, studio: { client } } as unknown as Application;
    const built: Record<string, unknown>[] = [];
    f.gateway.submit = async (job) => {
      const submission = await new Operations(client, []).build(job);
      assert.equal(submission.route, '/v2/studio/operation/image_to_model');
      built.push(submission.body);
      f.gateway.posts++;
      return { remote_ids: { project_id: 'new-project', operator_id: 'new-model' } };
    };
    const create = () => processingPlan('smartsegment', '@last', { segType: 'image' });
    const flags = { requestId: 'reference-parts', wait: false, download: false };
    const first = await executePlan(app, create(), flags);
    assert.equal(first.status, 'queued');
    assert.equal(f.gateway.posts, 1);
    assert.deepEqual(built[0]!.image, {
      bucket: 'generated',
      key: 'exact/source.png',
      image_audit_result: 'pass',
      image_source: 'generate',
    });
    assert.equal(built[0]!.generate_parts, true);
    assert.equal(built[0]!.segmentation_granularity, 'balanced');
    const stored = f.jobs.find('test-account', 'reference-parts-0')!;
    assert.deepEqual(stored.input.image_asset, { asset_id: assetId, output_index: 0 });
    assert.equal(stored.input.image_path, undefined);
    const beforeRetry = requests.length;
    const newer = completedSource(f, 'newer-source');
    assert.notEqual(newer.job_id, source.job_id);
    assert.equal(resolveJob(app, '@last').job_id, newer.job_id);
    const resumed = await executePlan(app, create(), flags);
    assert.equal(resumed.task_id, first.task_id);
    assert.equal(f.gateway.posts, 1);
    assert.equal(requests.length, beforeRetry);
    const policy = f.jobs.requestPolicy('test-account', 'sources:reference-parts')!;
    assert.equal(object((policy.sources as unknown[])[0]).job_id, source.job_id);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('direct Studio image assets support both parts and hinted plans without a local input file', async () => {
  const f = await fixture();
  try {
    const requests: string[] = [];
    const client = clientFor(asset, 'pass', requests);
    const app = { service: f.service, studio: { client } } as unknown as Application;
    const jobs: Job[] = [];
    f.gateway.submit = async (job) => {
      jobs.push(job);
      f.gateway.posts++;
      return { remote_ids: { project_id: 'new-project', operator_id: `step-${jobs.length}` } };
    };
    f.gateway.status = async (job) => ({
      state: 'succeeded',
      progress: 100,
      artifacts: [
        { artifact_id: 'model', kind: 'model', format: 'glb', index: 0 },
        ...(job.operation === 'segment'
          ? [{ artifact_id: 'semantic-mask', kind: 'image' as const, format: 'png', index: 1 }]
          : []),
      ],
    });
    const plan = processingPlan('smartsegment', assetId, { segType: 'image', hint: 'head and body' });
    assert.deepEqual(plan.pending_uploads, []);
    assert.equal(plan.smartSegmentImage!.source, assetId);
    const result = await executePlan(app, plan, { requestId: 'hint-asset', download: false, timeout: 1 });
    assert.equal(result.status, 'success');
    assert.deepEqual(
      jobs.map((job) => job.operation),
      ['model', 'segment'],
    );
    assert.deepEqual(jobs[0]!.input.image_asset, { asset_id: assetId, output_index: 0 });
    assert.equal(jobs[0]!.input.generate_parts, false);
    assert.equal(jobs[1]!.input.project_id, 'new-project');
    assert.equal(jobs[1]!.input.expected_operator_id, 'step-1');
    assert.equal(jobs[1]!.input.prompt, 'head and body');
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('model tasks, foreign tasks and unavailable API IDs fail before image reads or model submission', async () => {
  const f = await fixture();
  try {
    const requests: string[] = [];
    const client = clientFor(asset, 'pass', requests);
    const app = { service: f.service, studio: { client } } as unknown as Application;
    const model = f.jobs.prepare('test-account', 'model-source', 'model', { mode: 'image' }, quote);
    f.jobs.update(model.job_id, 'succeeded', {
      remote_ids: { project_id: 'project', operator_id: 'model', asset_id: assetId },
    });
    const foreign = f.jobs.prepare('other-account', 'foreign-source', 'image', { prompt: 'source' }, quote);
    f.jobs.update(foreign.job_id, 'succeeded', { remote_ids: { asset_id: assetId } });
    const unfinished = f.jobs.prepare(
      'test-account',
      'unfinished-source',
      'image',
      { prompt: 'source' },
      quote,
    );
    f.jobs.update(unfinished.job_id, 'submitted', { remote_ids: { asset_id: assetId } });
    f.gateway.status = async () => ({ state: 'running', progress: 30, artifacts: [] });
    for (const [input, code] of [
      [model.job_id, 'INVALID_INPUT'],
      [foreign.job_id, 'ACCOUNT_MISMATCH'],
      ['task_official_unknown', 'STUDIO_CAPABILITY_UNAVAILABLE'],
      [unfinished.job_id, 'INPUT_NOT_READY'],
    ])
      await assert.rejects(
        executePlan(app, processingPlan('smartsegment', input!, { segType: 'image' }), {
          requestId: `reject-${input}`,
          wait: false,
          download: false,
        }),
        { code },
      );
    assert.equal(f.gateway.posts, 0);
    assert.equal(requests.length, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('unfinished assets, missing storage identity and failed admission never reach generation', async () => {
  const cases: [Record<string, unknown>, string, string][] = [
    [{ ...asset(), asset_id: 'other' }, 'pass', 'CONTRACT_CHANGED'],
    [{ ...asset(), status: 'running' }, 'pass', 'INPUT_NOT_READY'],
    [{ ...asset(), output: { data: [{ bucket: 'generated' }] } }, 'pass', 'CONTENT_AUDIT_REJECTED'],
    [asset(), 'banned', 'CONTENT_AUDIT_REJECTED'],
  ];
  for (const [value, audit, code] of cases) {
    const f = await fixture();
    try {
      const source = completedSource(f);
      const client = clientFor(() => value, audit, []);
      const app = { service: f.service, studio: { client } } as unknown as Application;
      await assert.rejects(
        executePlan(app, processingPlan('smartsegment', source.job_id, { segType: 'image' }), {
          requestId: 'invalid-source',
          wait: false,
          download: false,
        }),
        { code },
      );
      assert.equal(f.gateway.posts, 0);
    } finally {
      f.jobs.close();
      await rm(f.dir, { recursive: true, force: true });
    }
  }
});
