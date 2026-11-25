/** Exercise real task persistence, Gateway routing and original-run stop status with synthetic Studio replies. */
import test from 'node:test';
import { ZodError } from 'zod';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { StudioGateway } from '../studio/api/gateway.ts';
import { StudioClient } from '../studio/api/client.ts';
import { PricingService } from '../studio/api/pricing.ts';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { MemoryLinks } from '../studio/auth/artifact-links.ts';
import { object } from '../studio/contracts/errors.ts';
import type { RemoteIds } from '../studio/contracts/types.ts';
import { fixture } from './helpers.ts';

const target = { canvas_id: 'canvas', node_id: 'game', expected_run_id: 'source-run', revision: '3' };

async function taskFixture(action: 'stop' | 'retry', existing?: string) {
  const f = await fixture(existing);
  const status = {
    source: action === 'stop' ? 'RUN_STATUS_RUNNING' : 'RUN_STATUS_FAILED',
    turn: 'TURN_STATUS_DONE',
    receiptSession: 'session',
    response: 'ok',
    node: '',
    nodeRun: 'source-run',
    stopRequestedTime: '',
  };
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const credentials = new MemoryCredentials({
    accountRef: 'test-account',
    deviceId: 'device',
    importedAt: '',
    bearer:
      'eyJhbGciOiJIUzI1NiJ9.' +
      Buffer.from(
        JSON.stringify({
          sub: 'test-account',
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ).toString('base64url') +
      '.fixture',
  });
  const client = new StudioClient(credentials, async (_url, init) => {
    const method = new Headers(init.headers).get('x-micro-method')!.split('/').at(-1)!;
    const body = object(JSON.parse(String(init.body)));
    calls.push({ method, body });
    let result: Record<string, unknown>;
    if (method === 'GetCanvas')
      result = {
        canvas: { canvasId: 'canvas', revision: '3' },
        nodes: [
          { id: 'game', type: 'NODE_TYPE_HOLY_MOLLY', params: { hm_phase: 'building', retryable: true } },
        ],
        nodeRuns: [{ nodeId: 'game', runId: status.nodeRun, status: status.node || status.source }],
      };
    else if (method === 'GetRun')
      result = {
        run: {
          runId: body.runId,
          canvasId: 'canvas',
          nodeIds: ['game', 'other-node'],
          turnId: 'source-turn',
          status: status.source,
          stopRequestedTime: status.stopRequestedTime,
        },
      };
    else if (method === 'GetTurnDetail')
      result = {
        turn: {
          turnId: body.turnId,
          sessionId: body.turnId === 'receipt-turn' ? status.receiptSession : 'session',
          status: status.turn,
        },
      };
    else if (method === 'GetSession') result = { session: { sessionId: body.sessionId, canvasId: 'canvas' } };
    else {
      assert.equal(method, action === 'stop' ? 'StopNodeExecution' : 'RetryNodeExecution');
      if (status.response === 'lost') throw new Error('synthetic lost response');
      result =
        status.response === 'missing'
          ? {}
          : action === 'stop' && status.response !== 'turn'
            ? { runId: 'source-run', status: 'accepted' }
            : { turnId: 'receipt-turn' };
    }
    return Response.json({ error: { code: 0 }, ...result });
  });
  const gateway = new StudioGateway(client, [], new MemoryLinks());
  gateway.account = async () => ({ account_ref: 'test-account', balance: 1000 });
  f.service.gateway = gateway;
  f.service.pricing = new PricingService('/nonexistent-node-control-price');
  return {
    ...f,
    status,
    calls,
    writes: () => calls.filter(({ method }) => method.endsWith('NodeExecution')),
  };
}

test('stop uses the claimed durable request and waits for the exact original run, regardless of turn completion', async () => {
  const f = await taskFixture('stop');
  try {
    const submitted = await f.service.submit('canvas_node_stop', 'stop-once', target, 0);
    assert.equal(submitted.state, 'submitted');
    assert.deepEqual(submitted.remote_ids, {
      task_id: 'source-run',
      node_execution_receipt: 'accepted_run',
    });
    assert.equal(object(submitted.quote).known, false);
    assert.equal(object(submitted.quote).credits, undefined);
    assert.deepEqual(f.writes(), [
      { method: 'StopNodeExecution', body: { nodeId: 'game', requestId: submitted.job_id } },
    ]);
    const id = String(submitted.job_id);
    assert.equal((await f.service.get(id)).state, 'running');
    f.status.source = 'RUN_STATUS_STOPPED';
    const stopped = await f.service.get(id);
    assert.equal(stopped.state, 'succeeded');
    assert.deepEqual(stopped.artifacts, []);
    assert.equal(stopped.observed_cost, undefined);
    assert.equal(stopped.canvas_acceptance, undefined);
    assert.equal((await f.service.submit('canvas_node_stop', 'stop-once', target, 0)).job_id, id);
    assert.equal(f.writes().length, 1);
    const lastWrite = f.calls.findIndex(({ method }) => method === 'StopNodeExecution');
    assert.equal(
      f.calls
        .slice(lastWrite + 1)
        .filter(({ method }) => method === 'GetRun')
        .every(({ body }) => body.runId === 'source-run'),
      true,
    );
    assert.equal(
      f.calls
        .slice(lastWrite + 1)
        .filter(({ method }) => method === 'GetTurnDetail')
        .every(({ body }) => body.turnId === 'source-turn'),
      true,
      'A run receipt is never sent to GetTurnDetail as a control turn.',
    );
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('completed or failed runs with a stop request time still cannot prove that StopNodeExecution took effect', async () => {
  for (const source of ['RUN_STATUS_DONE', 'RUN_STATUS_FAILED']) {
    const f = await taskFixture('stop');
    try {
      const submitted = await f.service.submit('canvas_node_stop', 'stop-race', target, 0);
      f.status.source = source;
      f.status.stopRequestedTime = '2026-01-01T00:00:01Z';
      const ended = await f.service.get(String(submitted.job_id));
      assert.equal(ended.state, 'failed');
      assert.equal(object(ended.error).code, 'STOP_NOT_CONFIRMED');
      assert.equal(object(ended.error).original_run_status, source);
      assert.equal(object(ended.error).node_status, source);
      assert.equal(object(ended.error).stop_requested_time, f.status.stopRequestedTime);
      assert.equal(f.writes().length, 1);
    } finally {
      f.jobs.close();
      await rm(f.dir, { recursive: true, force: true });
    }
  }
});

test('accepted run receipts persist across restart without replay or a made-up control turn', async () => {
  const f = await taskFixture('stop');
  const submitted = await f.service.submit('canvas_node_stop', 'restart-stop', target, 0);
  assert.equal(f.writes().length, 1);
  f.jobs.close();
  const resumed = await taskFixture('stop', f.dir);
  try {
    const restored = await resumed.service.submit('canvas_node_stop', 'restart-stop', target, 0);
    assert.equal(restored.job_id, submitted.job_id);
    assert.deepEqual(restored.remote_ids, submitted.remote_ids);
    assert.equal(resumed.calls.length, 0);
    resumed.status.source = 'RUN_STATUS_STOPPED';
    const result = await resumed.service.get(String(submitted.job_id));
    assert.equal(result.state, 'succeeded');
    assert.equal(resumed.writes().length, 0);
    assert.equal(
      resumed.calls
        .filter(({ method }) => method === 'GetTurnDetail')
        .every(({ body }) => body.turnId === 'source-turn'),
      true,
    );
  } finally {
    resumed.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('a stored Stop receipt cannot change its run identity or infer a run acknowledgment from an untagged ID', async () => {
  const f = await taskFixture('stop');
  try {
    const submitted = await f.service.submit('canvas_node_stop', 'receipt-identity', target, 0);
    const saved = f.jobs.get(String(submitted.job_id));
    const count = f.calls.length;
    const receipts: RemoteIds[] = [
      { task_id: 'other-run', node_execution_receipt: 'accepted_run' },
      { node_execution_receipt: 'accepted_run' },
      { task_id: 'source-run' },
      { task_id: 'source-run', node_execution_receipt: 'turn' },
    ];
    for (const remote_ids of receipts)
      await assert.rejects(f.service.gateway.status({ ...saved, remote_ids }), {
        code: 'CONTRACT_CHANGED',
      });
    assert.equal(f.calls.length, count);
    assert.deepEqual(f.jobs.get(saved.job_id).remote_ids, saved.remote_ids);
    assert.equal(f.writes().length, 1);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('explicit old turn receipts still require control-turn session ownership before stop verification', async () => {
  const f = await taskFixture('stop');
  try {
    f.status.response = 'turn';
    const submitted = await f.service.submit('canvas_node_stop', 'turn-stop', target, 0);
    assert.deepEqual(submitted.remote_ids, { task_id: 'receipt-turn', node_execution_receipt: 'turn' });
    f.status.source = 'RUN_STATUS_STOPPED';
    f.status.receiptSession = 'other-session';
    const rejected = await f.service.get(String(submitted.job_id));
    assert.notEqual(rejected.state, 'succeeded');
    assert.equal(object(rejected.poll_error).code, 'CONTRACT_CHANGED');
    const saved = f.jobs.get(String(submitted.job_id));
    await assert.rejects(f.service.gateway.status({ ...saved, remote_ids: { task_id: 'receipt-turn' } }), {
      code: 'CONTRACT_CHANGED',
    });
    f.status.receiptSession = 'session';
    assert.equal((await f.service.get(String(submitted.job_id))).state, 'succeeded');
    assert.equal(
      (await f.service.gateway.status({ ...saved, remote_ids: { task_id: 'receipt-turn' } })).state,
      'succeeded',
    );
    assert.equal(f.writes().length, 1);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('stop follows the exact target node within a multi-node run and never a newer execution', async () => {
  for (const [node, source, nodeRun, expectedState, expectedCode] of [
    ['NODE_STATUS_CANCELLED', 'RUN_STATUS_RUNNING', 'source-run', 'succeeded', undefined],
    ['NODE_STATUS_CANCELED', 'RUN_STATUS_RUNNING', 'source-run', 'succeeded', undefined],
    ['NODE_STATUS_SUCCEEDED', 'RUN_STATUS_CANCELLED', 'source-run', 'failed', 'STOP_NOT_CONFIRMED'],
    ['NODE_STATUS_CANCELLED', 'RUN_STATUS_RUNNING', 'new-run', 'failed', 'STOP_STATE_UNAVAILABLE'],
  ] as const) {
    const f = await taskFixture('stop');
    try {
      const submitted = await f.service.submit('canvas_node_stop', 'exact-node', target, 0);
      f.status.node = node;
      f.status.source = source;
      f.status.nodeRun = nodeRun;
      const result = await f.service.get(String(submitted.job_id));
      assert.equal(result.state, expectedState);
      assert.equal(object(result.error).code, expectedCode);
      assert.equal(f.writes().length, 1);
    } finally {
      f.jobs.close();
      await rm(f.dir, { recursive: true, force: true });
    }
  }
});

test('retry requires explicit variable billing and preserves game acceptance after its exact returned turn completes', async () => {
  const f = await taskFixture('retry');
  try {
    await assert.rejects(
      f.service.submit('canvas_node_retry', 'missing-consent', target, 0),
      (error: unknown) =>
        error instanceof ZodError && error.issues.some((issue) => issue.path[0] === 'accept_variable_cost'),
    );
    assert.equal(f.calls.length, 0);
    const input = { ...target, accept_variable_cost: true };
    const submitted = await f.service.submit('canvas_node_retry', 'retry-once', input, 0);
    assert.equal(submitted.state, 'submitted');
    const result = await f.service.get(String(submitted.job_id));
    assert.equal(result.state, 'succeeded');
    assert.equal(object(result.canvas_acceptance).status, 'needs_review');
    assert.equal(object(result.canvas_acceptance).artifacts_checked, false);
    assert.equal(result.observed_cost, undefined);
    assert.deepEqual(f.writes(), [
      { method: 'RetryNodeExecution', body: { nodeId: 'game', requestId: submitted.job_id } },
    ]);
    await f.service.submit('canvas_node_retry', 'retry-once', input, 0);
    assert.equal(f.writes().length, 1);
    for (const field of ['canvas_id', 'node_id', 'expected_run_id', 'revision'])
      await assert.rejects(
        f.service.submit(
          'canvas_node_retry',
          'retry-once',
          { ...input, [field]: field === 'revision' ? '4' : 'different' },
          0,
        ),
        { code: 'IDEMPOTENCY_CONFLICT' },
      );
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('unknown node receipts survive restart without replay or arbitrary same-session reconciliation', async () => {
  for (const action of ['stop', 'retry'] as const)
    for (const response of ['lost', 'missing']) {
      const operation = action === 'stop' ? 'canvas_node_stop' : 'canvas_node_retry';
      const f = await taskFixture(action);
      f.status.response = response;
      const input = { ...target, ...(action === 'retry' ? { accept_variable_cost: true } : {}) };
      const submitted = await f.service.submit(operation, 'unknown-node', input, 0);
      assert.equal(submitted.state, 'outcome_unknown');
      assert.equal(f.writes().length, 1);
      f.jobs.close();
      const resumed = await taskFixture(action, f.dir);
      try {
        const recovered = await resumed.service.submit(operation, 'unknown-node', input, 0);
        assert.equal(recovered.job_id, submitted.job_id);
        assert.equal(recovered.state, 'outcome_unknown');
        await assert.rejects(
          resumed.service.reconcile(String(submitted.job_id), { task_id: 'receipt-turn' }),
          {
            code: 'RECONCILE_UNVERIFIABLE',
          },
        );
        assert.equal(resumed.calls.length, 0);
      } finally {
        resumed.jobs.close();
        await rm(f.dir, { recursive: true, force: true });
      }
    }
});

test('a returned turn from another session is not accepted as node retry completion', async () => {
  const f = await taskFixture('retry');
  try {
    const submitted = await f.service.submit(
      'canvas_node_retry',
      'wrong-session',
      { ...target, accept_variable_cost: true },
      0,
    );
    f.status.receiptSession = 'other-session';
    const result = await f.service.get(String(submitted.job_id));
    assert.notEqual(result.state, 'succeeded');
    assert.equal(object(result.poll_error).code, 'CONTRACT_CHANGED');
    assert.equal(f.writes().length, 1);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
