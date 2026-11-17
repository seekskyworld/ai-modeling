/** 已完成的多图任务恢复不重审远端来源；显式来源改变仍须在再次生成前拒绝。 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { fixture, quote, imageInput } from './helpers.ts';
import { StudioClient } from '../studio/api/client.ts';
import { StudioGateway } from '../studio/api/gateway.ts';
import { MemoryLinks } from '../studio/auth/artifact-links.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import { generationPlan } from '../cli/compat/planning.ts';
import { executePlan, type Application } from '../cli/compat/runtime.ts';
import type { Job } from '../studio/contracts/types.ts';

const sourceAssets = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];
const prompt = 'Keep both original image subjects side by side.';
const request = 'live16-source-recovery';

async function setup(t: TestContext) {
  const f = await fixture();
  t.after(async () => {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  });
  const sources = sourceAssets.map((asset, index) => {
    const job = f.jobs.prepare(
      'test-account',
      `source-${index}`,
      'image',
      normalize('image', imageInput),
      quote,
    );
    return f.jobs.update(job.job_id, 'succeeded', {
      remote_ids: { asset_id: asset },
      artifacts: [{ artifact_id: 'image-0', kind: 'image', format: 'png', index: 0 }],
    });
  });
  let sourceReads = 0;
  let mode: 'deleted' | 'network' | 'valid' = 'deleted';
  const client = new StudioClient(f.service.credentials, async (url, init) => {
    assert.equal(new URL(url).pathname, '/v2/studio/image/get_image_asset');
    assert.equal(init.method, 'POST');
    const input = JSON.parse(String(init.body));
    assert.ok(sourceAssets.includes(input.asset_id));
    sourceReads++;
    if (mode === 'network') throw new Error('Controlled offline source');
    if (mode === 'deleted')
      return Response.json({ code: 2043, message: 'Controlled source deleted' }, { status: 404 });
    return Response.json({
      code: 0,
      data: {
        asset_id: input.asset_id,
        status: 'success',
        output: { data: [{ bucket: 'controlled', key: 'controlled.png', image_audit_result: 'pass' }] },
      },
    });
  });
  const app: Application = {
    service: f.service,
    studio: new StudioGateway(client, [], new MemoryLinks()),
    close: () => {},
  };
  const makePlan = (refs = sources.slice(0, 2).map((job) => job.job_id), editBase = false) =>
    generationPlan('image-to-image', refs, { model: 'banana2', editBase, param: { prompt } });
  const original = (inputSources = sources.slice(0, 2)): Job => {
    const input = normalize('image', {
      prompt,
      model_version: 'gemini_3.1_flash_image_preview',
      image_sources: inputSources.map((job) => ({ asset_id: job.remote_ids.asset_id, output_index: 0 })),
    });
    const job = f.jobs.prepare('test-account', `${request}-0`, 'image', input, quote);
    return f.jobs.update(job.job_id, 'succeeded', {
      remote_ids: { asset_id: '44444444-4444-4444-8444-444444444444' },
      artifacts: [{ artifact_id: 'image-0', kind: 'image', format: 'png', index: 0 }],
    });
  };
  return {
    ...f,
    app,
    sources,
    makePlan,
    original,
    setMode: (next: typeof mode) => {
      mode = next;
    },
    reads: () => sourceReads,
  };
}

test('successful multiple-image recovery survives deleted or offline original image assets', async (t) => {
  const f = await setup(t);
  const original = f.original();
  for (const mode of ['deleted', 'network'] as const) {
    f.setMode(mode);
    const recovered = await executePlan(f.app, f.makePlan(), {
      requestId: request,
      download: false,
      maxCredits: 0,
    });
    assert.equal(recovered.task_id, original.job_id);
    assert.equal(recovered.status, 'success');
    assert.deepEqual(recovered.studio, original.remote_ids);
  }
  assert.equal(f.reads(), 0);
  assert.equal(f.gateway.posts, 0);
  assert.equal(f.jobs.list('test-account').length, 4);
  assert.deepEqual(f.jobs.get(original.job_id).input, original.input);
});

test('changed explicit alias cannot reuse the old multiple-image request or submit another image', async (t) => {
  const f = await setup(t);
  f.original();
  f.jobs.setAlias('test-account', 'hero', f.sources[0]!.job_id);
  const refs = ['@hero', f.sources[1]!.job_id];
  const first = await executePlan(f.app, f.makePlan(refs), {
    requestId: request,
    download: false,
    maxCredits: 0,
  });
  assert.equal(first.status, 'success');
  f.jobs.setAlias('test-account', 'old-hero', f.sources[0]!.job_id);
  f.jobs.setAlias('test-account', 'hero', f.sources[2]!.job_id);
  await assert.rejects(
    executePlan(f.app, f.makePlan(refs), { requestId: request, download: false, maxCredits: 0 }),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
  assert.equal(f.reads(), 0);
  assert.equal(f.gateway.posts, 0);
});

test('changed image order and primary-image role are rejected before online access or generation', async (t) => {
  const f = await setup(t);
  f.original();
  const refs = f.sources.slice(0, 2).map((job) => job.job_id);
  for (const plan of [f.makePlan([...refs].reverse()), f.makePlan(refs, true)]) {
    await assert.rejects(executePlan(f.app, plan, { requestId: request, download: false, maxCredits: 0 }), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
  }
  assert.equal(f.reads(), 0);
  assert.equal(f.gateway.posts, 0);
  assert.equal(f.jobs.list('test-account').length, 4);
});

test('new multiple-image requests still verify remote source audit and cannot bypass deleted assets', async (t) => {
  const f = await setup(t);
  await assert.rejects(
    executePlan(f.app, f.makePlan(), { requestId: request, download: false, maxCredits: 10 }),
    { code: 'STUDIO_REJECTED' },
  );
  assert.equal(f.gateway.posts, 0);
  assert.equal(f.jobs.list('test-account').length, 3);
  assert.ok(f.reads() > 0);
  const before = f.reads();
  f.setMode('valid');
  const accepted = await executePlan(f.app, f.makePlan(), {
    requestId: request,
    download: false,
    wait: false,
    maxCredits: 10,
  });
  assert.equal(accepted.status, 'queued');
  assert.equal(f.reads() - before, 2);
  assert.equal(f.gateway.posts, 1);
});

test('prepared local image intents still require source audit before their first upstream submission', async (t) => {
  const f = await setup(t);
  const prepared = f.jobs.prepare(
    'test-account',
    `${request}-0`,
    'image',
    normalize('image', {
      prompt,
      model_version: 'gemini_3.1_flash_image_preview',
      image_sources: f.sources
        .slice(0, 2)
        .map((job) => ({ asset_id: job.remote_ids.asset_id, output_index: 0 })),
    }),
    quote,
  );
  await assert.rejects(
    executePlan(f.app, f.makePlan(), {
      requestId: request,
      download: false,
      wait: false,
      maxCredits: 10,
    }),
    { code: 'STUDIO_REJECTED' },
  );
  assert.equal(f.gateway.posts, 0);
  assert.equal(f.jobs.get(prepared.job_id).state, 'prepared');
  assert.ok(f.reads() > 0);
});
