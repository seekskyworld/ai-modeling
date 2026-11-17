/** 验证真实 SQLite 和可控远端的提交次数，覆盖响应丢失、重启与并发领取。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fixture, imageInput, quote } from './helpers.ts';
import { TripoError } from '../studio/contracts/errors.ts';
import { normalize } from '../studio/contracts/schemas.ts';

test('concurrent duplicate submissions share one receipt; changing input conflicts', async () => {
  const a = await fixture();
  const b = await fixture(a.dir);
  b.service.gateway = a.gateway;
  try {
    const [first, second] = await Promise.all([
      a.service.submit('image', 'repeat', imageInput, 10),
      b.service.submit('image', 'repeat', imageInput, 10),
    ]);
    assert.equal(first.job_id, second.job_id);
    assert.equal(a.gateway.posts, 1);
    assert.equal((await a.service.submit('image', 'repeat', imageInput, 0)).job_id, first.job_id);
    await assert.rejects(a.service.submit('image', 'repeat', { ...imageInput, prompt: 'different' }, 10), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
  } finally {
    a.jobs.close();
    b.jobs.close();
    await rm(a.dir, { recursive: true, force: true });
  }
});
test('accepted request with lost receipt never resubmits across restart; exact IDs reconcile', async () => {
  const a = await fixture();
  a.gateway.failSubmit = new TripoError('NETWORK_ERROR', 'Response was lost', 'unknown');
  const first = await a.service.submit('image', 'lost', imageInput, 10);
  assert.equal(first.state, 'outcome_unknown');
  assert.equal(a.gateway.posts, 1);
  a.jobs.close();
  const b = await fixture(a.dir);
  try {
    assert.equal((await b.service.submit('image', 'lost', imageInput, 10)).state, 'outcome_unknown');
    assert.equal(b.gateway.posts, 0);
    const reconciled = await b.service.reconcile(String(first.job_id), { asset_id: 'remote-image-1' });
    assert.equal(reconciled.state, 'succeeded');
    assert.equal(b.gateway.posts, 0);
  } finally {
    b.jobs.close();
    await rm(a.dir, { recursive: true, force: true });
  }
});
test('a dead submitting lease becomes unknown, while another prepared job can proceed', async () => {
  const f = await fixture();
  try {
    const first = f.jobs.prepare('test-account', 'crashed', 'image', normalize('image', imageInput), quote);
    assert.equal(f.jobs.claim(first.job_id, 1), true);
    await delay(5);
    f.jobs.recoverExpired();
    assert.equal(f.jobs.get(first.job_id).state, 'outcome_unknown');
    assert.equal(f.jobs.claim(first.job_id), false);
    assert.equal((await f.service.submit('image', 'other', imageInput, 10)).state, 'submitted');
    assert.equal(f.gateway.posts, 1);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
test('budget and unknown price reject before a remote POST', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.service.submit('image', 'budget', imageInput, 1), {
      code: 'ESTIMATE_EXCEEDS_BUDGET',
    });
    f.service.pricing = { quote: async () => ({ ...quote, known: false }) };
    await assert.rejects(f.service.submit('image', 'unknown', imageInput, 100), { code: 'PRICE_UNKNOWN' });
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('remote failure details survive reconnect and do not resubmit', async () => {
  const f = await fixture();
  const failure = { code: 'REMOTE_TASK_FAILED', remote_status: 'failed' };
  f.gateway.status = async () => ({ state: 'failed', progress: 0, artifacts: [], error: failure });
  const submitted = await f.service.submit('image', 'remote-failure', imageInput, 10);
  assert.deepEqual((await f.service.get(String(submitted.job_id))).error, failure);
  f.jobs.close();
  const restored = await fixture(f.dir);
  try {
    const job = await restored.service.submit('image', 'remote-failure', imageInput, 10);
    assert.equal(job.state, 'failed');
    assert.deepEqual(job.error, failure);
    assert.equal(restored.gateway.posts, 0);
  } finally {
    restored.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
test('expired auth preserves the remote ID and resumes polling with restored identity', async () => {
  const f = await fixture();
  try {
    const first = await f.service.submit('image', 'auth', imageInput, 10);
    f.gateway.failPoll = new TripoError('AUTH_REQUIRED', 'expired');
    assert.equal((await f.service.get(String(first.job_id))).state, 'requires_login');
    f.gateway.failPoll = undefined;
    assert.equal((await f.service.get(String(first.job_id))).state, 'succeeded');
    assert.equal(f.gateway.posts, 1);
    const session = f.service.credentials.load()!;
    f.service.credentials.save({ ...session, accountRef: 'different' });
    await assert.rejects(f.service.get(String(first.job_id)), { code: 'ACCOUNT_MISMATCH' });
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
test('separate OS processes atomically claim exactly one submission', async () => {
  const f = await fixture();
  try {
    const job = f.jobs.prepare('test-account', 'processes', 'image', normalize('image', imageInput), quote);
    const run = async (): Promise<string> =>
      await new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['tests/claim-fixture.ts', path.join(f.dir, 'jobs.sqlite'), job.job_id],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let out = '';
        let err = '';
        child.stdout.on('data', (data) => (out += String(data)));
        child.stderr.on('data', (data) => (err += String(data)));
        child.on('error', reject);
        child.on('exit', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err))));
      });
    const claims = await Promise.all([run(), run(), run()]);
    assert.deepEqual(claims.sort(), ['false', 'false', 'true']);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
test('reusing a submitted Canvas intent does not re-read a changed remote graph', async () => {
  const f = await fixture();
  let reads = 0;
  Object.assign(f.gateway, {
    prepareInput: async (_operation: string, input: Record<string, unknown>) => {
      reads++;
      if (reads > 1) throw new TripoError('CANVAS_CHANGED', 'Graph has advanced');
      return { ...input, _canvas_quotes: [{ operation: 'image', parameters: { amount: 1 } }] };
    },
  });
  const parameters = { canvas_id: 'canvas-1', revision: '1', node_ids: ['node-1'] };
  try {
    const first = await f.service.submit('canvas_run', 'canvas-intent', parameters, 10);
    assert.equal(
      (await f.service.submit('canvas_run', 'canvas-intent', parameters, 10)).job_id,
      first.job_id,
    );
    assert.equal(reads, 1);
    assert.equal(f.gateway.posts, 1);
    await assert.rejects(
      f.service.submit('canvas_run', 'canvas-intent', { ...parameters, revision: '2' }, 10),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
