/** Persisted Holy targets require exact history and saved graph evidence; no live Studio requests. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { StudioClient } from '../studio/api/client.ts';
import { resolveCanvasTurnPlan } from '../studio/api/canvas-turn-plan.ts';
import { historicalAttachments, historicalHolyMollyTarget } from '../studio/api/canvas-turn-history.ts';
import { array, object } from '../studio/contracts/errors.ts';

const input = {
  canvasId: 'history-canvas',
  sessionId: 'history-session',
  action: 'retry',
  sourceTurnId: 'failed-turn',
  sourceMessageId: 'failed-user',
};
const gameId = 'original-game';
const card = { capabilities: ['holy_molly'], targetNodeId: gameId, turnRefs: null };
const source = (result: Record<string, unknown>) => object(array(result.messages)[0]);

function fixture(edit?: (method: string, result: Record<string, unknown>, count: number) => void) {
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
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const client = new StudioClient(credentials, async (_url, init) => {
    const method = new Headers(init.headers).get('x-micro-method')!.split('/').at(-1)!;
    calls.push({ method, body: object(JSON.parse(String(init.body))) });
    const results: Record<string, Record<string, unknown>> = {
      GetSession: {
        session: {
          sessionId: input.sessionId,
          canvasId: input.canvasId,
          status: 'SESSION_STATUS_ACTIVE',
          activeTurnId: '',
        },
        messages: [],
      },
      GetCanvas: {
        canvas: { canvasId: input.canvasId, projectId: 'project', revision: '7' },
        nodes: [
          { id: gameId, type: 'NODE_TYPE_HOLY_MOLLY', params: { version: 'original' } },
          { id: 'another-game', type: 'NODE_TYPE_HOLY_MOLLY' },
          { id: 'image-node', type: 'NODE_TYPE_GENERATE_IMAGE' },
        ],
      },
      GetTurnDetail: {
        turn: {
          turnId: input.sourceTurnId,
          sessionId: input.sessionId,
          status: 'TURN_STATUS_FAILED',
          requestId: 'original-remote-request',
        },
        messages: [
          {
            messageId: input.sourceMessageId,
            turnId: input.sourceTurnId,
            role: 'MESSAGE_ROLE_USER',
            content: 'Change the original game.',
            attachments: [],
            cardJson: JSON.stringify(card),
          },
          {
            messageId: 'failed-agent',
            turnId: input.sourceTurnId,
            role: 'MESSAGE_ROLE_AGENT',
            failCode: 'fixture-failure',
            failCategory: 'FAIL_CATEGORY_SYSTEM',
            retryable: true,
          },
        ],
      },
      ListNodesAssets: {
        nodes: [
          {
            nodeId: 'image-node',
            assets: [
              { assetId: 'image-asset', nodeId: 'image-node', url: 'https://cdn.example/reference.png' },
            ],
          },
        ],
      },
    };
    assert.ok(Object.hasOwn(results, method), 'Preparation only reads exact sources: ' + method);
    const result = results[method]!;
    edit?.(method, result, calls.filter((call) => call.method === method).length);
    return Response.json({ error: { code: 0 }, ...result });
  });
  return { client, calls };
}

test('failed Holy history restores the exact persisted target without reusing the original request identity', async () => {
  const f = fixture(),
    result = object(await resolveCanvasTurnPlan(f.client, input));
  assert.equal(result.ready, true);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.source_turn_id, input.sourceTurnId);
  assert.equal(result.source_message_id, input.sourceMessageId);
  assert.equal(result.source_target_node_id, gameId);
  assert.deepEqual(result.source_capabilities, ['holy_molly']);
  assert.deepEqual(result.parameters, {
    session_id: input.sessionId,
    text: 'Change the original game.',
    mode: 'control',
    capabilities: ['holy_molly'],
    node_id: gameId,
    attachment_ids: [],
    refs: [],
  });
  assert.equal(result.requires_accept_variable_cost, true);
  assert.equal(result.execution_started, false);
  assert.equal(result.remote_saved, false);
  assert.match(String(result.request_key_policy), /new stable local request_id/);
  assert.equal(JSON.stringify(result).includes('original-remote-request'), false);
  assert.deepEqual(
    f.calls.map((call) => call.method),
    ['GetSession', 'GetCanvas', 'GetTurnDetail', 'GetSession', 'GetCanvas', 'GetTurnDetail'],
  );
  assert.ok(
    f.calls
      .filter((call) => call.method === 'GetTurnDetail')
      .every((call) => call.body.turnId === input.sourceTurnId),
  );
});

test('persisted targets require a supported explicit capability and exact valid identity', () => {
  assert.equal(historicalHolyMollyTarget({ cardJson: JSON.stringify(card) }), gameId);
  assert.equal(historicalHolyMollyTarget({ targetNodeId: gameId, cardJson: '{}' }), undefined);
  for (const targetNodeId of [null, '', ' ', ' target ', 1, {}, [], 'a'.repeat(257), 'other/game'])
    assert.throws(() => historicalHolyMollyTarget({ cardJson: JSON.stringify({ ...card, targetNodeId }) }), {
      code: 'CONTRACT_CHANGED',
    });
  for (const capabilities of [undefined, [], null, ['other']])
    assert.throws(() => historicalHolyMollyTarget({ cardJson: JSON.stringify({ ...card, capabilities }) }), {
      code: 'CONTRACT_CHANGED',
    });
});

test('null historical refs are absence of ordinary references, never a source identity or a guessed target', () => {
  assert.deepEqual(historicalAttachments({ attachments: [], cardJson: JSON.stringify(card) }), []);
  assert.deepEqual(
    historicalAttachments({ attachments: [{ assetId: 'input' }], cardJson: JSON.stringify(card) }),
    [{ assetId: 'input' }],
  );
  for (const turnRefs of [false, '', {}, '[]'])
    assert.throws(() => historicalAttachments({ cardJson: JSON.stringify({ ...card, turnRefs }) }), {
      code: 'CONTRACT_CHANGED',
    });
});

test('a restored Holy target preserves exact ordinary attachment sources and text', async () => {
  const f = fixture((method, result) => {
    if (method !== 'GetTurnDetail') return;
    const message = source(result);
    message.content = 'Change [Attachment: image-asset] in the original game.';
    message.attachments = [{ assetId: 'image-asset', name: 'reference.png', type: 'image/png' }];
    message.cardJson = JSON.stringify({
      ...card,
      turnRefs: [{ assetId: 'image-asset', nodeId: 'image-node', order: 0 }],
    });
  });
  const result = object(await resolveCanvasTurnPlan(f.client, input)),
    params = object(result.parameters);
  assert.equal(result.ready, true);
  assert.equal(params.node_id, gameId);
  assert.equal(params.text, 'Change [Attachment: image-asset] in the original game.');
  assert.deepEqual(params.attachment_ids, ['image-asset']);
  assert.deepEqual(params.refs, [
    { asset_id: 'image-asset', node_id: 'image-node', filename: 'reference.png', kind: 'image/png' },
  ]);
  assert.equal(f.calls.filter((call) => call.method === 'ListNodesAssets').length, 2);
});

test('restored targets must exist uniquely as Holy nodes in the selected saved Canvas', async () => {
  for (const scenario of ['missing', 'ordinary', 'duplicate']) {
    const f = fixture((method, result) => {
      if (method !== 'GetCanvas') return;
      const nodes = array(result.nodes);
      if (scenario === 'missing') result.nodes = nodes.slice(1);
      else if (scenario === 'ordinary') object(nodes[0]).type = 'NODE_TYPE_GENERATE_IMAGE';
      else nodes.push(structuredClone(nodes[0]));
    });
    await assert.rejects(resolveCanvasTurnPlan(f.client, input), {
      code: scenario === 'duplicate' ? 'CONTRACT_CHANGED' : 'CANVAS_CHANGED',
    });
  }
});

test('target restoration cannot bypass exact session, Canvas, turn or original USER message ownership', async () => {
  const scenarios: [string, string, (result: Record<string, unknown>) => void][] = [
    [
      'session',
      'GetSession',
      (value) => {
        object(value.session).sessionId = 'other';
      },
    ],
    [
      'session canvas',
      'GetSession',
      (value) => {
        object(value.session).canvasId = 'other';
      },
    ],
    [
      'canvas',
      'GetCanvas',
      (value) => {
        object(value.canvas).canvasId = 'other';
      },
    ],
    [
      'turn',
      'GetTurnDetail',
      (value) => {
        object(value.turn).turnId = 'other';
      },
    ],
    [
      'turn session',
      'GetTurnDetail',
      (value) => {
        object(value.turn).sessionId = 'other';
      },
    ],
    [
      'message',
      'GetTurnDetail',
      (value) => {
        source(value).messageId = 'other';
      },
    ],
    [
      'message turn',
      'GetTurnDetail',
      (value) => {
        source(value).turnId = 'other';
      },
    ],
    [
      'role',
      'GetTurnDetail',
      (value) => {
        source(value).role = 'MESSAGE_ROLE_AGENT';
      },
    ],
    [
      'duplicate',
      'GetTurnDetail',
      (value) => {
        array(value.messages).push(structuredClone(source(value)));
      },
    ],
  ];
  for (const [name, method, edit] of scenarios) {
    const f = fixture((current, result) => {
      if (current === method) edit(result);
    });
    await assert.rejects(resolveCanvasTurnPlan(f.client, input), { code: 'CONTRACT_CHANGED' }, name);
  }
});

test('history target and saved target content both participate in the preparation snapshot', async () => {
  for (const scenario of ['target', 'target-missing', 'params', 'type', 'removed']) {
    const f = fixture((method, result, count) => {
      if (count !== 2) return;
      if (method === 'GetTurnDetail' && ['target', 'target-missing'].includes(scenario))
        source(result).cardJson = JSON.stringify({
          ...card,
          targetNodeId: scenario === 'target' ? 'another-game' : undefined,
        });
      if (method !== 'GetCanvas') return;
      const nodes = array(result.nodes),
        target = object(nodes[0]);
      if (scenario === 'params') target.params = { version: 'replaced' };
      if (scenario === 'type') target.type = 'NODE_TYPE_GENERATE_IMAGE';
      if (scenario === 'removed') result.nodes = nodes.slice(1);
    });
    await assert.rejects(resolveCanvasTurnPlan(f.client, input), { code: 'CANVAS_CHANGED' }, scenario);
  }
});

test('a proven historical target does not override failure, content or latest-message retry restrictions', async () => {
  for (const scenario of ['done', 'not-retryable', 'empty', 'later-user', 'no-agent']) {
    const f = fixture((method, result) => {
      if (method !== 'GetTurnDetail') return;
      const messages = array(result.messages);
      if (scenario === 'done') object(result.turn).status = 'TURN_STATUS_DONE';
      if (scenario === 'not-retryable') object(messages[1]).retryable = false;
      if (scenario === 'empty') source(result).content = '';
      if (scenario === 'later-user') messages.push({ ...source(result), messageId: 'later-user' });
      if (scenario === 'no-agent') result.messages = messages.slice(0, 1);
    });
    const result = object(await resolveCanvasTurnPlan(f.client, input));
    assert.equal(result.ready, false, scenario);
    assert.equal(result.parameters, null, scenario);
    assert.equal(result.source_target_node_id, gameId);
    assert.equal(array(result.reasons).includes('retry_holy_molly_target_unknown'), false);
  }
});
