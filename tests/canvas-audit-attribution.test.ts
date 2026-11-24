/** Synthetic service-chain proofs; no credentials, account records or live generation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { StudioClient } from '../studio/api/client.ts';
import { auditCanvas } from '../studio/api/canvas-audit.ts';
import { array, object } from '../studio/contracts/errors.ts';

type RecordValue = Record<string, unknown>;
type Edit = (
  method: string,
  response: RecordValue,
  count: number,
  body: RecordValue,
  credentials: MemoryCredentials,
) => void;
const identities: Record<string, { step: string; task: string }> = {
  game: {
    step: '11111111-1111-4111-8111-111111111111',
    task: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  },
  previous: {
    step: '22222222-2222-4222-8222-222222222222',
    task: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  },
  other: {
    step: '33333333-3333-4333-8333-333333333333',
    task: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  },
};
const storageOrigin = 'https://tripo-data.fixture.data.tripo3d.com';
const holyUrl = (nodeId = 'game') =>
  `${storageOrigin}/canvas/holymolly/100000000000000000/${identities[nodeId]!.step}/${'a'.repeat(64)}/index.html`;
const imageUrl = (nodeId = 'game') =>
  `${storageOrigin}/generate-image/20260101/${identities[nodeId]!.task}/image.png`;
type ModelType = 'hd' | 'texture';
const modelNodeType = (type: ModelType) =>
  type === 'hd' ? 'NODE_TYPE_GENERATE_HD_MODEL' : 'NODE_TYPE_TEXTURE';
const modelUrl = (type: ModelType, directoryNodeId = 'game', filenameNodeId = directoryNodeId) =>
  `${storageOrigin}/tripo-studio/20260101/${identities[directoryNodeId]!.task}/tripo_${type === 'hd' ? 'base_model' : 'texture'}_${identities[filenameNodeId]!.task}_meshopt.glb`;
const request = {
  canvasId: 'canvas',
  turnId: 'turn',
  nodeIds: ['game'],
  expect: [{ nodeId: 'game', kind: 'html', assetIds: ['html'] }],
};
function graphNode(nodeId = 'game', assetId = 'html') {
  return {
    id: nodeId,
    type: 'NODE_TYPE_HOLY_MOLLY',
    params: { hm_phase: 'ready' },
    nodeAssets: [{ assetId, selected: true, url: `${holyUrl(nodeId)}?signature=synthetic` }],
  };
}
function nodeRun(nodeId = 'game', assetId = 'html') {
  return {
    nodeId,
    runId: `run-${nodeId}`,
    currentStepId: identities[nodeId]!.step,
    selectedAssetId: assetId,
    status: 'NODE_STATUS_DONE',
    credits: { status: 'NODE_CREDITS_STATUS_PENDING', points: '32' },
  };
}
function output(nodeId = 'game', assetId = 'html') {
  return {
    nodeId,
    assets: [
      {
        assetId,
        nodeId,
        selected: true,
        role: 'ASSET_ROLE_CURRENT',
        source: 'ASSET_SOURCE_STUDIO',
        kind: 'ASSET_KIND_UNSPECIFIED',
        studioState: 'STUDIO_ASSET_STATE_UNSPECIFIED',
        url: `${holyUrl(nodeId)}?signature=synthetic`,
      },
    ],
  };
}
function fixture(edit?: Edit) {
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
  const calls: { method: string; body: RecordValue }[] = [];
  const client = new StudioClient(credentials, async (_url, init) => {
    const method = new Headers(init.headers).get('x-micro-method')!.split('/').at(-1)!;
    const body = object(JSON.parse(String(init.body)));
    const nodeId = String(body.runId ?? 'run-game').replace(/^run-/, '');
    const responses: Record<string, RecordValue> = {
      GetCanvas: {
        canvas: { canvasId: 'canvas', projectId: 'project', revision: '3' },
        nodes: [graphNode()],
        edges: [],
        nodeRuns: [nodeRun()],
      },
      GetRun: {
        run: {
          runId: body.runId,
          canvasId: 'canvas',
          turnId: 'turn',
          scope: 'RUN_SCOPE_NODE',
          origin: 'RUN_ORIGIN_CHAT',
          status: 'RUN_STATUS_SUCCEEDED',
          nodeIds: [nodeId],
          steps: [
            {
              stepId: identities[nodeId]!.step,
              nodeId,
              taskId: identities[nodeId]!.task,
              status: 'RUN_STEP_STATUS_DONE',
              retryNo: 0,
              seqNo: 1,
              failCode: '',
            },
          ],
        },
      },
      GetTurnDetail: {
        turn: { turnId: 'turn', sessionId: 'session', status: 'TURN_STATUS_DONE' },
        messages: [
          { messageId: 'message', turnId: 'turn', content: 'Everything succeeded and all costs settled.' },
        ],
      },
      GetSession: { session: { sessionId: 'session', canvasId: 'canvas', activeTurnId: '' } },
      ListNodesAssets: { nodes: [output()] },
    };
    assert.ok(Object.hasOwn(responses, method), 'Only observed read RPCs are permitted: ' + method);
    calls.push({ method, body });
    const response = responses[method]!;
    edit?.(method, response, calls.filter((call) => call.method === method).length, body, credentials);
    return Response.json({ error: { code: 0 }, ...response });
  });
  return { client, calls };
}
const node = (result: RecordValue) => object(array(result.nodes)[0]);
const asset = (result: RecordValue) => object(array(node(result).assets)[0]);
const savedAsset = (result: RecordValue) => object(array(node(result).nodeAssets)[0]);
const current = (result: RecordValue) => object(array(result.nodeRuns)[0]);
const step = (result: RecordValue) => object(array(object(result.run).steps)[0]);
function originalFixture(type: 'image' | 'html', url: string, edit?: Edit) {
  return fixture((method, response, count, body, credentials) => {
    if (method === 'GetCanvas') {
      node(response).type = type === 'image' ? 'NODE_TYPE_GENERATE_IMAGE' : 'NODE_TYPE_HOLY_MOLLY';
      savedAsset(response).url = url;
    }
    if (method === 'ListNodesAssets') {
      asset(response).url = url;
      if (type === 'image') {
        asset(response).kind = 'ASSET_KIND_IMAGE';
        asset(response).role = 'ASSET_ROLE_CANDIDATE';
      }
    }
    edit?.(method, response, count, body, credentials);
  });
}
function modelFixture(type: ModelType, url = modelUrl(type), edit?: Edit) {
  return originalFixture('html', url, (method, response, count, body, credentials) => {
    if (method === 'GetCanvas') node(response).type = modelNodeType(type);
    if (method === 'ListNodesAssets') asset(response).kind = 'ASSET_KIND_MODEL';
    edit?.(method, response, count, body, credentials);
  });
}
function multiImageFixture(edit?: Edit) {
  return originalFixture('image', imageUrl(), (method, response, count, body, credentials) => {
    if (method === 'GetCanvas') {
      const other = graphNode('other', 'other-image');
      other.type = 'NODE_TYPE_GENERATE_IMAGE';
      other.nodeAssets[0]!.url = imageUrl('other');
      array(response.nodes).push(other);
      array(response.nodeRuns).push({ ...nodeRun('other', 'other-image'), runId: 'run-game' });
    }
    if (method === 'GetRun') {
      const run = object(response.run);
      run.scope = 'RUN_SCOPE_SEGMENT';
      run.nodeIds = ['game', 'other'];
      run.steps = [
        step(response),
        {
          ...step(response),
          nodeId: 'other',
          stepId: identities.other!.step,
          taskId: identities.other!.task,
          seqNo: 2,
        },
      ];
    }
    if (method === 'ListNodesAssets') {
      const other = output('other', 'other-image');
      Object.assign(other.assets[0]!, {
        kind: 'ASSET_KIND_IMAGE',
        role: 'ASSET_ROLE_CANDIDATE',
        url: imageUrl('other'),
      });
      array(response.nodes).push(other);
    }
    edit?.(method, response, count, body, credentials);
  });
}
const multiRequest = {
  ...request,
  nodeIds: ['game', 'other'],
  expect: [
    { nodeId: 'game', kind: 'image', assetIds: ['html'] },
    { nodeId: 'other', kind: 'image', assetIds: ['other-image'] },
  ],
};

test('exact HolyMolly original step path proves generation while preserving independent costs and content acceptance', async () => {
  for (const [status, points] of [
    ['PENDING', '32'],
    ['SETTLED', '13.50'],
  ]) {
    const f = fixture((method, response) => {
      if (method === 'GetCanvas')
        current(response).credits = { status: 'NODE_CREDITS_STATUS_' + status, points };
    });
    const result = object(await auditCanvas(f.client, request));
    const identity = {
      turn_id: 'turn',
      run_id: 'run-game',
      step_id: identities.game!.step,
      task_id: identities.game!.task,
    };
    assert.deepEqual(node(result).run_attribution, {
      status: 'verified',
      scope: 'node_run',
      source: 'canvas_run_step',
      reason: null,
      ...identity,
    });
    assert.deepEqual(node(result).current_selection_association, {
      status: 'verified',
      scope: 'current_selection',
      source: 'canvas_run_step_selection',
      reason: null,
      ...identity,
      asset_id: 'html',
    });
    assert.deepEqual(node(result).turn_attribution, {
      status: 'verified',
      scope: 'selected_generated_output',
      source: 'studio_execution_object',
      evidence: 'holy_molly_step_path',
      reason: null,
      ...identity,
      asset_id: 'html',
    });
    assert.equal(object(result.scope).turn_artifact_attribution, 'verified');
    assert.equal(object(result.scope).turn_artifact_attribution_scope, 'selected_generated_outputs');
    const game = object(node(result).game),
      credits = object(game.credits);
    assert.equal(credits.turn_attribution, 'verified');
    assert.equal(credits.attribution_scope, 'node_run_record');
    assert.equal(credits.ledger_attribution, 'not_checked');
    assert.equal(credits.status, 'NODE_CREDITS_STATUS_' + status);
    assert.equal(credits.points, points);
    assert.equal(game.playability_verified, false);
    assert.equal(object(result.acceptance).requirements_met, null);
    assert.equal(object(result.acceptance).bytes_verified, false);
    assert.equal(object(result.acceptance).status, 'needs_review');
    assert.deepEqual(
      f.calls.filter((call) => call.method === 'GetRun'),
      [
        { method: 'GetRun', body: { runId: 'run-game' } },
        { method: 'GetRun', body: { runId: 'run-game' } },
      ],
    );
    assert.doesNotMatch(JSON.stringify(result), /https?:|signature|synthetic|Everything succeeded/);
  }
});

test('missing run, current-step and asset identities remain unknown instead of using Agent prose', async () => {
  for (const mode of [
    'run',
    'runId',
    'canvasId',
    'turnId',
    'nodeIds',
    'steps',
    'stepId',
    'taskId',
    'step-nodeId',
    'currentStepId',
    'selectedAssetId',
    'nodeAssets',
  ]) {
    const f = fixture((method, response) => {
      if (method === 'GetRun') {
        if (mode === 'run') delete response.run;
        else if (['runId', 'canvasId', 'turnId', 'nodeIds', 'steps'].includes(mode))
          object(response.run)[mode] = null;
        else if (['stepId', 'taskId', 'step-nodeId'].includes(mode))
          delete step(response)[mode === 'step-nodeId' ? 'nodeId' : mode];
      }
      if (method === 'GetCanvas') {
        if (['currentStepId', 'selectedAssetId'].includes(mode)) delete current(response)[mode];
        if (mode === 'nodeAssets') delete node(response).nodeAssets;
      }
    });
    const result = object(await auditCanvas(f.client, request));
    assert.equal(object(node(result).turn_attribution).status, 'unknown', mode);
    assert.equal(object(result.scope).turn_artifact_attribution, 'unknown', mode);
    const runStatus = ['selectedAssetId', 'nodeAssets'].includes(mode) ? 'verified' : 'unknown';
    assert.equal(object(node(result).run_attribution).status, runStatus, mode);
    assert.equal(object(object(node(result).game).credits).turn_attribution, runStatus, mode);
    assert.equal(object(result.acceptance).requirements_met, null, mode);
  }
});

test('another turn and incomplete or duplicated node-step mappings remain unverified', async () => {
  for (const [mode, reason] of [
    ['turn', 'run_belongs_to_another_turn'],
    ['nodes', 'run_steps_incomplete'],
    ['duplicate-nodes', 'run_nodes_ambiguous'],
    ['steps', 'run_steps_ambiguous'],
    ['duplicate-steps', 'run_steps_ambiguous'],
  ]) {
    const f = fixture((method, response) => {
      if (method !== 'GetRun') return;
      const run = object(response.run);
      if (mode === 'turn') run.turnId = 'old-turn';
      if (mode === 'nodes') run.nodeIds = ['game', 'other'];
      if (mode === 'duplicate-nodes') run.nodeIds = ['game', 'game'];
      if (mode === 'steps') run.steps = [step(response), { ...step(response), stepId: 'other-step' }];
      if (mode === 'duplicate-steps') run.steps = [step(response), { ...step(response) }];
    });
    const result = object(await auditCanvas(f.client, request));
    assert.equal(object(node(result).turn_attribution).reason, reason, mode);
    assert.equal(object(result.scope).turn_artifact_attribution, 'unknown', mode);
  }
});

test('wrong run, Canvas, node, step or selected resource identities remain contract errors', async () => {
  for (const mode of ['runId', 'canvasId', 'nodeIds', 'stepId', 'step-nodeId', 'url']) {
    const f = fixture((method, response) => {
      if (method === 'GetRun') {
        if (['runId', 'canvasId'].includes(mode)) object(response.run)[mode] = 'foreign';
        if (mode === 'nodeIds') object(response.run).nodeIds = ['foreign'];
        if (mode === 'stepId') step(response).stepId = 'foreign';
        if (mode === 'step-nodeId') step(response).nodeId = 'foreign';
      }
      if (mode === 'url' && method === 'ListNodesAssets')
        asset(response).url = 'https://cdn.example/other.html';
    });
    await assert.rejects(auditCanvas(f.client, request), { code: 'CONTRACT_CHANGED' }, mode);
  }
});

test('unfinished execution preserves run ownership and current selection but cannot verify generation', async () => {
  for (const mode of ['run', 'node', 'step']) {
    const f = fixture((method, response) => {
      if (mode === 'run' && method === 'GetRun') object(response.run).status = 'RUN_STATUS_RUNNING';
      if (mode === 'step' && method === 'GetRun') step(response).status = 'RUN_STEP_STATUS_RUNNING';
      if (mode === 'node' && method === 'GetCanvas') current(response).status = 'NODE_STATUS_RUNNING';
    });
    const result = object(await auditCanvas(f.client, request));
    assert.equal(object(node(result).turn_attribution).reason, 'execution_not_completed');
    assert.equal(object(node(result).run_attribution).status, 'verified');
    assert.equal(object(node(result).current_selection_association).status, 'verified');
    assert.equal(object(object(node(result).game).credits).turn_attribution, 'verified');
    assert.equal(object(result.scope).turn_artifact_attribution, 'unknown');
    assert.equal(object(result.acceptance).requirements_met, null);
  }
});

test('failed runs retain exact node credit attribution without claiming that missing or old outputs were generated', async () => {
  for (const selected of [false, true]) {
    for (const matchingTurn of [false, true]) {
      const f = originalFixture('html', holyUrl('previous'), (method, response) => {
        if (method === 'GetCanvas') {
          current(response).status = 'NODE_STATUS_FAILED';
          current(response).credits = { status: 'NODE_CREDITS_STATUS_SETTLED', points: '1' };
          if (!selected) {
            delete current(response).selectedAssetId;
            node(response).nodeAssets = [];
          }
        }
        if (method === 'GetRun') {
          object(response.run).status = 'RUN_STATUS_FAILED';
          step(response).status = 'RUN_STEP_STATUS_FAILED';
          if (!matchingTurn) object(response.run).turnId = 'previous-turn';
        }
        if (method === 'GetTurnDetail') object(response.turn).status = 'TURN_STATUS_FAILED';
        if (method === 'ListNodesAssets' && !selected) node(response).assets = [];
      });
      const result = object(await auditCanvas(f.client, { ...request, expect: [] }));
      const status = matchingTurn ? 'verified' : 'unknown';
      assert.equal(object(node(result).run_attribution).status, status);
      assert.equal(object(node(result).turn_attribution).status, 'unknown');
      assert.equal(object(result.scope).turn_artifact_attribution, 'unknown');
      const credits = object(object(node(result).game).credits);
      assert.equal(credits.turn_attribution, status);
      assert.equal(credits.attribution_scope, 'node_run_record');
      assert.equal(credits.ledger_attribution, 'not_checked');
      assert.equal(credits.status, 'NODE_CREDITS_STATUS_SETTLED');
      assert.equal(credits.points, '1');
      assert.equal(object(result.acceptance).status, 'blocked');
      assert.equal(object(result.acceptance).requirements_met, null);
    }
  }
});

test('selection requires one exact available asset explicitly selected in both graph and list', async () => {
  for (const mode of [
    'unselected-graph',
    'unselected-list',
    'multiple-selected',
    'duplicate-saved',
    'missing-saved',
    'missing-output',
    'unavailable',
  ]) {
    const f = fixture((method, response) => {
      if (method === 'GetCanvas') {
        if (mode === 'unselected-graph') savedAsset(response).selected = false;
        if (mode === 'duplicate-saved') array(node(response).nodeAssets).push({ ...savedAsset(response) });
        if (mode === 'missing-saved') savedAsset(response).assetId = 'old-html';
      }
      if (method === 'ListNodesAssets') {
        if (mode === 'unselected-list') asset(response).selected = false;
        if (mode === 'missing-output') node(response).assets = [];
        if (mode === 'unavailable') asset(response).status = 'ASSET_STATUS_PROCESSING';
        if (mode === 'multiple-selected')
          array(node(response).assets).push({
            ...asset(response),
            assetId: 'other-html',
            selected: true,
          });
      }
    });
    const result = object(await auditCanvas(f.client, request));
    assert.equal(object(node(result).turn_attribution).status, 'unknown', mode);
    assert.equal(object(node(result).current_selection_association).status, 'unknown', mode);
    assert.equal(object(node(result).run_attribution).status, 'verified', mode);
    assert.equal(object(object(node(result).game).credits).turn_attribution, 'verified', mode);
    assert.equal(object(result.scope).turn_artifact_attribution, 'unknown', mode);
  }
});

test('a unique selected CURRENT output can be proved even when other unselected CURRENT assets exist', async () => {
  const f = fixture((method, response) => {
    if (method === 'ListNodesAssets')
      array(node(response).assets).push({ ...asset(response), assetId: 'other-html', selected: false });
  });
  const result = object(await auditCanvas(f.client, request));
  assert.equal(object(node(result).current_selection_association).status, 'verified');
  assert.equal(object(node(result).turn_attribution).status, 'verified');
  assert.equal(object(node(result).turn_attribution).asset_id, 'html');
});

test('an exact Studio image task path proves a selected CANDIDATE in a single-node SEGMENT run', async () => {
  const f = originalFixture('image', imageUrl(), (method, response) => {
    if (method === 'GetRun') object(response.run).scope = 'RUN_SCOPE_SEGMENT';
  });
  const result = object(
    await auditCanvas(f.client, {
      ...request,
      expect: [{ nodeId: 'game', kind: 'image', assetIds: ['html'] }],
    }),
  );
  const generation = object(node(result).turn_attribution);
  assert.equal(generation.status, 'verified');
  assert.equal(generation.evidence, 'generate_image_task_path');
  assert.equal(generation.task_id, identities.game!.task);
  assert.equal(generation.asset_id, 'html');
  assert.notEqual(generation.asset_id, generation.task_id);
  assert.equal(object(node(result).run_attribution).status, 'verified');
  assert.equal(object(node(result).current_selection_association).status, 'verified');
  assert.equal(object(result.scope).turn_artifact_attribution, 'verified');
  assert.equal(object(result.acceptance).status, 'needs_review');
  assert.equal(object(result.acceptance).requirements_met, null);
});

test('selecting an older result while keeping the current run and step never proves new generation', async () => {
  for (const type of ['image', 'html'] as const) {
    const f = originalFixture(
      type,
      type === 'image' ? imageUrl('previous') : holyUrl('previous'),
      (method, response) => {
        if (method === 'GetCanvas') {
          savedAsset(response).assetId = 'older-output';
          current(response).selectedAssetId = 'older-output';
          node(response).params = { hm_phase: 'ready', entry_url: holyUrl() };
        }
        if (method === 'ListNodesAssets') asset(response).assetId = 'older-output';
      },
    );
    const result = object(
      await auditCanvas(f.client, {
        ...request,
        expect: [{ nodeId: 'game', kind: type, assetIds: ['older-output'] }],
      }),
    );
    assert.equal(object(node(result).run_attribution).status, 'verified', type);
    assert.equal(object(node(result).current_selection_association).status, 'verified', type);
    assert.equal(object(node(result).turn_attribution).status, 'unknown', type);
    assert.equal(
      object(node(result).turn_attribution).reason,
      type === 'image' ? 'asset_task_identity_unverified' : 'asset_step_identity_unverified',
      type,
    );
    assert.equal(object(result.scope).turn_artifact_attribution, 'unknown', type);
    if (type === 'html') {
      const credits = object(object(node(result).game).credits);
      assert.equal(credits.turn_attribution, 'verified');
      assert.equal(credits.attribution_scope, 'node_run_record');
      assert.equal(credits.ledger_attribution, 'not_checked');
      assert.equal(credits.status, 'NODE_CREDITS_STATUS_PENDING');
      assert.equal(credits.points, '32');
    }
  }
});

test('generation requires an exact observed object namespace, source, role and task path', async () => {
  const task = identities.game!.task;
  const resources = [
    imageUrl().replace(storageOrigin, 'https://cdn.example'),
    imageUrl().replace(storageOrigin, 'https://tripo-data.fixture.data.tripo3d.com.example'),
    imageUrl().replace('https:', 'http:'),
    imageUrl().replace('https://', 'https://synthetic:password@'),
    imageUrl().replace(storageOrigin, storageOrigin + ':444'),
    `${storageOrigin}/unverified/${task}/image.png`,
    `${storageOrigin}/generate-image/20260101/${task}-suffix/image.png`,
    `${storageOrigin}/generate-image/20260101/prefix-${task}/image.png`,
    `${imageUrl('previous')}?task=${task}`,
    `${storageOrigin}/generate-image/${task}/image.png`,
    `${storageOrigin}/canvas/holymolly/100000000000000000/${task}/${'a'.repeat(64)}/index.html`,
  ];
  for (const url of resources) {
    const f = originalFixture('image', url);
    const result = object(await auditCanvas(f.client, { ...request, expect: [] }));
    assert.equal(object(node(result).current_selection_association).status, 'verified');
    assert.equal(object(node(result).turn_attribution).status, 'unknown', url);
  }
  for (const [field, value] of [
    ['source', 'ASSET_SOURCE_UPLOAD'],
    ['source', null],
    ['role', 'ASSET_ROLE_SUPERSEDED'],
    ['role', null],
    ['kind', 'ASSET_KIND_MODEL'],
  ]) {
    const f = originalFixture('image', imageUrl(), (method, response) => {
      if (method === 'ListNodesAssets') asset(response)[String(field)] = value;
    });
    const result = object(await auditCanvas(f.client, { ...request, expect: [] }));
    assert.equal(object(node(result).current_selection_association).status, 'verified');
    assert.equal(object(node(result).turn_attribution).status, 'unknown', String(field));
  }
});

test('HolyMolly provenance requires its exact step in the observed original HTML namespace', async () => {
  for (const url of [
    holyUrl().replace('/canvas/holymolly/', '/unverified/holymolly/'),
    holyUrl().replace('/100000000000000000/', '/owner-fixture/'),
    holyUrl().replace(identities.game!.step, identities.game!.task),
    holyUrl().replace('/' + 'a'.repeat(64) + '/', '/short-hash/'),
    holyUrl().replace('/index.html', '/preview.html'),
    `${holyUrl('previous')}?step=${identities.game!.step}`,
  ]) {
    const f = originalFixture('html', url);
    const result = object(await auditCanvas(f.client, request));
    assert.equal(object(node(result).current_selection_association).status, 'verified');
    assert.equal(object(node(result).turn_attribution).status, 'unknown', url);
    assert.equal(object(node(result).turn_attribution).reason, 'asset_step_identity_unverified');
  }
});

test('HD and texture model originals require their node-specific filename and matching directory and file task IDs', async () => {
  for (const type of ['hd', 'texture'] as const) {
    const f = modelFixture(type);
    const result = object(
      await auditCanvas(f.client, {
        ...request,
        expect: [{ nodeId: 'game', kind: 'model', assetIds: ['html'] }],
      }),
    );
    const provenance = object(node(result).turn_attribution);
    assert.equal(provenance.status, 'verified', type);
    assert.equal(provenance.evidence, type === 'hd' ? 'generate_hd_model_task_path' : 'texture_task_path');
    assert.equal(provenance.task_id, identities.game!.task);
    assert.equal(provenance.asset_id, 'html');
    assert.equal(object(result.scope).turn_artifact_attribution, 'verified');
    assert.equal(object(result.acceptance).requirements_met, null);
    assert.equal(object(result.acceptance).bytes_verified, false);
  }
});

const texturedHdUrl = (directoryNodeId = 'game', filenameNodeId = directoryNodeId) =>
  `${storageOrigin}/tripo-studio/20260101/${identities[directoryNodeId]!.task}/tripo_model_${identities[filenameNodeId]!.task}_meshopt.glb`;

test('textured HD originals prove generation with the exact observed model filename', async () => {
  const f = modelFixture('hd', texturedHdUrl(), (method, response) => {
    if (method === 'GetCanvas') node(response).params = { texture: true };
    if (method === 'ListNodesAssets') {
      asset(response).studioGenerated = false;
      asset(response).studioState = 'STUDIO_ASSET_STATE_READY';
      asset(response).factsJson = JSON.stringify({ textured: true, hd_textured: true });
    }
  });
  const result = object(
    await auditCanvas(f.client, {
      ...request,
      expect: [{ nodeId: 'game', kind: 'model', assetIds: ['html'] }],
    }),
  );
  assert.equal(object(node(result).run_attribution).status, 'verified');
  assert.equal(object(node(result).current_selection_association).status, 'verified');
  assert.equal(object(node(result).turn_attribution).status, 'verified');
  assert.equal(object(node(result).turn_attribution).evidence, 'generate_hd_model_task_path');
  assert.equal(object(node(result).turn_attribution).task_id, identities.game!.task);
  assert.equal(object(result.scope).turn_artifact_attribution, 'verified');
  assert.equal(object(result.acceptance).status, 'needs_review');
  assert.equal(object(result.acceptance).requirements_met, null);
  assert.equal(object(result.acceptance).bytes_verified, false);
});

test('textured HD proof rejects cross-task directories, filenames and arbitrary model variants', async () => {
  for (const url of [
    texturedHdUrl('game', 'previous'),
    texturedHdUrl('previous', 'game'),
    texturedHdUrl('previous'),
    texturedHdUrl().replace('_meshopt.glb', '.glb'),
    texturedHdUrl().replace('_meshopt.glb', '_meshopt.fbx'),
    texturedHdUrl().replace('_meshopt.glb', '_meshopt.glb.bak'),
    texturedHdUrl().replace('tripo_model_', 'tripo_model_preview_'),
    texturedHdUrl().replace('tripo_model_', 'arbitrary_model_'),
    texturedHdUrl().replace('/tripo-studio/', '/unverified/'),
    texturedHdUrl().replace(storageOrigin, 'https://cdn.example'),
    `${texturedHdUrl('previous')}?taskId=${identities.game!.task}`,
  ]) {
    const f = modelFixture('hd', url);
    const result = object(await auditCanvas(f.client, { ...request, expect: [] }));
    assert.equal(object(node(result).run_attribution).status, 'verified');
    assert.equal(object(node(result).current_selection_association).status, 'verified');
    assert.equal(object(node(result).turn_attribution).status, 'unknown', url);
    assert.equal(object(result.scope).turn_artifact_attribution, 'unknown');
  }
});

test('the textured HD object namespace does not prove another node type or a candidate selection', async () => {
  for (const nodeType of [
    'NODE_TYPE_TEXTURE',
    'NODE_TYPE_PBR',
    'NODE_TYPE_RETOPOLOGY',
    'NODE_TYPE_GENERATE_SM_MODEL',
    'NODE_TYPE_RIGGING',
  ]) {
    const f = modelFixture('hd', texturedHdUrl(), (method, response) => {
      if (method === 'GetCanvas') node(response).type = nodeType;
    });
    const result = object(await auditCanvas(f.client, { ...request, expect: [] }));
    assert.equal(object(node(result).turn_attribution).reason, 'asset_task_identity_unverified', nodeType);
  }
  const f = modelFixture('hd', texturedHdUrl(), (method, response) => {
    if (method === 'ListNodesAssets') asset(response).role = 'ASSET_ROLE_CANDIDATE';
  });
  const result = object(await auditCanvas(f.client, { ...request, expect: [] }));
  assert.equal(object(node(result).turn_attribution).status, 'unknown');
  assert.equal(object(node(result).turn_attribution).reason, 'asset_generation_source_unverified');
});

test('model provenance rejects mismatched directory and file tasks, cross-node prefixes and unverified formats', async () => {
  for (const type of ['hd', 'texture'] as const) {
    for (const url of [
      modelUrl(type, 'game', 'previous'),
      modelUrl(type, 'previous', 'game'),
      modelUrl(type, 'previous'),
      modelUrl(type === 'hd' ? 'texture' : 'hd'),
      modelUrl(type).replace('_meshopt.glb', '.glb'),
      modelUrl(type).replace('_meshopt.glb', '_meshopt.obj'),
      modelUrl(type).replace('/tripo-studio/', '/unverified/'),
      modelUrl(type).replace('/20260101/', '/date/'),
      `${modelUrl(type, 'previous')}?taskId=${identities.game!.task}`,
      modelUrl(type).replace(storageOrigin, 'https://cdn.example'),
    ]) {
      const f = modelFixture(type, url);
      const result = object(await auditCanvas(f.client, { ...request, expect: [] }));
      assert.equal(object(node(result).run_attribution).status, 'verified');
      assert.equal(object(node(result).current_selection_association).status, 'verified');
      assert.equal(object(node(result).turn_attribution).status, 'unknown', `${type}: ${url}`);
      assert.equal(object(result.scope).turn_artifact_attribution, 'unknown');
    }
  }
});

test('model object paths do not expand proof to other node types, asset kinds, sources or CANDIDATE roles', async () => {
  for (const type of ['hd', 'texture'] as const) {
    for (const [field, value] of [
      ['node-type', 'NODE_TYPE_GENERATE_MODEL'],
      ['node-type', 'NODE_TYPE_GENERATE_IMAGE'],
      ['kind', 'ASSET_KIND_IMAGE'],
      ['kind', 'ASSET_KIND_UNSPECIFIED'],
      ['source', 'ASSET_SOURCE_UPLOAD'],
      ['source', undefined],
      ['role', 'ASSET_ROLE_CANDIDATE'],
      ['role', 'ASSET_ROLE_SUPERSEDED'],
    ]) {
      const f = modelFixture(type, modelUrl(type), (method, response) => {
        if (field === 'node-type' && method === 'GetCanvas') node(response).type = value;
        if (field !== 'node-type' && method === 'ListNodesAssets') asset(response)[String(field)] = value;
      });
      const result = object(await auditCanvas(f.client, { ...request, expect: [] }));
      assert.equal(object(node(result).current_selection_association).status, 'verified');
      assert.equal(object(node(result).turn_attribution).status, 'unknown', `${type}: ${field}`);
    }
  }
});

test('a proved selected model does not attribute other outputs on the node to the same turn', async () => {
  for (const type of ['hd', 'texture'] as const) {
    const f = modelFixture(type, modelUrl(type), (method, response) => {
      if (method === 'ListNodesAssets')
        array(node(response).assets).push({
          ...asset(response),
          assetId: 'old-model',
          selected: false,
          role: 'ASSET_ROLE_CANDIDATE',
          url: modelUrl(type, 'previous'),
        });
    });
    const result = object(
      await auditCanvas(f.client, {
        ...request,
        expect: [{ nodeId: 'game', kind: 'model', assetIds: ['html', 'old-model'], minAssets: 2 }],
      }),
    );
    assert.equal(object(node(result).turn_attribution).status, 'verified');
    assert.equal(object(node(result).turn_attribution).asset_id, 'html');
    assert.equal(object(result.scope).turn_artifact_attribution, 'unknown');
    assert.equal(object(result.acceptance).requirements_met, null);
  }
});

const additionalModelCases = [
  ['NODE_TYPE_GENERATE_SM_MODEL', 'output_mesh_TASK.fbx', 'generate_sm_model_task_path'],
  ['NODE_TYPE_RETOPOLOGY', 'tripo_poly_TASK_meshopt.glb', 'retopology_task_path'],
  ['NODE_TYPE_RIGGING', 'tripo_rigging_TASK_meshopt.glb', 'rigging_task_path'],
  ['NODE_TYPE_PBR', 'tripo_texture_TASK_meshopt.glb', 'pbr_task_path'],
  ['NODE_TYPE_SMART_UV', 'tripo_mesh_uv_TASK.glb', 'smart_uv_task_path'],
] as const;
const studioModelUrl = (filename: string, directoryTask = identities.game!.task) =>
  `${storageOrigin}/tripo-studio/20260101/${directoryTask}/${filename}`;

test('SM, retopology, rigging, PBR and smart UV have distinct verified original file contracts', async () => {
  for (const [nodeType, template, evidence] of additionalModelCases) {
    const f = modelFixture(
      'hd',
      studioModelUrl(template.replace('TASK', identities.game!.task)),
      (method, response) => {
        if (method === 'GetCanvas') node(response).type = nodeType;
      },
    );
    const result = object(
      await auditCanvas(f.client, {
        ...request,
        expect: [{ nodeId: 'game', kind: 'model', assetIds: ['html'] }],
      }),
    );
    const provenance = object(node(result).turn_attribution);
    assert.equal(provenance.status, 'verified', nodeType);
    assert.equal(provenance.evidence, evidence);
    assert.equal(provenance.task_id, identities.game!.task);
    assert.equal(object(result.acceptance).requirements_met, null);
  }
});

test('additional model proofs reject old directory or filename tasks, wrong prefixes, formats and candidate roles', async () => {
  for (const [nodeType, template] of additionalModelCases) {
    const filename = template.replace('TASK', identities.game!.task);
    for (const url of [
      studioModelUrl(template.replace('TASK', identities.previous!.task)),
      studioModelUrl(filename, identities.previous!.task),
      studioModelUrl(`tripo_base_model_${identities.game!.task}_meshopt.glb`),
      studioModelUrl(filename.replace(/\.(?:fbx|glb)$/, '.obj')),
      studioModelUrl(filename + '.bak'),
    ]) {
      const f = modelFixture('hd', url, (method, response) => {
        if (method === 'GetCanvas') node(response).type = nodeType;
      });
      const result = object(await auditCanvas(f.client, { ...request, expect: [] }));
      assert.equal(object(node(result).run_attribution).status, 'verified');
      assert.equal(object(node(result).turn_attribution).reason, 'asset_task_identity_unverified', nodeType);
    }
    const f = modelFixture('hd', studioModelUrl(filename), (method, response) => {
      if (method === 'GetCanvas') node(response).type = nodeType;
      if (method === 'ListNodesAssets') asset(response).role = 'ASSET_ROLE_CANDIDATE';
    });
    const result = object(await auditCanvas(f.client, { ...request, expect: [] }));
    assert.equal(object(node(result).turn_attribution).status, 'unknown');
  }
});

test('animation and split results cannot borrow upstream rigging or image object provenance', async () => {
  for (const [nodeType, kind, url] of [
    [
      'NODE_TYPE_ANIMATION',
      'ASSET_KIND_MODEL',
      studioModelUrl(`tripo_rigging_${identities.game!.task}_meshopt.glb`),
    ],
    ['NODE_TYPE_SPLIT_RESULT', 'ASSET_KIND_IMAGE', imageUrl()],
  ]) {
    const f = originalFixture('image', url!, (method, response) => {
      if (method === 'GetCanvas') node(response).type = nodeType;
      if (method === 'ListNodesAssets') {
        asset(response).kind = kind;
        asset(response).role = 'ASSET_ROLE_CURRENT';
      }
    });
    const result = object(await auditCanvas(f.client, { ...request, expect: [] }));
    assert.equal(object(node(result).turn_attribution).reason, 'asset_generation_binding_unavailable');
  }
});

test('an exact selected result does not attribute other expected assets or larger minimum counts', async () => {
  for (const expect of [[{ nodeId: 'game', assetIds: ['old-html'] }], [{ nodeId: 'game', minAssets: 2 }]]) {
    const f = fixture((method, response) => {
      if (method === 'ListNodesAssets')
        array(node(response).assets).push({
          ...asset(response),
          assetId: 'old-html',
          selected: false,
          role: 'ASSET_ROLE_CANDIDATE',
        });
    });
    const result = object(await auditCanvas(f.client, { ...request, expect }));
    assert.equal(object(node(result).turn_attribution).status, 'verified');
    assert.equal(object(result.scope).turn_artifact_attribution, 'unknown');
  }
});

test('a mixed old/new graph keeps per-node proofs but never assigns the whole graph to one turn', async () => {
  const f = fixture((method, response, _count, body) => {
    if (method === 'GetCanvas') {
      array(response.nodes).push(graphNode('previous', 'old-html'));
      array(response.nodeRuns).push(nodeRun('previous', 'old-html'));
    }
    if (method === 'ListNodesAssets') array(response.nodes).push(output('previous', 'old-html'));
    if (method === 'GetRun' && body.runId === 'run-previous') object(response.run).turnId = 'previous-turn';
  });
  const result = object(await auditCanvas(f.client, { ...request, nodeIds: ['game', 'previous'] }));
  assert.equal(object(node(result).turn_attribution).status, 'verified');
  assert.equal(object(object(array(result.nodes)[1]).turn_attribution).reason, 'run_belongs_to_another_turn');
  assert.equal(object(result.scope).turn_artifact_attribution, 'unknown');
  assert.equal(f.calls.filter((call) => call.method === 'GetRun').length, 4);
});

test('run reads are limited to the selected scope, deduplicated, and omitted without a requested turn', async () => {
  const absent = fixture();
  const result = object(await auditCanvas(absent.client, { ...request, turnId: undefined }));
  assert.equal(object(node(result).turn_attribution).reason, 'turn_not_requested');
  assert.equal(absent.calls.filter((call) => call.method === 'GetRun').length, 0);
  const f = fixture((method, response) => {
    if (method === 'GetCanvas') {
      array(response.nodes).push(graphNode('other', 'other-html'));
      array(response.nodeRuns).push(nodeRun('other', 'other-html'));
    }
  });
  await auditCanvas(f.client, request);
  assert.equal(f.calls.filter((call) => call.method === 'GetRun').length, 2);
  assert.ok(
    f.calls.filter((call) => call.method === 'GetRun').every((call) => call.body.runId === 'run-game'),
  );
  const shared = fixture((method, response) => {
    if (method === 'GetCanvas') {
      array(response.nodes).push(graphNode('other', 'other-html'));
      array(response.nodeRuns).push({ ...nodeRun('other', 'other-html'), runId: 'run-game' });
    }
    if (method === 'GetRun') object(response.run).nodeIds = ['game', 'other'];
    if (method === 'ListNodesAssets') array(response.nodes).push(output('other', 'other-html'));
  });
  const mixed = object(await auditCanvas(shared.client, { ...request, nodeIds: ['game', 'other'] }));
  assert.equal(shared.calls.filter((call) => call.method === 'GetRun').length, 2);
  assert.equal(object(mixed.scope).turn_artifact_attribution, 'unknown');
  assert.ok(
    array(mixed.nodes).every(
      (entry) => object(object(entry).turn_attribution).reason === 'run_steps_incomplete',
    ),
  );
});

test('multi-node runs prove exact per-node outputs independently of step array order', async () => {
  for (const reversed of [false, true]) {
    const f = multiImageFixture((method, response) => {
      if (reversed && method === 'GetRun') array(object(response.run).steps).reverse();
    });
    const result = object(await auditCanvas(f.client, multiRequest));
    for (const entry of array(result.nodes).map(object)) {
      const provenance = object(entry.turn_attribution);
      assert.equal(provenance.status, 'verified');
      assert.equal(provenance.evidence, 'generate_image_task_path');
      assert.equal(provenance.step_id, identities[String(entry.node_id)]!.step);
      assert.equal(provenance.task_id, identities[String(entry.node_id)]!.task);
    }
    assert.equal(object(result.scope).turn_artifact_attribution, 'verified');
    assert.equal(f.calls.filter((call) => call.method === 'GetRun').length, 2);
    assert.equal(object(result.acceptance).requirements_met, null);
  }
});

test('multi-node proof requires a complete unique mapping and never chooses the latest retry', async () => {
  for (const [mode, reason] of [
    ['missing-step', 'run_steps_incomplete'],
    ['missing-task', 'step_identity_incomplete'],
    ['duplicate-node', 'run_nodes_ambiguous'],
    ['duplicate-step', 'run_steps_ambiguous'],
    ['duplicate-task', 'run_tasks_ambiguous'],
    ['repeated-node-retry', 'run_steps_ambiguous'],
    ['missing-turn', 'run_identity_incomplete'],
    ['different-turn', 'run_belongs_to_another_turn'],
  ]) {
    const f = multiImageFixture((method, response) => {
      if (method !== 'GetRun') return;
      const run = object(response.run),
        steps = array(run.steps).map(object);
      if (mode === 'missing-step') run.steps = steps.slice(0, 1);
      if (mode === 'missing-task') delete steps[1]!.taskId;
      if (mode === 'duplicate-node') run.nodeIds = ['game', 'other', 'game'];
      if (mode === 'duplicate-step') steps[1]!.stepId = steps[0]!.stepId;
      if (mode === 'duplicate-task') steps[1]!.taskId = steps[0]!.taskId;
      if (mode === 'repeated-node-retry')
        array(run.steps).push({
          ...steps[0],
          stepId: identities.previous!.step,
          taskId: identities.previous!.task,
          retryNo: 7,
          seqNo: 99,
        });
      if (mode === 'missing-turn') run.turnId = '';
      if (mode === 'different-turn') run.turnId = 'previous-turn';
    });
    const result = object(await auditCanvas(f.client, multiRequest));
    for (const entry of array(result.nodes).map(object)) {
      assert.equal(object(entry.run_attribution).status, 'unknown', mode);
      assert.equal(object(entry.turn_attribution).reason, reason, mode);
    }
    assert.equal(object(result.scope).turn_artifact_attribution, 'unknown', mode);
  }
});

test('multi-node identity conflicts fail rather than choosing another matching step', async () => {
  for (const mode of ['outside-step-node', 'wrong-current-step']) {
    const f = multiImageFixture((method, response) => {
      if (mode === 'outside-step-node' && method === 'GetRun')
        object(array(object(response.run).steps)[1]).nodeId = 'unlisted-node';
      if (mode === 'wrong-current-step' && method === 'GetCanvas')
        current(response).currentStepId = identities.other!.step;
    });
    await assert.rejects(auditCanvas(f.client, multiRequest), { code: 'CONTRACT_CHANGED' }, mode);
  }
});

test('a multi-node run does not claim an older selected asset or another node output', async () => {
  for (const sourceNode of ['previous', 'other']) {
    const f = multiImageFixture((method, response) => {
      if (method === 'GetCanvas') savedAsset(response).url = imageUrl(sourceNode);
      if (method === 'ListNodesAssets') asset(response).url = imageUrl(sourceNode);
    });
    const result = object(await auditCanvas(f.client, multiRequest));
    const reports = array(result.nodes).map(object);
    assert.equal(object(reports[0]!.run_attribution).status, 'verified');
    assert.equal(object(reports[0]!.current_selection_association).status, 'verified');
    assert.equal(object(reports[0]!.turn_attribution).reason, 'asset_task_identity_unverified');
    assert.equal(object(reports[1]!.turn_attribution).status, 'verified');
    assert.equal(object(result.scope).turn_artifact_attribution, 'unknown');
  }
});

test('verified asset provenance does not validate missing or malformed credit metadata', async () => {
  for (const credits of [undefined, { status: 'NODE_CREDITS_STATUS_SETTLED', points: 'not-a-number' }]) {
    const f = fixture((method, response) => {
      if (method === 'GetCanvas') current(response).credits = credits;
    });
    const result = object(await auditCanvas(f.client, request));
    assert.equal(object(node(result).turn_attribution).status, 'verified');
    const billing = object(object(node(result).game).credits);
    assert.equal(billing.turn_attribution, 'unknown');
    assert.equal(billing.points, null);
    assert.equal(billing.status, null);
  }
});

test('run state or identity changes are included in the two-pass stable snapshot', async () => {
  for (const mode of ['turn', 'task', 'status']) {
    const f = fixture((method, response, count) => {
      if (method !== 'GetRun' || count !== 2) return;
      if (mode === 'turn') object(response.run).turnId = 'changed-turn';
      if (mode === 'task') step(response).taskId = 'changed-task';
      if (mode === 'status') object(response.run).status = 'RUN_STATUS_FAILED';
    });
    await assert.rejects(auditCanvas(f.client, request), { code: 'CANVAS_CHANGED' }, mode);
  }
});

test('run transport and account failures stay errors and do not fall back to an unverified success report', async () => {
  for (const mode of ['network', 'account']) {
    const f = fixture((method, _response, _count, _body, credentials) => {
      if (method !== 'GetRun') return;
      if (mode === 'network') throw new Error('synthetic disconnected read');
      credentials.save({ ...credentials.load()!, accountRef: 'other' });
    });
    await assert.rejects(auditCanvas(f.client, request), {
      code: mode === 'network' ? 'NETWORK_ERROR' : 'ACCOUNT_MISMATCH',
    });
  }
});

test('rotating signed resource authorization retains the same selected asset identity', async () => {
  const f = fixture((method, response, count) => {
    if (method === 'GetCanvas') savedAsset(response).url = `${holyUrl()}?signature=graph-${count}`;
    if (method === 'ListNodesAssets') asset(response).url = `${holyUrl()}?signature=list-${count}`;
  });
  const result = object(await auditCanvas(f.client, request));
  assert.equal(object(result.scope).turn_artifact_attribution, 'verified');
  assert.equal(object(result.snapshot).stable, true);
});
