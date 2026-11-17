/** 隔离复制必须由真实执行器先核原件，再继续收费链；失败回执和旧布局不能被重排。 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EnvHttpProxyAgent, MockAgent } from 'undici';
import { labSourceFixture } from './lab-model-source-fixture.ts';
import { StudioClient } from '../studio/api/client.ts';
import { TaskService } from '../cli/core/service.ts';
import { JobStore } from '../cli/storage/jobs.ts';
import { object, array } from '../studio/contracts/errors.ts';
import type { Job } from '../studio/contracts/types.ts';
import { processingPlan } from '../cli/compat/planning.ts';
import { executePlan, type Application } from '../cli/compat/runtime.ts';
import { prepareLabModelSource, freezeLabModelSourceSelection } from '../cli/compat/lab-model-source.ts';
import { labModelIsolationProofKey } from '../cli/compat/lab-model-isolation-policy.ts';

async function runtimeFixture(t: TestContext) {
  const agent = new MockAgent();
  agent.disableNetConnect();
  t.mock.method(EnvHttpProxyAgent.prototype, 'dispatch', agent.dispatch.bind(agent));
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected global fetch outside the intercepted fixture transport');
  });
  t.after(() => agent.close());
  const f = await labSourceFixture(t);
  await prepareLabModelSource(f.context, f.job, 'studio_normalized');
  const url =
    'https://tripo-data.rg1.data.tripo3d.com/tripo-studio/copied-operator/model.glb?Signature=fixture&Expires=1';
  const detail = {
    id: 'copied-project',
    is_owner: true,
    model_url: url,
    operator: {
      operator_id: 'copied-operator',
      type: 'upload',
      status: 'success',
      is_pbr: false,
      metadata: {},
    },
  };
  const state = {
    bytes: f.normalized,
    offline: false,
    reads: [] as string[],
    downloads: 0,
    submissions: [] as Job[],
    events: [] as string[],
  };
  const client = new StudioClient(f.credentials, async (value, init) => {
    assert.equal(state.offline, false, 'Recovery must use frozen source/copy proofs without HTTP reads');
    const parsed = new URL(value);
    const method = new Headers(init.headers).get('x-micro-method');
    if (method?.endsWith('/GetNodeAssetDetail')) {
      assert.equal(object(JSON.parse(String(init.body))).assetId, 'node-asset');
      state.reads.push(method);
      return Response.json(f.state.detail);
    }
    assert.equal(init.method, 'GET');
    state.reads.push(parsed.pathname + parsed.search);
    if (parsed.pathname === '/v2/studio/project/detail/v3/studio-project') {
      assert.equal(parsed.searchParams.get('operator_id'), 'studio-operator');
      return Response.json({ code: 0, data: f.state.project });
    }
    assert.equal(parsed.pathname, '/v2/studio/project/detail/v3/copied-project');
    assert.equal(parsed.searchParams.get('operator_id'), 'copied-operator');
    state.events.push('read-copy');
    return Response.json({ code: 0, data: detail });
  });
  const parsed = new URL(url);
  agent
    .get(parsed.origin)
    .intercept({ path: parsed.pathname + parsed.search, method: 'GET' })
    .reply(200, () => {
      assert.equal(state.offline, false, 'Recovery must not redownload a verified copy');
      state.downloads++;
      state.events.push('download-copy');
      return state.bytes;
    })
    .persist();
  f.gateway.submit = async (job) => {
    assert.equal(state.offline, false, 'Recovery must not submit another operation');
    assert(['copy', 'export'].includes(job.operation));
    state.submissions.push(structuredClone(job));
    state.events.push(`submit-${job.operation}`);
    return {
      remote_ids:
        job.operation === 'copy'
          ? { project_id: 'copied-project', operator_id: 'copied-operator' }
          : { project_id: String(job.input.project_id), operator_id: 'export-receipt' },
    };
  };
  f.gateway.status = async (job) => {
    assert.equal(state.offline, false, 'Completed persisted tasks must not be repolled');
    state.events.push(`poll-${job.operation}`);
    return { state: 'succeeded', progress: 100, artifacts: [] };
  };
  f.gateway.artifactUrl = async () => {
    throw new Error('No export download is authorized by this runtime fixture');
  };
  const app = {
    service: f.service,
    studio: { client },
    close: () => {},
  } as unknown as Application;
  const plan = () =>
    processingPlan('convert', f.job.job_id, {
      param: {
        source_representation: 'studio_normalized',
        texture_format: 'PNG',
        with_animation: false,
      },
    });
  const restart = () => {
    const jobs = new JobStore(path.join(f.dir, 'jobs.sqlite'));
    t.after(() => jobs.close());
    return {
      ...app,
      service: new TaskService({
        jobs,
        gateway: f.gateway,
        credentials: f.credentials,
        pricing: f.service.pricing,
        config: f.service.config,
      }),
    };
  };
  return { ...f, app, plan, restart, state, flags: { requestId: 'runtime-isolation', download: false } };
}

test('new selected Lab source rejects no-wait before submitting its mandatory isolation copy', async (t) => {
  const f = await runtimeFixture(t);
  await assert.rejects(executePlan(f.app, f.plan(), { ...f.flags, wait: false }), {
    code: 'INVALID_INPUT',
    message: '--no-wait cannot execute a processing chain.',
  });
  assert.equal(f.state.submissions.length, 0);
  assert.equal(f.state.downloads, 0);
  assert.equal(f.jobs.find(f.job.account_ref, `${f.flags.requestId}-0`), undefined);
  assert.equal(f.jobs.find(f.job.account_ref, `${f.flags.requestId}-1`), undefined);
  assert.equal(
    f.jobs.requestPolicy(f.job.account_ref, `lab-model-isolation-layout:${f.flags.requestId}`)?.mode,
    'copy',
  );
});

test('copy-byte failure keeps the succeeded copy receipt and cannot submit export or repeat copy on recovery', async (t) => {
  const f = await runtimeFixture(t);
  f.state.bytes = f.original;
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(executePlan(f.app, f.plan(), f.flags), {
      code: 'LAB_MODEL_ISOLATION_UNVERIFIED',
    });
    assert.deepEqual(
      f.state.submissions.map((job) => job.operation),
      ['copy'],
    );
    const copy = f.jobs.find(f.job.account_ref, `${f.flags.requestId}-0`)!;
    assert.equal(copy.state, 'succeeded');
    assert.deepEqual(copy.remote_ids, { project_id: 'copied-project', operator_id: 'copied-operator' });
    assert.equal(f.jobs.find(f.job.account_ref, `${f.flags.requestId}-1`), undefined);
    assert.equal(f.jobs.requestPolicy(f.job.account_ref, labModelIsolationProofKey(copy)), undefined);
    const view = await f.service.get(copy.job_id);
    assert.equal(object(object(view.lab_model_source).source_isolation).status, 'pending');
  }
  assert.equal(
    f.state.downloads,
    2,
    'Each attempt may reverify the same receipt but never make another copy',
  );
});

test('runtime proves and publishes the copy before export, then recovers both original child requests offline', async (t) => {
  const f = await runtimeFixture(t),
    result = await executePlan(f.app, f.plan(), f.flags);
  assert.equal(result.status, 'success');
  assert.deepEqual(
    f.state.submissions.map((job) => job.operation),
    ['copy', 'export'],
  );
  assert.deepEqual(f.state.events, [
    'submit-copy',
    'poll-copy',
    'read-copy',
    'download-copy',
    'read-copy',
    'submit-export',
    'poll-export',
  ]);
  const copy = f.jobs.find(f.job.account_ref, `${f.flags.requestId}-0`)!,
    exported = f.jobs.find(f.job.account_ref, `${f.flags.requestId}-1`)!;
  assert.deepEqual(copy.input, { project_id: 'studio-project', operator_id: 'studio-operator' });
  assert.equal(exported.input.project_id, 'copied-project');
  assert.equal(exported.input.expected_operator_id, 'copied-operator');
  const chain = array(result.chain).map(object),
    isolation = object(object(chain[0]!.lab_model_source).source_isolation),
    lineage = array(object(result.lab_model_source).processing_lineage).map(object);
  assert.equal(chain[0]!.task_id, copy.job_id);
  assert.equal(chain[1]!.task_id, exported.job_id);
  assert.equal(isolation.status, 'verified', 'The first public chain item must refresh after proof creation');
  assert.equal(isolation.metadata_preserved, false);
  assert.equal(lineage.length, 2);
  assert.equal(lineage[0]!.job_id, copy.job_id);
  assert.equal(object(lineage[0]!.source_isolation).status, 'verified');
  assert.equal(lineage[1]!.job_id, exported.job_id);
  assert.equal(lineage[1]!.source_job_id, copy.job_id);
  const reads = f.state.reads.length,
    proof = f.jobs.requestPolicy(f.job.account_ref, labModelIsolationProofKey(copy));
  assert(proof);
  f.state.offline = true;
  const restored = await executePlan(f.restart(), f.plan(), f.flags);
  assert.equal(restored.task_id, result.task_id);
  assert.deepEqual(restored.chain, result.chain);
  assert.deepEqual(restored.lab_model_source, result.lab_model_source);
  assert.equal(f.state.reads.length, reads);
  assert.equal(f.state.downloads, 1);
  assert.equal(f.state.submissions.length, 2);
  assert.deepEqual(f.jobs.requestPolicy(f.job.account_ref, labModelIsolationProofKey(copy)), proof);
});

test('legacy selected requests retain single export and child index across offline runtime recovery', async (t) => {
  const f = await runtimeFixture(t);
  freezeLabModelSourceSelection(f.jobs, f.job.account_ref, f.flags.requestId, f.plan().steps, () => f.job);
  const selection = f.jobs.requestPolicy(f.job.account_ref, `lab-model-selection:${f.flags.requestId}`),
    result = await executePlan(f.app, f.plan(), f.flags);
  assert.equal(result.status, 'success');
  assert.deepEqual(
    f.state.submissions.map((job) => job.operation),
    ['export'],
  );
  const exported = f.jobs.find(f.job.account_ref, `${f.flags.requestId}-0`)!;
  assert.equal(exported.job_id, result.task_id);
  assert.equal(exported.input.project_id, 'studio-project');
  assert.equal(exported.input.expected_operator_id, 'studio-operator');
  assert.equal(f.jobs.find(f.job.account_ref, `${f.flags.requestId}-1`), undefined);
  assert.equal(
    f.jobs.requestPolicy(f.job.account_ref, `lab-model-isolation-layout:${f.flags.requestId}`),
    undefined,
  );
  assert.equal(
    f.jobs.requestPolicy(f.job.account_ref, `lab-model-copy-request:${f.flags.requestId}-0`),
    undefined,
  );
  assert.equal(result.chain, undefined);
  f.state.offline = true;
  const restored = await executePlan(f.restart(), f.plan(), { ...f.flags, wait: false });
  assert.equal(restored.task_id, result.task_id);
  assert.equal(restored.status, 'success');
  assert.deepEqual(restored.lab_model_source, result.lab_model_source);
  assert.equal(f.state.submissions.length, 1);
  assert.equal(f.state.downloads, 0);
  assert.deepEqual(
    f.jobs.requestPolicy(f.job.account_ref, `lab-model-selection:${f.flags.requestId}`),
    selection,
  );
  assert.equal(
    f.jobs.requestPolicy(f.job.account_ref, `lab-model-isolation-layout:${f.flags.requestId}`),
    undefined,
  );
});
