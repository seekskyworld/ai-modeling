import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { StudioClient } from '../studio/api/client.ts';
import { auditCanvas, canvasAuditSchema } from '../studio/api/canvas-audit.ts';
import { canvasArtifactContent } from '../studio/api/canvas-artifact.ts';
import { array, object } from '../studio/contracts/errors.ts';

const request = { canvasId: 'canvas', turnId: 'turn', expect: [{ nodeId: 'image', kind: 'image' }] };
type Edit = (
  method: string,
  result: Record<string, unknown>,
  count: number,
  credentials: MemoryCredentials,
) => void;
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
  const calls: string[] = [];
  const client = new StudioClient(credentials, async (_url, init) => {
    const method = new Headers(init.headers).get('x-micro-method')!.split('/').at(-1)!;
    const defaults: Record<string, unknown> = {
      GetCanvas: {
        canvas: { canvasId: 'canvas', projectId: 'project', revision: '3' },
        nodes: [
          { id: 'image', type: 'NODE_TYPE_GENERATE_IMAGE', params: { prompt: 'a red cube' }, pid: '' },
          {
            id: 'upload',
            type: 'NODE_TYPE_UPLOAD_CARD',
            inputMount: [
              {
                assetId: 'input',
                kind: 'ASSET_KIND_IMAGE',
                url: 'https://cdn.example/input.png?signature=secret',
              },
            ],
          },
          { id: 'group', type: 'NODE_TYPE_SECTION', params: null },
        ],
        edges: [],
        nodeRuns: [
          {
            nodeId: 'image',
            status: 'NODE_STATUS_DONE',
            runId: 'run',
            currentStepId: 'step',
            selectedAssetId: 'output',
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
      GetRun: { run: {} },
      GetTurnDetail: {
        turn: { turnId: 'turn', sessionId: 'session', status: 'TURN_STATUS_DONE' },
        messages: [
          {
            messageId: 'reply',
            turnId: 'turn',
            role: 'MESSAGE_ROLE_AGENT',
            status: 'MESSAGE_STATUS_DONE',
            content: 'Created a cube.',
          },
        ],
      },
      ListNodesAssets: {
        nodes: [
          {
            nodeId: 'image',
            assets: [
              {
                assetId: 'output',
                nodeId: 'image',
                kind: 'ASSET_KIND_IMAGE',
                selected: true,
                url: 'https://cdn.example/output.png?signature=secret',
                status: 'ASSET_STATUS_READY',
                version: 1,
              },
            ],
          },
        ],
      },
      BatchGetInputAssets: {
        assets: [{ assetId: 'input', status: 'INPUT_ASSET_STATUS_READY', kind: 'ASSET_KIND_IMAGE' }],
      },
    };
    assert.ok(Object.hasOwn(defaults, method), 'Only verified read RPCs are allowed: ' + method);
    calls.push(method);
    const result = structuredClone(object(defaults[method]));
    edit?.(method, result, calls.filter((entry) => entry === method).length, credentials);
    return Response.json({ error: { code: 0 }, ...result });
  });
  return { client, calls };
}
const nodes = (result: Record<string, unknown>) => array(result.nodes).map(object);
const firstAsset = (result: Record<string, unknown>) => object(array(nodes(result)[0]?.assets)[0]);

test('stable audit checks exact Canvas/session/turn and output expectations without asserting semantic acceptance', async () => {
  const f = fixture(),
    result = object(await auditCanvas(f.client, request));
  assert.equal(object(result.snapshot).stable, true);
  assert.equal(object(result.snapshot).atomic, false);
  assert.match(String(object(result.snapshot).fingerprint), /^[a-f0-9]{64}$/);
  assert.equal(object(result.turn).complete, true);
  assert.equal(object(result.execution).complete, true);
  assert.equal(result.artifact_ready, true);
  assert.equal(object(result.acceptance).status, 'needs_review');
  assert.equal(object(result.acceptance).requirements_met, null);
  assert.equal(object(result.scope).turn_artifact_attribution, 'unknown');
  assert.equal(object(result.scope).history_completeness, 'not_checked');
  assert.equal(nodes(result)[0]?.selected_asset_id, 'output');
  assert.equal(object(array(nodes(result)[1]?.assets)[0]).available, true);
  const actions = array(result.next_actions).map(object);
  assert.deepEqual(object(actions[0]?.parameters), { kind: 'canvas_node', id: 'output', node_id: 'image' });
  assert.deepEqual(object(actions[1]?.parameters), {
    kind: 'canvas_input',
    id: 'input',
    node_id: 'upload',
    canvas_id: 'canvas',
  });
  assert.deepEqual(actions[0]?.required_arguments, ['destination_path']);
  assert.doesNotMatch(JSON.stringify(result), /https?:|signature|Bearer|secret/);
  assert.equal(f.calls.filter((name) => name === 'GetTurnDetail').length, 2);
  assert.equal(f.calls.filter((name) => name === 'GetCanvas').length, 2);
});

test('omitted expectations and absent execution data remain unknown, not accepted', async () => {
  const f = fixture((method, result) => {
    if (method === 'GetCanvas') delete result.nodeRuns;
  });
  const result = object(await auditCanvas(f.client, { canvasId: 'canvas' }));
  assert.equal(result.turn, null);
  assert.equal(result.artifact_ready, null);
  assert.equal(object(result.execution).complete, null);
  assert.equal(object(result.acceptance).expectations_defined, false);
  assert.equal(object(result.acceptance).requirements_met, null);
});

test('waiting, running and failed remote states cannot become successful acceptance', async () => {
  for (const [remote, expected] of [
    ['WAITING_FOR_USER', 'waiting_input'],
    ['RUNNING', 'running'],
    ['FAILED', 'blocked'],
    ['CANCELLED', 'blocked'],
    ['NEW_UNKNOWN', 'blocked'],
  ]) {
    const f = fixture((method, result) => {
      if (method === 'GetTurnDetail') object(result.turn).status = 'TURN_STATUS_' + remote;
    });
    const result = object(await auditCanvas(f.client, request));
    assert.equal(object(result.acceptance).status, expected);
    assert.equal(object(result.turn).complete, false);
    assert.equal(object(result.acceptance).requirements_met, null);
  }
});

test('missing outputs, wrong kinds and exact missing IDs fail expectations instead of selecting a newer candidate', async () => {
  for (const mode of ['missing', 'wrong-kind', 'wrong-id', 'pending', 'superseded']) {
    const f = fixture((method, result) => {
      if (method !== 'ListNodesAssets') return;
      if (mode === 'missing') nodes(result)[0]!.assets = [];
      if (mode === 'wrong-kind') firstAsset(result).kind = 'ASSET_KIND_MODEL';
      if (mode === 'wrong-id') firstAsset(result).assetId = 'different';
      if (mode === 'pending') firstAsset(result).status = 'ASSET_STATUS_PROCESSING';
      if (mode === 'superseded') firstAsset(result).role = 'ASSET_ROLE_SUPERSEDED';
    });
    const result = object(
      await auditCanvas(f.client, {
        ...request,
        expect: [{ nodeId: 'image', kind: 'image', assetIds: ['output'] }],
      }),
    );
    assert.equal(result.artifact_ready, false, mode);
    assert.equal(object(result.acceptance).status, 'blocked', mode);
    assert.ok(
      array(result.issues)
        .map(object)
        .some((issue) => issue.code === 'expected_artifact_unavailable'),
      mode,
    );
  }
});

test('unready inputs are rejected while an unlisted exact mount remains downloadable with unknown readiness', async () => {
  for (const mode of ['pending', 'missing']) {
    const f = fixture((method, result) => {
      if (method === 'GetCanvas')
        object(array(nodes(result)[1]?.inputMount)[0]).status = 'INPUT_ASSET_STATUS_READY';
      if (method === 'BatchGetInputAssets') {
        if (mode === 'pending') object(array(result.assets)[0]).status = 'INPUT_ASSET_STATUS_PROCESSING';
        else result.assets = [];
      }
    });
    const result = object(
      await auditCanvas(f.client, { ...request, expect: [{ nodeId: 'upload', kind: 'image' }] }),
    );
    const asset = object(array(nodes(result)[1]?.assets)[0]);
    assert.equal(result.artifact_ready, mode === 'pending' ? false : null);
    assert.equal(asset.available, mode === 'missing');
    assert.equal(asset.ready, mode === 'pending' ? false : null);
    assert.equal(
      asset.input_metadata_scope,
      mode === 'pending' ? 'current_project' : 'not_in_current_project',
    );
    assert.equal(object(result.acceptance).status, mode === 'pending' ? 'blocked' : 'needs_review');
    assert.equal(
      array(result.next_actions)
        .map(object)
        .some((action) => object(action.parameters).id === 'input'),
      mode === 'missing',
    );
  }
});

test('download guidance prioritizes exact expectations or selected outputs and never promotes superseded or newer assets', async () => {
  for (const mode of ['selected', 'unselected', 'exact', 'missing-exact']) {
    const f = fixture((method, result) => {
      if (method === 'GetCanvas' && mode === 'unselected')
        object(array(result.nodeRuns)[0]).selectedAssetId = '';
      if (method === 'ListNodesAssets') {
        const original = firstAsset(result);
        if (mode === 'unselected') original.selected = false;
        (nodes(result)[0]!.assets as unknown[]).push({
          ...original,
          assetId: 'old',
          selected: false,
          role: 'ASSET_ROLE_SUPERSEDED',
        });
        (nodes(result)[0]!.assets as unknown[]).push({ ...original, assetId: 'alternate', selected: false });
      }
    });
    const expect =
      mode === 'exact' || mode === 'missing-exact'
        ? [{ nodeId: 'image', assetIds: [mode === 'exact' ? 'alternate' : 'absent'] }]
        : [];
    const result = object(await auditCanvas(f.client, { canvasId: 'canvas', expect }));
    const actions = array(result.next_actions)
      .map(object)
      .filter(
        (action) => object(action.parameters).node_id === 'image' || action.command === 'canvas node-assets',
      );
    if (mode === 'missing-exact') assert.equal(actions.length, 0);
    else if (mode === 'unselected') {
      assert.equal(actions[0]?.selection, 'requires_selection');
      assert.deepEqual(actions[0]?.candidate_asset_ids, ['output', 'alternate']);
    } else assert.equal(object(actions[0]?.parameters).id, mode === 'exact' ? 'alternate' : 'output');
    assert.ok(!actions.some((action) => object(action.parameters).id === 'old'));
  }
});

test('scope is explicit, bounded and never silently truncates or accepts an out-of-scope expectation', async () => {
  assert.equal(
    canvasAuditSchema.safeParse({ canvasId: 'canvas', nodeIds: ['image', 'image'] }).success,
    false,
  );
  assert.equal(
    canvasAuditSchema.safeParse({ canvasId: 'canvas', expect: [{ nodeId: 'image', minAssets: 0 }] }).success,
    false,
  );
  await assert.rejects(auditCanvas(fixture().client, { canvasId: 'canvas', nodeIds: ['absent'] }), {
    code: 'CANVAS_CHANGED',
  });
  await assert.rejects(auditCanvas(fixture().client, { ...request, nodeIds: ['upload'] }), {
    code: 'INVALID_INPUT',
  });
  const f = fixture((method, result) => {
    if (method === 'GetCanvas') {
      result.nodes = Array.from({ length: 101 }, (_, index) => ({
        id: 'n' + index,
        type: 'NODE_TYPE_SECTION',
      }));
      result.nodeRuns = [];
    }
  });
  await assert.rejects(auditCanvas(f.client, { canvasId: 'canvas' }), { code: 'AUDIT_SCOPE_REQUIRED' });
  assert.equal(f.calls.includes('ListNodesAssets'), false);
});

test('duplicate, cross-node and cross-session identities fail closed', async () => {
  for (const mode of [
    'canvas',
    'session',
    'turn',
    'message',
    'node',
    'edge',
    'run',
    'output-node',
    'asset-node',
    'asset-duplicate',
  ]) {
    const f = fixture((method, result) => {
      if (mode === 'canvas' && method === 'GetCanvas') object(result.canvas).canvasId = 'other';
      if (mode === 'session' && method === 'GetSession') object(result.session).canvasId = 'other';
      if (mode === 'turn' && method === 'GetTurnDetail') object(result.turn).turnId = 'other';
      if (mode === 'message' && method === 'GetTurnDetail')
        object(array(result.messages)[0]).turnId = 'other';
      if (mode === 'node' && method === 'GetCanvas')
        (result.nodes as unknown[]).push(structuredClone(nodes(result)[0]));
      if (mode === 'edge' && method === 'GetCanvas') result.edges = [{ id: 'same' }, { id: 'same' }];
      if (mode === 'run' && method === 'GetCanvas') object(array(result.nodeRuns)[0]).nodeId = 'absent';
      if (method === 'ListNodesAssets') {
        if (mode === 'output-node') nodes(result)[0]!.nodeId = 'other';
        if (mode === 'asset-node') firstAsset(result).nodeId = 'other';
        if (mode === 'asset-duplicate')
          (nodes(result)[0]!.assets as unknown[]).push(structuredClone(firstAsset(result)));
      }
    });
    await assert.rejects(auditCanvas(f.client, request), { code: 'CONTRACT_CHANGED' }, mode);
  }
  await assert.rejects(auditCanvas(fixture().client, { ...request, sessionId: 'other' }), {
    code: 'CONTRACT_CHANGED',
  });
});

test('graph defects, failed or unknown nodes and contradictory selected assets are reported as blocked', async () => {
  for (const mode of ['edge', 'failed', 'unknown', 'selection']) {
    const f = fixture((method, result) => {
      if (mode === 'edge' && method === 'GetCanvas')
        result.edges = [
          {
            id: 'bad',
            source: { nodeId: 'absent', port: 'image' },
            target: { nodeId: 'image', port: 'image' },
          },
        ];
      if (mode === 'failed' && method === 'GetCanvas')
        object(array(result.nodeRuns)[0]).status = 'NODE_STATUS_FAILED';
      if (mode === 'unknown' && method === 'GetCanvas')
        object(array(result.nodeRuns)[0]).status = 'NODE_STATUS_UNRECOGNIZED';
      if (mode === 'selection' && method === 'ListNodesAssets')
        (nodes(result)[0]!.assets as unknown[]).push({
          ...firstAsset(result),
          assetId: 'another',
          selected: true,
        });
    });
    const result = object(await auditCanvas(f.client, request));
    assert.equal(object(result.acceptance).status, 'blocked', mode);
    assert.ok(array(result.issues).length > 0);
  }
});

test('graph, asset, turn and session drift abort a snapshot and account changes retain account binding', async () => {
  for (const mode of ['graph', 'asset', 'resource', 'turn', 'session', 'account']) {
    const f = fixture((method, result, count, credentials) => {
      if (mode === 'graph' && method === 'GetCanvas' && count === 2) object(result.canvas).revision = '4';
      if (mode === 'asset' && method === 'ListNodesAssets' && count === 2) firstAsset(result).version = 2;
      if (mode === 'resource' && method === 'ListNodesAssets' && count === 2)
        firstAsset(result).url = 'https://cdn.example/replaced.png';
      if (mode === 'turn' && method === 'GetTurnDetail' && count === 2)
        object(array(result.messages)[0]).content = 'Changed answer.';
      if (mode === 'session' && method === 'GetSession' && count === 2)
        object(result.session).activeTurnId = 'other';
      if (mode === 'account' && method === 'GetCanvas')
        credentials.save({ ...credentials.load()!, accountRef: 'other' });
    });
    await assert.rejects(
      auditCanvas(f.client, request),
      { code: mode === 'account' ? 'ACCOUNT_MISMATCH' : 'CANVAS_CHANGED' },
      mode,
    );
  }
});

test('rotating signed download authorization preserves stable content identity while business URL queries do not', async () => {
  const signed = fixture((method, result, count) => {
    if (method === 'ListNodesAssets')
      firstAsset(result).url = `https://cdn.example/output.png?signature=secret-${count}&Expires=${count}`;
  });
  assert.equal(object(object(await auditCanvas(signed.client, request)).snapshot).stable, true);
  const business = fixture((method, result, count) => {
    if (method === 'ListNodesAssets')
      firstAsset(result).url = `https://cdn.example/output.png?version=${count}`;
  });
  await assert.rejects(auditCanvas(business.client, request), { code: 'CANVAS_CHANGED' });
});

function holyFixture(edit?: Edit) {
  return fixture((method, result, count, credentials) => {
    if (method === 'GetCanvas') {
      result.nodes = [
        {
          id: 'game',
          type: 'NODE_TYPE_HOLY_MOLLY',
          params: {
            entry_url: 'https://user:private@play.example/game?signature=private&version=3#private',
            cover_url: 'https://cdn.example/cover.png?signature=private',
            hm_phase: 'testing',
            retryable: false,
          },
        },
      ];
      result.nodeRuns = [
        {
          nodeId: 'game',
          status: 'NODE_STATUS_DONE',
          runId: 'game-run',
          selectedAssetId: 'html',
          credits: { status: 'NODE_CREDITS_STATUS_PENDING', points: '2.50' },
        },
      ];
    }
    if (method === 'ListNodesAssets')
      result.nodes = [
        {
          nodeId: 'game',
          assets: [
            {
              assetId: 'html',
              nodeId: 'game',
              filename: 'game.HTML',
              kind: 'ASSET_KIND_UNSPECIFIED',
              role: 'ASSET_ROLE_CURRENT',
              status: 'ASSET_STATUS_READY',
              selected: true,
              url: 'https://cdn.example/game.html?signature=private',
            },
          ],
        },
      ];
    edit?.(method, result, count, credentials);
  });
}
const holyRequest = { canvasId: 'canvas', turnId: 'turn', expect: [{ nodeId: 'game', kind: 'html' }] };
const gameReport = (result: Record<string, unknown>) => object(nodes(result)[0]?.game);

test('Holy audit separates an HTML suffix candidate, diagnostic preview and pending credits from actual gameplay', async () => {
  const f = holyFixture();
  const result = object(await auditCanvas(f.client, holyRequest));
  const game = gameReport(result),
    html = object(game.html),
    preview = object(game.preview);
  assert.equal(result.artifact_ready, true);
  assert.equal(object(result.execution).complete, true);
  assert.equal(object(result.acceptance).requirements_met, null);
  assert.equal(object(result.acceptance).gameplay_review, 'required');
  assert.equal(object(result.acceptance).status, 'needs_review');
  assert.equal(game.phase, 'testing');
  assert.equal(game.phase_source, 'saved_node_params');
  assert.equal(game.retryable, false);
  assert.deepEqual(html.candidate_asset_ids, ['html']);
  assert.deepEqual(html.available_asset_ids, ['html']);
  assert.equal(html.selected_asset_id, 'html');
  assert.equal(html.kind_evidence, 'url_path_extension_then_filename');
  assert.equal(html.bytes_verified, false);
  assert.equal(html.dependencies_verified, false);
  assert.equal(game.playability_verified, false);
  assert.equal(preview.entry_url_present, true);
  assert.equal(preview.entry_url_https, true);
  assert.equal(preview.entry_url, 'https://play.example/game');
  assert.equal(preview.cover_url, 'https://cdn.example/cover.png');
  assert.equal(preview.url_scope, 'diagnostic_only_incomplete_navigation');
  assert.equal(preview.navigation_verified, false);
  assert.doesNotMatch(JSON.stringify(result), /private|signature|version=|user:/);
  assert.deepEqual(game.credits, {
    source: 'canvas_node_run',
    node_id: 'game',
    run_id: 'game-run',
    status: 'NODE_CREDITS_STATUS_PENDING',
    points: '2.50',
    contract_valid: true,
    turn_attribution: 'unknown',
    attribution_scope: 'node_run_record',
    ledger_attribution: 'not_checked',
  });
  const actions = array(result.next_actions).map(object);
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.command, 'studio asset-download');
  assert.deepEqual(actions[0]?.parameters, { kind: 'canvas_node', id: 'html', node_id: 'game' });
  assert.match(String(actions[0]?.purpose), /without executing/);
  assert.ok(
    f.calls.every((method) =>
      ['GetCanvas', 'GetTurnDetail', 'GetSession', 'ListNodesAssets', 'GetRun'].includes(method),
    ),
  );
});

test('Holy audit uses the download URL path before filename and ignores query, MIME and unsafe URL hints', async () => {
  const cases = [
    { url: 'https://cdn.example/index.html?signature=private', filename: undefined, html: true },
    { url: 'https://cdn.example/index.HTML#private', filename: 'cover.png', html: true },
    { url: 'https://cdn.example/download?signature=private', filename: ' game.htm ', html: true },
    { url: 'https://cdn.example/cover.png?name=index.html', filename: 'game.html', html: false },
    { url: 'https://cdn.example/download?filename=index.html', filename: undefined, html: false },
    { url: 'https://cdn.example/download#index.html', filename: undefined, html: false },
    { url: 'https://cdn.example/index.html/preview', filename: undefined, html: false },
    { url: 'https://cdn.example/index%2ehtml', filename: undefined, html: false },
    { url: '/index.html', filename: 'game.html', html: false },
    { url: 'javascript:game.html', filename: 'game.html', html: false },
    { url: 'data:text/html,index.html', filename: 'game.html', html: false },
  ];
  for (const scenario of cases) {
    const f = holyFixture((method, result) => {
      if (method !== 'ListNodesAssets') return;
      const asset = firstAsset(result);
      asset.url = scenario.url;
      asset.filename = scenario.filename;
      asset.kind = 'ASSET_KIND_UNSPECIFIED';
      asset.mimeType = 'text/html';
      delete asset.status;
    });
    const result = object(await auditCanvas(f.client, holyRequest)),
      html = object(gameReport(result).html);
    assert.deepEqual(html.candidate_asset_ids, scenario.html ? ['html'] : [], scenario.url);
    assert.equal(result.artifact_ready, scenario.html, scenario.url);
    assert.equal(html.bytes_verified, false);
    assert.equal(html.dependencies_verified, false);
    assert.equal(gameReport(result).playability_verified, false);
    assert.equal(object(result.acceptance).requirements_met, null);
    assert.doesNotMatch(JSON.stringify(result), /private|signature|mimeType/);
    assert.equal(object(array(nodes(result)[0]?.assets)[0]).url, undefined);
    if (scenario.html) {
      const content = canvasArtifactContent(scenario.url, scenario.filename ?? '', 'ASSET_KIND_UNSPECIFIED');
      assert.ok(['html', 'htm'].includes(content.format));
      assert.deepEqual(content.content_hint, { kind: 'file' });
      const action = object(array(result.next_actions)[0]);
      assert.deepEqual(action.parameters, { kind: 'canvas_node', id: 'html', node_id: 'game' });
    } else assert.deepEqual(result.next_actions, []);
  }
});

test('an HTML filename without a download URL remains an unavailable candidate without selecting a replacement', async () => {
  const f = holyFixture((method, result) => {
    if (method === 'ListNodesAssets') delete firstAsset(result).url;
  });
  const result = object(await auditCanvas(f.client, holyRequest)),
    html = object(gameReport(result).html);
  assert.deepEqual(html.candidate_asset_ids, ['html']);
  assert.deepEqual(html.available_asset_ids, []);
  assert.equal(html.selected_asset_id, 'html');
  assert.equal(html.selection, 'selected_unavailable');
  assert.equal(result.artifact_ready, false);
  assert.deepEqual(result.next_actions, []);
});

test('Holy preview diagnostics canonicalize nonstandard URLs before removing credentials and signatures', async () => {
  for (const entry of [
    'https:/user:private@play.example/game?signature=private#private',
    'https:\\user:private@play.example/game?signature=private#private',
    'HTTPS://user:private@play.example/game?signature=private#private',
  ]) {
    const f = holyFixture((method, result) => {
      if (method === 'GetCanvas') object(nodes(result)[0]?.params).entry_url = entry;
    });
    const result = object(await auditCanvas(f.client, holyRequest));
    assert.equal(object(gameReport(result).preview).entry_url, 'https://play.example/game');
    assert.doesNotMatch(JSON.stringify(result), /private|signature|user:/);
  }
});

test('Holy HTML candidates honor current roles and suffixes without guessing the first or newest output', async () => {
  for (const mode of [
    'unselected',
    'explicit',
    'ambiguous',
    'current-cover',
    'superseded',
    'wrong-extension',
    'mime-only',
    'unspecified',
  ]) {
    const f = holyFixture((method, result) => {
      if (method === 'GetCanvas') object(array(result.nodeRuns)[0]).selectedAssetId = '';
      if (method !== 'ListNodesAssets') return;
      const asset = firstAsset(result);
      asset.selected = mode === 'ambiguous';
      asset.role = mode === 'superseded' ? 'ASSET_ROLE_SUPERSEDED' : 'ASSET_ROLE_UNSPECIFIED';
      if (mode === 'wrong-extension') {
        asset.filename = 'game.html.png';
        asset.url = 'https://cdn.example/game.html.png';
      }
      if (mode === 'mime-only') {
        asset.filename = 'game';
        asset.kind = 'text/html';
        asset.url = 'https://cdn.example/download';
      }
      if (mode === 'unspecified') asset.filename = ' game.htm ';
      if (['unselected', 'explicit', 'ambiguous'].includes(mode))
        (nodes(result)[0]!.assets as unknown[]).push({ ...asset, assetId: 'second', slotIndex: -1 });
      if (mode === 'current-cover')
        (nodes(result)[0]!.assets as unknown[]).push({
          ...asset,
          assetId: 'cover',
          filename: 'cover.png',
          url: 'https://cdn.example/cover.png',
          role: 'ASSET_ROLE_CURRENT',
          kind: 'ASSET_KIND_IMAGE',
        });
    });
    const expect = [
      { nodeId: 'game', kind: 'html', ...(mode === 'explicit' ? { assetIds: ['second'] } : {}) },
    ];
    const result = object(await auditCanvas(f.client, { ...holyRequest, expect }));
    const game = gameReport(result),
      html = object(game.html),
      actions = array(result.next_actions).map(object);
    if (['current-cover', 'superseded', 'wrong-extension', 'mime-only'].includes(mode)) {
      assert.deepEqual(html.candidate_asset_ids, [], mode);
      assert.equal(result.artifact_ready, false, mode);
      assert.equal(nodes(result)[0]?.artifact_ready, false, mode);
      assert.equal(actions.length, 0, mode);
    } else {
      assert.equal(result.artifact_ready, true, mode);
      assert.equal(html.selected_asset_id, null, mode);
      if (mode === 'explicit') {
        assert.equal(actions[0]?.selection, 'explicit_expectation');
        assert.equal(object(actions[0]?.parameters).id, 'second');
      } else {
        assert.equal(actions[0]?.command, 'canvas node-assets', mode);
        assert.equal(actions[0]?.selection, 'requires_selection', mode);
        assert.equal(html.selection, mode === 'ambiguous' ? 'ambiguous' : 'requires_selection', mode);
      }
    }
  }
});

test('Holy preview presence is independent from HTML bytes and unsafe URLs are not returned as navigation', async () => {
  for (const entry of [
    'https://play.example/game',
    'http://play.example/game',
    'javascript:alert(1)',
    'invalid',
    '',
  ]) {
    const f = holyFixture((method, result) => {
      if (method === 'GetCanvas') {
        object(nodes(result)[0]?.params).entry_url = entry;
        object(array(result.nodeRuns)[0]).selectedAssetId = '';
      }
      if (method === 'ListNodesAssets') nodes(result)[0]!.assets = [];
    });
    const result = object(await auditCanvas(f.client, holyRequest));
    const preview = object(gameReport(result).preview);
    assert.equal(result.artifact_ready, false, entry);
    assert.equal(preview.entry_url_present, Boolean(entry), entry);
    assert.equal(preview.entry_url_https, entry.startsWith('https:'), entry);
    assert.equal(preview.entry_url, entry.startsWith('http') ? entry : null, entry);
    assert.equal(preview.navigation_verified, false, entry);
    assert.equal(gameReport(result).playability_verified, false, entry);
    assert.equal(array(result.next_actions).length, 0, entry);
  }
});

test('an unavailable selected HTML keeps its identity and is never replaced with another downloadable game', async () => {
  const f = holyFixture((method, result) => {
    if (method !== 'ListNodesAssets') return;
    const original = firstAsset(result);
    (nodes(result)[0]!.assets as unknown[]).push({ ...original, assetId: 'alternate', selected: false });
    original.status = 'ASSET_STATUS_PROCESSING';
  });
  const result = object(
    await auditCanvas(f.client, {
      ...holyRequest,
      expect: [{ nodeId: 'game', kind: 'html', assetIds: ['html'] }],
    }),
  );
  const html = object(gameReport(result).html);
  assert.deepEqual(html.candidate_asset_ids, ['html', 'alternate']);
  assert.deepEqual(html.available_asset_ids, ['alternate']);
  assert.equal(html.selected_asset_id, 'html');
  assert.equal(html.selection, 'selected_unavailable');
  assert.equal(result.artifact_ready, false);
  assert.equal(object(result.acceptance).status, 'blocked');
  assert.equal(array(result.next_actions).length, 0);
});

test('Holy credit metadata preserves decimal strings and unknown settlement without inferring free or turn-attributed charges', async () => {
  const cases = [
    { raw: undefined, status: null, points: null, valid: null },
    { raw: { status: 'SETTLED', points: '0' }, status: 'SETTLED', points: '0', valid: true },
    {
      raw: { status: 'SETTLED', points: '12345678901234567890.10' },
      status: 'SETTLED',
      points: '12345678901234567890.10',
      valid: true,
    },
    { raw: { status: 'SETTLED', points: 2 }, status: null, points: null, valid: false },
    { raw: { status: 'SETTLED', points: '01' }, status: null, points: null, valid: false },
    { raw: { status: 'SETTLED', points: '-1' }, status: null, points: null, valid: false },
    { raw: { status: 'PENDING' }, status: 'PENDING', points: null, valid: true },
    { raw: { status: 'PENDING', points: '0.25' }, status: 'PENDING', points: '0.25', valid: true },
    { raw: { status: 'PENDING', points: 'NaN' }, status: 'PENDING', points: null, valid: true },
    { raw: { status: 'REVERSED', points: '100' }, status: 'REVERSED', points: null, valid: true },
    { raw: { status: 'UNKNOWN', points: '100' }, status: 'UNKNOWN', points: null, valid: true },
    { raw: { status: 'FUTURE', points: '100' }, status: null, points: null, valid: false },
  ];
  for (const scenario of cases) {
    const f = holyFixture((method, result) => {
      if (method !== 'GetCanvas') return;
      const run = object(array(result.nodeRuns)[0]);
      if (!scenario.raw) delete run.credits;
      else run.credits = { ...scenario.raw, status: 'NODE_CREDITS_STATUS_' + scenario.raw.status };
    });
    const result = object(await auditCanvas(f.client, holyRequest));
    const credits = object(gameReport(result).credits);
    assert.equal(credits.status, scenario.status ? 'NODE_CREDITS_STATUS_' + scenario.status : null);
    assert.equal(credits.points, scenario.points);
    assert.equal(credits.contract_valid, scenario.valid);
    assert.equal(credits.turn_attribution, 'unknown');
    assert.equal(credits.run_id, 'game-run');
    assert.equal(object(result.acceptance).requirements_met, null);
  }
});

test('Holy phase, preview identity, HTML classification and billing are included in the stable audit snapshot', async () => {
  for (const mode of ['phase', 'entry', 'filename', 'role', 'credits']) {
    const f = holyFixture((method, result, count) => {
      if (count !== 2) return;
      if (method === 'GetCanvas') {
        if (mode === 'phase') object(nodes(result)[0]?.params).hm_phase = 'building';
        if (mode === 'entry') object(nodes(result)[0]?.params).entry_url = 'https://play.example/other-game';
        if (mode === 'credits') object(object(array(result.nodeRuns)[0]).credits).points = '3';
      }
      if (method === 'ListNodesAssets') {
        if (mode === 'filename') firstAsset(result).filename = 'cover.png';
        if (mode === 'role') firstAsset(result).role = 'ASSET_ROLE_SUPERSEDED';
      }
    });
    await assert.rejects(auditCanvas(f.client, holyRequest), { code: 'CANVAS_CHANGED' }, mode);
  }
  const f = holyFixture((method, result, count) => {
    if (method === 'GetCanvas')
      object(nodes(result)[0]?.params).entry_url =
        `https://play.example/game?signature=private-${count}&Expires=${count}&version=3`;
  });
  assert.equal(object(object(await auditCanvas(f.client, holyRequest)).snapshot).stable, true);
});
