/** 对照网页 Canvas 附件和确认部件契约，验证来源不丢失且失效节点不触发创作提交。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { submitCreativeTask } from '../studio/api/canvas-agent.ts';
import { StudioClient } from '../studio/api/client.ts';
import { Operations } from '../studio/api/operations.ts';
import { canvasGraphIssues } from '../studio/api/canvas-graph.ts';
import { callCanvas, canvasResources, canvasSaveSchema } from '../studio/api/canvas.ts';
import { prepareCanvasRun } from '../studio/api/canvas-run.ts';
import { editCanvas } from '../cli/local/canvas-edit.ts';
import type { ImageReference } from '../studio/api/upload.ts';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { canvasAgentSchemas } from '../studio/contracts/canvas-agent.ts';
import { object } from '../studio/contracts/errors.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import type { Job, Operation } from '../studio/contracts/types.ts';
import { quote } from './helpers.ts';

const turnInput = { accept_variable_cost: true, session_id: 'session', text: 'Describe these attachments.' };
const turnJob = (parameters: Record<string, unknown>): Job => ({
  job_id: 'job',
  account_ref: 'test-account',
  request_id: 'request',
  input_hash: 'input',
  operation: 'canvas_turn',
  input: normalize('canvas_turn', { ...turnInput, ...parameters }),
  contract_version: 'test',
  state: 'submitting',
  remote_ids: {},
  quote,
  progress: 0,
  artifacts: [],
  created_at: '',
  updated_at: '',
  lease_until: 0,
});

function client(handler: (method: string, body: Record<string, unknown>) => unknown): StudioClient {
  const bearer =
    'eyJhbGciOiJIUzI1NiJ9.' +
    Buffer.from(JSON.stringify({ sub: 'test-account', exp: Math.floor(Date.now() / 1000) + 3600 })).toString(
      'base64url',
    ) +
    '.fixture';
  return new StudioClient(
    new MemoryCredentials({ accountRef: 'test-account', bearer, deviceId: 'device', importedAt: '' }),
    async (url, init) => {
      assert.equal(url, 'https://msapi.tripo3d.ai/ms/web/api');
      const method = String(object(init.headers)['x-micro-method']).split('/').at(-1)!;
      return Response.json({
        error: { code: 0, message: '' },
        ...object(handler(method, object(JSON.parse(String(init.body))))),
      });
    },
  );
}

const operationJob = (operation: Operation, input: Record<string, unknown>): Job => ({
  ...turnJob({}),
  operation,
  input: normalize(operation, input),
});
function restClient(handler: (route: string, body: Record<string, unknown>) => unknown): StudioClient {
  return new StudioClient(
    new MemoryCredentials({
      accountRef: 'test-account',
      cookie: 'fixture',
      deviceId: 'device',
      importedAt: '',
    }),
    async (url, init) =>
      Response.json({
        code: 0,
        data: handler(new URL(url).pathname, object(init.body ? JSON.parse(String(init.body)) : {})),
      }),
  );
}

test('Canvas references preserve ordered attachment identity and reject conflicting legacy IDs', () => {
  const refs = [
    { asset_id: 'asset', node_id: 'left', filename: ' Left.glb ', kind: 'model' },
    { asset_id: 'asset', node_id: 'right', filename: 'Right.glb', kind: 'model' },
  ];
  assert.deepEqual(turnJob({ refs, attachment_ids: ['asset', 'asset'] }).input.refs, [
    { ...refs[0], filename: 'Left.glb' },
    refs[1],
  ]);
  for (const attachment_ids of [['other'], ['asset'], ['asset', 'other']])
    assert.throws(() => turnJob({ refs, attachment_ids }), /must match refs/);
  assert.throws(() => turnJob({ refs: [{ asset_id: 'asset', uploaded_files: [] }] }));
  assert.throws(() => turnJob({ refs, asset_ids: ['asset'] }));
  assert.ok(object(z.toJSONSchema(canvasAgentSchemas.canvas_turn).properties).refs);
});

test('Canvas CreateTurn sends every reference and checks source nodes in the session canvas first', async () => {
  const calls: string[] = [];
  const refs = [
    { asset_id: 'shared', filename: 'Left.glb', kind: 'model', node_id: 'left' },
    { asset_id: 'shared', filename: 'Right.glb', kind: 'model', node_id: 'right' },
    { asset_id: 'uploaded', filename: 'photo.png', kind: 'image/png' },
  ];
  const gateway = client((method, body) => {
    calls.push(method);
    if (method === 'GetSession') {
      assert.deepEqual(body, { sessionId: 'session' });
      return { session: { sessionId: 'session', canvasId: 'canvas' } };
    }
    if (method === 'GetCanvas') {
      assert.deepEqual(body, { canvasId: 'canvas' });
      return {
        canvas: { canvasId: 'canvas', projectId: 'project' },
        nodes: [
          { id: 'left', type: 'NODE_TYPE_GENERATE_HD_MODEL' },
          { id: 'right', type: 'NODE_TYPE_GENERATE_HD_MODEL' },
        ],
      };
    }
    if (method === 'BatchGetInputAssets') {
      assert.deepEqual(body, { projectId: 'project', assetIds: ['uploaded'] });
      return { assets: [{ assetId: 'uploaded', status: 'INPUT_ASSET_STATUS_READY' }] };
    }
    if (method === 'ListNodesAssets') {
      assert.deepEqual(body, { nodeIds: ['left', 'right'] });
      return {
        nodes: ['left', 'right'].map((nodeId) => ({
          nodeId,
          assets: [{ nodeId, assetId: 'shared', url: 'https://cdn.tripo3d.ai/shared.glb' }],
        })),
      };
    }
    assert.equal(method, 'CreateTurn');
    assert.deepEqual(body, {
      sessionId: 'session',
      text: turnInput.text,
      mode: 'MODE_CONTROL',
      nodeId: '',
      attachmentIds: ['shared', 'shared', 'uploaded'],
      refs: [
        { assetId: 'shared', filename: 'Left.glb', kind: 'model', nodeId: 'left' },
        { assetId: 'shared', filename: 'Right.glb', kind: 'model', nodeId: 'right' },
        { assetId: 'uploaded', filename: 'photo.png', kind: 'image/png' },
      ],
    });
    return { turnId: 'turn' };
  });
  assert.deepEqual(await submitCreativeTask(gateway, turnJob({ refs })), { remote_ids: { task_id: 'turn' } });
  assert.deepEqual(calls, [
    'GetSession',
    'GetCanvas',
    'BatchGetInputAssets',
    'ListNodesAssets',
    'CreateTurn',
  ]);
});

test('uploaded references retain the webpage kind normalization without requiring a source node', async () => {
  const inputs = ['image/png', `image/${'x'.repeat(40)}`, `model/${'x'.repeat(40)}`, 'x'.repeat(33)];
  const expected = ['image/png', 'image', 'model', 'file'];
  let submissions = 0;
  const gateway = client((method, body) => {
    if (method === 'GetSession') return { session: { sessionId: 'session', canvasId: 'canvas' } };
    if (method === 'GetCanvas') return { canvas: { canvasId: 'canvas', projectId: 'project' }, nodes: [] };
    if (method === 'BatchGetInputAssets') {
      assert.deepEqual(body, { projectId: 'project', assetIds: ['asset'] });
      return { assets: [{ assetId: 'asset', status: 'INPUT_ASSET_STATUS_READY' }] };
    }
    assert.equal(method, 'CreateTurn');
    assert.deepEqual(body.attachmentIds, ['asset']);
    assert.deepEqual(body.refs, [{ assetId: 'asset', kind: expected[submissions++] }]);
    return { turnId: 'turn' };
  });
  for (const kind of inputs)
    await submitCreativeTask(gateway, turnJob({ refs: [{ asset_id: 'asset', kind }] }));
  assert.equal(submissions, 4);
});

test('attachment-only turns keep their request shape while checking independent uploads', async () => {
  let submitted = 0;
  const gateway = client((method, body) => {
    if (method === 'GetSession') return { session: { sessionId: 'session', canvasId: 'canvas' } };
    if (method === 'GetCanvas') return { canvas: { canvasId: 'canvas', projectId: 'project' }, nodes: [] };
    if (method === 'BatchGetInputAssets') {
      assert.deepEqual(body, { projectId: 'project', assetIds: ['existing'] });
      return { assets: [{ assetId: 'existing', status: 'INPUT_ASSET_STATUS_READY' }] };
    }
    assert.equal(method, 'CreateTurn');
    assert.deepEqual(body.attachmentIds, ['existing']);
    assert.equal(Object.hasOwn(body, 'refs'), false);
    submitted++;
    return { id: 'turn' };
  });
  const job = turnJob({ attachment_ids: ['existing'] });
  assert.equal(Object.hasOwn(job.input, 'refs'), false);
  await submitCreativeTask(gateway, job);
  assert.equal(submitted, 1);
});

test('wrong-session, wrong-canvas and removed-node references never reach CreateTurn', async () => {
  for (const failure of ['session', 'canvas', 'node']) {
    const calls: string[] = [];
    const gateway = client((method) => {
      calls.push(method);
      if (method === 'GetSession')
        return { session: { sessionId: failure === 'session' ? 'other' : 'session', canvasId: 'canvas' } };
      if (method === 'GetCanvas')
        return {
          canvas: { canvasId: failure === 'canvas' ? 'other' : 'canvas' },
          nodes: [{ id: failure === 'node' ? 'other' : 'node' }],
        };
      assert.fail('Invalid references must not submit a turn.');
    });
    await assert.rejects(
      submitCreativeTask(gateway, turnJob({ refs: [{ asset_id: 'asset', node_id: 'node' }] })),
      { code: failure === 'node' ? 'CANVAS_CHANGED' : 'CONTRACT_CHANGED', certainty: 'not_submitted' },
    );
    assert.equal(calls.includes('CreateTurn'), false);
  }
});

test('uploaded node references require a ready input asset in the session project before creating a turn', async () => {
  for (const scenario of ['ready', 'cross-project', 'pending', 'wrong-mount']) {
    const calls: string[] = [];
    const gateway = client((method, body) => {
      calls.push(method);
      if (method === 'GetSession') return { session: { sessionId: 'session', canvasId: 'canvas' } };
      if (method === 'GetCanvas')
        return {
          canvas: { canvasId: 'canvas', projectId: 'current-project' },
          nodes: [
            {
              id: 'upload',
              type: 'NODE_TYPE_UPLOAD_CARD',
              inputMount: [{ assetId: scenario === 'wrong-mount' ? 'other' : 'asset' }],
            },
          ],
        };
      if (method === 'BatchGetInputAssets') {
        assert.deepEqual(body, { projectId: 'current-project', assetIds: ['asset'] });
        return {
          assets:
            scenario === 'cross-project'
              ? []
              : [
                  {
                    assetId: 'asset',
                    status:
                      scenario === 'ready' ? 'INPUT_ASSET_STATUS_READY' : 'INPUT_ASSET_STATUS_PROCESSING',
                  },
                ],
        };
      }
      assert.equal(method, 'CreateTurn');
      assert.equal(scenario, 'ready');
      return { turnId: 'turn' };
    });
    const job = turnJob({ refs: [{ asset_id: 'asset', node_id: 'upload' }] });
    if (scenario === 'ready') await submitCreativeTask(gateway, job);
    else
      await assert.rejects(submitCreativeTask(gateway, job), {
        code: scenario === 'wrong-mount' ? 'CANVAS_CHANGED' : 'INPUT_NOT_READY',
        certainty: 'not_submitted',
      });
    assert.equal(calls.includes('CreateTurn'), scenario === 'ready');
    assert.equal(calls.includes('ListNodesAssets'), false);
  }
});

test('generated references verify asset and node identities without using the input asset service', async () => {
  for (const mismatch of ['asset', 'node', 'url']) {
    const calls: string[] = [];
    const gateway = client((method) => {
      calls.push(method);
      if (method === 'GetSession') return { session: { sessionId: 'session', canvasId: 'canvas' } };
      if (method === 'GetCanvas')
        return {
          canvas: { canvasId: 'canvas', projectId: 'project' },
          nodes: [{ id: 'node', type: 'NODE_TYPE_GENERATE_IMAGE' }],
        };
      assert.equal(method, 'ListNodesAssets');
      return {
        nodes: [
          {
            nodeId: 'node',
            assets: [
              {
                nodeId: mismatch === 'node' ? 'other' : 'node',
                assetId: mismatch === 'asset' ? 'other' : 'asset',
                url: mismatch === 'url' ? '' : 'https://cdn.tripo3d.ai/image.png',
              },
            ],
          },
        ],
      };
    });
    await assert.rejects(
      submitCreativeTask(gateway, turnJob({ refs: [{ asset_id: 'asset', node_id: 'node' }] })),
      { code: 'INPUT_NOT_READY', certainty: 'not_submitted' },
    );
    assert.equal(calls.includes('CreateTurn'), false);
    assert.equal(calls.includes('BatchGetInputAssets'), false);
  }
});

test('confirmed part names match webpage uniqueness, Unicode and count boundaries', () => {
  const input = { accept_variable_cost: true, turn_id: 'turn' };
  const parts = ['😀'.repeat(200), ' head '];
  assert.deepEqual(normalize('canvas_continue', { ...input, confirmed_parts: parts }).confirmed_parts, [
    parts[0],
    'head',
  ]);
  for (const confirmed_parts of [
    ['head', ' head '],
    ['😀'.repeat(201)],
    [' '],
    [],
    Array.from({ length: 13 }, (_, index) => `part-${index}`),
  ])
    assert.throws(() => normalize('canvas_continue', { ...input, confirmed_parts }));
  assert.equal(
    (
      normalize('canvas_continue', {
        ...input,
        confirmed_parts: Array.from({ length: 12 }, (_, index) => `part-${index}`),
      }).confirmed_parts as unknown[]
    ).length,
    12,
  );
});

test('Canvas extraction parts match webpage bounds before requests or quantity-based pricing', () => {
  const input = { canvas_id: 'canvas', revision: '1', node_ids: ['extract'] };
  const parts = ['😀'.repeat(200), ' leg '];
  assert.deepEqual(normalize('canvas_run', { ...input, parts }).parts, [parts[0], 'leg']);
  for (const parts of [
    ['leg', ' leg '],
    ['😀'.repeat(201)],
    [' '],
    [],
    Array.from({ length: 13 }, (_, index) => `part-${index}`),
  ])
    assert.throws(() => normalize('canvas_run', { ...input, parts }));
  for (const action of ['retry', 'detect']) {
    assert.throws(() => normalize('canvas_run', { ...input, action, parts: ['leg'] }), /parts only/);
    assert.equal(normalize('canvas_run', { ...input, action }).action, action);
  }
  assert.throws(
    () => normalize('canvas_run', { ...input, node_ids: ['extract', 'extract'] }),
    /node IDs must be unique/,
  );
});

test('mixed image references preserve edit roles and multiview holes through native request mapping', async () => {
  const assetReads: string[] = [];
  const gateway = restClient((route, body) => {
    assert.equal(route, '/v2/studio/image/get_image_asset');
    assetReads.push(String(body.asset_id));
    return {
      asset_id: body.asset_id,
      status: 'success',
      output: {
        data: [0, 1].map((index) => ({
          bucket: 'bucket',
          key: `${body.asset_id}-${index}`,
          image_audit_result: 'pass',
        })),
      },
    };
  });
  class LocalFiles extends Operations {
    override async imageReference(input: Record<string, unknown>, file?: string): Promise<ImageReference> {
      if (!file) return await super.imageReference(input);
      assert.equal(object(input._input_files)[file], 'frozen-file-hash');
      return { bucket: 'bucket', key: 'uploaded-file', image_audit_result: 'pass', image_source: 'upload' };
    }
  }
  const operations = new LocalFiles(gateway, []);
  const primary = { asset_id: 'primary' },
    reference = { asset_id: 'reference', output_index: 1 },
    file = { image_path: '/caller/file.png' };
  const image = operationJob('image', {
    prompt: 'restyle',
    image_asset: primary,
    image_sources: [reference, file],
  });
  image.input._input_files = { [file.image_path]: 'frozen-file-hash' };
  const edited = await operations.build(image);
  assert.equal(object(edited.body.image).key, 'primary-0');
  assert.deepEqual(
    (edited.body.images as Record<string, unknown>[]).map((ref) => [ref.key, ref.image_source]),
    [
      ['reference-1', 'generate'],
      ['uploaded-file', 'upload'],
    ],
  );
  const views = operationJob('model', { mode: 'multiview', image_sources: [file, null, reference, null] });
  views.input._input_files = { [file.image_path]: 'frozen-file-hash' };
  const model = await operations.build(views);
  assert.ok(model.route.endsWith('/multiview_to_model'));
  assert.deepEqual(
    (model.body.image as (Record<string, unknown> | null)[]).map((ref) => ref?.key ?? null),
    ['uploaded-file', null, 'reference-1', null],
  );
  const batch = operationJob('model', { mode: 'batch', image_sources: [reference, file] });
  batch.input._input_files = { [file.image_path]: 'frozen-file-hash' };
  assert.ok((await operations.build(batch)).route.endsWith('/batch_image_to_model'));
  assert.deepEqual(assetReads.sort(), ['primary', 'reference', 'reference', 'reference']);
});

test('mixed references reject ambiguous or empty roles and keep asset audit checks', async () => {
  const ref = { asset_id: 'asset' },
    file = { image_path: 'file.png' };
  for (const parameters of [
    { image_sources: [ref], image_assets: [ref] },
    { image_sources: [ref], image_paths: ['file.png'] },
    { image_sources: [{ ...ref, ...file }] },
    { image_sources: [null] },
    { model_version: 'midjourney', image_sources: [ref] },
  ])
    assert.throws(() => normalize('image', { prompt: 'test', ...parameters }));
  for (const parameters of [
    { mode: 'multiview', image_sources: [null, file, ref] },
    { mode: 'multiview', image_sources: [file, null, null, null] },
    { mode: 'multiview', image_sources: [file, ref, null, null, ref] },
    { mode: 'batch', image_sources: [file, null, ref] },
    { mode: 'image', image_sources: [ref] },
    { mode: 'text', prompt: 'test', image_sources: [ref] },
  ])
    assert.throws(() => normalize('model', parameters));
  const operations = new Operations(
    restClient((_route, body) => ({
      asset_id: body.asset_id,
      status: 'success',
      output: { data: [{ bucket: 'bucket', key: 'key', image_audit_result: 'reject' }] },
    })),
    [],
  );
  await assert.rejects(operations.build(operationJob('image', { prompt: 'test', image_sources: [ref] })), {
    code: 'CONTENT_AUDIT_REJECTED',
  });
});

test('rig schemas reject inactive specs while auto precheck preserves valid creature defaults', async () => {
  for (const input of [
    { rig_type: 'quadruped', skeleton_preset: 'unreal' },
    { rig_type: 'biped', skeleton_preset: 'unreal', model_version: 'v2.5-20260210' },
    { rig_type: 'quadruped', model_version: 'v1.0-20240301' },
    { rig_type: 'others', model_version: 'v2.5-20260210' },
  ])
    assert.throws(() => normalize('rig', { project_id: 'project', ...input }));
  let bodyType = 'quadruped';
  const operations = new Operations(
    restClient((route) =>
      route.endsWith('/pre_rig_check')
        ? { riggable: true, rig_type: bodyType }
        : { id: 'project', operator: { is_owner: true, is_textured: true, status: 'success' } },
    ),
    [],
  );
  const defaults = await operations.build(operationJob('rig', { project_id: 'project', rig_type: 'auto' }));
  assert.equal(defaults.body.rig_type, 'quadruped');
  assert.equal(defaults.body.spec, undefined);
  await assert.rejects(
    operations.build(
      operationJob('rig', { project_id: 'project', rig_type: 'auto', skeleton_preset: 'unreal' }),
    ),
    { code: 'INVALID_INPUT', certainty: 'not_submitted' },
  );
  await assert.rejects(
    operations.build(
      operationJob('rig', { project_id: 'project', rig_type: 'auto', model_version: 'v1.0-20240301' }),
    ),
    { code: 'INVALID_INPUT' },
  );
  bodyType = 'unknown';
  await assert.rejects(
    operations.build(operationJob('rig', { project_id: 'project', rig_type: 'auto', force: true })),
    { code: 'INPUT_NOT_READY' },
  );
  bodyType = 'biped';
  assert.equal(
    (
      await operations.build(
        operationJob('rig', { project_id: 'project', rig_type: 'auto', skeleton_preset: 'unreal' }),
      )
    ).body.spec,
    'unreal',
  );
});

test('preset families and generated motion are checked against the project rig without silent overrides', async () => {
  assert.equal(
    normalize('animate', { project_id: 'project', animation: 'preset:quadruped:walk' }).rig_type,
    'quadruped',
  );
  assert.throws(
    () =>
      normalize('animate', { project_id: 'project', animation: 'preset:quadruped:walk', rig_type: 'biped' }),
    /must match/,
  );
  assert.throws(
    () => normalize('animate', { project_id: 'project', motion_asset_id: 'motion', rig_type: 'quadruped' }),
    /biped/,
  );
  let bodyType = 'quadruped';
  const operations = new Operations(
    restClient(() => ({
      id: 'project',
      operator: {
        is_owner: true,
        is_textured: true,
        is_rigged: true,
        status: 'success',
        rigging: { type: bodyType },
      },
    })),
    [],
  );
  assert.equal(
    (
      await operations.build(
        operationJob('animate', { project_id: 'project', animation: 'preset:quadruped:walk' }),
      )
    ).body.rig_type,
    'quadruped',
  );
  await assert.rejects(
    operations.build(operationJob('animate', { project_id: 'project', animation: 'preset:biped:walk' })),
    { code: 'INVALID_INPUT' },
  );
  await assert.rejects(
    operations.build(operationJob('animate', { project_id: 'project', motion_asset_id: 'motion' })),
    { code: 'INVALID_INPUT' },
  );
  bodyType = '';
  await assert.rejects(
    operations.build(operationJob('animate', { project_id: 'project', motion_asset_id: 'motion' })),
    { code: 'INPUT_NOT_READY' },
  );
  bodyType = 'biped';
  const result = await operations.build(
    operationJob('animate', { project_id: 'project', motion_asset_id: 'motion' }),
  );
  assert.equal(result.body.motion_asset_id, 'motion');
  assert.equal(result.body.rig_type, 'biped');
});

test('Lab graphs type selected output and retain only evidenced legacy ports and empty graph planning', () => {
  const target = { id: 'target', type: 'NODE_TYPE_RIGGING' };
  const lab = { id: 'lab', type: 'NODE_TYPE_AI_3D_LAB' };
  const connect = (nodeAssets: unknown[] | undefined, port = 'output') =>
    canvasGraphIssues(
      [{ ...lab, nodeAssets }, target],
      [{ id: 'edge', source: { nodeId: 'lab', port }, target: { nodeId: 'target', port: 'model' } }],
    );
  assert.deepEqual(connect([]), []);
  const selected = { assetId: 'asset', kind: 'ASSET_KIND_MODEL', selected: true };
  assert.deepEqual(connect([selected]), []);
  assert.deepEqual(connect([selected], ''), []);
  assert.deepEqual(connect([{ assetId: 'asset', selected: true, filename: 'result.glb' }]), []);
  assert.match(connect([{ ...selected, kind: 'ASSET_KIND_IMAGE' }]).join(' '), /incompatible/);
  for (const port of ['image', 'model'])
    assert.match(connect([selected], port).join(' '), /invalid node or port/);
  const legacy = { ...selected, role: 'ASSET_ROLE_CURRENT', source: 'ASSET_SOURCE_STUDIO', selected: false };
  assert.deepEqual(connect([legacy], 'model'), []);
  assert.match(connect([legacy]).join(' '), /invalid node or port/);
  assert.match(
    connect([{ ...legacy, studioState: 'STUDIO_ASSET_STATE_FAILED' }], 'model').join(' '),
    /invalid/,
  );
  for (const assets of [
    [{ ...selected, selected: false }],
    [selected, { ...selected, assetId: 'other' }],
    [{ ...selected, status: 'running' }],
    [{ ...selected, studioState: 'STUDIO_ASSET_STATE_FAILED' }],
    [{ ...selected, kind: 'ASSET_KIND_UNSPECIFIED' }],
  ])
    assert.match(connect(assets).join(' '), /invalid node or port/);
  assert.deepEqual(connect([{ ...selected, role: 'ASSET_ROLE_SUPERSEDED' }]), []);
  const graph = canvasSaveSchema.parse({
    canvasId: 'canvas',
    clientId: 'client',
    revision: '1',
    nodes: [{ ...lab, nodeAssets: [selected] }, target],
    edges: [{ id: 'edge', source: { nodeId: 'lab' }, target: { nodeId: 'target', port: 'model' } }],
  });
  assert.equal(graph.edges[0]!.source.port, '');
});

test('Canvas Get to Save and template snapshots omit only null UI sizes while preserving dimensions and view holes', async () => {
  const params = { input_mode: 'multi', images: [{ assetId: 'front' }, null, { assetId: 'back' }, null] };
  const nodes = [
    {
      id: 'upload',
      type: 'NODE_TYPE_UPLOAD_CARD',
      params,
      ui: { position: { x: 100, y: 200 }, size: null },
      inputMount: [{ assetId: 'asset', filename: 'front.png', url: 'https://example.test/front.png' }],
      nodeAssets: [],
      displayNo: '#1',
    },
    {
      id: 'group',
      type: 'NODE_TYPE_SECTION',
      params: null,
      ui: { position: { x: 0, y: 0 }, size: { width: 900, height: 600 } },
    },
    {
      id: 'ordinary',
      type: 'NODE_TYPE_GENERATE_IMAGE',
      params: { prompt: 'keep the exact layout' },
      ui: { position: { x: 300, y: 200 }, size: { width: 0, height: 0 } },
    },
  ];
  let saves = 0,
    templates = 0;
  const gateway = client((method, body) => {
    if (method === 'GetCanvas')
      return { canvas: { canvasId: 'canvas', projectId: 'project', revision: '8' }, nodes, edges: [] };
    const written = body.nodes as Record<string, unknown>[];
    assert.deepEqual(written[0]!.ui, { position: { x: 100, y: 200 } });
    assert.deepEqual(written[0]!.params, params);
    assert.deepEqual(object(written[1]!.ui).size, { width: 900, height: 600 });
    assert.deepEqual(object(written[2]!.ui).size, { width: 0, height: 0 });
    if (method === 'SaveCanvas') {
      saves++;
      assert.deepEqual(written[0]!.inputMount, [{ assetId: 'asset' }]);
      assert.deepEqual(written[0]!.nodeAssets, []);
      assert.equal(written[0]!.displayNo, undefined);
      assert.equal(body.revision, '8');
      return { revision: '9', violations: [] };
    }
    assert.equal(method, 'CreateTemplate');
    templates++;
    assert.deepEqual(written[0]!.inputMount, nodes[0]!.inputMount);
    assert.equal(body.revision, undefined);
    return { id: 'template' };
  });
  const resource = (name: string) => canvasResources.find((entry) => entry.name === name)!;
  const read = object(await callCanvas(gateway, resource('get'), { canvasId: 'canvas' }));
  await callCanvas(gateway, resource('save'), {
    canvasId: 'canvas',
    clientId: 'client',
    revision: '8',
    nodes: read.nodes,
    edges: read.edges,
  });
  assert.equal(
    object(
      await callCanvas(gateway, resource('template_create'), {
        sourceProjectId: 'project',
        sourceCanvasId: 'canvas',
        scenarioId: 'scenario',
        revision: '8',
      }),
    ).source_revision,
    '8',
  );
  assert.deepEqual([saves, templates], [1, 1]);
  assert.equal(nodes[0]!.ui.size, null);
});

test('existing Lab edges survive saving and editing during reruns while new connections and selected runs check current assets', async () => {
  const saved = canvasSaveSchema.parse({
    canvasId: 'canvas',
    clientId: 'client',
    revision: '3',
    nodes: [
      {
        id: 'lab',
        type: 'NODE_TYPE_AI_3D_LAB',
        name: 'Working Lab',
        nodeAssets: [
          {
            assetId: 'asset',
            filename: 'old.glb',
            url: 'https://example.test/old.glb',
            selected: true,
            studioState: 'STUDIO_ASSET_STATE_RUNNING',
          },
        ],
      },
      { id: 'target', type: 'NODE_TYPE_RIGGING' },
      {
        id: 'unrelated',
        type: 'NODE_TYPE_GENERATE_IMAGE',
        params: { prompt: 'robot', model_version: 'gpt_image_2' },
      },
    ],
    edges: [{ id: 'edge', source: { nodeId: 'lab' }, target: { nodeId: 'target', port: 'model' } }],
  });
  const state: Parameters<typeof editCanvas>[0] = {
    kind: 'ai-modeling.canvas.graph',
    version: 1,
    source_sha256: 'a'.repeat(64),
    graph: saved,
    undo: [],
    redo: [],
  };
  const renamed = editCanvas(state, [
    { action: 'rename', node_id: 'target', name: 'Renamed downstream' },
  ]).state;
  assert.deepEqual(renamed.graph.edges, saved.edges);
  assert.deepEqual(editCanvas(renamed, [{ action: 'undo' }]).state.graph, saved);
  const noEdges = { ...state, graph: { ...saved, edges: [] } };
  assert.throws(
    () => editCanvas(noEdges, [{ action: 'connect', edge: saved.edges[0]! }]),
    /invalid node or port/,
  );
  assert.deepEqual(noEdges.graph.edges, []);

  let currentStatus = 'STUDIO_ASSET_STATE_RUNNING',
    currentKind = 'ASSET_KIND_MODEL',
    assetNode = 'lab';
  const calls: string[] = [];
  const gateway = client((method, body) => {
    calls.push(method);
    if (method === 'GetCanvas')
      return { canvas: { canvasId: 'canvas', revision: '3' }, nodes: saved.nodes, edges: saved.edges };
    assert.equal(method, 'ListNodesAssets');
    assert.deepEqual(body.nodeIds, ['lab']);
    return {
      nodes: [
        {
          nodeId: 'lab',
          assets: [
            {
              nodeId: assetNode,
              assetId: 'asset',
              url: 'https://example.test/current.glb',
              selected: true,
              kind: currentKind,
              role: 'ASSET_ROLE_CURRENT',
              source: 'ASSET_SOURCE_STUDIO',
              studioState: currentStatus,
            },
          ],
        },
      ],
    };
  });
  const request = { canvas_id: 'canvas', revision: '3', node_ids: ['unrelated'] };
  await prepareCanvasRun(gateway, request);
  assert.deepEqual(calls, ['GetCanvas']);
  request.node_ids = ['target'];
  await assert.rejects(prepareCanvasRun(gateway, request), /Lab output that is not ready/);
  currentStatus = 'STUDIO_ASSET_STATE_READY';
  await prepareCanvasRun(gateway, request);
  // GetCanvas 省略kind/role/source的旧命名边，执行时从ListNodesAssets恢复真实端口证据。
  saved.edges[0]!.source.port = 'model';
  await prepareCanvasRun(gateway, request);
  currentKind = 'ASSET_KIND_IMAGE';
  await assert.rejects(prepareCanvasRun(gateway, request), /invalid node or port/);
  currentKind = 'ASSET_KIND_MODEL';
  assetNode = 'other';
  await assert.rejects(prepareCanvasRun(gateway, request), { code: 'CONTRACT_CHANGED' });
  assert.equal(calls.includes('CreateRun'), false);
  assert.equal(saved.nodes[0]!.nodeAssets![0]!.studioState, 'STUDIO_ASSET_STATE_RUNNING');
});
