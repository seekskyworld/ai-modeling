import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, quote, tinyGlb } from './helpers.ts';
import { PricingService, priceSchema, type PriceSnapshot } from '../studio/api/pricing.ts';
import { pricingSnapshotStatus } from '../studio/api/pricing-maintenance.ts';
import { reviewedPrices } from '../studio/api/reviewed-prices.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import { unquotedOperations, type UnquotedOperation } from '../studio/contracts/unquoted-pricing.ts';
import { advancedOperation } from '../studio/api/advanced-operations.ts';
import { StudioClient } from '../studio/api/client.ts';
import type { Gateway } from '../studio/api/gateway.ts';
import { TripoError } from '../studio/contracts/errors.ts';

function snapshot(): PriceSnapshot {
  return {
    reviewed_at: new Date(Date.now() - 1000).toISOString(),
    expires_at: new Date(Date.now() + 600000).toISOString(),
    source: 'Synthetic reviewed webpage pricing contract',
    credits: { GenerateBase: 15 },
    evidence: [{ url: 'https://tripo-webapp-assets.tripo3d.ai/reviewed.js', sha256: 'a'.repeat(64) }],
    unquoted_operations: [...unquotedOperations],
  };
}

async function setup(t: test.TestContext) {
  const f = await fixture();
  t.after(async () => {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  });
  const file = path.join(f.dir, 'pricing.json');
  await writeFile(file, JSON.stringify(snapshot()));
  f.service.pricing = new PricingService(file);
  const model = path.join(f.dir, 'source.glb');
  const image = path.join(f.dir, 'source.png');
  await writeFile(model, tinyGlb());
  await writeFile(
    image,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
  const parameters: Record<UnquotedOperation, Record<string, unknown>> = {
    import_model: { model_path: model, name: 'Fixture model' },
    modification: { project_id: 'project', part_indices: { mesh: [0] }, part_indices_name: { 0: 'part' } },
    retexture_apply: { project_id: 'project', image_map: [{ part_name: 'mesh', image_path: image }] },
  };
  return { ...f, file, parameters };
}

test('unquoted review declarations are restricted, unique and cannot contradict a numeric price', () => {
  const current = snapshot();
  assert.equal(priceSchema.safeParse(current).success, true);
  assert.equal(priceSchema.safeParse({ ...current, unquoted_operations: ['model'] }).success, false);
  assert.equal(
    priceSchema.safeParse({ ...current, unquoted_operations: ['import_model', 'import_model'] }).success,
    false,
  );
  assert.equal(
    priceSchema.safeParse({ ...current, credits: { ...current.credits, ImportOwnModel: 0 } }).success,
    false,
  );
  const { unquoted_operations: ignored, ...legacy } = current;
  assert.ok(ignored);
  assert.equal(Object.hasOwn(priceSchema.parse(legacy), 'unquoted_operations'), false);
  assert.deepEqual(pricingSnapshotStatus(legacy).unquoted_operations, []);
});

test('a current bundled review exposes numeric coverage and explicitly unknown audited operations', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(reviewedPrices.reviewed_at) });
  const status = pricingSnapshotStatus(reviewedPrices);
  assert.equal(status.price_key_count, 48);
  assert.deepEqual(status.unquoted_operations, [...unquotedOperations]);
  for (const key of ['ImportOwnModel', 'SaveSegmentation', 'ApplyTextureBasic'])
    assert.equal(Object.hasOwn(reviewedPrices.credits, key), false);
  const pricing = new PricingService('/missing-unquoted-pricing.json', reviewedPrices);
  for (const operation of unquotedOperations) {
    const result = await pricing.quote(operation, {});
    assert.equal(result.known, false);
    assert.equal(result.variable, true);
    assert.equal(result.credits, undefined);
    assert.match(result.explanation, /without an advance price/);
    assert.match(result.explanation, /not free or a spending cap/);
  }
});

test('unknown billing requires an unexpired explicit declaration and nonempty evidence', async (t) => {
  const f = await setup(t);
  const current = snapshot();
  for (const candidate of [
    { ...current, unquoted_operations: undefined },
    { ...current, evidence: [] },
    { ...current, expires_at: new Date(Date.now() - 1).toISOString() },
    { ...current, reviewed_at: new Date(Date.now() + 60000).toISOString() },
  ]) {
    await writeFile(f.file, JSON.stringify(candidate));
    const result = await f.service.pricing.quote('modification', {});
    assert.equal(result.known, false);
    assert.equal(result.variable, undefined);
    assert.equal(result.credits, undefined);
    await assert.rejects(
      f.service.submit('modification', 'unavailable', {
        ...f.parameters.modification,
        accept_variable_cost: true,
      }),
      { code: 'PRICE_UNKNOWN' },
    );
  }
  assert.equal(f.gateway.posts, 0);
});

test('each reviewed operation requires literal consent and omission of every numeric budget', async (t) => {
  const f = await setup(t);
  for (const operation of unquotedOperations) {
    const parameters = f.parameters[operation];
    for (const invalid of [false, 'true', 1])
      assert.throws(() => normalize(operation, { ...parameters, accept_variable_cost: invalid }));
    await assert.rejects(f.service.submit(operation, `${operation}-default`, parameters), {
      code: 'PRICE_UNKNOWN',
    });
    const consent = { ...parameters, accept_variable_cost: true };
    for (const maximum of [0, 20, Infinity, NaN])
      await assert.rejects(f.service.submit(operation, `${operation}-budget-${maximum}`, consent, maximum), {
        code: 'UNQUOTED_BUDGET_UNSUPPORTED',
      });
  }
  assert.equal(f.gateway.posts, 0);
});

test('explicit unknown billing is persisted, keeps request identity and never resubmits unknown writes', async (t) => {
  const f = await setup(t);
  for (const operation of unquotedOperations) {
    const input = { ...f.parameters[operation], accept_variable_cost: true };
    const first = await f.service.submit(operation, operation, input);
    const duplicate = await f.service.submit(operation, operation, input);
    assert.equal(first.job_id, duplicate.job_id);
    const stored = f.jobs.get(String(first.job_id));
    assert.equal(stored.input.accept_variable_cost, true);
    assert.equal(stored.quote.known, false);
    assert.equal(stored.quote.credits, undefined);
    assert.equal(stored.quote.variable, true);
    assert.ok(Date.parse(stored.quote.expires_at) <= Date.now() + 300000);
    await assert.rejects(f.service.submit(operation, operation, f.parameters[operation]), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
  }
  assert.equal(f.gateway.posts, 3);
  f.gateway.failSubmit = new TripoError('NETWORK', 'Receipt unknown.', 'unknown');
  const input = { ...f.parameters.modification, accept_variable_cost: true };
  const unknown = await f.service.submit('modification', 'unknown', input);
  assert.equal(unknown.state, 'outcome_unknown');
  const recovered = await f.service.submit('modification', 'unknown', input);
  assert.equal(recovered.job_id, unknown.job_id);
  assert.equal(recovered.state, 'outcome_unknown');
  assert.equal(f.gateway.posts, 4);
});

test('a stale unquoted authorization is rejected again immediately before a remote write', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2040-01-01T00:00:00Z') });
  const f = await setup(t);
  (f.gateway as Gateway).submit = async (_job, beforeSend) => {
    t.mock.timers.tick(300001);
    beforeSend?.();
    f.gateway.posts++;
    return { remote_ids: { project_id: 'project', operator_id: 'new' } };
  };
  const result = await f.service.submit('modification', 'expires-at-send', {
    ...f.parameters.modification,
    accept_variable_cost: true,
  });
  assert.equal(result.state, 'failed');
  assert.equal((result.error as { code: string }).code, 'PRICE_UNKNOWN');
  assert.equal(f.gateway.posts, 0);
});

test('numeric quotes still require budgets and unrelated unknown prices gain no exemption', async (t) => {
  const f = await setup(t);
  const current = snapshot();
  await writeFile(
    f.file,
    JSON.stringify({
      ...current,
      unquoted_operations: [],
      credits: { GenerateBase: 15, SaveSegmentation: 8 },
    }),
  );
  const input = { ...f.parameters.modification, accept_variable_cost: true };
  await assert.rejects(f.service.submit('modification', 'numeric-missing-budget', input), {
    code: 'INVALID_INPUT',
  });
  await assert.rejects(f.service.submit('modification', 'numeric-over-budget', input, 7), {
    code: 'ESTIMATE_EXCEEDS_BUDGET',
  });
  await f.service.submit('modification', 'numeric-budget', input, 8);
  assert.equal(f.gateway.posts, 1);
  f.service.pricing = { quote: async () => ({ ...quote, known: false, credits: undefined, variable: true }) };
  await assert.rejects(f.service.submit('image', 'other-variable', { prompt: 'robot' }, 0), {
    code: 'PRICE_UNKNOWN',
  });
  assert.equal(f.gateway.posts, 1);
});

test('unknown-cost consent never appears in Studio upload or final business payloads', async (t) => {
  const f = await setup(t);
  const requests: unknown[] = [];
  const client = new StudioClient(f.service.credentials, async (_url, init) => {
    requests.push(init.body);
    return new Response(null, { status: 200 });
  });
  client.request = async (_method, route, body) => {
    assert.equal(route, '/v2/studio/storage/temporary_token');
    requests.push(body);
    return {
      sts_ak: 'synthetic-access-key',
      sts_sk: 'synthetic-secret-key',
      session_token: 'synthetic-session',
      resource_bucket: 'synthetic-bucket',
      resource_uri: 'synthetic-resource',
    };
  };
  for (const operation of unquotedOperations) {
    const input = normalize(operation, { ...f.parameters[operation], accept_variable_cost: true });
    if (operation === 'import_model')
      input._input_files = {
        [String(input.model_path)]: createHash('sha256').update(tinyGlb()).digest('hex'),
      };
    const job = f.jobs.prepare('test-account', operation, operation, input, quote);
    const submission = await advancedOperation(job, {
      client,
      roots: [f.dir],
      imageReference: async () => ({
        bucket: 'synthetic-bucket',
        key: 'synthetic-image',
        image_audit_result: 'pass',
        image_source: 'upload',
      }),
    });
    assert.ok(submission);
    requests.push(submission.body);
  }
  assert.equal(JSON.stringify(requests).includes('accept_variable_cost'), false);
  assert.equal(JSON.stringify(requests).includes('max_estimated_credits'), false);
});
