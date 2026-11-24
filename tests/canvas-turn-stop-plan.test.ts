/** Read-only cancellation discovery keeps exact ownership and never replays a write. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { StudioClient } from '../studio/api/client.ts';
import { resolveCanvasTurnStopPlan, turnStopPlanSchema } from '../studio/api/canvas-turn-stop-plan.ts';
import { array, object } from '../studio/contracts/errors.ts';

type RecordValue = Record<string, unknown>;
const input = { canvasId: 'canvas', turnId: 'turn' };
const request = { messageId: 'user', turnId: 'turn', role: 'MESSAGE_ROLE_USER', cardJson: '' };
const plan = {
  messageId: 'plan',
  turnId: 'turn',
  role: 'MESSAGE_ROLE_AGENT',
  cardType: 'CARD_TYPE_PLAN_STEPS',
  cardJson: JSON.stringify({ type: 'plan_steps', data: { groups: [{ steps: [{ nodeIds: ['owned'] }] }] } }),
};
const run = (runId: string, turnId: string, nodeId: string) => ({
  runId,
  turnId,
  canvasId: 'canvas',
  status: 'RUN_STATUS_RUNNING',
  nodeIds: [nodeId],
  steps: [{ stepId: `${nodeId}-step`, nodeId, status: 'RUN_STEP_STATUS_RUNNING' }],
});
interface Invocation {
  method: string;
  body: RecordValue;
  count: number;
  result: RecordValue;
}
function fixture(edit?: (invocation: Invocation, credentials: MemoryCredentials) => void) {
  const credentials = new MemoryCredentials({
    accountRef: 'fixture',
    deviceId: 'fixture',
    importedAt: '',
    bearer:
      'eyJhbGciOiJIUzI1NiJ9.' +
      Buffer.from(JSON.stringify({ sub: 'fixture', exp: Math.floor(Date.now() / 1000) + 3600 })).toString(
        'base64url',
      ) +
      '.fixture',
  });
  const calls: Invocation[] = [];
  const client = new StudioClient(credentials, async (_url, init) => {
    const method = new Headers(init.headers).get('x-micro-method')!.split('/').at(-1)!;
    const body = object(JSON.parse(String(init.body)));
    const catalog: Record<string, RecordValue> = {
      GetTurnDetail: {
        turn: { turnId: 'turn', sessionId: 'session', status: 'TURN_STATUS_RUNNING' },
        messages: [request, plan],
      },
      GetSession: {
        session: { sessionId: 'session', canvasId: 'canvas', status: 'SESSION_STATUS_ACTIVE' },
        messages: [request, plan],
      },
      GetCanvas: {
        canvas: { canvasId: 'canvas', projectId: 'project', revision: '4' },
        nodes: ['owned', 'other', 'manual'].map((id) => ({ id, type: 'NODE_TYPE_GENERATE_IMAGE' })),
        nodeRuns: ['owned', 'other', 'manual'].map((nodeId) => ({
          nodeId,
          runId: `${nodeId}-run`,
          currentStepId: `${nodeId}-step`,
          status: 'NODE_STATUS_RUNNING',
        })),
      },
      // The real ListCanvasRuns response can be empty despite Agent nodeRuns on GetCanvas.
      ListCanvasRuns: { runs: [] },
      GetRun: {
        run: run(
          String(body.runId),
          body.runId === 'owned-run' ? 'turn' : body.runId === 'manual-run' ? '' : 'another-turn',
          String(body.runId).replace('-run', ''),
        ),
      },
    };
    assert.ok(Object.hasOwn(catalog, method), `Only verified read RPCs are permitted: ${method}`);
    const invocation = {
      method,
      body,
      count: calls.filter((call) => call.method === method).length + 1,
      result: structuredClone(catalog[method]!),
    };
    calls.push(invocation);
    edit?.(invocation, credentials);
    return Response.json({ error: { code: 0 }, ...invocation.result });
  });
  return { client, credentials, calls };
}
const stages = (result: RecordValue) => array(result.stages).map(object);
const writes = (result: RecordValue) =>
  stages(result)
    .flatMap((stage) => array(stage.actions).map(object))
    .filter((action) => action.tool !== 'ai_modeling_canvas_turn_stop_plan');
const reasons = (result: RecordValue) => array(result.reasons);
async function prepare(edit?: Parameters<typeof fixture>[0], parameters: RecordValue = input) {
  const f = fixture(edit);
  return { ...f, result: object(await resolveCanvasTurnStopPlan(f.client, parameters)) };
}

test('an active exact turn prepares only CancelTurn and read-only rechecks, not StopRun', async () => {
  const { result, calls } = await prepare();
  assert.equal(result.ready, true);
  assert.equal(result.incomplete, false);
  assert.deepEqual(writes(result), [
    { tool: 'ai_modeling_canvas_turn_cancel', parameters: { turnId: 'turn' } },
  ]);
  assert.deepEqual(
    array(result.owned_runs).map((value) => object(value).run_id),
    ['owned-run'],
  );
  assert.equal(object(result.coverage).excluded_other_turn_runs, 1);
  assert.equal(object(result.coverage).excluded_unbound_runs, 1);
  assert.equal(object(result.coverage).listed_runs_observed, 0);
  assert.equal(object(result.coverage).history_complete, null);
  assert.equal(result.execution_started, false);
  assert.equal(result.remote_saved, false);
  assert.equal(calls.filter((call) => call.method === 'GetRun').length, 3);
  assert.equal(calls.filter((call) => call.method === 'GetCanvas').length, 2);
  assert.match(String(result.concurrency_policy), /new run can appear/);
});

test('a cancelled turn exposes StopRun only for verified owned active runs', async () => {
  const { result } = await prepare(({ method, result }) => {
    if (method === 'GetTurnDetail') object(result.turn).status = 'TURN_STATUS_CANCELLED';
  });
  assert.equal(result.ready, true);
  assert.deepEqual(writes(result), [
    { tool: 'ai_modeling_canvas_run_stop', parameters: { runId: 'owned-run' } },
  ]);
  assert.equal(result.terminal_turn_with_active_runs, true);
});

for (const terminal of ['DONE', 'FAILED']) {
  test(`terminal ${terminal} with an active owned run is reported without another cancellation`, async () => {
    const { result } = await prepare(({ method, result }) => {
      if (method === 'GetTurnDetail') object(result.turn).status = `TURN_STATUS_${terminal}`;
    });
    assert.equal(result.ready, true);
    assert.equal(result.active_owned_run_count, 1);
    assert.equal(result.terminal_turn_with_active_runs, true);
    assert.deepEqual(writes(result), []);
    assert.equal(
      stages(result).find((stage) => stage.stage === 'stop_runs')?.status,
      'requires_cancelled_turn',
    );
    assert.equal(Object.hasOwn(result, 'already_stopped'), false);
  });
}

test('already stopping and completed runs are queried without resubmitting StopRun', async () => {
  for (const state of ['CANCELLING', 'SUCCEEDED']) {
    const { result } = await prepare(({ method, body, result }) => {
      if (method === 'GetTurnDetail') object(result.turn).status = 'TURN_STATUS_CANCELLED';
      if (method === 'GetRun' && body.runId === 'owned-run')
        object(result.run).status = `RUN_STATUS_${state}`;
    });
    assert.equal(result.ready, true);
    assert.deepEqual(writes(result), []);
  }
});

test('a multi-node owned run produces only one stop action', async () => {
  const { result } = await prepare(({ method, body, result }) => {
    if (method === 'GetTurnDetail') object(result.turn).status = 'TURN_STATUS_CANCELLED';
    if (method === 'GetCanvas') {
      array(result.nodes).push({ id: 'owned-second' });
      array(result.nodeRuns).push({
        nodeId: 'owned-second',
        runId: 'owned-run',
        currentStepId: 'second-step',
        status: 'NODE_STATUS_RUNNING',
      });
    }
    if (method === 'GetRun' && body.runId === 'owned-run') {
      array(object(result.run).nodeIds).push('owned-second');
      array(object(result.run).steps).push({ stepId: 'second-step', nodeId: 'owned-second' });
    }
  });
  assert.equal(result.ready, true);
  assert.equal(writes(result).length, 1);
});

test('listed historical runs are verified individually and can cover nodes absent from the current graph', async () => {
  const { result, calls } = await prepare(({ method, body, result }) => {
    if (method === 'GetTurnDetail') object(result.turn).status = 'TURN_STATUS_CANCELLED';
    if (method === 'ListCanvasRuns') result.runs = [{ runId: 'historical-run' }];
    if (method === 'GetRun' && body.runId === 'historical-run')
      result.run = run('historical-run', 'turn', 'removed-node');
  });
  assert.equal(result.ready, true);
  assert.deepEqual(
    writes(result).map((action) => object(action.parameters).runId),
    ['historical-run', 'owned-run'],
  );
  assert.equal(calls.filter((call) => call.method === 'GetRun').length, 4);
});

test('foreign turn, session, Canvas, run and node identity mismatches never yield a plan', async () => {
  const edits: NonNullable<Parameters<typeof fixture>[0]>[] = [
    ({ method, result }) => {
      if (method === 'GetTurnDetail') object(result.turn).turnId = 'wrong';
    },
    ({ method, result }) => {
      if (method === 'GetSession') object(result.session).canvasId = 'wrong';
    },
    ({ method, result }) => {
      if (method === 'GetCanvas') object(result.canvas).canvasId = 'wrong';
    },
    ({ method, result }) => {
      if (method === 'GetRun') object(result.run).runId = 'wrong';
    },
    ({ method, result }) => {
      if (method === 'GetRun') object(result.run).canvasId = 'wrong';
    },
    ({ method, body, result }) => {
      if (method === 'GetRun' && body.runId === 'owned-run') object(result.run).nodeIds = ['other-node'];
    },
  ];
  for (const edit of edits) await assert.rejects(prepare(edit), { code: 'CONTRACT_CHANGED' });
});

test('duplicate source identities and ambiguous node/step references are rejected', async () => {
  const edits: NonNullable<Parameters<typeof fixture>[0]>[] = [
    ({ method, result }) => {
      if (method === 'GetCanvas') array(result.nodeRuns).push(array(result.nodeRuns)[0]);
    },
    ({ method, result }) => {
      if (method === 'ListCanvasRuns') result.runs = [{ runId: 'same' }, { runId: 'same' }];
    },
    ({ method, result }) => {
      if (method === 'GetTurnDetail') array(result.messages).push(array(result.messages)[0]);
    },
    ({ method, body, result }) => {
      if (method === 'GetRun' && body.runId === 'owned-run')
        array(object(result.run).steps).push(array(object(result.run).steps)[0]);
    },
  ];
  for (const edit of edits) await assert.rejects(prepare(edit), { code: 'CONTRACT_CHANGED' });
});

test('partial pagination, unknown totals and bounded limits suppress all write suggestions', async () => {
  const edits: NonNullable<Parameters<typeof fixture>[0]>[] = [
    ({ method, result }) => {
      if (method === 'ListCanvasRuns') result.nextPageToken = 'remaining';
    },
    ({ method, result }) => {
      if (method === 'GetTurnDetail') result.hasMore = true;
    },
    ({ method, result }) => {
      if (method === 'GetSession') result.total = 7;
    },
    ({ method, result }) => {
      if (method === 'GetCanvas') result.truncated = true;
    },
  ];
  for (const edit of edits) {
    const { result } = await prepare(edit);
    assert.equal(result.ready, false);
    assert.equal(result.incomplete, true);
    assert.deepEqual(writes(result), []);
  }
  for (const limits of [{ maxRuns: 3 }, { maxMessages: 2 }]) {
    const { result } = await prepare(undefined, { ...input, ...limits });
    assert.equal(result.ready, false);
    assert.deepEqual(writes(result), []);
  }
});

test('missing messages, mismatched session history and unresolved plan nodes stay incomplete', async () => {
  const edits: NonNullable<Parameters<typeof fixture>[0]>[] = [
    ({ method, result }) => {
      if (method === 'GetTurnDetail') delete result.messages;
    },
    ({ method, result }) => {
      if (method === 'GetSession') result.messages = [request];
    },
    ({ method, result }) => {
      if (['GetTurnDetail', 'GetSession'].includes(method))
        object(array(result.messages)[1]).cardJson = JSON.stringify({
          type: 'plan_steps',
          data: { groups: [{ steps: [{ nodeIds: ['missing'] }] }] },
        });
    },
    ({ method, result }) => {
      if (['GetTurnDetail', 'GetSession'].includes(method)) object(array(result.messages)[1]).cardJson = '{';
    },
    ({ method, result }) => {
      if (method === 'GetRun') object(result.run).status = 'RUN_STATUS_SOMETHING_NEW';
    },
  ];
  for (const edit of edits) {
    const { result } = await prepare(edit);
    assert.equal(result.incomplete, true);
    assert.deepEqual(writes(result), []);
  }
});

test('a new run, changed turn or replaced current execution during discovery blocks stale actions', async () => {
  const edits: NonNullable<Parameters<typeof fixture>[0]>[] = [
    ({ method, count, result }) => {
      if (method === 'GetCanvas' && count === 2) object(array(result.nodeRuns)[0]).runId = 'later-run';
    },
    ({ method, count, result }) => {
      if (method === 'ListCanvasRuns' && count === 2) result.runs = [{ runId: 'later-run' }];
    },
    ({ method, count, result }) => {
      if (method === 'GetTurnDetail' && count === 2) object(result.turn).status = 'TURN_STATUS_CANCELLED';
    },
    ({ method, count, result }) => {
      if (method === 'GetCanvas' && count === 2) object(result.canvas).revision = '5';
    },
  ];
  for (const edit of edits) {
    const { result } = await prepare(edit);
    assert.equal(result.ready, false);
    assert.ok(reasons(result).includes('discovery_changed_during_read'));
    assert.deepEqual(writes(result), []);
  }
});

test('an unavailable exact run is retained as unresolved without retrying or inferring its owner', async () => {
  const { result, calls } = await prepare(({ method, body, result }) => {
    if (method === 'GetRun' && body.runId === 'other-run') {
      delete result.run;
      result.error = { code: 5442, message: 'not available' };
    }
  });
  assert.equal(result.incomplete, true);
  assert.equal(array(result.unresolved_runs).length, 1);
  assert.deepEqual(writes(result), []);
  assert.equal(calls.filter((call) => call.method === 'GetRun' && call.body.runId === 'other-run').length, 1);
});

test('schema is bounded, strict and does not accept write identities or caller-provided run targets', () => {
  for (const extra of [
    { runIds: ['guess'] },
    { requestId: 'old-unknown' },
    { maxRuns: 501 },
    { maxMessages: 0 },
  ])
    assert.equal(turnStopPlanSchema.safeParse({ ...input, ...extra }).success, false);
  assert.equal(turnStopPlanSchema.safeParse({ ...input, expectedRevision: '4' }).success, true);
});

test('WAITING_FOR_USER without any created run still prepares the exact turn cancellation', async () => {
  const { result } = await prepare(({ method, result }) => {
    if (method === 'GetTurnDetail') object(result.turn).status = 'TURN_STATUS_WAITING_FOR_USER';
    if (['GetTurnDetail', 'GetSession'].includes(method)) result.messages = [request];
    if (method === 'GetCanvas') {
      result.nodes = [];
      result.nodeRuns = [];
    }
  });
  assert.equal(result.ready, true);
  assert.equal(result.active_owned_run_count, 0);
  assert.deepEqual(writes(result), [
    { tool: 'ai_modeling_canvas_turn_cancel', parameters: { turnId: 'turn' } },
  ]);
});

test('an unresolved current step or duplicate plan-node reference prevents stop suggestions', async () => {
  const edits: NonNullable<Parameters<typeof fixture>[0]>[] = [
    ({ method, result }) => {
      if (method === 'GetCanvas') object(array(result.nodeRuns)[0]).currentStepId = 'different-step';
    },
    ({ method, result }) => {
      if (['GetTurnDetail', 'GetSession'].includes(method))
        object(array(result.messages)[1]).cardJson = JSON.stringify({
          type: 'plan_steps',
          data: { groups: [{ steps: [{ nodeIds: ['owned', 'owned'] }] }] },
        });
    },
  ];
  for (const edit of edits) {
    const { result } = await prepare(edit);
    assert.equal(result.incomplete, true);
    assert.deepEqual(writes(result), []);
  }
});

test('an explicit old revision returns an incomplete plan without write actions', async () => {
  const { result } = await prepare(undefined, { ...input, expectedRevision: '3' });
  assert.equal(result.ready, false);
  assert.ok(reasons(result).includes('expected_revision_changed'));
  assert.deepEqual(writes(result), []);
});

test('current waiting states without a run identity cannot be treated as an empty discovery', async () => {
  for (const state of ['WAITING_REVIEW', 'AWAITING_CHOICE', 'AWAITING_INPUT']) {
    const { result } = await prepare(({ method, result }) => {
      if (method !== 'GetCanvas') return;
      const current = object(array(result.nodeRuns)[1]);
      current.runId = '';
      current.status = `NODE_STATUS_${state}`;
    });
    assert.equal(result.ready, false);
    assert.ok(reasons(result).includes('active_run_identity_unavailable'));
    assert.deepEqual(writes(result), []);
  }
});

test('switching account during discovery or on the last read never returns a usable plan', async () => {
  for (const last of [false, true]) {
    await assert.rejects(
      prepare(({ method, count }, credentials) => {
        if ((last && method === 'ListCanvasRuns' && count === 2) || (!last && method === 'GetRun'))
          credentials.save({ ...credentials.load()!, accountRef: 'other-account' });
      }),
      { code: 'ACCOUNT_MISMATCH' },
    );
  }
});

test('plans expose action identities without message text, attachment URLs or credentials', async () => {
  const { result } = await prepare(({ method, result }) => {
    if (!['GetSession', 'GetTurnDetail'].includes(method)) return;
    const message = object(array(result.messages)[0]);
    message.content = 'private-prompt-marker';
    message.attachments = [{ url: 'https://cdn.example/private-attachment?signature=secret' }];
  });
  assert.equal(result.ready, true);
  assert.doesNotMatch(
    JSON.stringify(result),
    /private-prompt-marker|private-attachment|signature=|bearer|eyJhb/,
  );
});
