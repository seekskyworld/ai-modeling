import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { mat4 } from 'gl-matrix';
import {
  normalizeFrontendAnimation,
  readFrontendDocument,
} from '../cli/artifacts/studio-assimp-normalize.ts';
import { restoreFrontendDefaults } from '../cli/artifacts/studio-assimp-rest.ts';
import { verifyStudioFrontend } from '../cli/artifacts/studio-assimp-proof.ts';
import { loadStudioAssimpAssets, studioAssimpFiles } from '../cli/artifacts/studio-assimp-assets.ts';
import { convertStudioFrontend } from '../cli/artifacts/studio-assimp-runtime.ts';

const metadata = { forward_axis: '-y' as const, pivot_to_center_bottom: true as const };
function fixture(): Document {
  const doc = new Document(),
    buffer = doc.createBuffer(),
    scene = doc.createScene();
  const mesh = doc.createMesh('triangle'),
    node = doc.createNode('mesh').setMesh(mesh),
    bone = doc.createNode('bone');
  scene.addChild(node).addChild(bone);
  doc.getRoot().setDefaultScene(scene);
  const floats = (type: 'VEC3' | 'VEC4' | 'MAT4' | 'SCALAR', values: number[]) =>
    doc.createAccessor().setType(type).setArray(new Float32Array(values)).setBuffer(buffer);
  const skin = doc
    .createSkin()
    .addJoint(bone)
    .setInverseBindMatrices(floats('MAT4', Array.from(mat4.create())));
  node.setSkin(skin);
  const position = floats('VEC3', [0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normal = floats('VEC3', [0, 0, 1, 0, 0, 1, 0, 0, 1]),
    joints = doc.createAccessor().setType('VEC4').setArray(new Uint8Array(12)).setBuffer(buffer),
    weights = floats('VEC4', [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  mesh.addPrimitive(
    doc
      .createPrimitive()
      .setAttribute('POSITION', position)
      .setAttribute('NORMAL', normal)
      .setAttribute('JOINTS_0', joints)
      .setAttribute('WEIGHTS_0', weights),
  );
  const time = floats('SCALAR', [0, 1]),
    rotation = doc
      .createAccessor()
      .setType('VEC4')
      .setArray(new Int16Array([0, 0, 0, 32767, 0, 0, 23170, 23170]))
      .setNormalized(true)
      .setBuffer(buffer);
  for (const name of ['idle', 'walk']) {
    const animation = doc.createAnimation(name),
      sampler = doc.createAnimationSampler().setInput(time).setOutput(rotation).setInterpolation('LINEAR');
    animation
      .addSampler(sampler)
      .addChannel(
        doc.createAnimationChannel().setTargetNode(bone).setTargetPath('rotation').setSampler(sampler),
      );
  }
  return doc;
}
const encode = async (doc: Document): Promise<Buffer> => Buffer.from(await new NodeIO().writeBinary(doc));
function patchJson(bytes: Buffer, edit: (json: Record<string, unknown>) => void): Buffer {
  const json = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12))) as Record<string, unknown>;
  edit(json);
  const data = Buffer.from(JSON.stringify(json)),
    padding = (4 - (data.length % 4)) % 4,
    binary = bytes.subarray(20 + bytes.readUInt32LE(12)),
    header = Buffer.from(bytes.subarray(0, 20));
  header.writeUInt32LE(20 + data.length + padding + binary.length, 8);
  header.writeUInt32LE(data.length + padding, 12);
  return Buffer.concat([header, data, Buffer.alloc(padding, 0x20), binary]);
}
async function pair(): Promise<{ source: Buffer; output: Document }> {
  const source = await encode(fixture()),
    normalized = await normalizeFrontendAnimation(source),
    output = await new NodeIO().readBinary(normalized.bytes),
    scene = output.getRoot().listScenes()[0]!;
  const original = scene.listChildren(),
    root = output.createNode('engine-root'),
    matrix = mat4.create();
  mat4.rotateY(matrix, matrix, -Math.PI / 2);
  mat4.translate(matrix, matrix, [-0.5, 0, 0]);
  root.setMatrix(Array.from(matrix) as ReturnType<typeof root.getMatrix>);
  for (const node of original) {
    scene.removeChild(node);
    root.addChild(node);
  }
  scene.addChild(root);
  return { source, output };
}

test('标准normalized动画解码保两clip所有采样/时间和微小原始TRS', async () => {
  const source = patchJson(await encode(fixture()), (json) => {
    const bone = (json.nodes as Record<string, unknown>[]).find((node) => node.name === 'bone')!;
    bone.rotation = [0, 0.000006, 0, 0.999999999982];
  });
  const original = (await readFrontendDocument(source)).getRoot(),
    result = await normalizeFrontendAnimation(source),
    decoded = (await readFrontendDocument(result.bytes)).getRoot();
  assert.equal(result.proof.changed_accessors, 1);
  assert.deepEqual(
    decoded
      .listNodes()
      .find((n) => n.getName() === 'bone')!
      .getRotation(),
    original
      .listNodes()
      .find((n) => n.getName() === 'bone')!
      .getRotation(),
  );
  for (let i = 0; i < 2; i++) {
    const a = original.listAnimations()[i]!.listSamplers()[0]!,
      b = decoded.listAnimations()[i]!.listSamplers()[0]!;
    assert.deepEqual([...a.getInput()!.getArray()!], [...b.getInput()!.getArray()!]);
    assert.equal(b.getOutput()!.getComponentType(), 5126);
    assert.equal(b.getOutput()!.getNormalized(), false);
    for (let j = 0; j < a.getOutput()!.getCount(); j++)
      assert.ok(
        a
          .getOutput()!
          .getElement(j, [])
          .every((v, k) => Math.abs(v - b.getOutput()!.getElement(j, [])[k]!) < 3e-8),
      );
  }
});

test('骨架GLB完整轨道和固定父变换通过；根位移或权重变化拒绝', async () => {
  const { source, output } = await pair();
  const proof = await verifyStudioFrontend(source, await encode(output), metadata);
  assert.equal(proof.faces, 1);
  assert.equal((proof.clips as unknown[]).length, 2);
  const primitive = output.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
  primitive.getAttribute('WEIGHTS_0')!.setElement(0, [0.9, 0, 0, 0]);
  await assert.rejects(verifyStudioFrontend(source, await encode(output), metadata), {
    code: 'FRONTEND_EXPORT_UNVERIFIED',
  });
  primitive.getAttribute('WEIGHTS_0')!.setElement(0, [1, 0, 0, 0]);
  output
    .getRoot()
    .listNodes()
    .find((n) => n.getName() === 'engine-root')!
    .setTranslation([0, 0, 2]);
  await assert.rejects(verifyStudioFrontend(source, await encode(output), metadata), {
    code: 'FRONTEND_EXPORT_UNVERIFIED',
  });
});

test('三角反面与材质颜色改变不会通过表面证明', async () => {
  const { source, output } = await pair(),
    primitive = output.getRoot().listMeshes()[0]!.listPrimitives()[0]!,
    buffer = output.getRoot().listBuffers()[0]!;
  primitive.setIndices(
    output
      .createAccessor()
      .setType('SCALAR')
      .setArray(new Uint16Array([0, 2, 1]))
      .setBuffer(buffer),
  );
  await assert.rejects(verifyStudioFrontend(source, await encode(output), metadata), {
    code: 'FRONTEND_EXPORT_UNVERIFIED',
  });
  primitive.setIndices(null);
  primitive.setMaterial(output.createMaterial().setBaseColorFactor([1, 0, 0, 1]));
  await assert.rejects(verifyStudioFrontend(source, await encode(output), metadata), {
    code: 'FRONTEND_EXPORT_UNVERIFIED',
  });
});

test('恢复复制原插值但不重写改变后的原轨道；最终证明继续拒绝', async () => {
  const { source, output } = await pair(),
    sampler = output.getRoot().listAnimations()[0]!.listSamplers()[0]!;
  sampler.setInterpolation('STEP');
  sampler.getOutput()!.setElement(1, [0, 0, 0, 1]);
  const restored = await restoreFrontendDefaults(source, await encode(output));
  assert.equal(restored.proof.restored_interpolations, 1);
  await assert.rejects(verifyStudioFrontend(source, restored.bytes, metadata), {
    code: 'FRONTEND_EXPORT_UNVERIFIED',
  });
});

test('指定引擎目录缺文件或摘要不符不联网；固定下载大小超限拒绝', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tripo-frontend-runtime-test-'));
  let calls = 0;
  try {
    const fetcher = async (): Promise<Response> => {
      calls++;
      return new Response(Buffer.alloc(studioAssimpFiles.glue.bytes + 1));
    };
    await assert.rejects(loadStudioAssimpAssets({ dataDir: directory, runtimeDir: directory }, fetcher), {
      code: 'FRONTEND_RUNTIME_MISSING',
    });
    assert.equal(calls, 0);
    await writeFile(
      path.join(directory, studioAssimpFiles.glue.name),
      Buffer.alloc(studioAssimpFiles.glue.bytes),
    );
    await assert.rejects(loadStudioAssimpAssets({ dataDir: directory, runtimeDir: directory }, fetcher), {
      code: 'FRONTEND_RUNTIME_INTEGRITY',
    });
    assert.equal(calls, 0);
    const fresh = path.join(directory, 'cache');
    await mkdir(fresh);
    await assert.rejects(loadStudioAssimpAssets({ dataDir: fresh }, fetcher), {
      code: 'FRONTEND_RUNTIME_INTEGRITY',
    });
    assert.equal(calls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('无效参数在引擎获取前失败且不提供静默元数据默认', async () => {
  const options = { dataDir: '/does-not-exist', projectName: 'model', metadata };
  await assert.rejects(convertStudioFrontend(Buffer.alloc(0), options), {
    code: 'FRONTEND_EXPORT_UNVERIFIED',
  });
  await assert.rejects(convertStudioFrontend(Buffer.alloc(28), { ...options, projectName: '../escape' }), {
    code: 'INVALID_INPUT',
  });
  await assert.rejects(convertStudioFrontend(Buffer.alloc(28), { ...options, timeoutMs: 120001 }), {
    code: 'INVALID_INPUT',
  });
  for (const invalid of [
    { forward_axis: '-y', pivot_to_center_bottom: 'false' },
    { forward_axis: '-y' },
    { forward_axis: '+z', pivot_to_center_bottom: false },
  ])
    await assert.rejects(
      convertStudioFrontend(Buffer.alloc(28), { ...options, metadata: invalid as never }),
      { code: 'FRONTEND_EXPORT_UNVERIFIED' },
    );
});
