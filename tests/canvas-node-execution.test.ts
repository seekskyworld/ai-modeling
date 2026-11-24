/** Isolated HolyMolly controls: exact identity and durable submission, with no live writes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { StudioClient } from '../studio/api/client.ts';
import { array, object, TripoError } from '../studio/contracts/errors.ts';
import {
  prepareCanvasNodeExecution,
  submitCanvasNodeExecution,
  readSourceRun,
  type CanvasNodeExecutionAction,
} from '../studio/api/canvas-node-execution.ts';
import type { JobState } from '../studio/contracts/types.ts';

const input = { canvas_id: 'canvas', node_id: 'game', expected_run_id: 'source-run', revision: '7' };
type Edit = (
  method: string,
  result: Record<string, unknown>,
  count: number,
  credentials: MemoryCredentials,
) => void;
function fixture(action: CanvasNodeExecutionAction = 'stop', edit?: Edit) {
  const credentials = new MemoryCredentials({
    accountRef: 'fixture',
    deviceId: 'fixture',
    importedAt: '',
    bearer:
      'eyJhbGciOiJIUzI1NiJ9.' +
      Buffer.from(
        JSON.stringify({
          sub: 'fixture',
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ).toString('base64url') +
      '.fixture',
  });
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const client = new StudioClient(credentials, async (_url, init) => {
    const method = new Headers(init.headers).get('x-micro-method')!.split('/').at(-1)!;
    calls.push({ method, body: object(JSON.parse(String(init.body))) });
    const status = action === 'stop' ? 'RUNNING' : 'FAILED';
    const responses: Record<string, Record<string, unknown>> = {
      GetCanvas: {
        canvas: { canvasId: 'canvas', projectId: 'project', revision: '7' },
        nodes: [
          {
            id: 'game',
            type: 'NODE_TYPE_HOLY_MOLLY',
            params: {
              hm_phase: action === 'stop' ? 'building' : 'failed',
              retryable: action === 'retry',
            },
          },
        ],
        nodeRuns: [{ nodeId: 'game', runId: 'source-run', status: 'NODE_STATUS_' + status }],
      },
      GetRun: {
        run: {
          runId: 'source-run',
          canvasId: 'canvas',
          nodeIds: ['game'],
          turnId: 'source-turn',
          status: 'RUN_STATUS_' + status,
        },
      },
      GetTurnDetail: { turn: { turnId: 'source-turn', sessionId: 'session', status: 'TURN_STATUS_DONE' } },
      GetSession: { session: { sessionId: 'session', canvasId: 'canvas', activeTurnId: 'unrelated-turn' } },
      StopNodeExecution: { turnId: 'control-turn' },
      RetryNodeExecution: { turnId: 'control-turn' },
    };
    assert.ok(Object.hasOwn(responses, method), 'No fallback or invented RPC: ' + method);
    const result = responses[method]!;
    edit?.(method, result, calls.filter((call) => call.method === method).length, credentials);
    return Response.json({ error: { code: 0 }, ...result });
  });
  return { client, calls };
}
const target = (result: Record<string, unknown>) => object(array(result.nodes)[0]);
const nodeRun = (result: Record<string, unknown>) => object(array(result.nodeRuns)[0]);
const writes = (calls: ReturnType<typeof fixture>['calls']) =>
  calls.filter((call) => /NodeExecution$/.test(call.method));
const parameters = (action: CanvasNodeExecutionAction) => ({
  ...input,
  ...(action === 'retry' ? { accept_variable_cost: true } : {}),
});
const job = (input: Record<string, unknown>, state: JobState = 'prepared') => ({
  job_id: 'durable-job',
  account_ref: 'fixture',
  input,
  state,
});
const validClaim = () => {};
async function prepared(action: CanvasNodeExecutionAction, edit?: Edit) {
  const f = fixture(action, edit);
  const ready = await prepareCanvasNodeExecution(f.client, parameters(action), action);
  return { ...f, ready };
}

test('prepare freezes exact run/turn/session ownership without writes and stop requires no new-generation consent', async () => {
  for (const action of ['stop', 'retry'] as const) {
    const f = await prepared(action);
    assert.deepEqual(f.ready, {
      ...parameters(action),
      _node_execution: { action, source_turn_id: 'source-turn', session_id: 'session' },
    });
    assert.deepEqual(
      f.calls.map((call) => call.method),
      ['GetCanvas', 'GetRun', 'GetTurnDetail', 'GetSession', 'GetCanvas'],
    );
    assert.equal(writes(f.calls).length, 0);
    assert.deepEqual(f.calls.find((call) => call.method === 'GetRun')?.body, { runId: 'source-run' });
  }
});

test('only one exact NodeService control is submitted with the durable job ID and returned turn identity', async () => {
  for (const action of ['stop', 'retry'] as const) {
    const f = await prepared(action);
    let checks = 0;
    const receipt = await submitCanvasNodeExecution(f.client, job(f.ready), action, () => {
      checks++;
    });
    assert.equal(
      checks,
      2,
      'Validate the durable claim at entry and again after authentication before sending.',
    );
    assert.deepEqual(receipt, {
      remote_ids: {
        task_id: 'control-turn',
        ...(action === 'stop' ? { node_execution_receipt: 'turn' } : {}),
      },
    });
    assert.deepEqual(writes(f.calls), [
      {
        method: action === 'stop' ? 'StopNodeExecution' : 'RetryNodeExecution',
        body: { nodeId: 'game', requestId: 'durable-job' },
      },
    ]);
  }
});

test('the observed accepted Stop run receipt preserves the exact original run identity', async () => {
  const f = await prepared('stop', (method, result) => {
    if (method !== 'StopNodeExecution') return;
    delete result.turnId;
    Object.assign(result, { runId: 'source-run', status: 'accepted' });
  });
  assert.deepEqual(await submitCanvasNodeExecution(f.client, job(f.ready), 'stop', validClaim), {
    remote_ids: { task_id: 'source-run', node_execution_receipt: 'accepted_run' },
  });
  assert.equal(writes(f.calls).length, 1);
});

test('foreign, incomplete or ambiguous Stop run receipts remain unknown and cannot fall back to a turn', async () => {
  for (const receipt of [
    { runId: 'other-run', status: 'accepted' },
    { runId: '', status: 'accepted' },
    { runId: 42, status: 'accepted' },
    { runId: 'source-run' },
    { runId: 'source-run', status: 'rejected' },
    { runId: 'source-run', status: 'accepted', turnId: 'control-turn' },
    { turnId: 'source-run' },
    { turnId: 'control-turn', status: 'rejected' },
  ]) {
    const f = await prepared('stop', (method, result) => {
      if (method !== 'StopNodeExecution') return;
      delete result.turnId;
      Object.assign(result, receipt);
    });
    await assert.rejects(submitCanvasNodeExecution(f.client, job(f.ready), 'stop', validClaim), {
      code: 'CONTRACT_CHANGED',
      certainty: 'unknown',
    });
    assert.equal(writes(f.calls).length, 1);
  }
});

test('the Stop run receipt does not relax the unverified Retry turn receipt contract', async () => {
  const f = await prepared('retry', (method, result) => {
    if (method !== 'RetryNodeExecution') return;
    delete result.turnId;
    Object.assign(result, { runId: 'source-run', status: 'accepted' });
  });
  await assert.rejects(submitCanvasNodeExecution(f.client, job(f.ready), 'retry', validClaim), {
    code: 'CONTRACT_CHANGED',
    certainty: 'unknown',
  });
  assert.equal(writes(f.calls).length, 1);
});

test('missing exact input and unaccepted retry billing stop before any network request', async () => {
  for (const field of ['canvas_id', 'node_id', 'expected_run_id', 'revision']) {
    const f = fixture();
    const invalid = { ...input, [field]: undefined };
    await assert.rejects(prepareCanvasNodeExecution(f.client, invalid, 'stop'), {
      code: 'INVALID_INPUT',
      certainty: 'not_submitted',
    });
    assert.equal(f.calls.length, 0);
  }
  for (const accept_variable_cost of [undefined, false, 'true']) {
    const f = fixture('retry');
    await assert.rejects(prepareCanvasNodeExecution(f.client, { ...input, accept_variable_cost }, 'retry'), {
      code: 'VARIABLE_COST_NOT_ACCEPTED',
      certainty: 'not_submitted',
    });
    assert.equal(f.calls.length, 0);
  }
});

test('foreign, missing or duplicate saved graph and run identities never reach a write', async () => {
  for (const mode of [
    'canvas',
    'revision',
    'missing-node',
    'duplicate-node',
    'wrong-type',
    'missing-run',
    'duplicate-run',
    'different-run',
  ]) {
    const f = fixture('stop', (method, result) => {
      if (method !== 'GetCanvas') return;
      if (mode === 'canvas') object(result.canvas).canvasId = 'foreign';
      if (mode === 'revision') object(result.canvas).revision = '8';
      if (mode === 'missing-node') result.nodes = [];
      if (mode === 'duplicate-node') array(result.nodes).push(structuredClone(target(result)));
      if (mode === 'wrong-type') target(result).type = 'NODE_TYPE_GENERATE_IMAGE';
      if (mode === 'missing-run') result.nodeRuns = [];
      if (mode === 'duplicate-run') array(result.nodeRuns).push(structuredClone(nodeRun(result)));
      if (mode === 'different-run') nodeRun(result).runId = 'newer-run';
    });
    await assert.rejects(
      prepareCanvasNodeExecution(f.client, input, 'stop'),
      { certainty: 'not_submitted' },
      mode,
    );
    assert.equal(writes(f.calls).length, 0, mode);
  }
});

test('run, node, turn and session ownership must all match the selected saved Canvas', async () => {
  for (const mode of [
    'run-id',
    'run-canvas',
    'run-node',
    'run-nodes-duplicate',
    'run-turn',
    'turn-id',
    'turn-session',
    'session-id',
    'session-canvas',
  ]) {
    const f = fixture('stop', (method, result) => {
      if (method === 'GetRun') {
        const run = object(result.run);
        if (mode === 'run-id') run.runId = 'other';
        if (mode === 'run-canvas') run.canvasId = 'other';
        if (mode === 'run-node') run.nodeIds = ['other'];
        if (mode === 'run-nodes-duplicate') run.nodeIds = ['game', 'game'];
        if (mode === 'run-turn') delete run.turnId;
      }
      if (method === 'GetTurnDetail') {
        if (mode === 'turn-id') object(result.turn).turnId = 'other';
        if (mode === 'turn-session') delete object(result.turn).sessionId;
      }
      if (method === 'GetSession') {
        if (mode === 'session-id') object(result.session).sessionId = 'other';
        if (mode === 'session-canvas') object(result.session).canvasId = 'other';
      }
    });
    await assert.rejects(
      prepareCanvasNodeExecution(f.client, input, 'stop'),
      {
        code: 'CONTRACT_CHANGED',
        certainty: 'not_submitted',
      },
      mode,
    );
    assert.equal(writes(f.calls).length, 0);
  }
});

test('stop requires an observed UI active phase and recognized nonterminal node and run states', async () => {
  for (const phase of [
    'analysing',
    'building',
    'gate',
    'testing',
    'queued',
    'waiting',
    '',
    'done',
    'unknown',
  ]) {
    const f = fixture('stop', (method, result) => {
      if (method === 'GetCanvas') object(target(result).params).hm_phase = phase;
    });
    if (['analysing', 'building', 'gate', 'testing', 'queued', 'waiting'].includes(phase))
      await prepareCanvasNodeExecution(f.client, input, 'stop');
    else
      await assert.rejects(prepareCanvasNodeExecution(f.client, input, 'stop'), {
        code: 'NODE_EXECUTION_NOT_STOPPABLE',
        certainty: 'not_submitted',
      });
  }
  for (const boundary of ['node', 'run'])
    for (const status of ['DONE', 'FAILED', 'STOPPED', 'UNKNOWN', '']) {
      const f = fixture('stop', (method, result) => {
        if (boundary === 'node' && method === 'GetCanvas') nodeRun(result).status = 'NODE_STATUS_' + status;
        if (boundary === 'run' && method === 'GetRun') object(result.run).status = 'RUN_STATUS_' + status;
      });
      await assert.rejects(prepareCanvasNodeExecution(f.client, input, 'stop'), {
        code: 'NODE_EXECUTION_NOT_STOPPABLE',
      });
    }
});

test('retry requires explicit retryable and terminal source states, independent of whether the failed game has a cover', async () => {
  for (const retryable of [undefined, false, 'true', 1]) {
    const f = fixture('retry', (method, result) => {
      if (method === 'GetCanvas') object(target(result).params).retryable = retryable;
    });
    await assert.rejects(prepareCanvasNodeExecution(f.client, parameters('retry'), 'retry'), {
      code: 'NODE_EXECUTION_NOT_RETRYABLE',
      certainty: 'not_submitted',
    });
  }
  for (const boundary of ['node', 'run'])
    for (const status of ['RUNNING', 'QUEUED', 'UNKNOWN']) {
      const f = fixture('retry', (method, result) => {
        if (boundary === 'node' && method === 'GetCanvas') nodeRun(result).status = 'NODE_STATUS_' + status;
        if (boundary === 'run' && method === 'GetRun') object(result.run).status = 'RUN_STATUS_' + status;
      });
      await assert.rejects(prepareCanvasNodeExecution(f.client, parameters('retry'), 'retry'), {
        code: 'NODE_EXECUTION_NOT_RETRYABLE',
      });
    }
});

test('a graph/run or eligibility change during preflight aborts the control before sending', async () => {
  for (const action of ['stop', 'retry'] as const)
    for (const mode of ['run', 'revision', 'eligibility']) {
      const f = fixture(action, (method, result, count) => {
        if (method !== 'GetCanvas' || count !== 2) return;
        if (mode === 'run') nodeRun(result).runId = 'newer-run';
        if (mode === 'revision') object(result.canvas).revision = '8';
        if (mode === 'eligibility')
          object(target(result).params)[action === 'stop' ? 'hm_phase' : 'retryable'] =
            action === 'stop' ? 'done' : false;
      });
      await assert.rejects(prepareCanvasNodeExecution(f.client, parameters(action), action), {
        certainty: 'not_submitted',
      });
      assert.equal(writes(f.calls).length, 0);
    }
});

test('submission rejects missing or changed frozen context, and never replays an unclaimed or unknown job', async () => {
  for (const state of [
    'prepared',
    'submitted',
    'running',
    'outcome_unknown',
    'failed',
    'requires_login',
    'succeeded',
  ] as const) {
    const f = await prepared('stop');
    const count = f.calls.length;
    const durable: { state: JobState } = { state };
    await assert.rejects(
      submitCanvasNodeExecution(f.client, job(f.ready), 'stop', () => {
        if (durable.state !== 'submitting')
          throw new TripoError('SUBMISSION_NOT_CLAIMED', 'The durable task has no submission claim.');
      }),
      {
        code: 'SUBMISSION_NOT_CLAIMED',
        certainty: 'not_submitted',
      },
    );
    assert.equal(f.calls.length, count);
  }
  for (const mode of ['missing', 'turn', 'session', 'action']) {
    const f = await prepared('stop');
    const invalid = structuredClone(f.ready);
    if (mode === 'missing') delete invalid._node_execution;
    else
      object(invalid._node_execution)[
        mode === 'turn' ? 'source_turn_id' : mode === 'session' ? 'session_id' : 'action'
      ] = mode === 'action' ? 'retry' : 'other';
    await assert.rejects(submitCanvasNodeExecution(f.client, job(invalid), 'stop', validClaim), {
      code: 'CONTRACT_CHANGED',
      certainty: 'not_submitted',
    });
    assert.equal(writes(f.calls).length, 0);
  }
});

test('a required durable claim callback is rechecked at the real send boundary and may block after successful reads', async () => {
  const missing = await prepared('stop');
  await assert.rejects(
    submitCanvasNodeExecution(missing.client, job(missing.ready), 'stop', undefined as unknown as () => void),
    {
      code: 'SUBMISSION_NOT_CLAIMED',
      certainty: 'not_submitted',
    },
  );
  assert.equal(writes(missing.calls).length, 0);
  const f = await prepared('stop');
  let checks = 0;
  await assert.rejects(
    submitCanvasNodeExecution(f.client, job(f.ready), 'stop', () => {
      checks++;
      if (checks === 2)
        throw new TripoError('SUBMISSION_IDENTITY_CHANGED', 'The durable claim changed during preflight.');
    }),
    { code: 'SUBMISSION_IDENTITY_CHANGED', certainty: 'not_submitted' },
  );
  assert.equal(checks, 2);
  assert.equal(writes(f.calls).length, 0);
  assert.equal(f.calls.filter((call) => call.method === 'GetCanvas').length, 4);
});

test('account changes at every source read boundary block submission', async () => {
  for (const boundary of ['GetCanvas', 'GetRun', 'GetTurnDetail', 'GetSession', 'final-canvas']) {
    const f = fixture('stop', (method, _result, count, credentials) => {
      if (method === boundary || (boundary === 'final-canvas' && method === 'GetCanvas' && count === 2))
        credentials.save({ ...credentials.load()!, accountRef: 'other' });
    });
    await assert.rejects(prepareCanvasNodeExecution(f.client, input, 'stop'), {
      code: 'ACCOUNT_MISMATCH',
      certainty: 'not_submitted',
    });
    assert.equal(writes(f.calls).length, 0);
  }
});

test('lost write responses and missing turn IDs remain unknown and are never retried or guessed', async () => {
  for (const action of ['stop', 'retry'] as const)
    for (const mode of ['network', 'missing', 'wrong-field', 'empty', 'invalid']) {
      const f = await prepared(action, (method, result) => {
        if (!/NodeExecution$/.test(method)) return;
        if (mode === 'network') throw new TypeError('Fixture network loss after sending.');
        if (mode === 'missing') delete result.turnId;
        if (mode === 'wrong-field') {
          delete result.turnId;
          result.id = 'unproven';
        }
        if (mode === 'empty') result.turnId = '';
        if (mode === 'invalid') result.turnId = 123;
      });
      await assert.rejects(submitCanvasNodeExecution(f.client, job(f.ready), action, validClaim), {
        certainty: 'unknown',
      });
      assert.equal(writes(f.calls).length, 1);
      assert.deepEqual(writes(f.calls)[0]?.body, { nodeId: 'game', requestId: 'durable-job' });
    }
});

test('source-run inspection preserves the original identity after current node replacement and never resolves an unknown receipt', async () => {
  const f = await prepared('stop');
  const count = f.calls.length;
  const run = await readSourceRun(f.client, job(f.ready, 'outcome_unknown'));
  assert.equal(run.runId, 'source-run');
  assert.equal(run.turnId, 'source-turn');
  assert.deepEqual(
    f.calls.slice(count).map((call) => call.method),
    ['GetRun', 'GetTurnDetail', 'GetSession'],
  );
  assert.equal(writes(f.calls).length, 0);
  assert.equal(Object.hasOwn(run, 'remote_ids'), false);
  const changed = structuredClone(f.ready);
  object(changed._node_execution).source_turn_id = 'newer-turn';
  await assert.rejects(readSourceRun(f.client, job(changed, 'submitted')), { code: 'CONTRACT_CHANGED' });
});
