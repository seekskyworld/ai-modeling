/** 已证网页能力字段及历史恢复；只使用离线响应，不提交真实创作。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { StudioClient } from '../studio/api/client.ts';
import { submitCreativeTask } from '../studio/api/canvas-agent.ts';
import { resolveCanvasTurnPlan } from '../studio/api/canvas-turn-plan.ts';
import { turnPlanSchema } from '../studio/api/canvas-turn-compose.ts';
import { historicalCapabilities } from '../studio/api/canvas-turn-history.ts';
import { canvasAgentSchemas } from '../studio/contracts/canvas-agent.ts';
import { array, object } from '../studio/contracts/errors.ts';
import { fixture as taskFixture, quote } from './helpers.ts';

const planInput = { canvasId: 'canvas', sessionId: 'session', text: 'Build a simple game.' };
const turnInput = { session_id: 'session', text: planInput.text, accept_variable_cost: true };
const retryInput = {
  canvasId: 'canvas',
  sessionId: 'session',
  action: 'retry',
  sourceTurnId: 'failed-turn',
  sourceMessageId: 'source-message',
};

function fixture(edit?: (method: string, result: Record<string, unknown>, count: number) => void) {
  const credentials = new MemoryCredentials({
    accountRef: 'test-account',
    deviceId: 'fixture',
    importedAt: '',
    bearer:
      'eyJhbGciOiJIUzI1NiJ9.' +
      Buffer.from(
        JSON.stringify({ sub: 'test-account', exp: Math.floor(Date.now() / 1000) + 3600 }),
      ).toString('base64url') +
      '.fixture',
  });
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const client = new StudioClient(credentials, async (_url, init) => {
    const method = new Headers(init.headers).get('x-micro-method')!.split('/').at(-1)!,
      body = object(JSON.parse(String(init.body)));
    calls.push({ method, body });
    const results: Record<string, Record<string, unknown>> = {
      GetSession: {
        session: {
          sessionId: 'session',
          canvasId: 'canvas',
          status: 'SESSION_STATUS_ACTIVE',
          activeTurnId: '',
        },
        messages: [],
      },
      GetCanvas: {
        canvas: { canvasId: 'canvas', projectId: 'project', revision: '7' },
        nodes: [],
      },
      BatchGetInputAssets: {
        assets: [{ assetId: 'input', status: 'INPUT_ASSET_STATUS_READY' }],
      },
      GetTurnDetail: {
        turn: { turnId: 'failed-turn', sessionId: 'session', status: 'TURN_STATUS_FAILED' },
        messages: [
          {
            messageId: 'source-message',
            turnId: 'failed-turn',
            role: 'MESSAGE_ROLE_USER',
            content: 'Keep the original game instructions.',
            attachments: [],
            cardJson: JSON.stringify({ capabilities: ['holy_molly'] }),
          },
          {
            messageId: 'failure',
            turnId: 'failed-turn',
            role: 'MESSAGE_ROLE_AGENT',
            failCode: 'fixture-failure',
            failCategory: 'FAIL_CATEGORY_SYSTEM',
            retryable: true,
          },
        ],
      },
      CreateTurn: { turnId: 'created-turn' },
    };
    assert.ok(Object.hasOwn(results, method), method);
    const result = results[method]!;
    edit?.(method, result, calls.filter((call) => call.method === method).length);
    return Response.json({ error: { code: 0 }, ...result });
  });
  return { client, calls };
}

test('raw and prepared turns accept only explicit verified capabilities without a new default', () => {
  assert.equal(Object.hasOwn(canvasAgentSchemas.canvas_turn.parse(turnInput), 'capabilities'), false);
  assert.equal(Object.hasOwn(turnPlanSchema.parse(planInput), 'capabilities'), false);
  for (const capabilities of [[], ['holy_molly']]) {
    assert.deepEqual(
      canvasAgentSchemas.canvas_turn.parse({ ...turnInput, capabilities }).capabilities,
      capabilities,
    );
    assert.deepEqual(turnPlanSchema.parse({ ...planInput, capabilities }).capabilities, capabilities);
  }
  for (const capabilities of [null, 'holy_molly', ['other'], ['holy_molly', 'holy_molly'], [true]]) {
    assert.equal(canvasAgentSchemas.canvas_turn.safeParse({ ...turnInput, capabilities }).success, false);
    assert.equal(turnPlanSchema.safeParse({ ...planInput, capabilities }).success, false);
  }
});

test('empty raw messages require an explicit HolyMolly target and reject plugin-only or asset mixtures', () => {
  const onlyTarget = {
    ...turnInput,
    text: '  ',
    capabilities: ['holy_molly'],
    node_id: 'game',
  };
  assert.equal(canvasAgentSchemas.canvas_turn.parse(onlyTarget).text, '');
  for (const input of [
    { ...onlyTarget, node_id: undefined },
    { ...onlyTarget, capabilities: undefined },
    { ...onlyTarget, capabilities: [] },
    { ...turnInput, text: '' },
    { ...onlyTarget, attachment_ids: ['input'] },
    { ...onlyTarget, refs: [{ asset_id: 'input' }] },
  ])
    assert.equal(canvasAgentSchemas.canvas_turn.safeParse(input).success, false);
  assert.equal(
    canvasAgentSchemas.canvas_turn.safeParse({ ...onlyTarget, accept_variable_cost: false }).success,
    false,
  );
});

test('target-only Holy preparation uses the unique saved game without inventing text or asset refs', async () => {
  for (const text of ['', '  ', undefined]) {
    const f = fixture((method, result) => {
      if (method === 'GetCanvas') result.nodes = [{ id: 'game', type: 'NODE_TYPE_HOLY_MOLLY' }];
    });
    const result = object(
      await resolveCanvasTurnPlan(f.client, {
        ...planInput,
        text,
        nodeId: 'game',
        capabilities: ['holy_molly'],
      }),
    );
    assert.equal(result.ready, true);
    assert.deepEqual(result.parameters, {
      session_id: 'session',
      text: '',
      mode: 'control',
      capabilities: ['holy_molly'],
      node_id: 'game',
      attachment_ids: [],
      refs: [],
    });
    assert.equal(result.character_count, text?.length ?? 0);
    assert.equal(result.attachment_count, 0);
    assert.equal(result.requires_accept_variable_cost, true);
    assert.equal(result.execution_started, false);
    assert.ok(f.calls.every(({ method }) => ['GetSession', 'GetCanvas'].includes(method)));
  }
});

test('empty preparation refuses a plugin alone, an ordinary target and a target whose type changes', async () => {
  for (const mode of ['plugin', 'ordinary', 'missing-capability', 'changed']) {
    const f = fixture((method, result, count) => {
      if (method === 'GetCanvas')
        result.nodes = [
          {
            id: 'target',
            type:
              mode === 'ordinary' || (mode === 'changed' && count === 2)
                ? 'NODE_TYPE_GENERATE_IMAGE'
                : 'NODE_TYPE_HOLY_MOLLY',
          },
        ];
    });
    const plan = resolveCanvasTurnPlan(f.client, {
      ...planInput,
      text: '',
      ...(mode === 'plugin' ? {} : { nodeId: 'target' }),
      ...(mode === 'missing-capability' ? {} : { capabilities: ['holy_molly'] }),
    });
    if (mode === 'changed') await assert.rejects(plan, { code: 'CANVAS_CHANGED' });
    else {
      const result = object(await plan);
      assert.equal(result.ready, false, mode);
      assert.equal(result.parameters, null, mode);
      assert.ok((result.reasons as string[]).includes('empty_message'), mode);
      if (mode === 'ordinary')
        assert.ok((result.reasons as string[]).includes('empty_message_target_not_holy_molly'));
    }
    assert.equal(
      f.calls.some(({ method }) => method === 'CreateTurn'),
      false,
    );
  }
});

test('ordinary attachments compose their real marker instead of using the target-only empty branch', async () => {
  const f = fixture((method, result) => {
    if (method === 'GetCanvas') result.nodes = [{ id: 'game', type: 'NODE_TYPE_HOLY_MOLLY' }];
  });
  const result = object(
    await resolveCanvasTurnPlan(f.client, {
      ...planInput,
      text: '',
      nodeId: 'game',
      capabilities: ['holy_molly'],
      attachments: [{ assetId: 'input' }],
    }),
  );
  assert.equal(result.ready, true);
  assert.equal(object(result.parameters).text, '[Attachment: input]');
  assert.deepEqual(object(result.parameters).attachment_ids, ['input']);
  assert.equal(result.attachment_count, 1);
});

test('turn preparation binds explicit capabilities and never enables them from attachment kinds', async () => {
  const f = fixture(),
    plain = object(await resolveCanvasTurnPlan(f.client, planInput)),
    holy = object(await resolveCanvasTurnPlan(f.client, { ...planInput, capabilities: ['holy_molly'] })),
    reference = object(
      await resolveCanvasTurnPlan(f.client, {
        ...planInput,
        attachments: [{ assetId: 'input', kind: 'application/x-holymolly' }],
      }),
    );
  assert.equal(plain.ready, true);
  assert.equal(holy.ready, true);
  assert.equal(reference.ready, true);
  assert.equal(Object.hasOwn(object(plain.parameters), 'capabilities'), false);
  assert.equal(Object.hasOwn(object(reference.parameters), 'capabilities'), false);
  assert.deepEqual(object(holy.parameters).capabilities, ['holy_molly']);
  assert.notEqual(plain.input_binding, holy.input_binding);
  assert.equal(
    f.calls.some(({ method }) => method === 'CreateTurn'),
    false,
  );
});

test('history restores capabilities only from exact user cardJson and rejects unknown contracts', () => {
  assert.deepEqual(historicalCapabilities({ cardJson: '{"capabilities":["holy_molly"]}' }), ['holy_molly']);
  assert.deepEqual(historicalCapabilities({ cardJson: '{"capabilities":[]}' }), []);
  assert.equal(historicalCapabilities({ capabilities: ['holy_molly'], cardJson: '{}' }), undefined);
  assert.equal(historicalCapabilities({}), undefined);
  for (const capabilities of [
    null,
    'holy_molly',
    ['new_capability'],
    ['holy_molly', 1],
    ['holy_molly', 'holy_molly'],
  ])
    assert.throws(() => historicalCapabilities({ cardJson: JSON.stringify({ capabilities }) }), {
      code: 'CONTRACT_CHANGED',
    });
  assert.throws(() => historicalCapabilities({ cardJson: '{' }), { code: 'CONTRACT_CHANGED' });
});

test('failed HolyMolly history retains capabilities but refuses to invent its unrecorded target', async () => {
  const f = fixture(),
    result = object(await resolveCanvasTurnPlan(f.client, retryInput));
  assert.equal(result.ready, false);
  assert.equal(result.parameters, null);
  assert.deepEqual(result.reasons, ['retry_holy_molly_target_unknown']);
  assert.equal(result.source_turn_id, 'failed-turn');
  assert.equal(result.source_message_id, 'source-message');
  assert.deepEqual(result.source_capabilities, ['holy_molly']);
  for (const capabilities of [[], ['holy_molly']])
    assert.equal(turnPlanSchema.safeParse({ ...retryInput, capabilities }).success, false);
  assert.equal(turnPlanSchema.safeParse({ ...retryInput, nodeId: 'replacement-target' }).success, false);
  assert.equal(
    f.calls.some(({ method }) => method === 'CreateTurn'),
    false,
  );
});

test('new-message preparation binds only the exact explicit saved target without inferring capabilities', async () => {
  const f = fixture((method, result) => {
    if (method === 'GetCanvas')
      result.nodes = [
        { id: 'first', type: 'NODE_TYPE_HOLY_MOLLY' },
        { id: 'second', type: 'NODE_TYPE_HOLY_MOLLY' },
      ];
  });
  const first = object(await resolveCanvasTurnPlan(f.client, { ...planInput, nodeId: 'first' })),
    second = object(await resolveCanvasTurnPlan(f.client, { ...planInput, nodeId: 'second' }));
  assert.equal(first.ready, true);
  assert.equal(second.ready, true);
  assert.equal(object(first.parameters).node_id, 'first');
  assert.equal(object(second.parameters).node_id, 'second');
  assert.notEqual(first.input_binding, second.input_binding);
  assert.equal(Object.hasOwn(object(first.parameters), 'capabilities'), false);
  assert.equal(
    f.calls.some(({ method }) => method === 'CreateTurn'),
    false,
  );
});

test('missing, duplicated, removed or changed explicit targets reject the prepared request', async () => {
  for (const scenario of ['missing', 'duplicate', 'removed', 'changed']) {
    const f = fixture((method, result, count) => {
      if (method !== 'GetCanvas') return;
      const target = {
        id: 'target',
        type: 'NODE_TYPE_HOLY_MOLLY',
        params: { version: count === 2 && scenario === 'changed' ? '2' : '1' },
      };
      result.nodes =
        scenario === 'missing' || (scenario === 'removed' && count === 2)
          ? []
          : scenario === 'duplicate'
            ? [target, structuredClone(target)]
            : [target];
    });
    await assert.rejects(
      resolveCanvasTurnPlan(f.client, {
        ...planInput,
        nodeId: 'target',
        capabilities: ['holy_molly'],
      }),
      { code: scenario === 'duplicate' ? 'CONTRACT_CHANGED' : 'CANVAS_CHANGED' },
    );
    assert.equal(
      f.calls.some(({ method }) => method === 'CreateTurn'),
      false,
    );
  }
});

test('unverified historical target-shaped fields never silently make a HolyMolly retry ready', async () => {
  const f = fixture((method, result) => {
    if (method === 'GetTurnDetail') {
      object(result.turn).nodeId = 'guessed-target';
      const message = object(array(result.messages)[0]);
      message.holyMollyTargetId = 'guessed-target';
      message.cardJson = JSON.stringify({ capabilities: ['holy_molly'], nodeId: 'guessed-target' });
    }
  });
  const result = object(await resolveCanvasTurnPlan(f.client, retryInput));
  assert.equal(result.ready, false);
  assert.equal(result.parameters, null);
  assert.deepEqual(result.reasons, ['retry_holy_molly_target_unknown']);
  assert.deepEqual(result.source_capabilities, ['holy_molly']);
});

test('missing historical capabilities never inherit unrelated turn or session properties', async () => {
  const f = fixture((method, result) => {
    if (method === 'GetSession') object(result.session).capabilities = ['holy_molly'];
    if (method === 'GetTurnDetail') {
      object(result.turn).capabilities = ['holy_molly'];
      object(array(result.messages)[0]).cardJson = '{}';
    }
  });
  const result = object(await resolveCanvasTurnPlan(f.client, retryInput));
  assert.equal(result.ready, true);
  assert.equal(Object.hasOwn(object(result.parameters), 'capabilities'), false);
});

test('unknown or changed historical capabilities cannot produce a ready retry', async () => {
  for (const scenario of ['unknown', 'changed']) {
    const f = fixture((method, result, count) => {
      if (method === 'GetTurnDetail' && (scenario === 'unknown' || count === 2))
        object(array(result.messages)[0]).cardJson = JSON.stringify({
          capabilities: scenario === 'unknown' ? ['future_capability'] : [],
        });
    });
    await assert.rejects(resolveCanvasTurnPlan(f.client, retryInput), {
      code: scenario === 'unknown' ? 'CONTRACT_CHANGED' : 'CANVAS_CHANGED',
    });
    assert.equal(
      f.calls.some(({ method }) => method === 'CreateTurn'),
      false,
    );
  }
});

test('CreateTurn forwards only explicit nonempty capabilities with the original plain-chat payload intact', async () => {
  const store = await taskFixture();
  try {
    for (const capabilities of [undefined, [], ['holy_molly']]) {
      const input = canvasAgentSchemas.canvas_turn.parse({ ...turnInput, capabilities }),
        f = fixture(),
        job = store.jobs.prepare(
          'test-account',
          'capability-' + String(capabilities),
          'canvas_turn',
          input,
          quote,
        );
      const result = await submitCreativeTask(f.client, job);
      assert.deepEqual(result, { remote_ids: { task_id: 'created-turn' } });
      const writes = f.calls.filter(({ method }) => method === 'CreateTurn');
      assert.equal(writes.length, 1);
      assert.deepEqual(writes[0]!.body, {
        sessionId: 'session',
        text: turnInput.text,
        mode: 'MODE_CONTROL',
        nodeId: '',
        attachmentIds: [],
        ...(capabilities?.length ? { capabilities } : {}),
      });
    }
  } finally {
    store.jobs.close();
    await rm(store.dir, { recursive: true, force: true });
  }
});

test('saved request identity freezes capabilities and target while an unknown submission does not replay', async () => {
  const store = await taskFixture();
  try {
    const input = { ...turnInput, capabilities: ['holy_molly'], node_id: 'original-target' },
      first = await store.service.submit('canvas_turn', 'holy-request', input, 10),
      jobId = String(first.job_id);
    store.jobs.update(jobId, 'outcome_unknown');
    store.gateway.submit = async () => assert.fail('Unknown requests must not submit a new turn.');
    store.gateway.account = async () => assert.fail('Recovery must retain its original account and inputs.');
    const restored = await store.service.submit('canvas_turn', 'holy-request', input, 10);
    assert.equal(restored.job_id, jobId);
    assert.equal(restored.state, 'outcome_unknown');
    assert.deepEqual(store.jobs.get(jobId).input.capabilities, ['holy_molly']);
    assert.equal(store.jobs.get(jobId).input.node_id, 'original-target');
    assert.equal(store.gateway.posts, 1);
    await assert.rejects(
      store.service.submit('canvas_turn', 'holy-request', { ...input, capabilities: [] }, 10),
      {
        code: 'IDEMPOTENCY_CONFLICT',
      },
    );
    await assert.rejects(
      store.service.submit('canvas_turn', 'holy-request', { ...input, node_id: 'changed-target' }, 10),
      {
        code: 'IDEMPOTENCY_CONFLICT',
      },
    );
  } finally {
    store.jobs.close();
    await rm(store.dir, { recursive: true, force: true });
  }
});
