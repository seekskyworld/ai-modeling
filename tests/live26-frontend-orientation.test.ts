/** 原生同源四向作为独立方向基准；旧意图仍按原worker语义恢复，完整验证不能静默改写。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFile, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Document, NodeIO } from '@gltf-transform/core';
import { mat4, vec3 } from 'gl-matrix';
import sharp from 'sharp';
import { fixture, quote } from './helpers.ts';
import { processingPlan } from '../cli/compat/planning.ts';
import { executePlan, type Application } from '../cli/compat/runtime.ts';
import { fullTools } from '../cli/compat/full-tools.ts';
import { redoFrontendConvertPlan, type FrontendConvertIntent } from '../cli/compat/frontend-convert.ts';
import { frontendOrientationMapping, type ConvertOrientation } from '../cli/compat/frontend-orientation.ts';
import { validateFrontendConvert } from '../cli/compat/frontend-convert-validation.ts';
import { validateFrontendStaticConvert } from '../cli/compat/frontend-static-convert-validation.ts';
import { verifyStudioFrontend } from '../cli/artifacts/studio-assimp-proof.ts';
import { saveVerifiedOutputCache } from '../cli/artifacts/verified-output-cache.ts';
import { fingerprint } from '../cli/core/fingerprint.ts';
import { object, text } from '../studio/contracts/errors.ts';

const io = new NodeIO(),
  hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
  workerAngles = { '+x': Math.PI, '-x': 0, '+y': Math.PI / 2, '-y': -Math.PI / 2 },
  nativeAngles = { '+x': 0, '-x': Math.PI, '+y': Math.PI / 2, '-y': -Math.PI / 2 },
  expectedAxes = { '+x': '-x', '-x': '+x', '+y': '+y', '-y': '-y' } as const;

async function sourceBytes(animated: boolean): Promise<Buffer> {
  const doc = new Document(),
    buffer = doc.createBuffer(),
    scene = doc.createScene('scene'),
    parent = doc.createNode('parent'),
    material = doc.createMaterial('material'),
    accessor = (type: 'VEC2' | 'VEC3' | 'VEC4' | 'SCALAR' | 'MAT4', values: number[]) =>
      doc.createAccessor().setBuffer(buffer).setType(type).setArray(new Float32Array(values)),
    primitive = doc
      .createPrimitive()
      .setAttribute('POSITION', accessor('VEC3', [2, 1, 3, 4, 1, 3, 2, 5, 3]))
      .setAttribute('NORMAL', accessor('VEC3', [0, 0, 1, 0, 0, 1, 0, 0, 1]))
      .setAttribute('TEXCOORD_0', accessor('VEC2', [0, 0, 1, 0, 0, 1]))
      .setMaterial(material),
    node = doc.createNode('mesh').setMesh(doc.createMesh('mesh').addPrimitive(primitive));
  doc.getRoot().setDefaultScene(scene);
  scene.addChild(parent);
  parent.addChild(node);
  if (animated) {
    const bone = doc.createNode('bone'),
      joints = doc.createAccessor().setBuffer(buffer).setType('VEC4').setArray(new Uint16Array(12)),
      inverse = accessor('MAT4', Array.from(mat4.create())),
      skin = doc.createSkin('skin').addJoint(bone).setInverseBindMatrices(inverse),
      times = accessor('SCALAR', [0, 1]),
      positions = accessor('VEC3', [0, 0, 0, 1, 0, 0]),
      sampler = doc.createAnimationSampler().setInput(times).setOutput(positions).setInterpolation('LINEAR'),
      channel = doc
        .createAnimationChannel()
        .setSampler(sampler)
        .setTargetNode(bone)
        .setTargetPath('translation'),
      image = await sharp({ create: { width: 2048, height: 2048, channels: 3, background: '#b05522' } })
        .jpeg()
        .toBuffer();
    primitive
      .setAttribute('JOINTS_0', joints)
      .setAttribute('WEIGHTS_0', accessor('VEC4', [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]));
    material.setBaseColorTexture(doc.createTexture('color').setMimeType('image/jpeg').setImage(image));
    parent.addChild(bone);
    node.setSkin(skin);
    doc.createAnimation('walk').addSampler(sampler).addChannel(channel);
  }
  return Buffer.from(await io.writeBinary(doc));
}

async function prepared(animated: boolean, axis: ConvertOrientation, revision: 1 | 2) {
  const f = await fixture(),
    original = await sourceBytes(animated),
    doc = await io.readBinary(original),
    scene = doc.getRoot().listScenes()[0]!,
    forward = revision === 1 ? axis : expectedAxes[axis],
    rotation = mat4.fromYRotation(mat4.create(), workerAngles[forward]),
    root = doc.createNode('ROOT');
  root.setMatrix(Array.from(rotation) as ReturnType<typeof root.getMatrix>);
  for (const child of scene.listChildren()) {
    scene.removeChild(child);
    root.addChild(child);
  }
  scene.addChild(root);
  const bytes = Buffer.from(await io.writeBinary(doc)),
    parameters = {
      format: 'GLTF',
      export_orientation: axis,
      pivot_to_center_bottom: false,
      with_animation: animated,
      animate_in_place: false,
      bake: false,
      texture_format: 'JPEG',
      texture_size: 2048,
      pack_uv: false,
      export_vertex_colors: false,
      scale_factor: 1,
    } as FrontendConvertIntent,
    metadata = { forward_axis: forward, pivot_to_center_bottom: false },
    input = {
      project_id: 'project',
      operator_id: 'operator',
      format: 'glb',
      ...metadata,
      name: null,
      ...(animated ? {} : { exclude_retarget: true }),
    },
    proof = {
      version: 2,
      account_ref: 'test-account',
      authorization_request_id: 'convert-0',
      input,
      intent: fingerprint(input),
      project_id: 'project',
      operator_id: 'operator',
      name: 'synthetic',
      source_metadata: {},
      source_is_pbr: false,
      source_location: fingerprint('https://cdn.tripo3d.ai/source.glb'),
      source_format: 'glb',
      source_sha256: hash(original),
      source_bytes: original.length,
      output_sha256: hash(bytes),
      output_bytes: bytes.length,
      conversion: await verifyStudioFrontend(original, bytes, metadata),
    },
    intent = {
      version: revision,
      source: '@source',
      parameters,
      project_id: 'project',
      operator_id: 'operator',
      ...(revision === 2 ? { orientation_mapping: frontendOrientationMapping(axis) } : {}),
    },
    source = f.jobs.prepare('test-account', 'source', 'import_model', { name: 'source' }, quote);
  f.jobs.update(source.job_id, 'succeeded', {
    remote_ids: { project_id: 'project', operator_id: 'operator' },
  });
  f.jobs.assignName('test-account', 'source', source.job_id);
  f.jobs.bindRequestPolicy('test-account', 'frontend-export-proof:convert-0', proof);
  // 新请求由实际执行器冻结v2；旧请求预存v1，验证升级恢复不替换旧字节与语义。
  if (revision === 1) f.jobs.bindRequestPolicy('test-account', 'frontend-convert-intent:convert-0', intent);
  await saveVerifiedOutputCache(
    { account_ref: 'test-account' },
    { artifact_id: 'frontend-model', kind: 'model', format: 'glb', index: 0 },
    { sha256: hash(bytes), bytes: bytes.length },
    bytes,
    f.dir,
  );
  const counts = { source: 0 },
    client = {
      request: async () => ({ id: 'project', operator: { operator_id: 'unrelated-current-operator' } }),
      forAccount: () => ({
        credentials: { load: () => undefined },
        request: async () => {
          counts.source++;
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
    throw Error('Converted output cannot fall back to the original model.');
  };
  const app = { service: f.service, studio: { client } } as unknown as Application,
    plan = () => processingPlan('convert', '@source', { param: parameters });
  return { ...f, app, plan, original, bytes, proof, intent, parameters, counts };
}

const flags = { requestId: 'convert', wait: false, download: false };
for (const animated of [false, true])
  for (const axis of ['+x', '-x'] as const)
    for (const revision of [1, 2] as const)
      test(`${animated ? 'animated' : 'static'} ${axis} v${revision} keeps its direction through restart, redo and full MCP adapter`, async () => {
        const f = await prepared(animated, axis, revision);
        let reopened: Awaited<ReturnType<typeof fixture>> | undefined;
        try {
          const frozenSource = f.jobs.requestPolicy('test-account', 'frontend-export-proof:convert-0'),
            result = await executePlan(f.app, f.plan(), flags),
            id = text(result.task_id),
            job = f.jobs.get(id),
            expectedAngle = revision === 1 ? workerAngles[axis] : nativeAngles[axis],
            output = await io.readBinary(f.bytes),
            mesh = output
              .getRoot()
              .listNodes()
              .find((node) => node.getName() === 'mesh')!,
            actual = vec3.transformMat4(vec3.create(), [2, 1, 3], mesh.getWorldMatrix()),
            expected = vec3.transformMat4(
              vec3.create(),
              [2, 1, 3],
              mat4.fromYRotation(mat4.create(), expectedAngle),
            );
          assert.deepEqual([...actual], [...expected]);
          assert.deepEqual(
            f.jobs.requestPolicy('test-account', 'frontend-convert-intent:convert-0'),
            f.intent,
          );
          const semantic = f.jobs.requestPolicy('test-account', 'frontend-convert-proof:convert-0')!;
          assert.equal(semantic.version, revision);
          assert.equal(object(semantic.validation).version, revision);
          assert.deepEqual(object(semantic.validation).orientation_mapping, f.intent.orientation_mapping);
          const first = await f.service.download(id, 'model', 'first.glb'),
            firstState = await lstat(text(first.local_path)),
            redo = redoFrontendConvertPlan(f.jobs, f.dir, job)!;
          assert.equal(redo.steps[0]!.frontendConvertRevision, revision);
          assert.equal(redo.steps[0]!.parameters.operator_id, 'operator');
          f.jobs.bindRequestPolicy('test-account', 'frontend-export-proof:redo-0', {
            ...f.proof,
            authorization_request_id: 'redo-0',
          });
          const repeated = await executePlan(f.app, redo, { ...flags, requestId: 'redo' });
          assert.notEqual(repeated.task_id, id);
          assert.deepEqual(f.jobs.requestPolicy('test-account', 'frontend-convert-intent:redo-0'), {
            ...f.intent,
            source: 'project',
          });
          assert.equal(object((repeated.artifacts as unknown[])[0]).sha256, hash(f.bytes));
          assert.equal(f.gateway.posts, 2);
          f.jobs.close();
          reopened = await fixture(f.dir);
          const unavailable = () => {
            throw Error('Recovery must not access the original webpage or authorize again.');
          };
          reopened.gateway.submit = unavailable;
          reopened.gateway.status = unavailable;
          const app = {
            service: reopened.service,
            studio: { client: { forAccount: unavailable } },
          } as unknown as Application;
          const recovered = await executePlan(app, f.plan(), flags);
          assert.equal(recovered.task_id, id);
          const full = fullTools(app.service, app.studio),
            tool = full.find((item) => item.name === 'ai_modeling_convert')!,
            args = tool.schema.parse({ input: '@source', ...f.parameters, request_id: 'convert' });
          assert.equal(object(await tool.run(object(args))).task_id, id);
          const second = await app.service.download(id, 'model', 'second.glb');
          assert.deepEqual(await readFile(text(second.local_path)), f.bytes);
          await app.service.download(id, 'model', 'first.glb');
          const after = await lstat(text(first.local_path));
          assert.equal(after.ino, firstState.ino);
          assert.equal(after.mtimeMs, firstState.mtimeMs);
          assert.equal(reopened.gateway.posts, 0);
          assert.deepEqual(
            reopened.jobs.requestPolicy('test-account', 'frontend-convert-proof:convert-0'),
            semantic,
          );
          assert.deepEqual(
            reopened.jobs.requestPolicy('test-account', 'frontend-export-proof:convert-0'),
            frozenSource,
          );
        } finally {
          if (reopened) reopened.jobs.close();
          else f.jobs.close();
          await rm(f.dir, { recursive: true, force: true });
        }
      });

test('mapped validation binds original axis, worker input and engine metadata for static and animated outputs', async () => {
  for (const animated of [false, true]) {
    const f = await prepared(animated, '+x', 2);
    try {
      const mapping = frontendOrientationMapping('+x'),
        validate = (proof: Record<string, unknown>, value = mapping) =>
          f.parameters.with_animation
            ? validateFrontendConvert(proof, f.bytes, value)
            : validateFrontendStaticConvert(proof, f.bytes, f.parameters, value);
      await validate(f.proof);
      for (const change of [
        (proof: Record<string, unknown>) => (proof.version = 1),
        (proof: Record<string, unknown>) => (object(proof.input).forward_axis = '+x'),
        (proof: Record<string, unknown>) => (object(object(proof.conversion).metadata).forward_axis = '+x'),
      ]) {
        const changed = structuredClone(f.proof);
        change(changed);
        await assert.rejects(validate(changed), { code: 'FRONTEND_CONVERT_UNVERIFIED' });
      }
      await assert.rejects(validate(f.proof, { ...mapping, forward_axis: '+x' }), {
        code: 'FRONTEND_CONVERT_UNVERIFIED',
      });
    } finally {
      f.jobs.close();
      await rm(f.dir, { recursive: true, force: true });
    }
  }
});

test('a tampered v2 mapping cannot recover, publish, or be reinterpreted as legacy v1', async () => {
  const f = await prepared(false, '+x', 2);
  try {
    const result = await executePlan(f.app, f.plan(), flags),
      id = text(result.task_id),
      db = new DatabaseSync(path.join(f.dir, 'jobs.sqlite'));
    try {
      const changed = structuredClone(f.intent);
      changed.orientation_mapping!.forward_axis = '+x';
      db.prepare('UPDATE request_policies SET policy=? WHERE account_ref=? AND request_id=?').run(
        JSON.stringify(changed),
        'test-account',
        'frontend-convert-intent:convert-0',
      );
    } finally {
      db.close();
    }
    await assert.rejects(executePlan(f.app, f.plan(), flags), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.equal((await f.service.get(id)).state, 'needs_attention');
    await assert.rejects(f.service.download(id, 'model', 'invalid.glb'));
    assert.equal(f.gateway.posts, 1);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('all new axis mappings have the fixed native orientation while y preserves original worker values', () => {
  for (const axis of ['+x', '-x', '+y', '-y'] as const) {
    const mapping = frontendOrientationMapping(axis);
    assert.equal(mapping.export_orientation, axis);
    assert.equal(mapping.forward_axis, expectedAxes[axis]);
    assert.equal(workerAngles[mapping.forward_axis], nativeAngles[axis]);
  }
});
