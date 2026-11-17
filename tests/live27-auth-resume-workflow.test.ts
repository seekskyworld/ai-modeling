/** 原任务只续读原回执；认证变化不重置已发送写请求或候选子请求身份。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { fixture, imageInput, quote } from './helpers.ts';
import { StudioClient } from '../studio/api/client.ts';
import { TripoError, array, object, text } from '../studio/contracts/errors.ts';
import { waitTask, type Application } from '../cli/compat/runtime.ts';
import { executeCandidates } from '../cli/compat/run-plan.ts';
import { generationPlan } from '../cli/compat/planning.ts';

const denied = () => Response.json({ code: 1002 }, { status: 401 });
const pending = () =>
  new TripoError('AUTH_REQUIRED', 'Controlled login is pending.', 'read', {
    login: { status: 'waiting_for_login', login_id: '22222222-2222-4222-8222-222222222222' },
    resume: { checkpoint: 'read_rejected', replay_submitted_writes: false },
  });

test('waiting resumes only the original poll after login and never re-enters submission', async () => {
  const f = await fixture(),
    polls: string[] = [];
  let logins = 0;
  try {
    const first = await f.service.submit('image', 'live27-original-poll', imageInput, 10);
    const id = text(first.job_id),
      original = f.jobs.get(id);
    const client = new StudioClient(
      f.service.credentials,
      async (url) => {
        polls.push(url);
        return polls.length === 1
          ? denied()
          : Response.json({ code: 0, data: { state: 'succeeded', progress: 100, artifacts: [] } });
      },
      undefined,
      async (context) => {
        logins++;
        assert.equal(context.expectedAccountRef, original.account_ref);
        f.service.credentials.save({
          ...f.service.credentials.load()!,
          cookie: 'controlled-restored-cookie',
        });
      },
    );
    f.gateway.status = async (job) =>
      (await client
        .forAccount(job.account_ref)
        .request('GET', `/v2/studio/operation/status/${job.remote_ids.asset_id}`)) as {
        state: 'succeeded';
        progress: number;
        artifacts: [];
      };
    const result = await waitTask({ service: f.service } as Application, id, 0);
    assert.equal(result.state, 'succeeded');
    assert.equal(result.job_id, id);
    assert.equal(result.request_id, original.request_id);
    assert.deepEqual(f.jobs.get(id).remote_ids, original.remote_ids);
    assert.equal(logins, 1);
    assert.equal(polls.length, 2);
    assert.equal(polls[0], polls[1]);
    assert.equal(f.gateway.posts, 1);
    assert.equal(f.jobs.list('test-account').length, 1);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('pending noninteractive poll persists requires_login and later recovers the same job', async () => {
  const f = await fixture();
  let ready = false,
    fresh = false,
    reads = 0,
    logins = 0;
  try {
    const first = await f.service.submit('image', 'live27-pending-original', imageInput, 10),
      id = text(first.job_id);
    const original = f.jobs.get(id);
    const client = new StudioClient(
      f.service.credentials,
      async () => {
        reads++;
        return fresh
          ? Response.json({ code: 0, data: { state: 'succeeded', progress: 100, artifacts: [] } })
          : denied();
      },
      undefined,
      async () => {
        logins++;
        if (!ready) throw pending();
        fresh = true;
        f.service.credentials.save({
          ...f.service.credentials.load()!,
          cookie: 'controlled-restored-cookie',
        });
      },
    );
    f.gateway.status = async (job) =>
      (await client.forAccount(job.account_ref).request('GET', '/v2/studio/operation/status/original')) as {
        state: 'succeeded';
        progress: number;
        artifacts: [];
      };
    const waiting = await waitTask({ service: f.service } as Application, id, 0);
    assert.equal(waiting.state, 'requires_login');
    assert.equal(object(object(waiting.error).login).status, 'waiting_for_login');
    assert.equal(reads, 1);
    assert.equal(f.gateway.posts, 1);
    ready = true;
    const recovered = await f.service.get(id);
    assert.equal(recovered.state, 'succeeded');
    assert.equal(recovered.job_id, id);
    assert.equal(recovered.request_id, original.request_id);
    assert.deepEqual(recovered.remote_ids, original.remote_ids);
    assert.equal(logins, 2);
    assert.equal(reads, 3);
    assert.equal(f.gateway.posts, 1);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

for (const outcome of ['auth_rejected', 'unknown'] as const) {
  test(`an original paid ${outcome} is retained when the same request is invoked after login`, async () => {
    const f = await fixture();
    let sends = 0,
      logins = 0;
    try {
      const client = new StudioClient(
        f.service.credentials,
        async () => {
          sends++;
          if (outcome === 'unknown') throw new TypeError('controlled receipt loss');
          return denied();
        },
        undefined,
        async () => {
          logins++;
        },
      );
      f.gateway.submit = async (job) => {
        await client
          .forAccount(job.account_ref)
          .request('POST', '/v2/studio/operation/generate', job.input, { paid: true });
        throw new Error('Controlled paid outcome unexpectedly succeeded');
      };
      const first = await f.service.submit('image', 'live27-paid-original', imageInput, 10);
      assert.equal(first.state, outcome === 'unknown' ? 'outcome_unknown' : 'failed');
      assert.equal(object(first.error).code, outcome === 'unknown' ? 'NETWORK_ERROR' : 'AUTH_REQUIRED');
      f.service.credentials.save({ ...f.service.credentials.load()!, cookie: 'controlled-new-login' });
      const restored = await f.service.submit('image', 'live27-paid-original', imageInput, 10);
      assert.equal(restored.job_id, first.job_id);
      assert.equal(restored.state, first.state);
      assert.deepEqual(restored.error, first.error);
      assert.equal(sends, 1);
      assert.equal(logins, 0);
      assert.equal(f.jobs.list('test-account').length, 1);
    } finally {
      f.jobs.close();
      await rm(f.dir, { recursive: true, force: true });
    }
  });
}

test('candidate auth failures expose stable child IDs and recovery preserves their seeds and submitted intents', async () => {
  const f = await fixture();
  let ready = false;
  const app = { service: f.service } as Application;
  const flags = { candidates: 2, requestId: 'live27-candidates', wait: false, download: false };
  const plan = generationPlan('text-to-model', ['cube'], { param: { texture: false } });
  f.service.pricing.quote = async () => {
    if (!ready) throw pending();
    return quote;
  };
  try {
    const first = array((await executeCandidates(app, plan, flags)).candidates).map(object);
    assert.equal(first.length, 2);
    assert.deepEqual(
      first.map((row) => row.request_id),
      ['live27-candidates-0', 'live27-candidates-1'],
    );
    assert.ok(first.every((row) => object(row.error).code === 'AUTH_REQUIRED'));
    assert.equal(f.gateway.posts, 0);
    ready = true;
    const restored = array((await executeCandidates(app, plan, flags)).candidates).map(object);
    assert.deepEqual(
      restored.map((row) => row.seed),
      first.map((row) => row.seed),
    );
    assert.deepEqual(
      restored.map((row) => row.request_id),
      ['live27-candidates-0-0', 'live27-candidates-1-0'],
    );
    assert.equal(f.gateway.posts, 2);
    const repeated = array((await executeCandidates(app, plan, flags)).candidates).map(object);
    assert.deepEqual(
      repeated.map((row) => row.task_id),
      restored.map((row) => row.task_id),
    );
    assert.equal(f.gateway.posts, 2);
    assert.equal(f.jobs.list('test-account').length, 2);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
