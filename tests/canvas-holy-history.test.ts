/** Holy history and explicit local redo are different sources of intent; no live Studio calls. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { StudioClient } from '../studio/api/client.ts';
import { resolveCanvasTurnPlan } from '../studio/api/canvas-turn-plan.ts';
import { historicalAttachments } from '../studio/api/canvas-turn-history.ts';
import { redoPlan } from '../cli/compat/redo.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import { object } from '../studio/contracts/errors.ts';
import type { Job, Operation } from '../studio/contracts/types.ts';

const sessionId = 'history-session';
const canvasId = 'history-canvas';
const gameId = 'existing-game';
const sourceTurnId = 'failed-turn';
const sourceMessageId = 'failed-user-message';

function historyFixture(kind: 'sole-node' | 'ordinary-ref' | 'literal-marker') {
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
  const source = {
    messageId: sourceMessageId,
    turnId: sourceTurnId,
    role: 'MESSAGE_ROLE_USER',
    content: kind === 'literal-marker' ? `Change [Attachment: ${gameId}].` : 'Change the game.',
    attachments:
      kind === 'ordinary-ref' ? [{ assetId: 'game-html', type: 'text/html', name: 'index.html' }] : [],
    cardJson: JSON.stringify({
      capabilities: ['holy_molly'],
      ...(kind === 'ordinary-ref' ? { turnRefs: [{ assetId: 'game-html', nodeId: gameId }] } : {}),
    }),
  };
  const calls: string[] = [];
  const client = new StudioClient(credentials, async (_url, init) => {
    const method = new Headers(init.headers).get('x-micro-method')!.split('/').at(-1)!;
    calls.push(method);
    const results: Record<string, unknown> = {
      GetSession: {
        session: { sessionId, canvasId, status: 'SESSION_STATUS_ACTIVE', activeTurnId: '' },
        messages: [],
      },
      GetCanvas: {
        canvas: { canvasId, projectId: 'project', revision: '7' },
        nodes: [{ id: gameId, type: 'NODE_TYPE_HOLY_MOLLY' }],
      },
      GetTurnDetail: {
        turn: { turnId: sourceTurnId, sessionId, status: 'TURN_STATUS_FAILED' },
        messages: [
          source,
          {
            messageId: 'failure',
            turnId: sourceTurnId,
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
            nodeId: gameId,
            assets: [{ assetId: 'game-html', nodeId: gameId, url: 'https://cdn.example/index.html' }],
          },
        ],
      },
    };
    assert.ok(Object.hasOwn(results, method), 'Only exact read-only preparation calls: ' + method);
    return Response.json({ error: { code: 0 }, ...object(results[method]) });
  });
  return { client, calls, source };
}

test('ordinary Holy HTML refs, literal markers and the sole current game cannot recover a historical target', async () => {
  for (const kind of ['sole-node', 'ordinary-ref', 'literal-marker'] as const) {
    const f = historyFixture(kind);
    if (kind === 'ordinary-ref')
      assert.deepEqual(historicalAttachments(f.source), [
        { assetId: 'game-html', nodeId: gameId, filename: 'index.html', kind: 'text/html' },
      ]);
    const result = object(
      await resolveCanvasTurnPlan(f.client, {
        canvasId,
        sessionId,
        action: 'retry',
        sourceTurnId,
        sourceMessageId,
      }),
    );
    assert.equal(result.ready, false, kind);
    assert.equal(result.parameters, null, kind);
    assert.deepEqual(result.reasons, ['retry_holy_molly_target_unknown'], kind);
    assert.deepEqual(result.source_capabilities, ['holy_molly']);
    assert.equal(f.calls.includes('CreateTurn'), false);
  }
});

function storedJob(operation: Operation, input: Record<string, unknown>): Job {
  return {
    job_id: 'exact-local-job',
    account_ref: 'fixture',
    request_id: 'original-request',
    input_hash: 'fixture-hash',
    operation,
    input: normalize(operation, input),
    contract_version: 'fixture',
    state: 'failed',
    remote_ids: { task_id: sourceTurnId },
    quote: {
      known: false,
      variable: true,
      source: 'fixture',
      hard_limit: false,
      explanation: 'New creation may consume credits.',
      observed_at: '',
      expires_at: '',
    },
    progress: 0,
    artifacts: [],
    created_at: '',
    updated_at: '',
    lease_until: 0,
  };
}

test('explicit redo of an exact local Holy turn preserves both new-game and targeted-modification intent', () => {
  for (const node_id of [undefined, gameId]) {
    const original = storedJob('canvas_turn', {
      accept_variable_cost: true,
      session_id: sessionId,
      text: 'Keep the exact request.',
      capabilities: ['holy_molly'],
      ...(node_id ? { node_id } : {}),
      refs: [{ asset_id: 'reference', node_id: 'image-node', filename: 'reference.png', kind: 'image/png' }],
    });
    for (const state of ['failed', 'succeeded'] as const) {
      const plan = redoPlan({ ...original, state });
      assert.equal(plan.steps.length, 1);
      assert.equal(plan.steps[0]!.operation, 'canvas_turn');
      assert.deepEqual(plan.steps[0]!.parameters, original.input);
      assert.equal(Object.hasOwn(plan.steps[0]!.parameters, 'node_id'), node_id !== undefined);
      assert.equal(Object.hasOwn(plan.steps[0]!.parameters, 'request_id'), false);
      assert.equal(Object.hasOwn(plan.steps[0]!.parameters, 'turn_id'), false);
      assert.deepEqual(original.remote_ids, { task_id: sourceTurnId });
    }
    for (const state of [
      'prepared',
      'submitting',
      'submitted',
      'running',
      'waiting_input',
      'requires_login',
      'outcome_unknown',
    ] as const)
      assert.throws(() => redoPlan({ ...original, state }), { code: 'INPUT_NOT_READY' });
    assert.throws(() => redoPlan(original, 123), { code: 'STUDIO_CAPABILITY_UNAVAILABLE' });
  }
});

test('redo of node control discards private preparation but cannot silently choose a replacement run or revision', () => {
  for (const operation of ['canvas_node_stop', 'canvas_node_retry'] as const) {
    const original = storedJob(operation, {
      canvas_id: canvasId,
      node_id: gameId,
      expected_run_id: 'original-run',
      revision: '7',
      ...(operation === 'canvas_node_retry' ? { accept_variable_cost: true } : {}),
    });
    const input = structuredClone(original.input);
    original.input._node_execution = {
      action: operation === 'canvas_node_stop' ? 'stop' : 'retry',
      source_turn_id: sourceTurnId,
      session_id: sessionId,
    };
    const plan = redoPlan(original);
    assert.deepEqual(plan.steps[0]!.parameters, input);
    assert.equal(Object.hasOwn(plan.steps[0]!.parameters, '_node_execution'), false);
    assert.equal(original.input._node_execution !== undefined, true);
    assert.throws(() => redoPlan({ ...original, state: 'outcome_unknown' }), { code: 'INPUT_NOT_READY' });
  }
});
