/** 新创作前的来源/状态校验和原回执恢复；全部网络响应均为隔离夹具。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { StudioClient } from '../studio/api/client.ts';
import { submitCreativeTask } from '../studio/api/canvas-agent.ts';
import { submitCanvasRun } from '../studio/api/canvas-run.ts';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { array, object, TripoError } from '../studio/contracts/errors.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import type { Job, Operation } from '../studio/contracts/types.ts';
import { fixture, quote } from './helpers.ts';
import { StudioGateway } from '../studio/api/gateway.ts';
import { MemoryLinks } from '../studio/auth/artifact-links.ts';

const turnInput = { accept_variable_cost: true, session_id: 'session', text: 'Inspect these inputs.' };
const answerInput = { accept_variable_cost: true, turn_id: 'turn', selected_option_ids: ['selected'] };
const runInput = { canvas_id: 'canvas', revision: '3', node_ids: ['target'] };
function job(operation: Operation, input: Record<string, unknown>): Job {
  return {
    job_id: 'job',
    request_id: 'new-request',
    account_ref: 'test-account',
    input_hash: 'input',
    operation,
    input: normalize(operation, input),
    contract_version: 'test',
    state: 'submitting',
    remote_ids: {},
    quote,
    progress: 0,
    artifacts: [],
    created_at: '',
    updated_at: '',
    lease_until: 0,
  };
}
function agentFixture(
  edit?: (method: string, result: Record<string, unknown>, credentials: MemoryCredentials) => void,
) {
  const credentials = new MemoryCredentials({
    accountRef: 'test-account',
    deviceId: 'device',
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
      GetSession: { session: { sessionId: 'session', canvasId: 'canvas' } },
      GetCanvas: {
        canvas: { canvasId: 'canvas', projectId: 'project' },
        nodes: [
          { id: 'upload', type: 'NODE_TYPE_UPLOAD_CARD', inputMount: [{ assetId: 'uploaded' }] },
          { id: 'generated', type: 'NODE_TYPE_GENERATE_IMAGE' },
        ],
      },
      BatchGetInputAssets: { assets: [{ assetId: 'uploaded', status: 'INPUT_ASSET_STATUS_READY' }] },
      ListNodesAssets: {
        nodes: [
          {
            nodeId: 'generated',
            assets: [{ assetId: 'output', nodeId: 'generated', url: 'https://cdn.tripo3d.ai/test.png' }],
          },
        ],
      },
      GetTurnDetail: {
        turn: { turnId: 'turn', requestId: 'original-create', status: 'TURN_STATUS_WAITING_FOR_USER' },
      },
      CreateTurn: { turnId: 'turn' },
      ContinueTurn: {},
      CreateRun: { runId: 'run' },
      CreateLabJob: { jobId: 'lab-job' },
    };
    assert.ok(Object.hasOwn(results, method), method);
    const result = results[method]!;
    edit?.(method, result, credentials);
    return Response.json({ error: { code: 0 }, ...result });
  }).forAccount('test-account');
  return { client, calls };
}
const writes = (calls: ReturnType<typeof agentFixture>['calls']) =>
  calls.filter(({ method }) => ['CreateTurn', 'ContinueTurn', 'CreateRun'].includes(method));

test('HolyMolly uses the webpage capability and ordinary verified material references without a graph run', async () => {
  const f = agentFixture((method, result) => {
    if (method === 'GetCanvas') array(result.nodes).push({ id: 'game', type: 'NODE_TYPE_HOLY_MOLLY' });
  });
  const input = {
    ...turnInput,
    text: 'Use [Attachment: uploaded] to adjust the game.',
    capabilities: ['holy_molly'],
    node_id: 'game',
    refs: [{ asset_id: 'uploaded', filename: 'reference.png', kind: 'image/png' }],
  };
  await submitCreativeTask(f.client, job('canvas_turn', input));
  assert.deepEqual(writes(f.calls), [
    {
      method: 'CreateTurn',
      body: {
        sessionId: 'session',
        text: input.text,
        mode: 'MODE_CONTROL',
        nodeId: 'game',
        capabilities: ['holy_molly'],
        attachmentIds: ['uploaded'],
        refs: [{ assetId: 'uploaded', filename: 'reference.png', kind: 'image/png' }],
      },
    },
  ]);
  assert.ok(f.calls.some(({ method }) => method === 'BatchGetInputAssets'));
  assert.equal(
    f.calls.some(({ method }) => method === 'CreateRun'),
    false,
  );
});

test('new HolyMolly requests can omit a target node; ordinary messages do not acquire a capability', async () => {
  const f = agentFixture();
  await submitCreativeTask(f.client, job('canvas_turn', { ...turnInput, capabilities: ['holy_molly'] }));
  assert.deepEqual(writes(f.calls)[0]!.body.capabilities, ['holy_molly']);
  assert.equal(writes(f.calls)[0]!.body.nodeId, '');
  const ordinary = agentFixture();
  await submitCreativeTask(ordinary.client, job('canvas_turn', turnInput));
  assert.equal(Object.hasOwn(writes(ordinary.calls)[0]!.body, 'capabilities'), false);
  const empty = agentFixture();
  await submitCreativeTask(empty.client, job('canvas_turn', { ...turnInput, capabilities: [] }));
  assert.equal(Object.hasOwn(writes(empty.calls)[0]!.body, 'capabilities'), false);
});

test('empty HolyMolly reference submissions require the exact saved game type before any write', async () => {
  for (const type of ['NODE_TYPE_HOLY_MOLLY', 'NODE_TYPE_GENERATE_IMAGE']) {
    const f = agentFixture((method, result) => {
      if (method === 'GetCanvas') array(result.nodes).push({ id: 'game', type });
    });
    const request = job('canvas_turn', {
      ...turnInput,
      text: '',
      node_id: 'game',
      capabilities: ['holy_molly'],
    });
    if (type === 'NODE_TYPE_HOLY_MOLLY') {
      await submitCreativeTask(f.client, request);
      assert.equal(writes(f.calls)[0]!.body.text, '');
      assert.equal(writes(f.calls)[0]!.body.nodeId, 'game');
    } else {
      await assert.rejects(submitCreativeTask(f.client, request), {
        code: 'INVALID_INPUT',
        certainty: 'not_submitted',
      });
      assert.equal(writes(f.calls).length, 0);
    }
  }
});

function runFixture(mismatch = '') {
  return agentFixture((method, result) => {
    if (method === 'GetCanvas') {
      result.canvas = { canvasId: 'canvas', revision: '3' };
      if (mismatch === 'canvas') object(result.canvas).canvasId = 'other-canvas';
      if (mismatch === 'missing-canvas') delete object(result.canvas).canvasId;
      result.nodes = [
        { id: 'lab', type: 'NODE_TYPE_AI_3D_LAB' },
        { id: 'target', type: 'NODE_TYPE_RIGGING' },
      ];
      result.edges = [{ id: 'edge', source: { nodeId: 'lab' }, target: { nodeId: 'target', port: 'model' } }];
    }
    if (method === 'ListNodesAssets') {
      const asset: Record<string, unknown> = {
        nodeId: 'lab',
        assetId: 'asset',
        url: 'https://cdn.tripo3d.ai/test.glb',
        selected: true,
        kind: 'ASSET_KIND_MODEL',
        role: 'ASSET_ROLE_CURRENT',
        source: 'ASSET_SOURCE_STUDIO',
        studioState: 'STUDIO_ASSET_STATE_READY',
      };
      if (mismatch === 'missing-asset-id') delete asset.assetId;
      if (mismatch === 'asset-node') asset.nodeId = 'different-lab';
      const node = { nodeId: 'lab', assets: [asset] };
      if (mismatch === 'duplicate-asset') node.assets.push(structuredClone(asset));
      result.nodes = mismatch === 'missing-node' ? [] : [node];
      if (mismatch === 'duplicate-node') array(result.nodes).push(structuredClone(node));
    }
  });
}

test('run submission binds the exact canvas and unique Lab output identities before CreateRun', async () => {
  for (const mismatch of [
    '',
    'canvas',
    'missing-canvas',
    'missing-node',
    'duplicate-node',
    'duplicate-asset',
    'missing-asset-id',
    'asset-node',
  ]) {
    const f = runFixture(mismatch),
      pending = submitCanvasRun(f.client, job('canvas_run', runInput));
    if (!mismatch) {
      assert.deepEqual(await pending, { remote_ids: { task_id: 'run' } });
      assert.deepEqual(writes(f.calls)[0]!.body, {
        canvasId: 'canvas',
        nodeIds: ['target'],
        idempotencyKey: 'job',
        includeCompleted: true,
        mode: 'MODE_CONTROL',
        origin: 'RUN_ORIGIN_CANVAS',
      });
    } else
      await assert.rejects(pending, {
        code: ['missing-node', 'duplicate-node'].includes(mismatch) ? 'INPUT_NOT_READY' : 'CONTRACT_CHANGED',
      });
    assert.equal(writes(f.calls).length, mismatch ? 0 : 1);
  }
});

test('independent attachments require exactly one ready current-project input for both request forms', async () => {
  for (const form of ['refs', 'ids']) {
    for (const state of ['ready', 'missing', 'processing', 'duplicate', 'wrong-id']) {
      const f = agentFixture((method, result) => {
        if (method !== 'BatchGetInputAssets') return;
        if (state === 'missing') result.assets = [];
        if (state === 'processing') object(array(result.assets)[0]).status = 'INPUT_ASSET_STATUS_PROCESSING';
        if (state === 'duplicate') array(result.assets).push(structuredClone(array(result.assets)[0]));
        if (state === 'wrong-id') object(array(result.assets)[0]).assetId = 'other';
      });
      const input = {
        ...turnInput,
        ...(form === 'refs' ? { refs: [{ asset_id: 'uploaded' }] } : { attachment_ids: ['uploaded'] }),
      };
      if (state === 'ready') {
        await submitCreativeTask(f.client, job('canvas_turn', input));
        assert.equal(writes(f.calls).length, 1);
        assert.equal(Object.hasOwn(writes(f.calls)[0]!.body, 'refs'), form === 'refs');
      } else {
        await assert.rejects(submitCreativeTask(f.client, job('canvas_turn', input)), {
          code: 'INPUT_NOT_READY',
          certainty: 'not_submitted',
        });
        assert.equal(writes(f.calls).length, 0);
      }
      assert.deepEqual(f.calls.find(({ method }) => method === 'BatchGetInputAssets')!.body, {
        projectId: 'project',
        assetIds: ['uploaded'],
      });
    }
  }
});

test('missing project identity and ambiguous upload mounts or source nodes stop before creation', async () => {
  for (const mismatch of ['project', 'mount', 'source']) {
    const f = agentFixture((method, result) => {
      if (method !== 'GetCanvas') return;
      const nodes = array(result.nodes),
        upload = object(nodes[0]);
      if (mismatch === 'project') delete object(result.canvas).projectId;
      if (mismatch === 'mount') array(upload.inputMount).push({ assetId: 'uploaded' });
      if (mismatch === 'source') nodes.push(structuredClone(upload));
    });
    await assert.rejects(
      submitCreativeTask(
        f.client,
        job('canvas_turn', {
          ...turnInput,
          refs: [{ asset_id: 'uploaded', node_id: 'upload' }],
        }),
      ),
      { code: mismatch === 'project' ? 'CONTRACT_CHANGED' : 'CANVAS_CHANGED', certainty: 'not_submitted' },
    );
    assert.equal(writes(f.calls).length, 0);
    assert.equal(
      f.calls.some(({ method }) => method === 'BatchGetInputAssets'),
      false,
    );
  }
});

test('an explicit message target must be uniquely present in its session canvas', async () => {
  for (const target of ['valid', 'missing', 'duplicate']) {
    const f = agentFixture((method, result) => {
      if (method === 'GetCanvas' && target === 'duplicate')
        array(result.nodes).push(structuredClone(array(result.nodes)[1]));
    });
    const pending = submitCreativeTask(
      f.client,
      job('canvas_turn', {
        ...turnInput,
        node_id: target === 'missing' ? 'other-canvas-node' : 'generated',
      }),
    );
    if (target === 'valid') {
      await pending;
      assert.equal(writes(f.calls)[0]!.body.nodeId, 'generated');
    } else await assert.rejects(pending, { code: 'CANVAS_CHANGED', certainty: 'not_submitted' });
    assert.equal(writes(f.calls).length, target === 'valid' ? 1 : 0);
  }
});

test('plain messages keep the original no-attachment request without unnecessary graph reads', async () => {
  const f = agentFixture();
  await submitCreativeTask(f.client, job('canvas_turn', turnInput));
  assert.deepEqual(
    f.calls.map(({ method }) => method),
    ['CreateTurn'],
  );
});

test('only a waiting turn accepts a new continuation, without changing the original answer payload', async () => {
  for (const status of [
    'TURN_STATUS_WAITING_FOR_USER',
    'TURN_STATUS_DONE',
    'TURN_STATUS_RUNNING',
    'TURN_STATUS_CANCELLED',
    'TURN_STATUS_FAILED',
    'TURN_STATUS_UNKNOWN',
    undefined,
  ]) {
    const f = agentFixture((method, result) => {
      if (method === 'GetTurnDetail') object(result.turn).status = status;
    });
    const waiting = status === 'TURN_STATUS_WAITING_FOR_USER',
      input = { ...answerInput, other_text: 'keep this text', attachment_ids: ['uploaded'] };
    if (waiting) {
      await submitCreativeTask(f.client, job('canvas_continue', input));
      assert.deepEqual(writes(f.calls)[0]!.body, {
        turnId: 'turn',
        requestId: 'job',
        selectedOptionIds: ['selected'],
        otherText: 'keep this text',
        attachmentIds: ['uploaded'],
      });
    } else
      await assert.rejects(submitCreativeTask(f.client, job('canvas_continue', input)), {
        code: 'TURN_NOT_WAITING',
        certainty: 'not_submitted',
      });
    assert.equal(writes(f.calls).length, waiting ? 1 : 0);
  }
});

test('account changes at every attachment or continuation read boundary never reach a write', async () => {
  for (const boundary of [
    'GetSession',
    'GetCanvas',
    'BatchGetInputAssets',
    'ListNodesAssets',
    'GetTurnDetail',
  ]) {
    const f = agentFixture((method, _result, credentials) => {
      if (method === boundary) credentials.save({ ...credentials.load()!, accountRef: 'other-account' });
    });
    const continuation = boundary === 'GetTurnDetail',
      task = continuation
        ? job('canvas_continue', answerInput)
        : job('canvas_turn', {
            ...turnInput,
            refs: [{ asset_id: 'uploaded' }, { asset_id: 'output', node_id: 'generated' }],
          });
    await assert.rejects(submitCreativeTask(f.client, task), {
      code: 'ACCOUNT_MISMATCH',
      certainty: 'not_submitted',
    });
    assert.equal(writes(f.calls).length, 0);
  }
});

test('an interrupted CreateTurn remains unknown after successful attachment checks', async () => {
  const f = agentFixture((method) => {
    if (method === 'CreateTurn') throw new TypeError('Fixture transport interrupted after submission.');
  });
  await assert.rejects(
    submitCreativeTask(
      f.client,
      job('canvas_turn', {
        ...turnInput,
        attachment_ids: ['uploaded'],
      }),
    ),
    { code: 'NETWORK_ERROR', certainty: 'unknown' },
  );
  assert.equal(writes(f.calls).length, 1);
});

test('persisted turn, answer and run requests resume unchanged without rechecking current inputs or resubmitting', async () => {
  const store = await fixture();
  try {
    for (const operation of ['canvas_turn', 'canvas_continue', 'canvas_run'] as const) {
      for (const state of ['submitted', 'succeeded', 'outcome_unknown'] as const) {
        const parameters =
          operation === 'canvas_turn'
            ? { ...turnInput, attachment_ids: ['uploaded'] }
            : operation === 'canvas_continue'
              ? answerInput
              : runInput;
        const f = operation === 'canvas_run' ? runFixture() : agentFixture(),
          requestId = `${operation}-${state}`;
        store.gateway.submit = async (task) => {
          store.gateway.posts++;
          return operation === 'canvas_run'
            ? submitCanvasRun(f.client, task)
            : submitCreativeTask(f.client, task);
        };
        const first = await store.service.submit(operation, requestId, parameters, 10),
          jobId = String(first.job_id);
        assert.equal(first.state, 'submitted');
        store.jobs.update(jobId, state);
        const calls = f.calls.length,
          writesBefore = store.gateway.posts;
        store.gateway.submit = async () => assert.fail('A saved request must not execute again.');
        store.gateway.account = async () =>
          assert.fail('Resume must not re-read the current sources or budget.');
        const resumed = await store.service.submit(operation, requestId, parameters, 10);
        assert.equal(resumed.job_id, jobId);
        assert.equal(resumed.state, state);
        assert.deepEqual(resumed.remote_ids, { task_id: operation === 'canvas_run' ? 'run' : 'turn' });
        assert.equal(f.calls.length, calls);
        assert.equal(store.gateway.posts, writesBefore);
        // The next independent new request still needs its normal budget check.
        store.gateway.account = async () => ({
          authenticated: true,
          balance: 100,
          account_ref: 'test-account',
        });
      }
    }
  } finally {
    store.jobs.close();
    await rm(store.dir, { recursive: true, force: true });
  }
});

test('Canvas writes recheck the durable submission claim after preparation and authentication', async () => {
  for (const operation of ['canvas_turn', 'canvas_continue', 'canvas_lab', 'canvas_run'] as const) {
    const f = operation === 'canvas_run' ? runFixture() : agentFixture();
    const parameters =
      operation === 'canvas_run'
        ? runInput
        : operation === 'canvas_continue'
          ? answerInput
          : operation === 'canvas_lab'
            ? { accept_variable_cost: true, node_id: 'lab', prompt: 'Inspect the supplied model.' }
            : { ...turnInput, attachment_ids: ['uploaded'] };
    const gateway = new StudioGateway(f.client, [], new MemoryLinks());
    let claims = 0;
    await assert.rejects(
      gateway.submit(job(operation, parameters), () => {
        claims++;
        if (claims === 2)
          throw new TripoError(
            'SUBMISSION_IDENTITY_CHANGED',
            'Synthetic claim changed during preparation.',
            'not_submitted',
          );
      }),
      { code: 'SUBMISSION_IDENTITY_CHANGED', certainty: 'not_submitted' },
    );
    assert.equal(claims, 2);
    assert.equal(
      f.calls.some(({ method }) =>
        ['CreateTurn', 'ContinueTurn', 'CreateLabJob', 'CreateRun'].includes(method),
      ),
      false,
    );
    if (operation !== 'canvas_lab') assert.ok(f.calls.length > 0);
  }
});
