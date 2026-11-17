/** composer 准备与原历史身份；只使用受控读取，不提交 CreateTurn。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { StudioClient } from '../studio/api/client.ts';
import { canvasResources, callCanvas } from '../studio/api/canvas.ts';
import { resolveCanvasTurnPlan } from '../studio/api/canvas-turn-plan.ts';
import { composeCanvasTurn, turnPlanSchema } from '../studio/api/canvas-turn-compose.ts';
import { canvasAgentSchemas } from '../studio/contracts/canvas-agent.ts';
import { submitCreativeTask } from '../studio/api/canvas-agent.ts';
import { historicalAttachments } from '../studio/api/canvas-turn-history.ts';
import { object } from '../studio/contracts/errors.ts';
import { fixture as jobFixture, quote } from './helpers.ts';
const input = { canvasId: 'canvas', sessionId: 'session', text: 'Compare the reference.' };
const attachment = { assetId: 'generated', nodeId: 'image', filename: 'reference.png', kind: 'image/png' };
function fixture(
  edit?: (
    method: string,
    body: Record<string, unknown>,
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
    const method = new Headers(init.headers).get('x-micro-method')!.split('/').at(-1)!,
      body = JSON.parse(String(init.body));
    calls.push(method);
    const defaults: Record<string, unknown> = {
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
        canvas: { canvasId: 'canvas', projectId: 'project', revision: '3' },
        nodes: [
          {
            id: 'image',
            type: 'NODE_TYPE_GENERATE_IMAGE',
            nodeAssets: [{ assetId: 'generated', nodeId: 'image' }],
          },
          { id: 'upload', type: 'NODE_TYPE_UPLOAD_CARD', inputMount: [{ assetId: 'uploaded' }] },
          {
            id: 'copied',
            type: 'NODE_TYPE_GENERATE_IMAGE',
            nodeAssets: [{ assetId: 'copy-new', nodeId: 'copied' }],
          },
        ],
      },
      BatchGetInputAssets: {
        assets: [
          { assetId: 'uploaded', status: 'INPUT_ASSET_STATUS_READY', version: 1 },
          { assetId: 'unmounted', status: 'INPUT_ASSET_STATUS_READY', version: 2 },
        ],
      },
      ListNodesAssets: {
        nodes: [
          {
            nodeId: 'image',
            assets: [
              {
                assetId: 'generated',
                nodeId: 'image',
                url: 'https://cdn.example/image.png?signature=secret',
                version: 1,
              },
            ],
          },
          {
            nodeId: 'copied',
            assets: [
              {
                assetId: 'copy-new',
                nodeId: 'copied',
                kind: 'ASSET_KIND_IMAGE',
                slotIndex: 0,
                url: 'https://cdn.example/copy.png',
                version: 1,
              },
            ],
          },
        ],
      },
      GetTurnDetail: {
        turn: { turnId: body.turnId, sessionId: 'session', status: 'TURN_STATUS_FAILED' },
        messages: [
          {
            messageId: 'user-message',
            turnId: body.turnId,
            role: 'MESSAGE_ROLE_USER',
            content: 'Inspect [Attachment: generated].',
            attachments: [{ assetId: 'generated', name: 'reference.png', type: 'image/png' }],
            cardJson: JSON.stringify({ turnRefs: [{ assetId: 'generated', nodeId: 'image' }] }),
          },
          {
            messageId: 'failed',
            turnId: body.turnId,
            role: 'MESSAGE_ROLE_AGENT',
            status: 'MESSAGE_STATUS_FAILED',
            failCode: '5000',
            failCategory: 'FAIL_CATEGORY_SYSTEM',
            retryable: true,
          },
        ],
      },
    };
    assert.ok(Object.hasOwn(defaults, method), 'Only known read calls: ' + method);
    const result = structuredClone(object(defaults[method]));
    edit?.(method, body, result, calls.filter((item) => item === method).length, credentials);
    return Response.json({ error: { code: 0 }, ...result });
  });
  return { client, calls };
}
test('turn-plan is a read-only resource and composes exact selected-node references without execution consent', async () => {
  const f = fixture(),
    spec = canvasResources.find((resource) => resource.name === 'turn_plan')!;
  assert.equal(spec.readOnly, true);
  const result = object(await callCanvas(f.client, spec, { ...input, attachments: [attachment] }));
  assert.equal(result.ready, true);
  assert.deepEqual(result.parameters, {
    session_id: 'session',
    text: 'Compare the reference. [Attachment: generated]',
    mode: 'control',
    attachment_ids: ['generated'],
    refs: [{ asset_id: 'generated', node_id: 'image', filename: 'reference.png', kind: 'image/png' }],
  });
  assert.equal(result.execution_started, false);
  assert.equal(result.remote_saved, false);
  assert.ok(!JSON.stringify(result).includes('signature=secret'));
  assert.ok(!Object.hasOwn(object(result.parameters), 'request_id'));
  assert.equal(f.calls.filter((method) => method === 'GetCanvas').length, 2);
});
test('marker positions, repeated IDs on different nodes and unknown literal markers preserve user meaning', () => {
  const a = { assetId: 'same', nodeId: 'one' },
    b = { assetId: 'same', nodeId: 'two' };
  const result = composeCanvasTurn(
    'B [Attachment: same] then [Attachment: same] literal [Attachment: unknown]',
    [a, b],
    'new',
  );
  assert.deepEqual(
    result.attachments.map(({ assetId, nodeId }) => ({ assetId, nodeId })),
    [a, b],
  );
  assert.equal(result.text, 'B [Attachment: same] then [Attachment: same] literal [Attachment: unknown]');
  assert.equal(result.characterCount, [...'B  then  literal [Attachment: unknown]'].length);
  const repeated = composeCanvasTurn('[Attachment: same] [Attachment: same]', [a], 'new');
  assert.deepEqual(
    repeated.attachments.map(({ assetId, nodeId }) => ({ assetId, nodeId })),
    [a, a],
  );
});
test('new message count applies to serialized composer attachments while failed-history retry keeps original order', () => {
  const refs = Array.from({ length: 31 }, (_, i) => ({ assetId: 'asset-' + i }));
  const current = composeCanvasTurn('Inspect', refs, 'new');
  assert.ok(current.reasons.includes('new_message_attachment_limit_exceeded'));
  const retry = composeCanvasTurn('Inspect', refs, 'retry');
  assert.ok(!retry.reasons.includes('new_message_attachment_limit_exceeded'));
  const reordered = composeCanvasTurn(
    '[Attachment: second] [Attachment: first]',
    [{ assetId: 'first' }, { assetId: 'second' }],
    'retry',
  );
  assert.deepEqual(
    reordered.attachments.map((ref) => ref.assetId),
    ['first', 'second'],
  );
  assert.equal(reordered.text, '[Attachment: second] [Attachment: first]');
});
test('known marker characters are excluded from the raw turn Unicode boundary, unknown markers remain prose', () => {
  const raw = {
    session_id: 'session',
    accept_variable_cost: true,
    attachment_ids: ['image'],
    text: '😀'.repeat(200000) + '[Attachment: image]',
  };
  assert.equal(canvasAgentSchemas.canvas_turn.parse(raw).text, raw.text);
  assert.throws(() => canvasAgentSchemas.canvas_turn.parse({ ...raw, text: raw.text + 'a' }));
  assert.throws(() =>
    canvasAgentSchemas.canvas_turn.parse({ ...raw, text: '😀'.repeat(200000) + '[Attachment: unknown]' }),
  );
  assert.equal(
    canvasAgentSchemas.canvas_turn.parse({
      ...raw,
      text: 'a'.repeat(200000) + '[Attachment: image][Attachment: image]',
    }).text.length,
    200038,
  );
});
test('explicit saved-copy marker mappings must target current refs and never excuse unknown literal markers', () => {
  const mapping = { node_id: 'copied', from_asset_id: 'old', to_asset_id: 'copy-new' },
    raw = {
      session_id: 'session',
      accept_variable_cost: true,
      text: 'a'.repeat(200000) + '[Attachment: old]',
      refs: [{ asset_id: 'copy-new', node_id: 'copied' }],
      attachment_rebindings: [mapping],
    };
  assert.equal(canvasAgentSchemas.canvas_turn.parse(raw).text, raw.text);
  for (const attachment_rebindings of [
    [{ ...mapping, node_id: 'other' }],
    [{ ...mapping, to_asset_id: 'other' }],
    [{ ...mapping, from_asset_id: 'copy-new' }],
    [mapping, mapping],
  ])
    assert.throws(() => canvasAgentSchemas.canvas_turn.parse({ ...raw, attachment_rebindings }));
  assert.throws(() => canvasAgentSchemas.canvas_turn.parse({ ...raw, refs: [] }));
  assert.throws(() =>
    canvasAgentSchemas.canvas_turn.parse({ ...raw, text: raw.text + '[Attachment: unknown]' }),
  );
  assert.throws(() => canvasAgentSchemas.canvas_turn.parse({ ...raw, attachment_rebindings: undefined }));
});
test('uploaded node mounts and unmounted READY project inputs are checked before a plan becomes ready', async () => {
  const result = object(
    await resolveCanvasTurnPlan(fixture().client, {
      ...input,
      attachments: [{ assetId: 'uploaded', nodeId: 'upload' }, { assetId: 'unmounted' }],
    }),
  );
  assert.equal(result.ready, true);
  const f = fixture((method, _body, result) => {
    if (method === 'BatchGetInputAssets')
      object((result.assets as unknown[])[0]).status = 'INPUT_ASSET_STATUS_PROCESSING';
  });
  await assert.rejects(
    resolveCanvasTurnPlan(f.client, { ...input, attachments: [{ assetId: 'uploaded', nodeId: 'upload' }] }),
    { code: 'INPUT_NOT_READY' },
  );
  await assert.rejects(
    resolveCanvasTurnPlan(fixture().client, { ...input, attachments: [{ assetId: 'generated' }] }),
    { code: 'INPUT_NOT_READY' },
  );
});
test('history retry requires the exact failed user message and restores turnRefs node identity', async () => {
  const request = {
    canvasId: 'canvas',
    sessionId: 'session',
    action: 'retry',
    sourceTurnId: 'failed-turn',
    sourceMessageId: 'user-message',
  };
  const result = object(await resolveCanvasTurnPlan(fixture().client, request));
  assert.equal(result.ready, true);
  assert.equal(object(result.parameters).text, 'Inspect [Attachment: generated].');
  assert.deepEqual(object(result.parameters).refs, [
    { asset_id: 'generated', node_id: 'image', filename: 'reference.png', kind: 'image/png' },
  ]);
  for (const mode of ['done', 'not-retryable'] as const) {
    const f = fixture((method, _body, result) => {
      if (method !== 'GetTurnDetail') return;
      if (mode === 'done') object(result.turn).status = 'TURN_STATUS_DONE';
      else object((result.messages as unknown[])[1]).retryable = false;
    });
    assert.equal(object(await resolveCanvasTurnPlan(f.client, request)).ready, false);
  }
  assert.throws(() => turnPlanSchema.parse({ ...request, text: 'Different intent' }));
  await assert.rejects(resolveCanvasTurnPlan(fixture().client, { ...request, sourceMessageId: 'failed' }), {
    code: 'CONTRACT_CHANGED',
  });
});
test('retry failure folding preserves classified refusal through explanation or legacy but accepts a later classified retry', async () => {
  for (const later of ['explanation', 'legacy', 'classified'] as const) {
    const f = fixture((method, _body, result) => {
      if (method !== 'GetTurnDetail') return;
      object((result.messages as unknown[])[1]).retryable = false;
      (result.messages as unknown[]).push({
        messageId: 'later',
        turnId: 'failed-turn',
        role: 'MESSAGE_ROLE_AGENT',
        content: 'An explanation of the prior error.',
        ...(later === 'explanation' ? {} : { failCode: '5001' }),
        ...(later === 'classified' ? { failCategory: 'FAIL_CATEGORY_SYSTEM', retryable: true } : {}),
      });
    });
    const result = object(
      await resolveCanvasTurnPlan(f.client, {
        canvasId: 'canvas',
        sessionId: 'session',
        action: 'retry',
        sourceTurnId: 'failed-turn',
        sourceMessageId: 'user-message',
      }),
    );
    assert.equal(result.ready, later === 'classified', later);
  }
});
test('real generated-input history restores explicit original asset and node but its DONE turn cannot be retried', async () => {
  const sample = JSON.parse(
    await readFile(new URL('fixtures/canvas-generated-input-history.json', import.meta.url), 'utf8'),
  );
  const message = object(sample.messages[0]),
    original = object(JSON.parse(String(message.cardJson)).turnRefs[0]);
  assert.notEqual(object((message.attachments as unknown[])[0]).assetId, original.assetId);
  const attachments = historicalAttachments(message);
  assert.deepEqual(attachments, [{ assetId: original.assetId, nodeId: original.nodeId, kind: 'image/png' }]);
  const f = fixture((method, _body, result) => {
    if (method === 'GetSession') object(result.session).sessionId = sample.turn.sessionId;
    if (method === 'GetTurnDetail') {
      result.turn = sample.turn;
      result.messages = sample.messages;
    }
    if (method === 'GetCanvas') {
      const node = object((result.nodes as unknown[])[0]);
      node.id = original.nodeId;
      node.nodeAssets = [{ assetId: original.assetId, nodeId: original.nodeId }];
    }
    if (method === 'ListNodesAssets') {
      const node = object((result.nodes as unknown[])[0]);
      node.nodeId = original.nodeId;
      Object.assign(object((node.assets as unknown[])[0]), {
        assetId: original.assetId,
        nodeId: original.nodeId,
      });
    }
  });
  const result = object(
    await resolveCanvasTurnPlan(f.client, {
      canvasId: 'canvas',
      sessionId: sample.turn.sessionId,
      action: 'retry',
      sourceTurnId: sample.turn.turnId,
      sourceMessageId: message.messageId,
    }),
  );
  assert.equal(result.ready, false);
  assert.ok((result.reasons as string[]).includes('retry_source_not_failed'));
  assert.equal(result.parameters, null);
  assert.ok(!f.calls.includes('CreateTurn'));
  assert.ok(!f.calls.includes('BatchGetInputAssets'));
});
test('historical source order disambiguates only explicitly linked aliases and never guesses by array position', () => {
  const first = { assetId: 'source-a', nodeId: 'node-a', inputAssetId: 'input', order: 0 },
    second = { assetId: 'source-b', nodeId: 'node-b', inputAssetId: 'input', order: 1 },
    message = { attachments: [{ assetId: 'input' }, { assetId: 'input' }] };
  assert.deepEqual(
    historicalAttachments({ ...message, cardJson: JSON.stringify({ turnRefs: [second, first] }) }),
    [
      { assetId: 'source-a', nodeId: 'node-a' },
      { assetId: 'source-b', nodeId: 'node-b' },
    ],
  );
  for (const refs of [
    [
      { ...first, order: undefined },
      { ...second, order: undefined },
    ],
    [{ ...first, order: 3 }],
    [{ ...first, order: '0' }],
    [{ ...first, nodeId: undefined }],
  ])
    assert.throws(() => historicalAttachments({ ...message, cardJson: JSON.stringify({ turnRefs: refs }) }), {
      code: 'CONTRACT_CHANGED',
    });
  assert.deepEqual(
    historicalAttachments({
      attachments: [{ assetId: 'unlinked-input' }],
      cardJson: JSON.stringify({ turnRefs: [first] }),
    }),
    [{ assetId: 'unlinked-input' }],
  );
  assert.throws(
    () =>
      historicalAttachments({
        attachments: [{ assetId: 'same' }],
        cardJson: JSON.stringify({
          turnRefs: [
            { assetId: 'same', nodeId: 'one' },
            { assetId: 'same', nodeId: 'two' },
          ],
        }),
      }),
    { code: 'CONTRACT_CHANGED' },
  );
});
test('active running turn blocks new preparation, waiting card does not become an implicit answer', async () => {
  for (const state of ['TURN_STATUS_RUNNING', 'TURN_STATUS_WAITING_FOR_USER']) {
    const f = fixture((method, _body, result) => {
      if (method === 'GetSession') object(result.session).activeTurnId = 'active';
      if (method === 'GetTurnDetail') object(result.turn).status = state;
    });
    const result = object(await resolveCanvasTurnPlan(f.client, input));
    assert.equal(result.ready, state === 'TURN_STATUS_WAITING_FOR_USER');
    if (result.ready) assert.ok(!Object.hasOwn(object(result.parameters), 'selected_option_ids'));
  }
});
test('copied output IDs resolve only with supplied pre-save nodes and the exact already-saved revision', async () => {
  const copied = {
    id: 'copied',
    type: 'NODE_TYPE_GENERATE_IMAGE',
    nodeAssets: [{ assetId: 'copy-old', nodeId: 'origin', kind: 'ASSET_KIND_IMAGE', slotIndex: 0 }],
  };
  const request = {
    ...input,
    expectedRevision: '3',
    attachments: [{ assetId: 'copy-old', nodeId: 'copied' }],
    copiedNodes: [copied],
  };
  const result = object(await resolveCanvasTurnPlan(fixture().client, request));
  assert.equal(result.ready, true);
  assert.deepEqual(object(result.parameters).attachment_ids, ['copy-new']);
  assert.match(String(object(result.parameters).text), /\[Attachment: copy-old\]/);
  assert.deepEqual(result.asset_rebindings, [
    { node_id: 'copied', from_asset_id: 'copy-old', to_asset_id: 'copy-new' },
  ]);
  const boundary = object(
    await resolveCanvasTurnPlan(fixture().client, { ...request, text: 'a'.repeat(199999) }),
  );
  assert.equal(boundary.ready, true);
  assert.equal(boundary.character_count, 200000);
  assert.deepEqual(object(boundary.parameters).attachment_rebindings, result.asset_rebindings);
  assert.ok(
    canvasAgentSchemas.canvas_turn.safeParse({
      ...object(boundary.parameters),
      accept_variable_cost: true,
    }).success,
  );
  await assert.rejects(resolveCanvasTurnPlan(fixture().client, { ...request, expectedRevision: '2' }), {
    code: 'CANVAS_CHANGED',
  });
  assert.throws(() => turnPlanSchema.parse({ ...request, expectedRevision: undefined }));
});
test('raw submission persists saved-copy metadata locally while sending only current references and original text', async () => {
  const reads = fixture(),
    store = await jobFixture(),
    sent: Record<string, unknown>[] = [];
  const client = new StudioClient(reads.client.credentials, async (url, init) => {
    if (new Headers(init.headers).get('x-micro-method')?.endsWith('/CreateTurn')) {
      sent.push(JSON.parse(String(init.body)));
      return Response.json({ error: { code: 0 }, id: 'new-turn' });
    }
    return reads.client.fetcher(url, init);
  });
  try {
    const parameters = canvasAgentSchemas.canvas_turn.parse({
      session_id: 'session',
      text: 'a'.repeat(200000) + '[Attachment: copy-old]',
      refs: [{ asset_id: 'copy-new', node_id: 'copied' }],
      attachment_rebindings: [{ node_id: 'copied', from_asset_id: 'copy-old', to_asset_id: 'copy-new' }],
      accept_variable_cost: true,
    });
    const job = store.jobs.prepare('fixture', 'copied-boundary', 'canvas_turn', parameters, quote);
    assert.deepEqual(job.input.attachment_rebindings, parameters.attachment_rebindings);
    await submitCreativeTask(client, job);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.text, parameters.text);
    assert.deepEqual(sent[0]!.refs, [{ assetId: 'copy-new', nodeId: 'copied' }]);
    assert.deepEqual(sent[0]!.attachmentIds, ['copy-new']);
    assert.equal(sent[0]!.attachment_rebindings, undefined);
    assert.equal(sent[0]!.attachmentRebindings, undefined);
    assert.ok(reads.calls.includes('ListNodesAssets'));
  } finally {
    store.jobs.close();
    await rm(store.dir, { recursive: true, force: true });
  }
});
test('raw submission rechecks generated status and unique identity before any CreateTurn request', async () => {
  const store = await jobFixture();
  try {
    const parameters = canvasAgentSchemas.canvas_turn.parse({
      session_id: 'session',
      text: 'Inspect [Attachment: generated].',
      refs: [{ asset_id: 'generated', node_id: 'image' }],
      accept_variable_cost: true,
    });
    const job = store.jobs.prepare('fixture', 'generated-submit-guard', 'canvas_turn', parameters, quote);
    for (const mode of ['failed', 'processing', 'cancelled', 'duplicate-asset', 'duplicate-node'] as const) {
      const f = fixture((method, _body, result) => {
        if (method !== 'ListNodesAssets') return;
        const node = object((result.nodes as unknown[])[0]),
          asset = object((node.assets as unknown[])[0]);
        if (mode === 'failed') asset.status = 'ASSET_STATUS_FAILED';
        if (mode === 'processing') asset.studioState = 'STUDIO_ASSET_STATE_PROCESSING';
        if (mode === 'cancelled') asset.status = 'ASSET_STATUS_CANCELED';
        if (mode === 'duplicate-asset') (node.assets as unknown[]).push(structuredClone(asset));
        if (mode === 'duplicate-node') (result.nodes as unknown[]).push(structuredClone(node));
      });
      await assert.rejects(submitCreativeTask(f.client, job), { code: 'INPUT_NOT_READY' }, mode);
      assert.ok(!f.calls.includes('CreateTurn'));
    }
  } finally {
    store.jobs.close();
    await rm(store.dir, { recursive: true, force: true });
  }
});
test('account, session, graph and selected asset changes are detected during preparation', async () => {
  for (const mode of ['account', 'session', 'graph', 'asset'] as const) {
    const f = fixture((method, _body, result, count, credentials) => {
      if (mode === 'account' && method === 'GetCanvas')
        credentials.save({ ...credentials.load()!, accountRef: 'changed' });
      if (mode === 'session' && method === 'GetSession' && count === 2)
        object(result.session).mode = 'MODE_AUTO';
      if (mode === 'graph' && method === 'GetCanvas' && count === 2) object(result.canvas).revision = '4';
      if (mode === 'asset' && method === 'ListNodesAssets' && count === 2)
        object((object((result.nodes as unknown[])[0]).assets as unknown[])[0]).version = 2;
    });
    await assert.rejects(resolveCanvasTurnPlan(f.client, { ...input, attachments: [attachment] }), {
      code: mode === 'account' ? 'ACCOUNT_MISMATCH' : 'CANVAS_CHANGED',
    });
  }
});
test('wrong session ownership, removed nodes and a historical message changed during read fail closed', async () => {
  const ownership = fixture((method, _body, result) => {
    if (method === 'GetSession') object(result.session).canvasId = 'other';
  });
  await assert.rejects(resolveCanvasTurnPlan(ownership.client, input), { code: 'CONTRACT_CHANGED' });
  await assert.rejects(
    resolveCanvasTurnPlan(fixture().client, {
      ...input,
      attachments: [{ assetId: 'generated', nodeId: 'gone' }],
    }),
    { code: 'CANVAS_CHANGED' },
  );
  const history = fixture((method, _body, result, count) => {
    if (method === 'GetTurnDetail' && count === 2)
      object((result.messages as unknown[])[0]).content = 'Changed instruction';
  });
  await assert.rejects(
    resolveCanvasTurnPlan(history.client, {
      canvasId: 'canvas',
      sessionId: 'session',
      action: 'retry',
      sourceTurnId: 'failed-turn',
      sourceMessageId: 'user-message',
    }),
    { code: 'CANVAS_CHANGED' },
  );
});

test('rotating signed URLs do not change asset identity, while resource paths and business query parameters do', async () => {
  for (const mode of ['signature', 'path', 'query', 'unsigned-policy', 'unsigned-expires'] as const) {
    const f = fixture((method, _body, result, count) => {
      if (!['GetCanvas', 'ListNodesAssets'].includes(method)) return;
      const first = object((result.nodes as unknown[])[0]);
      const asset = object(((method === 'GetCanvas' ? first.nodeAssets : first.assets) as unknown[])[0]);
      const resource = mode === 'path' && count === 2 ? 'replaced.png' : 'image.png';
      const width = mode === 'query' && count === 2 ? 512 : 256;
      asset.url = `https://cdn.example/${resource}?width=${width}&Key-Pair-Id=fixture&Policy=expires-${count}&Signature=signature-${count}`;
      if (mode === 'unsigned-policy') asset.url = `https://cdn.example/image.png?policy=${count}`;
      if (mode === 'unsigned-expires') asset.url = `https://cdn.example/image.png?expires=${count}`;
    });
    const promise = resolveCanvasTurnPlan(f.client, { ...input, attachments: [attachment] });
    if (mode === 'signature') assert.equal(object(await promise).ready, true);
    else await assert.rejects(promise, { code: 'CANVAS_CHANGED' });
  }
});
test('historical prose remains exact even when it contains a signed resource URL', async () => {
  const f = fixture((method, _body, result, count) => {
    if (method === 'GetTurnDetail')
      object((result.messages as unknown[])[0]).content =
        `https://cdn.example/image.png?Signature=${count}&Policy=policy-${count}`;
  });
  await assert.rejects(
    resolveCanvasTurnPlan(f.client, {
      canvasId: 'canvas',
      sessionId: 'session',
      action: 'retry',
      sourceTurnId: 'failed-turn',
      sourceMessageId: 'user-message',
    }),
    { code: 'CANVAS_CHANGED' },
  );
});
