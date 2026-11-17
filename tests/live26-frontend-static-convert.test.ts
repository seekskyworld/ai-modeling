/** 静态兼容路径验证实际像素、世界轴心、持久恢复及旧路线隔离，不把请求字段当效果。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { Document, NodeIO } from '@gltf-transform/core';
import sharp from 'sharp';
import { fixture, quote } from './helpers.ts';
import { processingPlan } from '../cli/compat/planning.ts';
import { fullToolPlan } from '../cli/compat/full-tools.ts';
import { executePlan, type Application } from '../cli/compat/runtime.ts';
import {
  assertFrontendConvertPlan,
  frontendConvertPlan,
  redoFrontendConvertPlan,
} from '../cli/compat/frontend-convert.ts';
import {
  frontendStaticConvertSchema,
  type FrontendStaticConvertIntent,
} from '../cli/compat/frontend-static-convert.ts';
import { validateFrontendStaticConvert } from '../cli/compat/frontend-static-convert-validation.ts';
import { verifyStudioFrontend } from '../cli/artifacts/studio-assimp-proof.ts';
import { saveVerifiedOutputCache } from '../cli/artifacts/verified-output-cache.ts';
import { fingerprint } from '../cli/core/fingerprint.ts';
import { array, object } from '../studio/contracts/errors.ts';

const parameters = frontendStaticConvertSchema.parse({
  format: 'GLTF',
  export_orientation: '-x',
  pivot_to_center_bottom: false,
  with_animation: false,
  bake: false,
  texture_format: 'JPEG',
  texture_size: 8,
});
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function staticBytes(
  image?: { format: 'jpeg' | 'png' | 'webp'; size?: number; declared?: string },
  offset = 0,
  animated = false,
): Promise<Buffer> {
  const doc = new Document(),
    buffer = doc.createBuffer(),
    scene = doc.createScene('scene'),
    material = doc.createMaterial('material').setMetallicFactor(0.25).setRoughnessFactor(0.4),
    accessor = (type: 'VEC2' | 'VEC3', values: number[]) =>
      doc.createAccessor().setBuffer(buffer).setType(type).setArray(new Float32Array(values)),
    primitive = doc
      .createPrimitive()
      .setAttribute('POSITION', accessor('VEC3', [-1, 0, -1, 1, 0, -1, 1, 2, 1, -1, 2, 1]))
      .setAttribute('NORMAL', accessor('VEC3', Array(4).fill([0, -Math.SQRT1_2, Math.SQRT1_2]).flat()))
      .setAttribute('TEXCOORD_0', accessor('VEC2', [0, 0, 1, 0, 1, 1, 0, 1]))
      .setIndices(
        doc
          .createAccessor()
          .setBuffer(buffer)
          .setType('SCALAR')
          .setArray(new Uint16Array([0, 1, 2, 0, 2, 3])),
      )
      .setMaterial(material),
    node = doc.createNode('mesh').setMesh(doc.createMesh('mesh').addPrimitive(primitive));
  scene.addChild(node.setTranslation([offset, 0, 0]));
  if (image) {
    const size = image.size ?? 8,
      bytes = await sharp({ create: { width: size, height: size, channels: 3, background: '#b05522' } })
        .toFormat(image.format)
        .toBuffer();
    material.setBaseColorTexture(
      doc
        .createTexture('color')
        .setMimeType(image.declared ?? `image/${image.format}`)
        .setImage(bytes),
    );
  }
  if (animated) {
    const times = doc
        .createAccessor()
        .setBuffer(buffer)
        .setType('SCALAR')
        .setArray(new Float32Array([0, 1])),
      values = accessor('VEC3', [offset, 0, 0, offset + 1, 0, 0]),
      sampler = doc.createAnimationSampler().setInput(times).setOutput(values),
      channel = doc
        .createAnimationChannel()
        .setSampler(sampler)
        .setTargetNode(node)
        .setTargetPath('translation');
    doc.createAnimation('move').addSampler(sampler).addChannel(channel);
  }
  return Buffer.from(await new NodeIO().writeBinary(doc));
}

async function proof(bytes: Buffer, params = parameters): Promise<Record<string, unknown>> {
  const metadata = {
      forward_axis: params.export_orientation,
      pivot_to_center_bottom: params.pivot_to_center_bottom,
    },
    input = {
      project_id: 'project',
      operator_id: 'operator',
      format: 'glb',
      ...metadata,
      name: null,
      exclude_retarget: true,
    };
  return {
    version: 2,
    account_ref: 'test-account',
    authorization_request_id: 'static-0',
    input,
    intent: fingerprint(input),
    project_id: 'project',
    operator_id: 'operator',
    name: 'synthetic',
    source_metadata: {},
    source_is_pbr: false,
    source_location: fingerprint('https://cdn.tripo3d.ai/source.glb'),
    source_format: 'glb',
    source_sha256: hash(bytes),
    source_bytes: bytes.length,
    output_sha256: hash(bytes),
    output_bytes: bytes.length,
    // -x 是原引擎单位朝向；参考源/结果固定相同，不靠被测转换器生成预期顶点。
    conversion: await verifyStudioFrontend(bytes, bytes, metadata),
  };
}

test('static frontend plans require the complete explicit combination and retain ordinary native plans', () => {
  for (const axis of ['+x', '-x', '+y', '-y'] as const)
    for (const pivot of [false, true]) {
      const input = { ...parameters, export_orientation: axis, pivot_to_center_bottom: pivot },
        plan = processingPlan('convert', '@source', { param: input });
      assert.equal(plan.steps[0]!.operation, 'export_lite');
      assert.deepEqual(plan.steps[0]!.frontendConvert, input);
      assert.deepEqual(fullToolPlan('ai_modeling_convert', { input: '@source', ...input }), plan);
    }
  for (const key of ['export_orientation', 'pivot_to_center_bottom', 'texture_format', 'texture_size']) {
    const incomplete = { ...parameters } as Record<string, unknown>;
    delete incomplete[key];
    assert.equal(frontendConvertPlan('@source', incomplete, false), undefined);
  }
  for (const input of [{ format: 'GLTF' }, { format: 'GLTF', bake: false, with_animation: false }])
    assert.equal(processingPlan('convert', '@source', { param: input }).steps[0]!.operation, 'export');
  for (const source of ['model.glb', 'https://example.com/model.glb', 'upstream'])
    assert.throws(() => processingPlan('convert', source, { param: parameters }), {
      code: 'STUDIO_CAPABILITY_UNAVAILABLE',
    });
});

test('static mapping never swallows other processing options or unsupported encoding', () => {
  for (const change of [
    { format: 'FBX' },
    { texture_format: 'OPEN_EXR' },
    { texture_size: 8193 },
    { texture_size: 1.5 },
    { part_names: ['mesh'] },
    { scale_factor: 2 },
    { face_limit: 2000 },
    { pack_uv: true },
    { animate_in_place: true },
    { export_vertex_colors: true },
    { unknown: true },
  ])
    assert.equal(frontendConvertPlan('@source', { ...parameters, ...change }, false), undefined);
});

test('untextured static files satisfy explicit texture intent without creating images', async () => {
  const bytes = await staticBytes();
  for (const pivot of [false, true]) {
    const input = { ...parameters, pivot_to_center_bottom: pivot },
      validation = await validateFrontendStaticConvert(await proof(bytes, input), bytes, input);
    assert.deepEqual(validation.textures, []);
    assert.equal(validation.texture_reencoding, false);
    assert.equal(validation.skeletons, 0);
    assert.deepEqual(object(validation.static_world_bounds).center_bottom, [0, 0, 0]);
  }
});

test('static texture verification decodes actual JPEG, PNG and WEBP bytes and requested dimensions', async () => {
  for (const format of ['jpeg', 'png', 'webp'] as const) {
    const bytes = await staticBytes({ format }),
      input = { ...parameters, texture_format: format.toUpperCase() } as FrontendStaticConvertIntent,
      saved = await proof(bytes, input),
      validation = await validateFrontendStaticConvert(saved, bytes, input);
    assert.equal(object(array(validation.textures)[0]).mime, `image/${format}`);
    assert.equal(object(array(validation.textures)[0]).width, 8);
    await assert.rejects(validateFrontendStaticConvert(saved, bytes, { ...input, texture_size: 16 }), {
      code: 'FRONTEND_CONVERT_UNVERIFIED',
    });
    await assert.rejects(
      validateFrontendStaticConvert(saved, bytes, {
        ...input,
        texture_format: format === 'jpeg' ? 'PNG' : 'JPEG',
      }),
      { code: 'FRONTEND_CONVERT_UNVERIFIED' },
    );
  }
  const spoofed = await staticBytes({ format: 'png', declared: 'image/jpeg' });
  await assert.rejects(validateFrontendStaticConvert(await proof(spoofed), spoofed, parameters), {
    code: 'FRONTEND_CONVERT_UNVERIFIED',
  });
});

test('static validation binds byte identity, axis, retarget choice and complete surface proof', async () => {
  const bytes = await staticBytes(),
    saved = await proof(bytes);
  const changes: Array<(value: Record<string, unknown>) => void> = [
    (value) => (value.output_sha256 = '0'.repeat(64)),
    (value) => (value.output_bytes = bytes.length + 1),
    (value) => (value.source_format = 'fbx'),
    (value) => (value.source_is_pbr = undefined),
    (value) => (object(value.input).exclude_retarget = false),
    (value) => (object(value.conversion).faces = 3),
    (value) => (object(value.conversion).surfaces = []),
    (value) => (object(array(object(value.conversion).surfaces)[0]).original_skin_joints = 1),
    (value) => (object(value.conversion).clips = [{ name: 'lost' }]),
    (value) => (object(value.conversion).transform_representation = 'additional_root_transform'),
  ];
  for (const change of changes) {
    const mutated = structuredClone(saved);
    change(mutated);
    await assert.rejects(validateFrontendStaticConvert(mutated, bytes, parameters), {
      code: 'FRONTEND_CONVERT_UNVERIFIED',
    });
  }
  await assert.rejects(
    validateFrontendStaticConvert(saved, bytes, { ...parameters, export_orientation: '+x' }),
    { code: 'FRONTEND_CONVERT_UNVERIFIED' },
  );
});

test('static validator rejects real clips and verifies actual rendered bottom-center independently', async () => {
  const animated = await staticBytes(undefined, 0, true),
    forged = await proof(animated);
  object(forged.conversion).clips = [];
  object(forged.conversion).transform_representation = 'verified_world_surface_bake';
  await assert.rejects(validateFrontendStaticConvert(forged, animated, parameters), {
    code: 'FRONTEND_CONVERT_UNVERIFIED',
  });
  const displaced = await staticBytes(undefined, 1),
    saved = await proof(displaced);
  await validateFrontendStaticConvert(saved, displaced, parameters);
  object(saved.input).pivot_to_center_bottom = true;
  object(object(saved.conversion).metadata).pivot_to_center_bottom = true;
  await assert.rejects(
    validateFrontendStaticConvert(saved, displaced, { ...parameters, pivot_to_center_bottom: true }),
    { code: 'FRONTEND_CONVERT_UNVERIFIED' },
  );
});

async function preparedFixture(image?: { format: 'jpeg' | 'png' | 'webp' }) {
  const f = await fixture(),
    bytes = await staticBytes(image),
    source = f.jobs.prepare('test-account', 'source', 'import_model', { name: 'source' }, quote);
  f.jobs.update(source.job_id, 'succeeded', {
    remote_ids: { project_id: 'project', operator_id: 'operator' },
  });
  f.jobs.assignName('test-account', 'source', source.job_id);
  // 原静态夹具使用worker -x单位旋转，保留对应历史意图，不能追认为新原生轴向映射。
  f.jobs.bindRequestPolicy('test-account', 'frontend-convert-intent:static-0', {
    version: 1,
    source: '@source',
    parameters,
    project_id: 'project',
    operator_id: 'operator',
  });
  f.jobs.bindRequestPolicy('test-account', 'frontend-export-proof:static-0', await proof(bytes));
  await saveVerifiedOutputCache(
    { account_ref: 'test-account' },
    { artifact_id: 'frontend-model', kind: 'model', format: 'glb', index: 0 },
    { sha256: hash(bytes), bytes: bytes.length },
    bytes,
    f.dir,
  );
  const reads = { source: 0 };
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
          operator: { operator_id: 'operator', status: 'success', metadata: {}, is_pbr: false },
        };
      },
    }),
  };
  f.gateway.submit = async () => {
    f.gateway.posts++;
    return {
      remote_ids: { project_id: 'project', operator_id: 'operator' },
      status: { state: 'succeeded' as const, progress: 100, artifacts: [] },
    };
  };
  f.gateway.artifactUrl = async () => {
    throw Error('Original source must not replace the converted output.');
  };
  const app = { service: f.service, studio: { client } } as unknown as Application;
  return { ...f, bytes, app, reads };
}

test('static conversion survives store reopen and new download paths without another authorization', async () => {
  const f = await preparedFixture(),
    plan = () => processingPlan('convert', '@source', { param: parameters }),
    flags = { requestId: 'static', wait: false, download: false };
  let second: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    const result = await executePlan(f.app, plan(), flags),
      id = String(result.task_id);
    assert.equal(result.type, 'convert_model');
    assert.equal(result.studio_operation, 'export_lite');
    assert.equal(f.gateway.posts, 1);
    assert.equal(f.reads.source, 1);
    const redo = redoFrontendConvertPlan(f.jobs, f.dir, f.jobs.get(id))!;
    assert.deepEqual(redo.steps[0]!.frontendConvert, parameters);
    assert.equal(redo.steps[0]!.source, 'project');
    assert.equal(redo.steps[0]!.parameters.operator_id, 'operator');
    assert.throws(
      () => redoFrontendConvertPlan(f.jobs, f.dir, f.jobs.get(id), undefined, { with_animation: true }),
      {
        code: 'STUDIO_CAPABILITY_UNAVAILABLE',
      },
    );
    const original = await f.service.download(id, 'model', 'first.glb');
    assert.deepEqual(await readFile(String(original.local_path)), f.bytes);
    f.jobs.close();
    second = await fixture(f.dir);
    const reopened = {
      service: second.service,
      studio: {
        client: {
          forAccount: () => {
            throw Error('No new source read.');
          },
        },
      },
    } as unknown as Application;
    const recovered = await executePlan(reopened, plan(), flags);
    assert.equal(recovered.task_id, id);
    assert.equal(second.gateway.posts, 0);
    const alternate = await second.service.download(id, 'model', 'second.glb');
    assert.equal(alternate.sha256, original.sha256);
    assert.deepEqual(await readFile(String(alternate.local_path)), f.bytes);
  } finally {
    if (second) second.jobs.close();
    else f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('mismatched static texture never submits a new authorization', async () => {
  const f = await preparedFixture({ format: 'png' });
  try {
    await assert.rejects(
      executePlan(f.app, processingPlan('convert', '@source', { param: parameters }), {
        requestId: 'static',
        wait: false,
        download: false,
      }),
      { code: 'FRONTEND_CONVERT_UNVERIFIED' },
    );
    assert.equal(f.gateway.posts, 0);
    assert.equal(f.jobs.find('test-account', 'static-0'), undefined);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('new static routing refuses to replace an existing native export receipt', async () => {
  const f = await fixture();
  try {
    const original = f.jobs.prepare('test-account', 'static-0', 'export', { format: 'glb' }, quote),
      step = processingPlan('convert', '@source', { param: parameters }).steps[0]!;
    assert.throws(() => assertFrontendConvertPlan(f.jobs, 'test-account', 'static-0', step), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    assert.equal(f.jobs.get(original.job_id).operation, 'export');
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
