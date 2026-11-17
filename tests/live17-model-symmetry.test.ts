/** P2 网页依赖链回归：审核后的图片→有界只读预检→一次生成，恢复不得重复前置或付费请求。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { Operations } from '../studio/api/operations.ts';
import { applyModelSymmetry } from '../studio/api/model-symmetry.ts';
import { StudioClient, type Fetcher } from '../studio/api/client.ts';
import { StudioGateway } from '../studio/api/gateway.ts';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { MemoryLinks } from '../studio/auth/artifact-links.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import { object, TripoError } from '../studio/contracts/errors.ts';
import type { Job } from '../studio/contracts/types.ts';
import { TaskService } from '../cli/core/service.ts';
import { fixture, quote } from './helpers.ts';

const p2 = 'Nexus-v2.0-20260801';
const credentials = () =>
  new MemoryCredentials({
    cookie: 'fixture-session',
    deviceId: 'fixture-device',
    accountRef: 'test-account',
    importedAt: new Date().toISOString(),
  });
const asset = (id: unknown) => ({
  asset_id: id,
  status: 'success',
  output: { data: [{ bucket: 'fixture', key: `${String(id)}.png`, image_audit_result: 'pass' }] },
});
const reply = (data: unknown) => Response.json({ code: 0, data });
const job = (input: Record<string, unknown>) =>
  ({ operation: 'model', account_ref: 'test-account', input: normalize('model', input) }) as Job;

test('P2 resolves symmetry from the audited primary image before the paid model request', async () => {
  const requests: { route: string; body: Record<string, unknown> }[] = [];
  const client = new StudioClient(credentials(), async (url, init) => {
    const route = new URL(url).pathname;
    const body = object(JSON.parse(String(init.body)));
    requests.push({ route, body });
    if (route.endsWith('/get_image_asset')) return reply(asset(body.asset_id));
    if (route.endsWith('/symmetry_check')) return reply({ symmetry: true });
    assert.ok(route.endsWith('/image_to_model'));
    assert.equal(body.symmetry, true);
    assert.deepEqual(body.image, {
      bucket: 'fixture',
      key: 'front.png',
      image_audit_result: 'pass',
      image_source: 'generate',
    });
    return reply({ project_id: 'project', operator_id: 'operator' });
  });
  await new StudioGateway(client, [], new MemoryLinks()).submit(
    job({ mode: 'image', model_version: p2, image_asset: { asset_id: 'front' } }),
  );
  assert.deepEqual(
    requests.map((request) => request.route.split('/').at(-1)),
    ['get_image_asset', 'symmetry_check', 'image_to_model'],
  );
  assert.deepEqual(requests[1]!.body, { image: { bucket: 'fixture', key: 'front.png' } });
});

test('P2 multiview checks front once, preserves null slots and respects explicit symmetry', async () => {
  let checks = 0;
  const client = new StudioClient(credentials(), async (url, init) => {
    const body = object(JSON.parse(String(init.body)));
    if (url.endsWith('/get_image_asset')) return reply(asset(body.asset_id));
    assert.ok(url.endsWith('/symmetry_check'));
    checks++;
    assert.deepEqual(body, { image: { bucket: 'fixture', key: 'front.png' } });
    return reply({ symmetry: true });
  });
  const operations = new Operations(client, []);
  const parameters = {
    mode: 'multiview',
    model_version: p2,
    image_assets: [{ asset_id: 'front' }, null, { asset_id: 'back' }, null],
  };
  const automatic = await operations.build(job(parameters));
  assert.equal(automatic.body.symmetry, true);
  assert.equal((automatic.body.image as unknown[])[1], null);
  assert.equal((automatic.body.image as unknown[])[3], null);
  for (const symmetry of [false, true]) {
    const explicit = await operations.build(job({ ...parameters, symmetry }));
    assert.equal(explicit.body.symmetry, symmetry);
  }
  assert.equal(checks, 1);
  const hd = await operations.build(job({ ...parameters, model_version: 'v3.1-20260211' }));
  assert.equal(hd.body.symmetry, undefined);
  assert.equal(checks, 1);
});

test('P2 text and batch do not borrow a stale webpage primary image for the check', async () => {
  const client = new StudioClient(credentials(), async (url, init) => {
    assert.ok(url.endsWith('/get_image_asset'));
    return reply(asset(object(JSON.parse(String(init.body))).asset_id));
  });
  const operations = new Operations(client, []);
  const text = await operations.build(job({ mode: 'text', model_version: p2, prompt: 'cube' }));
  assert.equal(text.body.symmetry, false);
  const batch = await operations.build(
    job({ mode: 'batch', model_version: p2, image_assets: [{ asset_id: 'first' }, { asset_id: 'second' }] }),
  );
  assert.equal(batch.body.symmetry, false);
});

test('P2 precheck follows the webpage fallback for network failures without hiding identity errors', async () => {
  for (const outcome of ['network', 'invalid', 'false', 'auth', 'account']) {
    const client = {
      request: async (_method: string, _route: string, _body: unknown, options: { timeoutMs: number }) => {
        assert.equal(options.timeoutMs, 1500);
        if (outcome === 'network') throw new TripoError('NETWORK_ERROR', 'fixture');
        if (outcome === 'auth') throw new TripoError('AUTH_REQUIRED', 'fixture');
        if (outcome === 'account') throw new TripoError('ACCOUNT_MISMATCH', 'fixture');
        return { symmetry: outcome === 'invalid' ? 'true' : false };
      },
    } as unknown as StudioClient;
    const body: Record<string, unknown> = { image: { bucket: 'fixture', key: 'front.png' } };
    const check = applyModelSymmetry(client, { model_version: p2, mode: 'image' }, body);
    if (outcome === 'auth' || outcome === 'account')
      await assert.rejects(check, { code: outcome === 'auth' ? 'AUTH_REQUIRED' : 'ACCOUNT_MISMATCH' });
    else {
      await check;
      assert.equal(body.symmetry, false);
    }
  }
});

test('P2 precheck is bounded even if a transport ignores its AbortSignal', { timeout: 5000 }, async () => {
  const client = { request: () => new Promise(() => {}) } as unknown as StudioClient;
  const body: Record<string, unknown> = { image: { bucket: 'fixture', key: 'front.png' } };
  await applyModelSymmetry(client, { model_version: p2, mode: 'image' }, body);
  assert.equal(body.symmetry, false);
});

test('recovering submitted or unknown P2 jobs performs neither a fresh symmetry check nor a second generation', async () => {
  for (const lostReceipt of [false, true]) {
    const f = await fixture();
    const creds = credentials();
    let reads = 0;
    let checks = 0;
    let submissions = 0;
    const fetcher: Fetcher = async (url, init) => {
      if (url.endsWith('/profile/payment')) return reply({ wallet: { total_credit: 100 } });
      if (url.endsWith('/get_image_asset')) {
        reads++;
        return reply(asset(object(JSON.parse(String(init.body))).asset_id));
      }
      if (url.endsWith('/symmetry_check')) {
        checks++;
        return reply({ symmetry: true });
      }
      assert.ok(url.endsWith('/image_to_model'));
      submissions++;
      if (lostReceipt) throw new Error('fixture receipt lost');
      return reply({ project_id: 'project', operator_id: 'operator' });
    };
    const service = () =>
      new TaskService({
        jobs: f.jobs,
        credentials: creds,
        gateway: new StudioGateway(new StudioClient(creds, fetcher), [], new MemoryLinks()),
        pricing: { quote: async () => quote },
        config: {
          dataDir: f.dir,
          outputDir: path.join(f.dir, 'output'),
          inputRoots: [],
          credentialProfile: 'test',
        },
      });
    const input = { mode: 'image', model_version: p2, image_asset: { asset_id: 'front' } };
    try {
      const first = await service().submit('model', 'auto-symmetry', input, 10);
      assert.equal(first.state, lostReceipt ? 'outcome_unknown' : 'submitted');
      const resumed = await service().submit('model', 'auto-symmetry', input, 10);
      assert.equal(resumed.job_id, first.job_id);
      assert.equal(resumed.state, first.state);
      assert.deepEqual({ reads, checks, submissions }, { reads: 1, checks: 1, submissions: 1 });
      await assert.rejects(service().submit('model', 'auto-symmetry', { ...input, symmetry: false }, 10), {
        code: 'IDEMPOTENCY_CONFLICT',
      });
    } finally {
      f.jobs.close();
      await rm(f.dir, { recursive: true, force: true });
    }
  }
});
