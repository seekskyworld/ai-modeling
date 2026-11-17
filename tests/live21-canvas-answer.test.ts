/** 真正卡片返回形状与读取期间变化；不使用账号或提交 ContinueTurn。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import { resourceInput, resourceOptions } from '../cli/compat/resource-options.ts';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { StudioClient } from '../studio/api/client.ts';
import { canvasResources, callCanvas } from '../studio/api/canvas.ts';
import { answerPlanSchema, resolveCanvasAnswerPlan } from '../studio/api/canvas-answer-plan.ts';
import { object } from '../studio/contracts/errors.ts';
import { canvasAgentSchemas } from '../studio/contracts/canvas-agent.ts';

const input = { canvasId: 'canvas', turnId: 'turn', cardMessageId: 'card' };
const selection = () => ({
  type: 'selection',
  intent: 'clarify',
  prompt: 'Choose an animal.',
  min: 1,
  max: 1,
  options: [
    { id: 'cat', label: 'Cat', selected: true },
    { id: 'dog', label: 'Dog' },
    { id: '__other__', label: 'Other', input: true },
    { id: '__skip__', label: 'Skip', skip: true },
  ],
});
function fixture(
  card = selection() as Record<string, unknown>,
  edit?: (
    method: string,
    result: Record<string, unknown>,
    count: number,
    credentials: MemoryCredentials,
  ) => void,
) {
  const credentials = new MemoryCredentials({
    accountRef: 'fixture',
    bearer:
      'eyJhbGciOiJIUzI1NiJ9.' +
      Buffer.from(JSON.stringify({ sub: 'fixture', exp: Math.floor(Date.now() / 1000) + 3600 })).toString(
        'base64url',
      ) +
      '.fixture',
    deviceId: 'fixture',
    importedAt: '',
  });
  const calls: string[] = [];
  const client = new StudioClient(credentials, async (_url, init) => {
    const method = new Headers(init.headers).get('x-micro-method')!.split('/').at(-1)!;
    calls.push(method);
    const defaults: Record<string, unknown> = {
      GetTurnDetail: {
        turn: {
          turnId: 'turn',
          sessionId: 'session',
          status: 'TURN_STATUS_WAITING_FOR_USER',
          requestId: 'original-create',
        },
        messages: [
          {
            messageId: 'card',
            turnId: 'turn',
            role: 'MESSAGE_ROLE_AGENT',
            status: 'MESSAGE_STATUS_DONE',
            cardType: card.type === 'astra' ? 'CARD_TYPE_ASTRA' : 'CARD_TYPE_SELECTION',
            cardJson: JSON.stringify({ ...card, messageId: 'card' }),
          },
        ],
      },
      GetSession: {
        session: {
          sessionId: 'session',
          canvasId: 'canvas',
          status: 'SESSION_STATUS_ACTIVE',
          activeTurnId: '',
        },
      },
      GetCanvas: {
        canvas: { canvasId: 'canvas', projectId: 'project', revision: '3' },
        nodes: [
          {
            id: 'model',
            type: 'NODE_TYPE_GENERATE_HD_MODEL',
            nodeAssets: [{ assetId: 'asset', nodeId: 'model' }],
          },
          { id: 'upload', type: 'NODE_TYPE_UPLOAD_CARD', inputMount: [{ assetId: 'uploaded' }] },
        ],
      },
      ListNodesAssets: {
        nodes: [
          {
            nodeId: 'model',
            assets: [
              {
                nodeId: 'model',
                assetId: 'asset',
                url: 'https://cdn.example/model.glb?signature=secret',
                version: 3,
              },
            ],
          },
        ],
      },
      BatchGetInputAssets: {
        assets: [{ assetId: 'uploaded', status: 'INPUT_ASSET_STATUS_READY', version: 1 }],
      },
      GetNodeAssetDetail: { assetId: 'asset', detail: { operator_id: 'operator' } },
    };
    assert.ok(Object.hasOwn(defaults, method), 'Only known read methods allowed: ' + method);
    const result = structuredClone(object(defaults[method]));
    edit?.(method, result, calls.filter((value) => value === method).length, credentials);
    return Response.json({ error: { code: 0 }, ...result });
  });
  return { client, calls };
}

test('answer plan is a read-only named Canvas command and returns no execution consent or remote request key', async () => {
  const spec = canvasResources.find((value) => value.name === 'answer_plan')!;
  assert.equal(spec.readOnly, true);
  const command = new Command().exitOverride();
  resourceOptions(command, spec.schema);
  command.parse(
    [
      '--canvas-id',
      'canvas',
      '--turn-id',
      'turn',
      '--card-message-id',
      'card',
      '--selected-option-ids',
      '["dog"]',
    ],
    { from: 'user' },
  );
  const parsed = answerPlanSchema.parse(resourceInput(command.opts(), spec.schema)),
    f = fixture();
  const result = object(await callCanvas(f.client, spec, parsed));
  assert.equal(result.ready, true);
  assert.deepEqual(result.parameters, { turn_id: 'turn', selected_option_ids: ['dog'] });
  assert.equal(result.execution_started, false);
  assert.equal(result.requires_accept_variable_cost, true);
  assert.match(String(result.answer_effect), /including Skip.*paid creation/);
  assert.ok(!JSON.stringify(result.parameters).includes('request_id'));
  assert.equal(f.calls.filter((method) => method === 'GetTurnDetail').length, 2);
});

test('single card preserves server defaults and trims Other while excluding asset selections like the webpage', async () => {
  let f = fixture();
  let result = object(await resolveCanvasAnswerPlan(f.client, input));
  assert.deepEqual(result.parameters, { turn_id: 'turn', selected_option_ids: ['cat'] });
  f = fixture({
    ...selection(),
    max: 2,
    options: [
      { id: 'model-choice', nodeId: 'model', assetId: 'asset' },
      { id: '__other__', input: true },
    ],
  });
  result = object(
    await resolveCanvasAnswerPlan(f.client, {
      ...input,
      selectedOptionIds: ['model-choice', '__other__'],
      otherText: '  A purple rabbit.  ',
    }),
  );
  assert.deepEqual(result.parameters, {
    turn_id: 'turn',
    selected_option_ids: ['__other__'],
    other_text: 'A purple rabbit.',
  });
  assert.ok(!f.calls.includes('ListNodesAssets'));
});

test('multi-question skip keeps valid answers, skips only allowed unanswered questions, and uses per-question Other', async () => {
  const card = {
    type: 'selection',
    questions: [
      { id: 'animal', prompt: 'Animal?', min: 1, max: 1, options: [{ id: 'animal:__other__', input: true }] },
      { id: 'style', prompt: 'Style?', skippable: true, options: [{ id: 'style:realistic' }] },
    ],
  };
  let result = object(
    await resolveCanvasAnswerPlan(fixture(card).client, {
      ...input,
      action: 'skip',
      selectedOptionIds: ['animal:__other__'],
      otherTexts: { animal: ' rabbit ' },
    }),
  );
  assert.equal(result.ready, true);
  assert.deepEqual(result.parameters, {
    turn_id: 'turn',
    selected_option_ids: ['animal:__other__', 'style:__skip__'],
    other_texts: { animal: 'rabbit' },
  });
  result = object(await resolveCanvasAnswerPlan(fixture(card).client, { ...input, action: 'skip' }));
  assert.equal(result.ready, false);
  assert.ok((result.reasons as string[]).includes('question_not_skippable:animal'));
  assert.equal(result.parameters, null);
});

test('confirmation uses empty selection or Other and preserves validated part names on skip', async () => {
  const card = {
    type: 'confirmation',
    intent: 'plan',
    skippable: true,
    data: { confirmNodeId: 'model', parts: [' head ', 'body'] },
  };
  let result = object(
    await resolveCanvasAnswerPlan(fixture(card).client, { ...input, otherText: 'Make three parts.' }),
  );
  assert.deepEqual(result.parameters, {
    turn_id: 'turn',
    selected_option_ids: ['__other__'],
    confirmed_parts: ['head', 'body'],
    other_text: 'Make three parts.',
  });
  result = object(
    await resolveCanvasAnswerPlan(fixture(card).client, {
      ...input,
      action: 'skip',
      confirmedParts: ['upper', 'lower'],
    }),
  );
  assert.deepEqual(result.parameters, {
    turn_id: 'turn',
    selected_option_ids: ['__skip__'],
    confirmed_parts: ['upper', 'lower'],
  });
  result = object(
    await resolveCanvasAnswerPlan(fixture({ ...card, data: { parts: ['head', 'head'] } }).client, input),
  );
  assert.equal(result.ready, false);
  assert.ok((result.reasons as string[]).includes('invalid_confirmed_parts'));
});

test('retry card accepts only explicit continuation with no invented option IDs', async () => {
  const card = { type: 'confirmation', intent: 'retry' };
  const result = object(await resolveCanvasAnswerPlan(fixture(card).client, input));
  assert.deepEqual(result.parameters, { turn_id: 'turn', selected_option_ids: [] });
  const invalid = object(
    await resolveCanvasAnswerPlan(fixture(card).client, { ...input, otherText: 'Try this instead.' }),
  );
  assert.equal(invalid.ready, false);
});

test('parts are never attached to selection or grouped answers and caller edits cannot be silently lost', async () => {
  const card = { ...selection(), data: { parts: ['head', 'body'] } };
  const prepared = object(await resolveCanvasAnswerPlan(fixture(card).client, input));
  assert.deepEqual(prepared.parameters, { turn_id: 'turn', selected_option_ids: ['cat'] });
  const invalid = object(
    await resolveCanvasAnswerPlan(fixture(card).client, {
      ...input,
      confirmedParts: ['upper', 'lower'],
    }),
  );
  assert.equal(invalid.ready, false);
  assert.equal(invalid.parameters, null);
  assert.ok((invalid.reasons as string[]).includes('confirmed_parts_not_sent_by_branch'));
});

test('free-text limits count Unicode code points only for answer preparation; new message allows 200000', () => {
  assert.equal(answerPlanSchema.parse({ ...input, otherText: '😀'.repeat(500) }).otherText?.length, 1000);
  assert.throws(() => answerPlanSchema.parse({ ...input, otherText: '😀'.repeat(501) }));
  assert.throws(() => answerPlanSchema.parse({ ...input, selectedOptionIds: ['cat', 'cat'] }));
  const turn = { accept_variable_cost: true, session_id: 'session', text: ' 😀'.trim().repeat(200000) };
  assert.equal(canvasAgentSchemas.canvas_turn.parse(turn).text.length, 400000);
  assert.throws(() => canvasAgentSchemas.canvas_turn.parse({ ...turn, text: turn.text + 'a' }));
  assert.equal(
    canvasAgentSchemas.canvas_turn.parse({ ...turn, text: '  ' + 'a'.repeat(16001) + '  ' }).text.length,
    16001,
  );
  // 原始 ContinueTurn 扩展字段不被其他卡片的 500 限制统一误伤。
  assert.equal(
    canvasAgentSchemas.canvas_continue.parse({
      accept_variable_cost: true,
      turn_id: 'turn',
      text: 'x'.repeat(1000),
    }).text?.length,
    1000,
  );
});

test('answered, expired, terminal and superseded cards never yield submission parameters', async () => {
  for (const changed of [{ selected_option_ids: [] }, { expired: true }]) {
    const result = object(
      await resolveCanvasAnswerPlan(fixture({ ...selection(), ...changed }).client, input),
    );
    assert.equal(result.ready, false);
    assert.equal(result.parameters, null);
  }
  for (const mode of ['done', 'newer'] as const) {
    const f = fixture(selection(), (method, result) => {
      if (method !== 'GetTurnDetail') return;
      if (mode === 'done') object(result.turn).status = 'TURN_STATUS_DONE';
      else
        (result.messages as unknown[]).push({
          messageId: 'later-card',
          turnId: 'turn',
          role: 'MESSAGE_ROLE_AGENT',
          cardType: 'CARD_TYPE_SELECTION',
          cardJson: JSON.stringify(selection()),
        });
    });
    assert.equal(object(await resolveCanvasAnswerPlan(f.client, input)).ready, false);
  }
});

test('exact turn, assistant card, JSON identity and session-to-Canvas binding are required', async () => {
  for (const mode of ['turn', 'card-turn', 'user', 'json-id', 'session', 'canvas'] as const) {
    const f = fixture(selection(), (method, result) => {
      if (method === 'GetTurnDetail') {
        const message = object((result.messages as unknown[])[0]);
        if (mode === 'turn') object(result.turn).turnId = 'other';
        if (mode === 'card-turn') message.turnId = 'other';
        if (mode === 'user') message.role = 'MESSAGE_ROLE_USER';
        if (mode === 'json-id') message.cardJson = JSON.stringify({ ...selection(), messageId: 'other' });
      }
      if (method === 'GetSession' && mode === 'session') object(result.session).canvasId = 'other';
      if (method === 'GetCanvas' && mode === 'canvas') object(result.canvas).canvasId = 'other';
    });
    await assert.rejects(resolveCanvasAnswerPlan(f.client, input), { code: 'CONTRACT_CHANGED' }, mode);
  }
});

test('card, graph or account changes during read preparation fail closed', async () => {
  for (const mode of ['card', 'graph', 'account'] as const) {
    const f = fixture(selection(), (method, result, count, credentials) => {
      if (mode === 'card' && method === 'GetTurnDetail' && count === 2)
        object((result.messages as unknown[])[0]).cardJson = JSON.stringify({
          ...selection(),
          prompt: 'Changed question.',
        });
      if (mode === 'graph' && method === 'GetCanvas' && count === 2) object(result.canvas).revision = '4';
      if (mode === 'account' && method === 'GetCanvas')
        credentials.save({ ...credentials.load()!, accountRef: 'other' });
    });
    await assert.rejects(resolveCanvasAnswerPlan(f.client, input), {
      code: mode === 'account' ? 'ACCOUNT_MISMATCH' : 'CANVAS_CHANGED',
    });
  }
});

test('selected generated asset requires exact node identity and detects version drift', async () => {
  const card = { ...selection(), options: [{ id: 'chosen', nodeId: 'model', assetId: 'asset' }] },
    requested = { ...input, selectedOptionIds: ['chosen'] };
  const result = object(await resolveCanvasAnswerPlan(fixture(card).client, requested));
  assert.equal(result.ready, true);
  assert.ok(!JSON.stringify(result).includes('signature=secret'));
  for (const mode of ['node', 'version'] as const) {
    const f = fixture(card, (method, value, count) => {
      if (method !== 'ListNodesAssets') return;
      const node = object((value.nodes as unknown[])[0]),
        asset = object((node.assets as unknown[])[0]);
      if (mode === 'node') asset.nodeId = 'other';
      else if (count === 2) asset.version = 4;
    });
    await assert.rejects(resolveCanvasAnswerPlan(f.client, requested), {
      code: mode === 'node' ? 'INPUT_NOT_READY' : 'CANVAS_CHANGED',
    });
  }
});
test('selected generated assets reject failed or newly processing output despite a valid URL', async () => {
  const card = { ...selection(), options: [{ id: 'chosen', nodeId: 'model', assetId: 'asset' }] };
  for (const mode of ['failed-status', 'failed-studio', 'processing-later'] as const) {
    const f = fixture(card, (method, value, count) => {
      if (method !== 'ListNodesAssets') return;
      const asset = object((object((value.nodes as unknown[])[0]).assets as unknown[])[0]);
      if (mode === 'failed-status') asset.status = 'ASSET_STATUS_FAILED';
      if (mode === 'failed-studio') asset.studioState = 'STUDIO_ASSET_STATE_FAILED';
      if (mode === 'processing-later') asset.status = count === 1 ? 'READY' : 'PROCESSING';
    });
    await assert.rejects(resolveCanvasAnswerPlan(f.client, { ...input, selectedOptionIds: ['chosen'] }), {
      code: 'INPUT_NOT_READY',
    });
  }
});

test('asset-only image choices bind through the saved Canvas and never call model-only detail', async () => {
  const card = {
      ...selection(),
      options: [{ id: 'image', assetId: 'asset', thumbnailUrl: 'https://cdn.example/image.png' }],
    },
    request = { ...input, selectedOptionIds: ['image'] },
    f = fixture(card);
  assert.equal(object(await resolveCanvasAnswerPlan(f.client, request)).ready, true);
  assert.ok(f.calls.includes('ListNodesAssets'));
  assert.ok(!f.calls.includes('GetNodeAssetDetail'));
  const ambiguous = fixture(card, (method, result) => {
    if (method === 'GetCanvas')
      (result.nodes as unknown[]).push({
        id: 'second',
        type: 'NODE_TYPE_GENERATE_IMAGE',
        nodeAssets: [{ assetId: 'asset' }],
      });
  });
  await assert.rejects(resolveCanvasAnswerPlan(ambiguous.client, request), { code: 'CONTRACT_CHANGED' });
});

test('selected uploads and implicit canvas_node choices cannot outlive their saved node or mount', async () => {
  const card = { ...selection(), options: [{ id: 'chosen', nodeId: 'upload', assetId: 'uploaded' }] },
    requested = { ...input, selectedOptionIds: ['chosen'] };
  assert.equal(object(await resolveCanvasAnswerPlan(fixture(card).client, requested)).ready, true);
  const f = fixture(card, (method, value, count) => {
    if (method === 'GetCanvas' && count === 2)
      object((value.nodes as unknown[])[1]).inputMount = [{ assetId: 'replacement' }];
  });
  await assert.rejects(resolveCanvasAnswerPlan(f.client, requested), { code: 'CANVAS_CHANGED' });
  const implicit = {
    ...selection(),
    data: { field: 'canvas_node', values: ['missing'] },
    options: [{ id: 'missing', label: 'Gone node' }],
  };
  await assert.rejects(
    resolveCanvasAnswerPlan(fixture(implicit).client, { ...input, selectedOptionIds: ['missing'] }),
    { code: 'CANVAS_CHANGED' },
  );
});

test('invalid or unknown answers return explicit reasons instead of silently selecting or dropping text', async () => {
  for (const provided of [
    { selectedOptionIds: ['unknown'] },
    { selectedOptionIds: ['cat'], otherText: 'Lost text' },
    { selectedOptionIds: ['__other__'] },
  ]) {
    const result = object(await resolveCanvasAnswerPlan(fixture().client, { ...input, ...provided }));
    assert.equal(result.ready, false);
    assert.equal(result.parameters, null);
  }
  await assert.rejects(
    resolveCanvasAnswerPlan(fixture({ type: 'astra', data: { requestText: 'Create a cube' } }).client, input),
    { code: 'UNSUPPORTED_CARD' },
  );
});
