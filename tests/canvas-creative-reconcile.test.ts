/** Unknown creative writes cannot be matched by guessed IDs; exact recorded receipts remain readable. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { fixture, quote } from './helpers.ts';
import { creativeDetail } from '../studio/api/canvas-agent.ts';
import { StudioClient } from '../studio/api/client.ts';
import { StudioGateway } from '../studio/api/gateway.ts';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { MemoryLinks } from '../studio/auth/artifact-links.ts';
import { object, TripoError } from '../studio/contracts/errors.ts';
import { normalize } from '../studio/contracts/schemas.ts';

const inputs = {
  canvas_turn: { accept_variable_cost: true, session_id: 'session', text: 'Make a game.' },
  canvas_continue: { accept_variable_cost: true, turn_id: 'turn', selected_option_ids: ['confirm'] },
  canvas_lab: { accept_variable_cost: true, node_id: 'lab-node', prompt: 'Inspect this model.' },
} as const;

for (const operation of ['canvas_turn', 'canvas_continue', 'canvas_lab'] as const)
  test(`${operation}: a lost receipt survives restart without guessing an ID or resubmitting`, async () => {
    const f = await fixture();
    f.gateway.failSubmit = new TripoError('NETWORK_ERROR', 'Synthetic lost receipt.', 'unknown');
    const first = await f.service.submit(operation, 'unknown-creative', inputs[operation], 10);
    assert.equal(first.state, 'outcome_unknown');
    assert.equal(f.gateway.posts, 1);
    f.jobs.close();
    const resumed = await fixture(f.dir);
    try {
      resumed.gateway.status = async () => assert.fail('Guessed IDs must not even be queried.');
      resumed.gateway.submit = async () => assert.fail('An unknown write must not be sent again.');
      const restored = await resumed.service.submit(operation, 'unknown-creative', inputs[operation], 10);
      assert.equal(restored.job_id, first.job_id);
      assert.equal(restored.state, 'outcome_unknown');
      const id = String(first.job_id),
        before = resumed.jobs.get(id);
      // Even the original turn ID cannot prove that an unknown ContinueTurn answer was accepted.
      for (const task_id of ['turn', 'other-existing-turn', 'unrelated-lab'])
        await assert.rejects(resumed.service.reconcile(id, { task_id }), {
          code: 'RECONCILE_UNVERIFIABLE',
        });
      assert.deepEqual(resumed.jobs.get(id), before);
      assert.equal(resumed.gateway.posts, 0);
      assert.equal((await resumed.service.get(id)).state, 'outcome_unknown');
    } finally {
      resumed.jobs.close();
      await rm(f.dir, { recursive: true, force: true });
    }
  });

function readFixture() {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const response: Record<string, unknown> = { sessionId: 'session', status: 'TURN_STATUS_DONE' };
  const client = new StudioClient(
    new MemoryCredentials({
      accountRef: 'test-account',
      deviceId: 'synthetic-device',
      importedAt: '',
      bearer:
        'eyJhbGciOiJIUzI1NiJ9.' +
        Buffer.from(
          JSON.stringify({ sub: 'test-account', exp: Math.floor(Date.now() / 1000) + 3600 }),
        ).toString('base64url') +
        '.fixture',
    }),
    async (_url, init) => {
      const method = new Headers(init.headers).get('x-micro-method')!.split('/').at(-1)!;
      const body = object(JSON.parse(String(init.body)));
      calls.push({ method, body });
      if (method === 'GetLabJob')
        return Response.json({ error: { code: 0 }, jobId: body.jobId, status: 'completed', artifacts: [] });
      assert.equal(method, 'GetTurnDetail');
      return Response.json({ error: { code: 0 }, turn: { turnId: body.turnId, ...response }, messages: [] });
    },
  );
  return { client, calls, response };
}

test('recorded original creative receipts still query to completion without manual reconciliation', async () => {
  const f = await fixture(),
    remote = readFixture();
  f.service.gateway = new StudioGateway(remote.client, [], new MemoryLinks());
  try {
    for (const operation of ['canvas_turn', 'canvas_continue', 'canvas_lab'] as const) {
      const input = normalize(operation, inputs[operation]),
        saved = f.jobs.prepare('test-account', operation, operation, input, quote),
        task_id = operation === 'canvas_lab' ? 'lab-job' : 'turn';
      f.jobs.update(saved.job_id, 'submitted', { remote_ids: { task_id } });
      const result = await f.service.get(saved.job_id);
      assert.equal(result.state, 'succeeded');
      assert.deepEqual(result.remote_ids, { task_id });
      const readCount = remote.calls.length;
      const restored = await f.service.submit(operation, operation, inputs[operation], 10);
      assert.equal(restored.job_id, saved.job_id);
      assert.equal(restored.state, 'succeeded');
      assert.equal(remote.calls.length, readCount);
      await assert.rejects(f.service.reconcile(saved.job_id, { task_id: 'another' }), {
        code: 'RECONCILE_NOT_NEEDED',
      });
    }
    assert.ok(remote.calls.every(({ method }) => ['GetTurnDetail', 'GetLabJob'].includes(method)));
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('prepared and known not-submitted creative requests remain separate from unknown receipts', async () => {
  const f = await fixture();
  try {
    const saved = f.jobs.prepare('test-account', 'prepared', 'canvas_turn', inputs.canvas_turn, quote);
    await assert.rejects(f.service.reconcile(saved.job_id, { task_id: 'turn' }), {
      code: 'RECONCILE_NOT_NEEDED',
    });
    assert.equal(f.jobs.get(saved.job_id).state, 'prepared');
    f.gateway.failSubmit = new TripoError(
      'TURN_NOT_WAITING',
      'Synthetic preflight refusal.',
      'not_submitted',
    );
    const failed = await f.service.submit('canvas_continue', 'not-sent', inputs.canvas_continue, 10);
    assert.equal(failed.state, 'failed');
    await assert.rejects(f.service.reconcile(String(failed.job_id), { task_id: 'turn' }), {
      code: 'RECONCILE_NOT_NEEDED',
    });
    assert.equal(f.jobs.get(String(failed.job_id)).error?.certainty, 'not_submitted');
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('continuation reads reject another remote turn before a query is sent', async () => {
  const f = await fixture(),
    remote = readFixture();
  try {
    const saved = f.jobs.prepare('test-account', 'answer', 'canvas_continue', inputs.canvas_continue, quote);
    for (const task_id of [undefined, '', 'other-turn'])
      await assert.rejects(creativeDetail(remote.client, { ...saved, remote_ids: { task_id } }), {
        code: 'CONTRACT_CHANGED',
      });
    assert.deepEqual(remote.calls, []);
    assert.equal(
      (await creativeDetail(remote.client, { ...saved, remote_ids: { task_id: 'turn' } })).turnId,
      'turn',
    );
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('a recorded CreateTurn receipt requires its exact session, including when the response omits it', async () => {
  const f = await fixture(),
    remote = readFixture();
  try {
    const saved = f.jobs.prepare('test-account', 'message', 'canvas_turn', inputs.canvas_turn, quote);
    for (const sessionId of [undefined, '', 'other-session']) {
      remote.response.sessionId = sessionId;
      await assert.rejects(creativeDetail(remote.client, { ...saved, remote_ids: { task_id: 'turn' } }), {
        code: 'CONTRACT_CHANGED',
      });
    }
    remote.response.sessionId = 'session';
    assert.equal(
      (await creativeDetail(remote.client, { ...saved, remote_ids: { task_id: 'turn' } })).sessionId,
      'session',
    );
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
