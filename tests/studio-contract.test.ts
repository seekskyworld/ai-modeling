/** 脱敏契约夹具覆盖账户切换、网页字段变化和付费请求的接收边界。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { MemoryCredentials, parseCredential } from '../studio/auth/credentials.ts';
import { MemoryLinks } from '../studio/auth/artifact-links.ts';
import { importCredential } from '../studio/auth/import.ts';
import { StudioClient } from '../studio/api/client.ts';
import { StudioGateway } from '../studio/api/gateway.ts';
import { Operations } from '../studio/api/operations.ts';
import { fixture, quote } from './helpers.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import type { Operation } from '../studio/contracts/types.ts';
import { object } from '../studio/contracts/errors.ts';
import { PricingService } from '../studio/api/pricing.ts';
import { reviewedPrices } from '../studio/api/reviewed-prices.ts';

function session(): MemoryCredentials {
  return new MemoryCredentials({ ...parseCredential('a'.repeat(32)), accountRef: 'test-account' });
}
test('plain-text image enum rejection is not mistaken for an uncertain paid submission', async () => {
  const body = 'error: value "0.5K" is not defined in options "[1K 2K 4K]"\n';
  for (const [status, response, code, certainty] of [
    [400, body, 'STUDIO_REJECTED', 'not_submitted'],
    [400, 'type mismatch for field "texture_seed"\n', 'STUDIO_REJECTED', 'not_submitted'],
    [400, 'invalid modelVersion: v3.0\n', 'STUDIO_REJECTED', 'not_submitted'],
    [500, body, 'UPSTREAM_ERROR', 'unknown'],
    [400, '<html>Bad gateway</html>', 'CONTRACT_CHANGED', 'unknown'],
  ] as const) {
    let posts = 0;
    const client = new StudioClient(session(), async () => {
      posts++;
      return new Response(response, { status });
    });
    await assert.rejects(client.request('POST', '/v2/studio/image/gen_image_v2', {}, { paid: true }), {
      code,
      certainty,
    });
    assert.equal(posts, 1);
  }
});
test('a validated import preserves the previous credentials if verification fails', async () => {
  const store = session();
  const original = store.load();
  await assert.rejects(
    importCredential('b'.repeat(32), store, async () => Response.json({ code: 1002 }, { status: 401 })),
    { code: 'AUTH_REQUIRED' },
  );
  assert.equal(store.load(), original);
  const result = await importCredential('b'.repeat(32), store, async (url) =>
    url.includes('whoami')
      ? Response.json({ identity: { id: 'one-account' }, expires_at: '2026-12-01T00:00:00Z' })
      : Response.json({ code: 0, data: { wallet: { total_credit: 120 } } }),
  );
  assert.equal(result.balance, 120);
  assert.equal(result.renewable, true);
  assert.notEqual(store.load()?.accountRef, 'test-account');
  assert.equal('cookie' in result, false);
});
test('expired JWT refresh uses only the session cookie and never repeats a paid POST', async () => {
  const jwt = (expires: number): string =>
    `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ exp: expires, sub: 'test' })).toString('base64url')}.fake`;
  const store = session();
  store.save({ ...store.load()!, bearer: jwt(1) });
  let posts = 0;
  let refreshes = 0;
  const client = new StudioClient(store, async (url, init) => {
    if (url.includes('whoami')) {
      refreshes++;
      assert.equal(object(init.headers).authorization, undefined);
      return Response.json({ tokenized: jwt(Math.floor(Date.now() / 1000) + 600) });
    }
    posts++;
    assert.equal(object(init.headers).authorization, `Bearer ${store.load()?.bearer}`);
    return Response.json({ code: 0, data: { asset_id: 'accepted' } });
  });
  await client.request('POST', '/v2/studio/image/gen_image_v2', {}, { paid: true });
  assert.equal(posts, 1);
  assert.equal(refreshes, 1);
});
test('a credential change after preflight is detected before a paid submission', async () => {
  const f = await fixture();
  const store = session();
  let posts = 0;
  const client = new StudioClient(store, async (url) => {
    if (url.includes('/project/detail/')) {
      store.save({ ...store.load()!, accountRef: 'different' });
      return Response.json({
        code: 0,
        data: { id: 'project-1', is_owner: true, operator: { status: 'success', is_textured: true } },
      });
    }
    posts++;
    return Response.json({ code: 0, data: { operator_id: 'incorrect' } });
  });
  const gateway = new StudioGateway(client, [f.dir], new MemoryLinks());
  try {
    const job = f.jobs.prepare(
      'test-account',
      'switch',
      'texture',
      normalize('texture', { project_id: 'project-1' }),
      quote,
    );
    await assert.rejects(gateway.submit(job), { code: 'ACCOUNT_MISMATCH' });
    assert.equal(posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
test('known image receipt, status and artifact remain tied to the requested asset', async () => {
  const f = await fixture();
  const store = session();
  let mismatch = false;
  const gateway = new StudioGateway(
    new StudioClient(store, async (url) =>
      Response.json({
        code: 0,
        data: url.includes('gen_image_v2')
          ? { asset_id: 'image-123' }
          : {
              asset_id: mismatch ? 'wrong' : 'image-123',
              status: 'success',
              output: {
                data: [
                  {
                    url: 'https://cdn.tripo3d.ai/image.png',
                    bucket: 'tripo-data',
                    key: 'safe',
                    image_audit_result: 'pass',
                  },
                ],
              },
            },
      }),
    ),
    [f.dir],
    new MemoryLinks(),
  );
  try {
    let job = f.jobs.prepare(
      'test-account',
      'contract',
      'image',
      normalize('image', { prompt: 'toy' }),
      quote,
    );
    const receipt = await gateway.submit(job);
    job = f.jobs.update(job.job_id, 'submitted', { remote_ids: receipt.remote_ids });
    const status = await gateway.status(job);
    assert.equal(status.state, 'succeeded');
    assert.equal(status.artifacts.length, 1);
    assert.equal(await gateway.artifactUrl(job, status.artifacts[0]!), 'https://cdn.tripo3d.ai/image.png');
    mismatch = true;
    await assert.rejects(gateway.status(job), { code: 'CONTRACT_CHANGED' });
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
test('postprocessing honors nested ownership/rig flags, and current download/progress contracts', async () => {
  const f = await fixture();
  let rigged = true;
  const requests: { route: string; body: Record<string, unknown> }[] = [];
  const client = new StudioClient(session(), async (url, init) => {
    requests.push({
      route: new URL(url).pathname,
      body: object(init.body ? JSON.parse(String(init.body)) : undefined),
    });
    if (url.includes('pre_rig_check'))
      return Response.json({ code: 0, data: { riggable: true, rig_type: 'biped' } });
    if (url.endsWith('/progress'))
      return Response.json({ code: 0, data: [{ id: 'operation-1', status: 'success', progress: 100 }] });
    if (url.includes('download_with_name'))
      return Response.json({ code: 0, data: { model_url: 'https://cdn.tripo3d.ai/export.glb' } });
    if (url.includes('txn/records'))
      return Response.json({
        code: 0,
        data: {
          records: [
            {
              operator_id: 'operation-1',
              amount: 20,
              txn_type: 'charge',
              direction: 'sub',
              status: 'fulfilled',
            },
          ],
        },
      });
    return Response.json({
      code: 0,
      data: {
        id: 'project-1',
        operator: {
          operator_id: 'operation-1',
          is_owner: true,
          status: 'success',
          is_textured: true,
          is_rigged: rigged,
          retarget: [{ operator_id: 'operation-1', model_url: 'https://cdn.tripo3d.ai/walk.glb' }],
        },
        model_url: 'https://cdn.tripo3d.ai/model.glb',
      },
    });
  });
  const gateway = new StudioGateway(client, [f.dir], new MemoryLinks());
  const operations = new Operations(client, [f.dir]);
  try {
    for (const operation of ['rig', 'animate', 'export', 'texture'] as Operation[]) {
      const input = normalize(operation, {
        project_id: 'project-1',
        ...(operation === 'animate' ? { animation: 'preset:biped:walk' } : {}),
      });
      let job = f.jobs.prepare('test-account', operation, operation, input, quote);
      const wire = await operations.build(job);
      assert.ok(wire.route.startsWith('/v2/studio/operation/'));
      job = f.jobs.update(job.job_id, 'submitted', {
        remote_ids: { project_id: 'project-1', operator_id: 'operation-1' },
      });
      assert.equal((await gateway.status(job)).state, 'succeeded');
      assert.ok(
        (
          await gateway.artifactUrl(job, { artifact_id: 'model', kind: 'model', format: 'glb', index: 0 })
        ).startsWith('https://cdn.tripo3d.ai/'),
      );
      assert.equal((await gateway.cost(job))?.credits, 20);
    }
    rigged = false;
    const bad = f.jobs.prepare(
      'test-account',
      'not-rigged',
      'animate',
      normalize('animate', { project_id: 'project-1', animation: 'preset:biped:walk' }),
      quote,
    );
    await assert.rejects(operations.build(bad), { code: 'RIG_REQUIRED' });
    assert.ok(requests.some((request) => request.route.endsWith('/pre_rig_check')));
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
test('reviewed estimates include geometry/texture additions and zero-cost own export explicitly', async () => {
  const prices = new PricingService('/does-not-exist/pricing.json', {
    ...reviewedPrices,
    reviewed_at: new Date(Date.now() - 1000).toISOString(),
    expires_at: new Date(Date.now() + 60000).toISOString(),
  });
  const mesh = await prices.quote('model', normalize('model', { mode: 'text', prompt: 'robot' }));
  const textured = await prices.quote(
    'model',
    normalize('model', {
      mode: 'text',
      prompt: 'robot',
      texture: true,
      pbr: true,
      texture_quality: 'detailed',
      geometry_quality: 'detailed',
    }),
  );
  assert.equal(mesh.credits, 15);
  assert.equal(textured.credits, 55);
  assert.equal(
    (await prices.quote('texture', normalize('texture', { project_id: 'p', action: 'pbr' }))).credits,
    5,
  );
  assert.equal(
    (await prices.quote('image', normalize('image', { prompt: 'toy', resolution: '4K', amount: 2 }))).credits,
    60,
  );
  assert.equal(
    (
      await prices.quote(
        'image',
        normalize('image', {
          prompt: 'toy',
          model_version: 'flux.1_kontext_pro',
          resolution: '4K',
          amount: 2,
        }),
      )
    ).credits,
    40,
  );
  assert.equal((await prices.quote('export', normalize('export', { project_id: 'p' }))).credits, 0);
});

test('export uses completed animation operator IDs and rejects presets or foreign motions before POST', async () => {
  const f = await fixture();
  const motion = '7987d3be-e2c3-4cdf-9939-bd70f0c83574';
  let motionStatus = 'success';
  let posts = 0;
  const client = new StudioClient(session(), async (url, init) => {
    if (url.includes('/project/detail/'))
      return Response.json({
        code: 0,
        data: {
          is_owner: true,
          operator: {
            status: 'success',
            retarget: [
              {
                operator_id: motion,
                status: motionStatus,
                model_url: 'https://cdn.tripo3d.ai/walk.glb',
              },
            ],
          },
        },
      });
    posts++;
    const body = JSON.parse(String(init.body));
    assert.equal(body.format, 'gltf');
    assert.deepEqual(body.animations, [motion]);
    return Response.json({ code: 0, data: { operator_id: 'export-1' } });
  });
  const gateway = new StudioGateway(client, [f.dir], new MemoryLinks());
  const parameters = { project_id: 'project-1', with_animation: true, animations: [motion] };
  try {
    assert.throws(() => normalize('export', { ...parameters, animations: ['preset:biped:walk'] }));
    assert.deepEqual(normalize('export', { ...parameters, animations: [] }).animations, []);
    const job = f.jobs.prepare(
      'test-account',
      'export-motion',
      'export',
      normalize('export', parameters),
      quote,
    );
    assert.equal((await gateway.submit(job)).remote_ids.operator_id, 'export-1');
    motionStatus = 'running';
    await assert.rejects(gateway.submit(job), { code: 'ANIMATION_NOT_READY' });
    motionStatus = 'success';
    await assert.rejects(
      gateway.submit({
        ...job,
        input: { ...job.input, animations: ['e7b11c6f-2dcd-4898-a22e-ec21e5364418'] },
      }),
      { code: 'ANIMATION_NOT_READY' },
    );
    assert.equal(posts, 1);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
