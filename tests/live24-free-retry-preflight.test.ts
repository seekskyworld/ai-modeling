/** 真实 REST 适配层的重试能力门槛；控制网络响应，生产数据库与真实项目均不写入。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rm } from 'node:fs/promises';
import { fixture, quote } from './helpers.ts';
import { StudioClient } from '../studio/api/client.ts';
import { StudioGateway } from '../studio/api/gateway.ts';
import { MemoryLinks } from '../studio/auth/artifact-links.ts';
import { object, text } from '../studio/contracts/errors.ts';

async function retryFixture(retryInfo: unknown, lostReceipt = false) {
  const f = await fixture();
  const detail: Record<string, unknown> = {
    id: 'retry-project',
    is_owner: true,
    running_operator: null,
    operator: { operator_id: 'original-generation', status: 'success', type: 'image_to_model' },
    retry_info: retryInfo,
  };
  const calls: { method: string; route: string; body?: unknown }[] = [];
  const client = new StudioClient(f.service.credentials, async (url, init) => {
    const target = new URL(url),
      route = target.pathname + target.search;
    calls.push({
      method: text(init.method),
      route,
      ...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    if (route === '/v2/studio/user/profile/payment')
      return Response.json({ code: 0, data: { wallet: { total_credit: 100 } } });
    if (route === '/v2/studio/project/detail/v3/retry-project')
      return Response.json({ code: 0, data: detail });
    assert.equal(init.method, 'POST');
    assert.equal(route, '/v2/studio/operation/free-retry/retry-project');
    if (lostReceipt) throw new Error('Controlled missing response after original POST');
    return Response.json({ code: 0, data: { project_id: 'retry-project', operator_id: 'retry-receipt' } });
  });
  const gateway = new StudioGateway(client, [], new MemoryLinks());
  f.service.gateway = gateway;
  return {
    ...f,
    gateway,
    detail,
    calls,
    posts: () => calls.filter((call) => call.method === 'POST'),
    close: async () => {
      f.jobs.close();
      await rm(f.dir, { recursive: true, force: true });
    },
  };
}

test('real REST preflight sends no free-retry POST without explicit generation eligibility', async () => {
  for (const info of [undefined, null, {}, { can_retry: false }, { can_retry: 'true' }, { can_retry: 1 }]) {
    const f = await retryFixture(info);
    try {
      f.detail.local_edit_retry_info = { can_retry: true };
      await assert.rejects(
        f.gateway.submit(
          f.jobs.prepare('test-account', 'ineligible-retry', 'retry', { project_id: 'retry-project' }, quote),
        ),
        { code: 'STUDIO_CAPABILITY_UNAVAILABLE', certainty: 'not_submitted' },
      );
      assert.deepEqual(
        f.calls.map((call) => call.route),
        ['/v2/studio/project/detail/v3/retry-project'],
      );
      assert.equal(f.posts().length, 0);
    } finally {
      await f.close();
    }
  }
});

test('explicit eligibility preserves the exact native free-retry route and existing ownership/busy guards', async () => {
  const f = await retryFixture({ can_retry: true, can_show_retry: false, remaining_retries: -1 });
  const job = f.jobs.prepare(
    'test-account',
    'eligible-retry',
    'retry',
    { project_id: 'retry-project' },
    quote,
  );
  try {
    f.detail.is_owner = false;
    await assert.rejects(f.gateway.submit(job), { code: 'OWNERSHIP_REQUIRED' });
    f.detail.is_owner = true;
    f.detail.running_operator = { operator_id: 'busy-operation' };
    await assert.rejects(f.gateway.submit(job), { code: 'PROJECT_BUSY' });
    assert.equal(f.posts().length, 0);
    f.detail.running_operator = null;
    assert.deepEqual(await f.gateway.submit(job), {
      remote_ids: { project_id: 'retry-project', operator_id: 'retry-receipt' },
    });
    assert.deepEqual(f.posts(), [
      { method: 'POST', route: '/v2/studio/operation/free-retry/retry-project', body: {} },
    ]);
  } finally {
    await f.close();
  }
});

test('natural failed-segmentation project capabilities reject before POST and retain the refused request', async () => {
  // live24 的两个原生失败项目均返回这组字段，current 仍是先前成功 meta_modification。
  const f = await retryFixture({
    max_retries: 999999,
    used_retries: 0,
    remaining_retries: -1,
    can_retry: false,
    can_show_retry: false,
  });
  try {
    f.detail.operator = { operator_id: 'prior-metadata', status: 'success', type: 'meta_modification' };
    f.detail.local_edit_retry_info = structuredClone(f.detail.retry_info);
    const input = { project_id: 'retry-project' };
    const first = await f.service.submit('retry', 'ineligible-project', input, 10);
    assert.equal(first.state, 'failed');
    assert.equal(object(first.error).code, 'STUDIO_CAPABILITY_UNAVAILABLE');
    assert.equal(object(first.error).certainty, 'not_submitted');
    assert.equal(f.posts().length, 0);
    f.detail.retry_info = { can_retry: true };
    const readCount = f.calls.length;
    assert.deepEqual(await f.service.submit('retry', 'ineligible-project', input, 10), first);
    assert.equal(f.calls.length, readCount);
    assert.equal(f.posts().length, 0);
  } finally {
    await f.close();
  }
});

test('accepted and unknown free-retry requests retain the original receipt without rechecking changed eligibility', async () => {
  for (const lostReceipt of [false, true]) {
    const f = await retryFixture({ can_retry: true }, lostReceipt);
    try {
      const input = { project_id: 'retry-project' };
      const first = await f.service.submit('retry', 'original-free-retry', input, 10);
      assert.equal(first.state, lostReceipt ? 'outcome_unknown' : 'submitted');
      if (!lostReceipt) f.jobs.update(text(first.job_id), 'succeeded', { progress: 100, artifacts: [] });
      f.detail.retry_info = { can_retry: false };
      const callCount = f.calls.length;
      const again = await f.service.submit('retry', 'original-free-retry', input, 10);
      assert.equal(again.job_id, first.job_id);
      assert.equal(again.state, lostReceipt ? 'outcome_unknown' : 'succeeded');
      assert.deepEqual(again.remote_ids, first.remote_ids);
      assert.equal(f.calls.length, callCount);
      assert.equal(f.posts().length, 1);
      if (lostReceipt) assert.deepEqual(again.error, first.error);
    } finally {
      await f.close();
    }
  }
});
