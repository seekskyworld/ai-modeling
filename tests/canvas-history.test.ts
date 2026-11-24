/** Session history diagnostics compare returned records; they never infer an undocumented retention limit. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { StudioClient } from '../studio/api/client.ts';
import { inspectCanvasSessionHistory, canvasHistorySchema } from '../studio/api/canvas-history.ts';
import { canvasResources, callCanvas } from '../studio/api/canvas.ts';
import { array, object } from '../studio/contracts/errors.ts';

type RecordValue = Record<string, unknown>;
const input = { canvasId: 'canvas', sessionId: 'session' };
interface Invocation {
  method: string;
  body: RecordValue;
  count: number;
  result: RecordValue;
}
function fixture(
  edit?: (invocation: Invocation, credentials: MemoryCredentials) => void,
  turns = 2,
  messages = 3,
) {
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
  const details = Array.from({ length: turns }, (_, i) => ({
    turn: { turnId: `turn-${i}`, sessionId: 'session', status: 'TURN_STATUS_DONE' },
    messages: Array.from({ length: messages }, (_, j) => ({
      messageId: `message-${i}-${j}`,
      turnId: `turn-${i}`,
      role: j ? 'MESSAGE_ROLE_AGENT' : 'MESSAGE_ROLE_USER',
      content: `Message ${i}/${j}`,
      cardType: j ? 'CARD_TYPE_CONFIRMATION' : 'CARD_TYPE_UNSPECIFIED',
      cardJson: j ? JSON.stringify({ type: 'confirmation', intent: 'plan' }) : '',
      status: 'MESSAGE_STATUS_DONE',
      attachments: [],
    })),
  }));
  const calls: Invocation[] = [];
  let active = 0,
    maximum = 0;
  const client = new StudioClient(credentials, async (_url, init) => {
    const method = new Headers(init.headers).get('x-micro-method')!.split('/').at(-1)!;
    const body = object(JSON.parse(String(init.body)));
    const source: Record<string, RecordValue> = {
      GetSession: {
        session: { sessionId: 'session', canvasId: 'canvas', activeTurnId: '' },
        messages: details.flatMap((detail) => detail.messages),
      },
      // Studio requires an explicit status filter; an omitted/empty filter can return no turns.
      ListTurns: {
        turns: details
          .map((detail) => detail.turn)
          .filter((turn) => array(body.statuses).includes(turn.status)),
      },
      GetTurnDetail: details.find((detail) => detail.turn.turnId === body.turnId) ?? {},
    };
    assert.ok(Object.hasOwn(source, method), `Only history read methods are allowed: ${method}`);
    assert.deepEqual(
      Object.keys(body),
      method === 'ListTurns'
        ? ['sessionId', 'statuses']
        : [method === 'GetTurnDetail' ? 'turnId' : 'sessionId'],
    );
    const invocation = {
      method,
      body,
      count:
        calls.filter((call) => call.method === method && JSON.stringify(call.body) === JSON.stringify(body))
          .length + 1,
      result: structuredClone(source[method]!),
    };
    calls.push(invocation);
    edit?.(invocation, credentials);
    active++;
    maximum = Math.max(maximum, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active--;
    return Response.json({ error: { code: 0 }, ...invocation.result });
  });
  return { client, credentials, calls, details, maxConcurrency: () => maximum };
}
async function inspect(edit?: Parameters<typeof fixture>[0], options: RecordValue = input) {
  const f = fixture(edit);
  return { ...f, result: object(await inspectCanvasSessionHistory(f.client, options)) };
}

test('long synthetic histories retain every returned identity and order with bounded read concurrency', async () => {
  const f = fixture(undefined, 60, 4);
  const result = object(await inspectCanvasSessionHistory(f.client, { ...input, maxTurns: 80 }));
  assert.equal(result.observed_history_consistent, true);
  assert.equal(result.snapshot_stable, true);
  assert.equal(result.history_complete, null);
  assert.equal(result.incomplete, false);
  assert.deepEqual(result.counts, {
    session_messages: 240,
    listed_turns: 60,
    discovered_turns: 60,
    inspected_turns: 60,
    detail_messages: 240,
  });
  assert.equal(array(result.turns).length, 60);
  assert.ok(array(result.turns).every((row) => object(row).consistent === true));
  assert.equal(f.calls.length, 124);
  assert.equal(f.maxConcurrency(), 4);
  assert.match(String(result.verification_scope), /No documented pagination or total-history contract/);
  assert.match(String(result.snapshot_sha256), /^[a-f0-9]{64}$/);
  assert.equal(result.remote_saved, false);
  assert.equal(result.execution_started, false);
  assert.equal(result.messages, undefined);
  assert.deepEqual(result.read_messages, {
    tool: 'ai_modeling_canvas_session_get',
    parameters: { sessionId: 'session' },
  });
});

for (const scenario of [
  'session_omission',
  'detail_omission',
  'content_change',
  'reordered',
  'unlisted',
  'status',
] as const) {
  test(`a stable ${scenario} is reported without merging or manufacturing history`, async () => {
    const { result } = await inspect(({ method, body, result }) => {
      if (method === 'GetSession' && scenario === 'session_omission') array(result.messages).splice(1, 1);
      if (method === 'ListTurns' && scenario === 'unlisted') array(result.turns).splice(0, 1);
      if (method !== 'GetTurnDetail' || body.turnId !== 'turn-0') return;
      const messages = array(result.messages);
      if (scenario === 'detail_omission') messages.splice(1, 1);
      if (scenario === 'content_change') object(messages[1]).content = 'A different service record';
      if (scenario === 'reordered') messages.reverse();
      if (scenario === 'status') object(result.turn).status = 'TURN_STATUS_FAILED';
    });
    assert.equal(result.observed_history_consistent, false);
    assert.equal(result.history_complete, null);
    const first = array(result.turns)
      .map(object)
      .find((turn) => turn.turn_id === 'turn-0')!;
    assert.equal(first.consistent, false);
    if (scenario === 'session_omission') assert.deepEqual(first.missing_from_session, ['message-0-1']);
    if (scenario === 'detail_omission') assert.deepEqual(first.missing_from_turn_detail, ['message-0-1']);
    if (scenario === 'content_change') assert.deepEqual(first.differing_message_ids, ['message-0-1']);
    if (scenario === 'reordered') assert.equal(first.message_order_matches, false);
    if (scenario === 'unlisted') assert.equal(first.listed, false);
    if (scenario === 'status') assert.equal(first.listed_status_matches, false);
  });
}

test('an active turn is inspected even if both discovery collections omit it', async () => {
  const { result, calls } = await inspect(({ method, result }) => {
    if (method === 'GetSession') {
      object(result.session).activeTurnId = 'turn-0';
      result.messages = array(result.messages).filter((row) => object(row).turnId !== 'turn-0');
    }
    if (method === 'ListTurns') array(result.turns).splice(0, 1);
  });
  assert.equal(result.observed_history_consistent, false);
  assert.equal(
    calls.filter((call) => call.method === 'GetTurnDetail' && call.body.turnId === 'turn-0').length,
    2,
  );
});

for (const method of ['GetSession', 'ListTurns', 'GetTurnDetail']) {
  test(`changes in the second ${method} snapshot reject a mixed historical view`, async () => {
    await assert.rejects(
      inspect(({ method: current, count, result }) => {
        if (current !== method || count !== 2) return;
        if (method === 'GetSession') object(array(result.messages)[0]).content = 'Later content';
        if (method === 'ListTurns') object(array(result.turns)[0]).status = 'TURN_STATUS_FAILED';
        if (method === 'GetTurnDetail') object(array(result.messages)[0]).content = 'Later detail';
      }),
      { code: 'CANVAS_CHANGED' },
    );
  });
}

for (const scenario of [
  'foreign_session',
  'foreign_turn',
  'foreign_message',
  'duplicate_message',
  'duplicate_turn',
  'missing_messages',
  'malformed_active_turn',
  'missing_listed_status',
  'missing_detail_status',
]) {
  test(`malformed history ${scenario} cannot pass identity checks`, async () => {
    await assert.rejects(
      inspect(({ method, result }) => {
        if (method === 'GetSession' && scenario === 'foreign_session')
          object(result.session).canvasId = 'other';
        if (method === 'GetSession' && scenario === 'duplicate_message')
          array(result.messages).push(array(result.messages)[0]);
        if (method === 'ListTurns' && scenario === 'duplicate_turn')
          array(result.turns).push(array(result.turns)[0]);
        if (method === 'GetSession' && scenario === 'malformed_active_turn')
          object(result.session).activeTurnId = 123;
        if (method === 'ListTurns' && scenario === 'missing_listed_status')
          for (const turn of array(result.turns).map(object)) delete turn.status;
        if (method === 'GetTurnDetail' && scenario === 'foreign_turn')
          object(result.turn).sessionId = 'other';
        if (method === 'GetTurnDetail' && scenario === 'missing_detail_status')
          delete object(result.turn).status;
        if (method === 'GetTurnDetail' && scenario === 'foreign_message')
          object(array(result.messages)[0]).turnId = 'other';
        if (method === 'GetTurnDetail' && scenario === 'missing_messages') delete result.messages;
      }),
      { code: 'CONTRACT_CHANGED' },
    );
  });
}

for (const hint of [
  { nextPageToken: 'more' },
  { have_more: true },
  { total: 8 },
  { pagination: { next_cursor: 'more' } },
]) {
  test(`advertised pagination ${Object.keys(hint)[0]} remains unresolved without invented requests`, async () => {
    const { result, calls } = await inspect(({ method, result }) => {
      if (method === 'GetSession') Object.assign(result, hint);
    });
    assert.equal(result.incomplete, true);
    assert.equal(result.observed_history_consistent, null);
    assert.equal(result.history_complete, null);
    assert.deepEqual(result.incomplete_reasons, ['session_messages_pagination_unresolved']);
    assert.equal(calls.length, 4);
  });
}

test('local discovery limits do not silently truncate returned histories or launch partial detail fanout', async () => {
  for (const options of [{ maxTurns: 1 }, { maxMessages: 5 }]) {
    const { result, calls } = await inspect(undefined, { ...input, ...options });
    assert.equal(result.incomplete, true);
    assert.equal(result.observed_history_consistent, null);
    assert.equal(object(result.counts).session_messages, 6);
    assert.equal(object(result.counts).listed_turns, 2);
    assert.equal(object(result.counts).inspected_turns, 0);
    assert.equal(calls.length, 4);
  }
});

test('a larger per-turn history is bounded even if the session response omitted most messages', async () => {
  const { result } = await inspect(
    ({ method, result }) => {
      if (method === 'GetSession') result.messages = [];
    },
    { ...input, maxMessages: 5 },
  );
  assert.equal(result.incomplete, true);
  assert.equal(result.observed_history_consistent, null);
  assert.deepEqual(result.incomplete_reasons, ['detail_message_limit_exceeded']);
  assert.equal(object(result.counts).detail_messages, 6);
});

test('empty matching collections establish only returned-history consistency', async () => {
  const f = fixture(undefined, 0);
  const result = object(await inspectCanvasSessionHistory(f.client, input));
  assert.equal(result.observed_history_consistent, true);
  assert.equal(result.history_complete, null);
  assert.equal(f.calls.length, 4);
});

test('history explicitly requests every known active and terminal turn status', async () => {
  const statuses = [
    'TURN_STATUS_QUEUED',
    'TURN_STATUS_RUNNING',
    'TURN_STATUS_WAITING_FOR_USER',
    'TURN_STATUS_DONE',
    'TURN_STATUS_FAILED',
    'TURN_STATUS_CANCELLED',
  ];
  const f = fixture(undefined, statuses.length, 1);
  for (const [index, status] of statuses.entries()) f.details[index]!.turn.status = status;
  const result = object(await inspectCanvasSessionHistory(f.client, input));
  assert.equal(result.observed_history_consistent, true);
  assert.equal(object(result.counts).listed_turns, 6);
  assert.deepEqual(result.listed_statuses, statuses);
  for (const call of f.calls.filter((call) => call.method === 'ListTurns'))
    assert.deepEqual(call.body.statuses, statuses);
  assert.equal(result.history_complete, null);
});

test('renewed signed attachments normalize only signature fields and are not exposed in the diagnostic', async () => {
  const { result } = await inspect(({ method, count, result }) => {
    if (method === 'ListTurns') return;
    for (const message of array(result.messages).map(object))
      message.attachments = [
        { url: `https://example.test/original.png?view=full&X-Amz-Signature=${method}-${count}` },
      ];
  });
  assert.equal(result.observed_history_consistent, true);
  assert.ok(!JSON.stringify(result).includes('example.test'));
});

test('account changes during the history inspection cannot switch later requests to another account', async () => {
  const f = fixture(({ method }, credentials) => {
    if (method === 'ListTurns') credentials.clear();
  });
  await assert.rejects(inspectCanvasSessionHistory(f.client, input), { code: 'ACCOUNT_MISMATCH' });
  assert.equal(f.calls.length, 2);
});

test('invalid limits fail before reading credentials and the registered capability is read-only', async () => {
  for (const invalid of [
    { maxTurns: 0 },
    { maxTurns: 101 },
    { maxMessages: 0 },
    { maxMessages: 10001 },
    { cursor: 'guessed' },
  ])
    assert.equal(canvasHistorySchema.safeParse({ ...input, ...invalid }).success, false);
  const f = fixture();
  const spec = canvasResources.find((resource) => resource.name === 'session_history')!;
  assert.equal(spec.readOnly, true);
  assert.equal(spec.destructive, undefined);
  const result = object(await callCanvas(f.client, spec, input));
  assert.equal(result.observed_history_consistent, true);
});
