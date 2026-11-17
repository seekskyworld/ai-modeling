/** 受限官方动画导出必须有真实纹理/骨骼/中心底部，并经原请求恢复同一授权产物。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import sharp from 'sharp';
import { fixture, quote } from './helpers.ts';
import { processingPlan, makePlan } from '../cli/compat/planning.ts';
import { fullToolPlan } from '../cli/compat/full-tools.ts';
import {
  executePlan,
  waitTask,
  taskResult,
  resolveJob,
  historyResult,
  type Application,
} from '../cli/compat/runtime.ts';
import { redoFrontendConvertPlan } from '../cli/compat/frontend-convert.ts';
import { redoPlan } from '../cli/compat/redo.ts';
import { validateFrontendConvert } from '../cli/compat/frontend-convert-validation.ts';
import { fingerprint } from '../cli/core/fingerprint.ts';
import { saveVerifiedOutputCache } from '../cli/artifacts/verified-output-cache.ts';
import { object, TripoError } from '../studio/contracts/errors.ts';

const parameters = {
  format: 'GLTF',
  export_orientation: '-y',
  pivot_to_center_bottom: true,
  with_animation: true,
  animate_in_place: false,
  bake: false,
  texture_format: 'JPEG',
  texture_size: 2048,
  pack_uv: false,
  export_vertex_colors: false,
  scale_factor: 1,
};
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function animated(
  options: {
    png?: boolean;
    size?: number;
    offset?: number;
    emptyWeights?: boolean;
    extraWeights?: boolean;
  } = {},
): Promise<Buffer> {
  const doc = new Document(),
    buffer = doc.createBuffer(),
    scene = doc.createScene('main');
  const position = doc
    .createAccessor()
    .setBuffer(buffer)
    .setType('VEC3')
    .setArray(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0, 1, 0]));
  const joints = doc.createAccessor().setBuffer(buffer).setType('VEC4').setArray(new Uint16Array(12));
  const weights = doc
    .createAccessor()
    .setBuffer(buffer)
    .setType('VEC4')
    .setArray(
      new Float32Array(options.emptyWeights ? Array(12).fill(0) : [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
    );
  const uv = doc
    .createAccessor()
    .setBuffer(buffer)
    .setType('VEC2')
    .setArray(new Float32Array([0, 0, 1, 0, 0.5, 1]));
  const offset = options.offset ?? 0;
  const parent = doc.createNode('parent').setTranslation([10 + offset, 5, 3]),
    bone = doc.createNode('bone'),
    meshNode = doc.createNode('mesh');
  scene.addChild(parent);
  parent.addChild(bone).addChild(meshNode);
  const inverse = doc
    .createAccessor()
    .setBuffer(buffer)
    .setType('MAT4')
    .setArray(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -10, -5, -3, 1]));
  const skin = doc.createSkin().addJoint(bone).setInverseBindMatrices(inverse);
  const size = options.size ?? 2048,
    encoder = sharp({ create: { width: size, height: size, channels: 3, background: '#b05522' } }),
    image = await (options.png ? encoder.png() : encoder.jpeg()).toBuffer(),
    texture = doc
      .createTexture()
      .setMimeType(options.png ? 'image/png' : 'image/jpeg')
      .setImage(image),
    material = doc.createMaterial().setBaseColorTexture(texture),
    primitive = doc
      .createPrimitive()
      .setAttribute('POSITION', position)
      .setAttribute('TEXCOORD_0', uv)
      .setAttribute('JOINTS_0', joints)
      .setAttribute('WEIGHTS_0', weights)
      .setMaterial(material);
  if (options.extraWeights) primitive.setAttribute('WEIGHTS_1', weights).setAttribute('JOINTS_1', joints);
  meshNode.setMesh(doc.createMesh().addPrimitive(primitive)).setSkin(skin);
  const input = doc
      .createAccessor()
      .setBuffer(buffer)
      .setType('SCALAR')
      .setArray(new Float32Array([0, 1])),
    output = doc
      .createAccessor()
      .setBuffer(buffer)
      .setType('VEC3')
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0])),
    sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation('LINEAR'),
    channel = doc
      .createAnimationChannel()
      .setSampler(sampler)
      .setTargetNode(bone)
      .setTargetPath('translation');
  doc.createAnimation('walk').addChannel(channel).addSampler(sampler);
  return Buffer.from(await new NodeIO().writeBinary(doc));
}
function proof(bytes: Buffer): Record<string, unknown> {
  return {
    version: 1,
    account_ref: 'test-account',
    authorization_request_id: 'convert-0',
    intent: fingerprint({
      project_id: 'project',
      operator_id: 'operator',
      format: 'glb',
      forward_axis: '-y',
      pivot_to_center_bottom: true,
      name: null,
    }),
    project_id: 'project',
    operator_id: 'operator',
    name: 'synthetic',
    source_metadata: {},
    source_location: fingerprint('https://cdn.tripo3d.ai/source.glb'),
    source_sha256: '1'.repeat(64),
    source_bytes: 100,
    output_sha256: hash(bytes),
    output_bytes: bytes.length,
    conversion: {
      source_sha256: '1'.repeat(64),
      output_sha256: hash(bytes),
      metadata: { forward_axis: '-y', pivot_to_center_bottom: true },
      transform_representation: 'additional_root_transform',
      clips: [{ name: 'walk', keyframe_times_exact: true, maximum_value_error: 0 }],
    },
  };
}

test('explicit animated unbaked mapping preserves ordinary defaults and canonical official parameters', () => {
  const plan = processingPlan('convert', '@source', { param: parameters });
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0]!.operation, 'export_lite');
  assert.deepEqual(plan.steps[0]!.frontendConvert, parameters);
  assert.equal(plan.steps[0]!.parameters.with_animation, undefined);
  assert.deepEqual(plan.steps[0]!.parameters, {
    project_id: 'upstream',
    operator_id: 'upstream',
    format: 'glb',
    public_model: false,
  });
  const defaults = processingPlan('convert', '@source', { format: 'GLTF' });
  assert.equal(defaults.steps[0]!.operation, 'export');
  assert.equal(defaults.steps[0]!.frontendConvert, undefined);
  assert.ok(defaults.steps[0]!.exportDefaults?.includes('with_animation'));
  const staticPlan = processingPlan('convert', '@source', { param: { format: 'GLTF', bake: false } });
  assert.equal(staticPlan.steps[0]!.operation, 'export');
  const minimal = { ...parameters } as Record<string, unknown>;
  for (const key of ['animate_in_place', 'pack_uv', 'export_vertex_colors', 'scale_factor'])
    delete minimal[key];
  assert.deepEqual(
    processingPlan('convert', '@source', { param: minimal }).steps[0]!.frontendConvert,
    parameters,
  );
  assert.deepEqual(
    fullToolPlan('ai_modeling_convert', { input: '@source', ...parameters }).steps[0]!.frontendConvert,
    parameters,
  );
});

test('unsupported animated options and source-changing chains fail before any paid prefix', () => {
  for (const change of [
    { format: 'FBX' },
    { export_orientation: '+z' },
    { export_orientation: undefined },
    { pivot_to_center_bottom: 'false' },
    { pivot_to_center_bottom: undefined },
    { texture_format: 'PNG' },
    { texture_format: undefined },
    { texture_size: 4096 },
    { texture_size: undefined },
    { animate_in_place: true },
    { scale_factor: 2 },
    { pack_uv: true },
    { export_vertex_colors: true },
    { animations: [] },
    { part_names: ['mesh'] },
    { face_limit: 1000 },
    { flatten_bottom: true },
  ])
    assert.throws(() => processingPlan('convert', '@source', { param: { ...parameters, ...change } }));
  for (const source of ['model.glb', 'https://example.com/model.glb', 'upstream'])
    assert.throws(() => processingPlan('convert', source, { param: parameters }), {
      code: 'STUDIO_CAPABILITY_UNAVAILABLE',
    });
  assert.throws(() =>
    makePlan(['model.glb'], {
      then: 'convert:GLTF,bake=false,with_animation=true,export_orientation=-y,pivot_to_center_bottom=true,texture_format=JPEG,texture_size=2048',
    }),
  );
});

test('actual skinned rest pivot is used once, independent of mesh parent transforms and moving clip frames', async () => {
  const bytes = await animated(),
    result = await validateFrontendConvert(proof(bytes), bytes);
  assert.deepEqual(object(result.rest_world_bounds).center_bottom, [0, 0, 0]);
  assert.deepEqual(result.clip_names, ['walk']);
  assert.equal(result.skeletons, 1);
  assert.equal(object((result.textures as unknown[])[0]).width, 2048);
});

test('historical v1 validation keeps its frozen shape while v2 explicitly records its pivot choice', async () => {
  const bytes = await animated(),
    historical = proof(bytes),
    oldValidation = await validateFrontendConvert(historical, bytes);
  assert.equal(Object.hasOwn(object(oldValidation.rest_world_bounds), 'pivot_to_center_bottom'), false);
  const metadata = object(object(historical.conversion).metadata),
    modern = { ...historical, version: 2, source_is_pbr: false, input: metadata },
    newValidation = await validateFrontendConvert(modern, bytes),
    { pivot_to_center_bottom, ...originalBounds } = object(newValidation.rest_world_bounds);
  assert.equal(pivot_to_center_bottom, true);
  assert.deepEqual({ ...newValidation, rest_world_bounds: originalBounds }, oldValidation);
  await assert.rejects(
    validateFrontendConvert(
      {
        ...historical,
        conversion: {
          ...object(historical.conversion),
          metadata: { ...metadata, pivot_to_center_bottom: false },
        },
      },
      bytes,
    ),
    { code: 'FRONTEND_CONVERT_UNVERIFIED' },
  );
});

test('incorrect actual pivot, empty weights, second skin channels, non-JPEG and wrong sizes are rejected', async () => {
  for (const options of [
    { offset: 0.1 },
    { emptyWeights: true },
    { extraWeights: true },
    { png: true },
    { size: 1024 },
  ]) {
    const bytes = await animated(options);
    await assert.rejects(validateFrontendConvert(proof(bytes), bytes), {
      code: 'FRONTEND_CONVERT_UNVERIFIED',
    });
  }
});

test('an unrelated or incomplete preservation proof cannot license the actual output', async () => {
  const bytes = await animated();
  for (const value of [
    { ...proof(bytes), output_sha256: '0'.repeat(64) },
    { ...proof(bytes), output_bytes: bytes.length + 1 },
    { ...proof(bytes), conversion: {} },
    { ...proof(bytes), conversion: { ...object(proof(bytes).conversion), clips: [] } },
    {
      ...proof(bytes),
      conversion: {
        ...object(proof(bytes).conversion),
        clips: [{ name: 'walk', keyframe_times_exact: true, maximum_value_error: NaN }],
      },
    },
  ])
    await assert.rejects(validateFrontendConvert(value, bytes), { code: 'FRONTEND_CONVERT_UNVERIFIED' });
});

async function conversionFixture() {
  const f = await fixture(),
    bytes = await animated();
  const source = f.jobs.prepare(
    'test-account',
    'source',
    'import_model',
    { name: 'source', model_path: '/source.glb' },
    quote,
  );
  f.jobs.update(source.job_id, 'succeeded', {
    remote_ids: { project_id: 'project', operator_id: 'operator' },
  });
  f.jobs.assignName('test-account', 'source', source.job_id);
  // 该夹具来自历史v1前端授权；显式冻结旧兼容意图，不能让新请求默认重释旧证明。
  f.jobs.bindRequestPolicy('test-account', 'frontend-convert-intent:convert-0', {
    version: 1,
    source: '@source',
    parameters,
    project_id: 'project',
    operator_id: 'operator',
  });
  f.jobs.bindRequestPolicy('test-account', 'frontend-export-proof:convert-0', proof(bytes));
  await saveVerifiedOutputCache(
    { account_ref: 'test-account' },
    { artifact_id: 'frontend-model', kind: 'model', format: 'glb', index: 0 },
    { sha256: hash(bytes), bytes: bytes.length },
    bytes,
    f.dir,
  );
  const reads = { source: 0, artifact: 0 };
  const client = {
    forAccount: () => ({
      credentials: { load: () => undefined },
      request: async () => {
        reads.source++;
        return {
          id: 'project',
          is_owner: true,
          project_name: 'synthetic',
          model_url: 'https://cdn.tripo3d.ai/source.glb',
          operator: { operator_id: 'operator', status: 'success', metadata: {} },
        };
      },
    }),
  };
  f.gateway.submit = async () => {
    f.gateway.posts++;
    if (f.gateway.failSubmit) throw f.gateway.failSubmit;
    return {
      remote_ids: { project_id: 'project', operator_id: 'operator' },
      status: { state: 'succeeded' as const, progress: 100, artifacts: [] },
    };
  };
  f.gateway.artifactUrl = async () => {
    reads.artifact++;
    throw Error('Never download the original source as converted output.');
  };
  const app = { service: f.service, studio: { client } } as unknown as Application;
  return {
    ...f,
    app,
    bytes,
    reads,
    source,
    plan: () => processingPlan('convert', '@source', { param: parameters }),
  };
}

test('compatible no-download result is the real authorization job with cached artifact, not a new operator', async () => {
  const f = await conversionFixture();
  try {
    const flags = { requestId: 'convert', wait: false, download: false },
      first = await executePlan(f.app, f.plan(), flags),
      id = String(first.task_id);
    assert.equal(first.type, 'convert_model');
    assert.equal(first.studio_operation, 'export_lite');
    assert.equal(first.request_id, 'convert-0');
    assert.equal(object(first.studio).operator_id, 'operator');
    assert.equal(f.jobs.find('test-account', 'frontend-export:convert-0'), undefined);
    assert.equal((first.artifacts as unknown[]).length, 1);
    assert.deepEqual(await readdir(path.join(f.dir, 'output')), []);
    const second = await executePlan(f.app, f.plan(), flags);
    assert.equal(second.task_id, id);
    assert.equal(f.gateway.posts, 1);
    assert.equal(f.reads.source, 1);
    assert.equal(taskResult(await waitTask(f.app, id, 0)).type, 'convert_model');
    const download = await f.service.download(id, 'model', 'caller.glb');
    assert.equal(download.sha256, hash(f.bytes));
    assert.deepEqual(await readFile(String(download.local_path)), f.bytes);
    assert.equal(f.reads.artifact, 0);
    await assert.rejects(
      executePlan(f.app, processingPlan('texture', id, {}), { requestId: 'no-fake-model', download: false }),
      {
        code: 'FRONTEND_CONVERT_CONTINUATION_UNVERIFIED',
      },
    );
    await assert.rejects(
      executePlan(f.app, processingPlan('convert', '@source', { format: 'GLTF' }), flags),
      {
        code: 'IDEMPOTENCY_CONFLICT',
      },
    );
    assert.equal(f.gateway.posts, 1);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('uncertain frontend authorization is retained as the same task and does not expose cached output', async () => {
  const f = await conversionFixture();
  try {
    f.gateway.failSubmit = new TripoError('NETWORK_ERROR', 'fixture uncertain write', 'unknown');
    const flags = { requestId: 'convert', wait: false, download: false },
      first = await executePlan(f.app, f.plan(), flags),
      second = await executePlan(f.app, f.plan(), flags);
    assert.equal(first.status, 'outcome_unknown');
    assert.equal(second.task_id, first.task_id);
    assert.deepEqual(second.artifacts, []);
    assert.equal(f.gateway.posts, 1);
    assert.equal(f.reads.source, 1);
    await assert.rejects(f.service.download(String(first.task_id), 'model', 'unknown.glb'));
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('frontend redo, history names and @last retain complete intent and never clone an empty authorization', async () => {
  const f = await conversionFixture();
  try {
    const first = await executePlan(f.app, f.plan(), {
      requestId: 'convert',
      wait: false,
      download: false,
      name: 'exact-conversion',
    });
    const job = f.jobs.get(String(first.task_id));
    assert.equal(resolveJob(f.app, '@last').job_id, job.job_id);
    assert.equal(resolveJob(f.app, '@exact-conversion').job_id, job.job_id);
    assert.equal(historyResult(f.app, f.service.summary(job)).type, 'convert_model');
    assert.equal(historyResult(f.app, f.service.summary(job)).name, 'exact-conversion');
    const redo = redoFrontendConvertPlan(f.jobs, f.dir, job)!;
    assert.equal(redo.steps[0]!.source, 'project');
    assert.equal(redo.steps[0]!.parameters.operator_id, 'operator');
    assert.deepEqual(redo.steps[0]!.frontendConvert, parameters);
    assert.throws(() => redoPlan(job), { code: 'FRONTEND_REDO_INTENT_REQUIRED' });
    for (const options of [
      { bake: true },
      { with_animation: false },
      { export_orientation: '+z' },
      { unexpected: 1 },
    ])
      assert.throws(() => redoFrontendConvertPlan(f.jobs, f.dir, job, undefined, options), {
        code: 'STUDIO_CAPABILITY_UNAVAILABLE',
      });
    assert.throws(() => redoFrontendConvertPlan(f.jobs, f.dir, job, 0), {
      code: 'STUDIO_CAPABILITY_UNAVAILABLE',
    });
    assert.throws(() => redoFrontendConvertPlan(f.jobs, f.dir, { ...job, state: 'outcome_unknown' }), {
      code: 'INPUT_NOT_READY',
    });
    await rm(
      path.join(f.dir, 'verified-output-cache', hash(Buffer.from('test-account')), hash(f.bytes) + '.glb'),
    );
    assert.throws(() => redoFrontendConvertPlan(f.jobs, f.dir, job), { code: 'INPUT_NOT_READY' });
    assert.equal(f.gateway.posts, 1);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('frontend redo executes the complete source-frozen path once and ignores the project current-operator drift', async () => {
  const f = await conversionFixture();
  try {
    const original = await executePlan(f.app, f.plan(), {
      requestId: 'convert',
      wait: false,
      download: false,
    });
    const job = f.jobs.get(String(original.task_id));
    f.jobs.bindRequestPolicy('test-account', 'frontend-export-proof:redo-0', {
      ...proof(f.bytes),
      authorization_request_id: 'redo-0',
    });
    let currentReads = 0;
    f.app.studio.client.request = async () => {
      currentReads++;
      return { id: 'project', operator: { operator_id: 'unrelated-current-operator' } };
    };
    const redo = () => redoFrontendConvertPlan(f.jobs, f.dir, job)!;
    const flags = { requestId: 'redo', wait: false, download: false };
    const first = await executePlan(f.app, redo(), flags),
      again = await executePlan(f.app, redo(), flags);
    assert.equal(first.task_id, again.task_id);
    assert.notEqual(first.task_id, original.task_id);
    assert.equal(first.type, 'convert_model');
    assert.equal(first.request_id, 'redo-0');
    assert.equal(object(first.studio).operator_id, 'operator');
    assert.equal(f.jobs.find('test-account', 'redo-0')!.input.operator_id, 'operator');
    assert.equal((first.artifacts as unknown[]).length, 1);
    assert.equal(currentReads, 1);
    assert.equal(f.gateway.posts, 2);
    assert.equal(f.reads.artifact, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
