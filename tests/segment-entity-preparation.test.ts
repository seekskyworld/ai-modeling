/** 真实 TaskService/Operations/SQLite + 假下载 transport，核对完整准备链及原请求恢复。 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { EnvHttpProxyAgent, MockAgent } from 'undici';
import { fixture, quote } from './helpers.ts';
import { scaleModel } from './helpers-smartsegment-scale.ts';
import type { Gateway } from '../studio/api/gateway.ts';
import type { StudioClient } from '../studio/api/client.ts';
import { Operations } from '../studio/api/operations.ts';
import { segmentEntitySnapshot } from '../studio/api/segment-entity-snapshot.ts';
import { object, TripoError } from '../studio/contracts/errors.ts';
import { segmentEntityPolicyKey, segmentEntityMarker } from '../cli/core/segment-entity-policy.ts';

async function setup(t: TestContext) {
  const f = await fixture(),
    agent = new MockAgent(),
    bytes = await scaleModel();
  agent.disableNetConnect();
  t.mock.method(EnvHttpProxyAgent.prototype, 'dispatch', agent.dispatch.bind(agent));
  agent
    .get('https://cdn.tripo3d.ai')
    .intercept({ path: /\/source\.glb/, method: 'GET' })
    .reply(200, bytes)
    .persist();
  const input = { project_id: 'entity-project', model_version: 'v2.0-20260430', prompt: 'head and body' };
  const detail = {
    id: input.project_id,
    is_owner: true,
    model_url: 'https://cdn.tripo3d.ai/source.glb?X-Amz-Date=old&X-Amz-Signature=old',
    operator: {
      operator_id: 'entity-source',
      status: 'success',
      is_segmented: true,
      metadata: { transform_matrix: [] as number[], children_deleted: [] as string[] },
    },
  };
  const reads: string[] = [],
    bodies: Record<string, unknown>[] = [];
  let afterSnapshot: (() => void) | undefined;
  const client = {
    forAccount(account: string) {
      assert.equal(account, 'test-account');
      return client;
    },
    async request(method: string, url: string) {
      assert.equal(method, 'GET');
      reads.push(url);
      return structuredClone(detail);
    },
  } as unknown as StudioClient;
  const gateway: Gateway = {
    account: () => f.gateway.account(),
    segmentEntitySource: async (account, sourceInput) => {
      const result = await segmentEntitySnapshot(client, account, sourceInput);
      afterSnapshot?.();
      return result;
    },
    submit: async (job, before, options) => {
      before?.();
      const submission = await new Operations(client, []).build(job, options);
      before?.();
      bodies.push(submission.body);
      f.gateway.posts++;
      return { remote_ids: { project_id: input.project_id, operator_id: 'entity-result' } };
    },
    status: async () => ({ state: 'succeeded', progress: 100, artifacts: [] }),
    artifactUrl: async () => {
      throw new TripoError('FIXTURE_NO_ARTIFACT', 'No network artifact lookup.');
    },
  };
  f.service.gateway = gateway;
  t.after(async () => {
    f.jobs.close();
    await agent.close();
    await rm(f.dir, { recursive: true, force: true });
  });
  return {
    ...f,
    gateway,
    input,
    detail,
    reads,
    bodies,
    afterSnapshot: (hook: () => void) => {
      afterSnapshot = hook;
    },
  };
}

test('new generic segment freezes an exact source, chooses ordinary for one sticky entity and restores the original job', async (t) => {
  const f = await setup(t),
    request = 'generic-first';
  const result = await f.service.submit('segment', request, f.input, 40);
  const job = f.jobs.get(String(result.job_id));
  assert.equal(f.bodies.length, 1);
  assert.equal(f.bodies[0]!.operator_id, undefined);
  assert.equal(f.bodies[0]!.segmentation_granularity, 'balanced');
  assert.equal(object(job.input[segmentEntityMarker]).version, 1);
  const policy = f.jobs.requestPolicy('test-account', segmentEntityPolicyKey(request))!;
  assert.equal(object(policy.proof).strategy, 'ordinary');
  assert.equal(JSON.stringify(policy).includes('X-Amz'), false);
  assert.deepEqual(object(object(policy.proof).metadata).transform_matrix, []);
  // 成功/已提交恢复不重新依赖已变化的来源，保持同一远端回执。
  f.detail.operator.operator_id = 'changed-after-submission';
  const before = f.reads.length,
    again = await f.service.submit('segment', request, f.input, 0);
  assert.equal(again.job_id, result.job_id);
  assert.equal(f.reads.length, before);
  assert.equal(f.bodies.length, 1);
  await assert.rejects(f.service.submit('segment', request, { ...f.input, prompt: 'different' }, 0), {
    code: 'IDEMPOTENCY_CONFLICT',
  });
});

test('budget rejection preserves prepared policy and signature renewal restores the same source without a new derivation', async (t) => {
  const f = await setup(t),
    request = 'generic-budget';
  await assert.rejects(f.service.submit('segment', request, f.input, 0), { code: 'ESTIMATE_EXCEEDS_BUDGET' });
  assert.equal(f.jobs.find('test-account', request), undefined);
  const prior = f.jobs.requestPolicy('test-account', segmentEntityPolicyKey(request));
  f.detail.model_url = 'https://cdn.tripo3d.ai/source.glb?X-Amz-Date=new&X-Amz-Signature=new';
  await f.service.submit('segment', request, f.input, 40);
  assert.deepEqual(f.jobs.requestPolicy('test-account', segmentEntityPolicyKey(request)), prior);
  assert.equal(f.bodies.length, 1);
});

test('stale absent deletion uses verified ordinary route and retains exact metadata across preparation and completed recovery', async (t) => {
  const f = await setup(t),
    request = 'stale-absent-first';
  f.detail.operator.metadata.children_deleted = ['old_part_9'];
  await assert.rejects(f.service.submit('segment', request, f.input, 0), { code: 'ESTIMATE_EXCEEDS_BUDGET' });
  const policy = f.jobs.requestPolicy('test-account', segmentEntityPolicyKey(request))!;
  assert.equal(object(policy.proof).strategy, 'ordinary');
  assert.deepEqual(object(object(policy.proof).metadata).children_deleted, ['old_part_9']);
  f.detail.model_url = 'https://cdn.tripo3d.ai/source.glb?X-Amz-Date=new&X-Amz-Signature=new';
  const result = await f.service.submit('segment', request, f.input, 40);
  assert.equal(f.bodies.length, 1);
  assert.equal(f.bodies[0]!.operator_id, undefined);
  assert.deepEqual(f.jobs.requestPolicy('test-account', segmentEntityPolicyKey(request)), policy);
  f.detail.operator.metadata.children_deleted = [];
  f.detail.operator.operator_id = 'later-operator';
  const reads = f.reads.length,
    again = await f.service.submit('segment', request, f.input, 0);
  assert.equal(again.job_id, result.job_id);
  assert.equal(f.reads.length, reads);
  assert.equal(f.bodies.length, 1);
  assert.deepEqual(f.jobs.requestPolicy('test-account', segmentEntityPolicyKey(request)), policy);
});

test('removing an absent deletion marker after preparation is still metadata drift before submission', async (t) => {
  const f = await setup(t),
    request = 'stale-absent-drift';
  f.detail.operator.metadata.children_deleted = ['old_part_9'];
  await assert.rejects(f.service.submit('segment', request, f.input, 0), { code: 'ESTIMATE_EXCEEDS_BUDGET' });
  const policy = f.jobs.requestPolicy('test-account', segmentEntityPolicyKey(request));
  f.detail.operator.metadata.children_deleted = [];
  await assert.rejects(f.service.submit('segment', request, f.input, 40), {
    code: 'SEGMENT_ENTITY_SOURCE_CHANGED',
  });
  assert.equal(f.bodies.length, 0);
  assert.deepEqual(f.jobs.requestPolicy('test-account', segmentEntityPolicyKey(request)), policy);
});

for (const mutation of ['operator', 'metadata'] as const)
  test(`source ${mutation} drift between preparation reads stops before quoting or submission`, async (t) => {
    const f = await setup(t);
    f.afterSnapshot(() => {
      if (mutation === 'operator') f.detail.operator.operator_id = 'changed';
      else f.detail.operator.metadata.children_deleted = ['editable-mesh'];
    });
    let quotes = 0;
    f.service.pricing = {
      quote: async () => {
        quotes++;
        return quote;
      },
    };
    await assert.rejects(f.service.submit('segment', 'generic-drift', f.input, 40));
    assert.equal(quotes, 0);
    assert.equal(f.bodies.length, 0);
    assert.equal(f.jobs.find('test-account', 'generic-drift'), undefined);
  });

test('existing legacy prepared job acquires no entity policy or source download', async (t) => {
  const f = await setup(t);
  // 先让旧版规范化输入通过真实准备，再冻结为尚未提交的旧任务。
  const { normalize } = await import('../studio/contracts/schemas.ts');
  f.jobs.prepare('test-account', 'legacy-prepared', 'segment', normalize('segment', f.input), quote);
  await f.service.submit('segment', 'legacy-prepared', f.input, 40);
  assert.equal(f.jobs.requestPolicy('test-account', segmentEntityPolicyKey('legacy-prepared')), undefined);
  assert.equal(f.bodies[0]!.operator_id, 'entity-source');
  assert.equal(f.reads.length, 1);
});

test('account changes during source inspection stop preparation without creating a job', async (t) => {
  const f = await setup(t);
  f.afterSnapshot(() => {
    const old = f.service.credentials.load()!;
    f.service.credentials.save({ ...old, accountRef: 'different-account' });
  });
  await assert.rejects(f.service.submit('segment', 'account-switch', f.input, 40), {
    code: 'ACCOUNT_MISMATCH',
  });
  assert.equal(f.bodies.length, 0);
  assert.equal(f.jobs.find('test-account', 'account-switch'), undefined);
});
