import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { fixture, imageInput, quote } from './helpers.ts';
import { StudioGateway, type Gateway } from '../studio/api/gateway.ts';
import { StudioClient } from '../studio/api/client.ts';
import { MemoryLinks } from '../studio/auth/artifact-links.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import { TripoError } from '../studio/contracts/errors.ts';

async function setup(t: test.TestContext) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2040-01-01T00:00:00Z') });
  const f = await fixture();
  t.after(async () => {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  });
  f.service.pricing.quote = async () => ({
    ...quote,
    observed_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 1000).toISOString(),
  });
  return f;
}

test('an estimate that expires during preparation blocks the final write and retains its original failure', async (t) => {
  const f = await setup(t);
  (f.gateway as Gateway).submit = async (_job, beforeSend) => {
    t.mock.timers.tick(1000);
    beforeSend?.();
    f.gateway.posts++;
    return { remote_ids: { asset_id: 'synthetic-image' } };
  };
  const result = await f.service.submit('image', 'expired-before-send', imageInput, 10);
  assert.equal(result.state, 'failed');
  assert.equal((result.error as { code: string }).code, 'PRICE_UNKNOWN');
  assert.equal((result.error as { certainty: string }).certainty, 'not_submitted');
  assert.equal(f.gateway.posts, 0);
  f.service.pricing.quote = async () => assert.fail('Original failed requests must not be requoted.');
  const recovered = await f.service.submit('image', 'expired-before-send', imageInput, 10);
  assert.equal(recovered.job_id, result.job_id);
  assert.deepEqual(recovered.error, result.error);
  assert.equal(f.gateway.posts, 0);
});

test('valid fixed estimates still submit once and original submitted or unknown receipts survive expiry', async (t) => {
  const f = await setup(t);
  for (const unknown of [false, true]) {
    (f.gateway as Gateway).submit = async (_job, beforeSend) => {
      t.mock.timers.tick(999);
      beforeSend?.();
      f.gateway.posts++;
      if (unknown) throw new TripoError('CONNECTION_LOST', 'Synthetic missing receipt.', 'unknown');
      return { remote_ids: { asset_id: 'synthetic-image' } };
    };
    const request = unknown ? 'unknown-before-expiry' : 'submitted-before-expiry';
    const result = await f.service.submit('image', request, imageInput, 10);
    assert.equal(result.state, unknown ? 'outcome_unknown' : 'submitted');
    t.mock.timers.tick(1001);
    const pricing = f.service.pricing.quote;
    f.service.pricing.quote = async () => assert.fail('Existing receipts must not be requoted.');
    const recovered = await f.service.submit('image', request, imageInput, 10);
    assert.equal(recovered.job_id, result.job_id);
    assert.equal(recovered.state, result.state);
    assert.deepEqual(recovered.remote_ids, result.remote_ids);
    f.service.pricing.quote = pricing;
  }
  assert.equal(f.gateway.posts, 2);
});

test('zero-credit estimates also require valid expiry before a write', async (t) => {
  const f = await setup(t);
  for (const expires_at of [new Date(Date.now()).toISOString(), 'invalid']) {
    f.service.pricing.quote = async () => ({ ...quote, credits: 0, expires_at });
    (f.gateway as Gateway).submit = async (_job, beforeSend) => {
      beforeSend?.();
      f.gateway.posts++;
      return { remote_ids: { asset_id: 'synthetic-image' } };
    };
    const result = await f.service.submit('image', `invalid-expiry-${expires_at}`, imageInput, 0);
    assert.equal(result.state, 'failed');
    assert.equal((result.error as { code: string }).code, 'PRICE_UNKNOWN');
  }
  assert.equal(f.gateway.posts, 0);
});

test('metadata, stop and variable creative operations retain their separate quote contracts', async (t) => {
  const f = await setup(t);
  const cases = [
    { operation: 'project_edit', input: { project_id: 'project', expected_operator_id: 'operator' } },
    {
      operation: 'canvas_node_stop',
      input: { canvas_id: 'canvas', node_id: 'node', revision: '1', expected_run_id: 'run' },
    },
    {
      operation: 'canvas_turn',
      input: { session_id: 'session', text: 'Synthetic test.', accept_variable_cost: true },
    },
  ] as const;
  for (const { operation, input } of cases) {
    const numeric = operation === 'project_edit';
    f.service.pricing.quote = async () => ({
      ...quote,
      known: numeric,
      credits: numeric ? 0 : undefined,
      variable: operation === 'canvas_turn' ? true : undefined,
      expires_at: new Date(Date.now()).toISOString(),
    });
    (f.gateway as Gateway).submit = async (job, beforeSend) => {
      assert.deepEqual(job.input, normalize(operation, input));
      beforeSend?.();
      f.gateway.posts++;
      return { remote_ids: {} };
    };
    const result = await f.service.submit(operation, operation, input, numeric ? 0 : undefined);
    assert.equal(result.state, 'submitted');
  }
  assert.equal(f.gateway.posts, cases.length);
});

for (const operation of ['export_lite', 'export_batch'] as const)
  test(`${operation} preserves the final quote guard after its real adapter awaits source inspection`, async (t) => {
    const f = await setup(t);
    const project = '797542b3-f4a1-4c20-8f42-77a9fcaef359';
    let writes = 0;
    let reads = 0;
    let readDelay = 1000;
    const client = new StudioClient(f.service.credentials, async (url, init) => {
      if (init.method === 'GET') {
        assert.match(url, /\/project\/detail\/v3\//);
        reads++;
        t.mock.timers.tick(readDelay);
        return Response.json({
          code: 0,
          data: { id: project, is_owner: true, operator: { operator_id: 'source-operator' } },
        });
      }
      writes++;
      assert.match(url, operation === 'export_lite' ? /\/export-lite$/ : /\/export-batch$/);
      return Response.json({
        code: 0,
        data: { result: [{ project_id: project, operator_id: 'export-operator', code: 0 }] },
      });
    });
    const gateway = new StudioGateway(client, [], new MemoryLinks());
    gateway.account = async () => ({ authenticated: true, balance: 100, account_ref: 'test-account' });
    f.service.gateway = gateway;
    const input =
      operation === 'export_lite'
        ? { project_id: project, operator_id: 'source-operator' }
        : { projects: [project] };
    const result = await f.service.submit(operation, `${operation}-expired`, input, 10);
    assert.equal(result.state, 'failed');
    assert.equal((result.error as { code: string }).code, 'PRICE_UNKNOWN');
    assert.equal((result.error as { certainty: string }).certainty, 'not_submitted');
    assert.equal(reads, 1);
    assert.equal(writes, 0);
    readDelay = 0;
    const accepted = await f.service.submit(operation, `${operation}-fresh`, input, 10);
    assert.equal(accepted.state, operation === 'export_lite' ? 'succeeded' : 'submitted');
    assert.equal(reads, 2);
    assert.equal(writes, 1);
  });
