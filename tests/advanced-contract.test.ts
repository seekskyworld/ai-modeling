/** 新网页契约以真实回执形状作回归，特别覆盖异步身份、价格继承和增量元数据。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { fixture, quote } from './helpers.ts';
import { MemoryCredentials, parseCredential } from '../studio/auth/credentials.ts';
import { MemoryLinks } from '../studio/auth/artifact-links.ts';
import { StudioClient } from '../studio/api/client.ts';
import { StudioGateway } from '../studio/api/gateway.ts';
import { Operations } from '../studio/api/operations.ts';
import { callResource, resources } from '../studio/api/resources.ts';
import { prepareInput } from '../studio/api/preparation.ts';
import { PricingService } from '../studio/api/pricing.ts';
import { reviewedPrices } from '../studio/api/reviewed-prices.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import { object } from '../studio/contracts/errors.ts';
import type { Operation } from '../studio/contracts/types.ts';

function client(
  handler: (url: string, body: Record<string, unknown>, method: string) => unknown,
): StudioClient {
  return new StudioClient(
    new MemoryCredentials({ ...parseCredential('a'.repeat(32)), accountRef: 'test-account' }),
    async (url, init) =>
      Response.json({
        code: 0,
        data: handler(
          url,
          object(init.body ? JSON.parse(String(init.body)) : undefined),
          String(init.method),
        ),
      }),
  );
}
const ownProject = {
  id: 'source',
  is_owner: true,
  operator: { operator_id: 'op-source', status: 'success' },
};
test('public exports use the public route and price while other operations retain ownership checks', async () => {
  const f = await fixture();
  const operations = new Operations(
    client(() => ({ ...ownProject, is_owner: false })),
    [],
  );
  try {
    const input = normalize('export', { project_id: 'source', public_model: true });
    const job = f.jobs.prepare('test-account', 'public-export', 'export', input, quote);
    assert.equal((await operations.build(job)).route, '/v2/studio/operation/export-public-model');
    assert.equal(
      (await new PricingService('/missing.json', reviewedPrices).quote('export', input)).credits,
      5,
    );
    await assert.rejects(operations.build({ ...job, input: { ...input, public_model: false } }), {
      code: 'OWNERSHIP_REQUIRED',
    });
    await assert.rejects(f.service.submit('image', 'invalid-budget', { prompt: 'robot' }, Number.NaN), {
      code: 'INVALID_INPUT',
    });
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('copy persists a project-only receipt and obtains the new operator through a read', async () => {
  const f = await fixture();
  let submitted = 0;
  const gateway = new StudioGateway(
    client((url) => {
      if (url.endsWith('/save_as_new')) {
        submitted++;
        return { project_id: 'copy' };
      }
      return url.endsWith('/copy')
        ? { id: 'copy', operator: { operator_id: 'op-copy', status: 'success' } }
        : ownProject;
    }),
    [],
    new MemoryLinks(),
  );
  try {
    const job = f.jobs.prepare(
      'test-account',
      'copy',
      'copy',
      normalize('copy', { project_id: 'source', operator_id: 'op-source' }),
      quote,
    );
    const receipt = await gateway.submit(job);
    assert.deepEqual(receipt.remote_ids, { project_id: 'copy' });
    const persisted = f.jobs.update(job.job_id, 'submitted', receipt);
    const status = await gateway.status(persisted);
    assert.deepEqual(status.remote_ids, { project_id: 'copy', operator_id: 'op-copy' });
    assert.equal(status.state, 'succeeded');
    assert.equal(submitted, 1);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('motion preserves both task and asset IDs and rejects a foreign artifact', async () => {
  const f = await fixture();
  let foreign = false;
  const gateway = new StudioGateway(
    client((url) =>
      url.endsWith('/get_task')
        ? { task_id: 'motion-task', asset_id: 'motion-asset', status: 'success' }
        : {
            task_id: foreign ? 'other' : 'motion-task',
            asset_id: 'motion-asset',
            motion_url: 'https://cdn.tripo3d.ai/motion.glb',
          },
    ),
    [],
    new MemoryLinks(),
  );
  try {
    const job = f.jobs.prepare(
      'test-account',
      'motion',
      'motion',
      normalize('motion', { segments: [{ prompt: 'wave', duration_seconds: 2 }] }),
      quote,
    );
    const saved = f.jobs.update(job.job_id, 'submitted', { remote_ids: { task_id: 'motion-task' } });
    const status = await gateway.status(saved);
    assert.equal(status.remote_ids?.asset_id, 'motion-asset');
    assert.equal(await gateway.artifactUrl(saved, status.artifacts[0]!), 'https://cdn.tripo3d.ai/motion.glb');
    foreign = true;
    await assert.rejects(gateway.artifactUrl(saved, status.artifacts[0]!), { code: 'CONTRACT_CHANGED' });
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('metadata preserves other edits and rejects an unexpected model version before writing', async () => {
  let current = 'op-source';
  const writes: Record<string, unknown>[] = [];
  const c = client((url, body, method) => {
    if (method === 'GET')
      return {
        ...ownProject,
        operator: {
          operator_id: current,
          metadata: {
            children_deleted: ['hidden'],
            children_rename: { head: 'Head' },
            material_factor: { metallic: 0.2 },
          },
        },
      };
    writes.push(body);
    return {};
  });
  const spec = resources.find((s) => s.name === 'project_metadata')!;
  const input = {
    project_id: 'source',
    expected_operator_id: 'op-source',
    children_rename: { hand: 'Hand' },
    material_factor: { roughness: 0.8 },
  };
  await callResource(c, spec, input);
  assert.deepEqual(writes[0]?.children_rename, { head: 'Head', hand: 'Hand' });
  assert.deepEqual(writes[0]?.children_deleted, ['hidden']);
  assert.deepEqual(writes[0]?.material_factor, { metallic: 0.2, roughness: 0.8 });
  current = 'someone-elses-update';
  await assert.rejects(callResource(c, spec, input), { code: 'PROJECT_CHANGED' });
  assert.equal(writes.length, 1);
});

test('image deletion sends per-asset output keys, not an untyped asset_ids field', async () => {
  const bodies: Record<string, unknown>[] = [];
  const c = client((_url, body) => {
    bodies.push(body);
    return {};
  });
  const spec = resources.find((s) => s.name === 'image_delete')!;
  await callResource(c, spec, { items: [{ asset_id: 'image', keys: ['output-key'] }] });
  assert.deepEqual(bodies, [{ items: [{ asset_id: 'image', keys: ['output-key'] }] }]);
  await assert.rejects(callResource(c, spec, { asset_ids: ['image'] }));
});

test('regeneration uses the original quantity and 4K surcharge and rejects a false model', async () => {
  const c = client(() => ({
    asset_id: 'image',
    input: { model_version: 'flux.1_kontext_pro', amount: 3, resolution: '4K' },
  }));
  const input = await prepareInput(
    c,
    'image_process',
    normalize('image_process', { action: 'regenerate', asset_id: 'image' }),
  );
  const prices = new PricingService('/missing/prices.json', {
    ...reviewedPrices,
    reviewed_at: new Date(Date.now() - 1000).toISOString(),
    expires_at: new Date(Date.now() + 60000).toISOString(),
  });
  assert.equal((await prices.quote('image_process', input)).credits, 60);
  assert.equal((await prices.quote('image_process', { action: 'regenerate' })).known, false);
  await assert.rejects(
    prepareInput(c, 'image_process', { action: 'regenerate', asset_id: 'image', model_version: 'gpt_4o' }),
    { code: 'INVALID_INPUT' },
  );
});

test('advanced operation bodies preserve the verified Studio field names', async () => {
  const f = await fixture();
  const operations = new Operations(
    client(() => ownProject),
    [],
  );
  const cases: [Operation, Record<string, unknown>, string, Record<string, unknown>][] = [
    [
      'remesh',
      { project_id: 'source', face_limit: 4000, smart_poly: true },
      'remesh',
      { smart_poly: true, face_limit: 4000, model_version: 'default' },
    ],
    [
      'segment',
      { project_id: 'source', segmentation_granularity: 'detailed' },
      'ai_segmentation',
      { segmentation_granularity: 'detailed', model_version: 'v2.0-20260430' },
    ],
    [
      'complete',
      { project_id: 'source', part_names: ['arm'], completion_mode: 'quick_cap' },
      'mesh_fill',
      { part_names: ['arm'], model_version: 'default' },
    ],
    [
      'uv_generate',
      { project_id: 'source', current_operator_id: 'op-source', action: 'retry' },
      'uv_edit/generate',
      { current_operator_id: 'op-source', action: 'retry' },
    ],
  ];
  try {
    for (const [operation, input, endpoint, expected] of cases) {
      const job = f.jobs.prepare('test-account', operation, operation, normalize(operation, input), quote);
      const wire = await operations.build(job);
      assert.equal(wire.route, `/v2/studio/operation/${endpoint}`);
      for (const [key, value] of Object.entries(expected)) assert.deepEqual(wire.body[key], value);
    }
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('real multiview regeneration metadata uses one reviewed multiview price despite empty image fields', async () => {
  const asset = {
    asset_id: 'views',
    type: 'multiview_images',
    status: 'success',
    input: { amount: 0, model_version: '', resolution: '' },
  };
  const api = client(() => asset);
  const input = await prepareInput(api, 'image_process', {
    action: 'regenerate_multiview',
    asset_id: 'views',
  });
  const price = await new PricingService('/missing.json', reviewedPrices).quote('image_process', input);
  assert.equal(price.known, true);
  assert.equal(price.credits, reviewedPrices.credits.ImageMultiview);
  const f = await fixture();
  try {
    const job = f.jobs.prepare('test-account', 'multiview-regeneration', 'image_process', input, price);
    const submission = await new Operations(api, []).build(job);
    assert.equal(submission.route, '/v2/studio/image/re_gen_multiview');
    assert.deepEqual(submission.body, { asset_id: 'views' });
    await assert.rejects(prepareInput(api, 'image_process', { action: 'regenerate', asset_id: 'views' }), {
      code: 'INVALID_INPUT',
    });
  } finally {
    f.jobs.close();
  }
});
