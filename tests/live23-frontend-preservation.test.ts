import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Document, NodeIO } from '@gltf-transform/core';
import { mat4 } from 'gl-matrix';
import { readFrontendDocument } from '../cli/artifacts/studio-assimp-normalize.ts';
import { restoreFrontendDefaults } from '../cli/artifacts/studio-assimp-rest.ts';
import { verifyStudioFrontend } from '../cli/artifacts/studio-assimp-proof.ts';
import { frontendAssetAigc, preserveFrontendAssetAigc } from '../cli/artifacts/studio-assimp-json.ts';

const metadata = { forward_axis: '-y', pivot_to_center_bottom: true } as const;
const io = new NodeIO();
const encode = async (document: Document): Promise<Buffer> => Buffer.from(await io.writeBinary(document));
const aigc = JSON.stringify(
  {
    Label: '1',
    ContentProducer: 'original-producer',
    ProduceID: 'original-production',
    ReservedCode1: '',
    ContentPropagator: 'original-propagator',
    PropagateID: 'original-propagation',
    ReservedCode2: '',
  },
  null,
  2,
);
function editJson(bytes: Buffer, mutate: (value: Record<string, unknown>) => void): Buffer {
  const json = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12))) as Record<string, unknown>;
  mutate(json);
  const body = Buffer.from(JSON.stringify(json)),
    pad = (4 - (body.length % 4)) % 4;
  const bin = bytes.subarray(20 + bytes.readUInt32LE(12)),
    header = Buffer.from(bytes.subarray(0, 20));
  header.writeUInt32LE(20 + body.length + pad + bin.length, 8);
  header.writeUInt32LE(body.length + pad, 12);
  return Buffer.concat([header, body, Buffer.alloc(pad, 32), bin]);
}
async function fixture(rotation = false) {
  const doc = new Document(),
    buffer = doc.createBuffer(),
    scene = doc.createScene('scene');
  const f = (type: 'VEC3' | 'VEC4' | 'MAT4' | 'SCALAR', values: number[]) =>
    doc.createAccessor().setType(type).setArray(new Float32Array(values)).setBuffer(buffer);
  const bone = doc.createNode('bone'),
    node = doc.createNode('mesh'),
    skin = doc
      .createSkin('skin')
      .addJoint(bone)
      .setInverseBindMatrices(f('MAT4', Array.from(mat4.create())));
  node.setSkin(skin).setMesh(
    doc.createMesh('mesh').addPrimitive(
      doc
        .createPrimitive()
        .setAttribute('POSITION', f('VEC3', [-1, 0, 0, 1, 0, 0, 0, 2, 0]))
        .setAttribute('NORMAL', f('VEC3', [0, 0, 1, 0, 0, 1, 0, 0, 1]))
        .setAttribute(
          'JOINTS_0',
          doc.createAccessor().setType('VEC4').setArray(new Uint8Array(12)).setBuffer(buffer),
        )
        .setAttribute('WEIGHTS_0', f('VEC4', [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])),
    ),
  );
  scene.addChild(bone).addChild(node);
  const values = rotation
    ? [0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0.5, 0, 0, 0, 0.25, 0, 0, 0, Math.SQRT1_2, Math.SQRT1_2, 0, 0, 0, 0]
    : [0, 0, 0, 0, 0, 0, 1, 0, 0, -0.5, 0, 0, 2, 0, 0, 0, 0, 0];
  const sampler = doc
    .createAnimationSampler()
    .setInterpolation('CUBICSPLINE')
    .setInput(f('SCALAR', [0, 2]))
    .setOutput(f(rotation ? 'VEC4' : 'VEC3', values));
  doc
    .createAnimation('motion')
    .addSampler(sampler)
    .addChannel(
      doc
        .createAnimationChannel()
        .setSampler(sampler)
        .setTargetNode(bone)
        .setTargetPath(rotation ? 'rotation' : 'translation'),
    );
  const source = await encode(doc),
    output = await io.readBinary(source),
    out = output.getRoot();
  const target = out.listAnimations()[0]!.listSamplers()[0]!,
    sourceValues = target.getOutput()!;
  target
    .setOutput(
      output
        .createAccessor()
        .setType(sourceValues.getType())
        .setBuffer(out.listBuffers()[0]!)
        .setArray(new Float32Array([...sourceValues.getElement(1, []), ...sourceValues.getElement(4, [])])),
    )
    .setInterpolation('LINEAR');
  const root = output
    .createNode('engine-root')
    .setMatrix(
      Array.from(mat4.fromYRotation(mat4.create(), -Math.PI / 2)) as ReturnType<typeof node.getMatrix>,
    );
  const targetScene = out.listScenes()[0]!;
  for (const child of targetScene.listChildren()) {
    targetScene.removeChild(child);
    root.addChild(child);
  }
  targetScene.addChild(root);
  return { source, output, target };
}

test('cubic recovery preserves source Hermite tangents and intermediate motion instead of linear endpoints', async () => {
  const f = await fixture(),
    restored = await restoreFrontendDefaults(f.source, await encode(f.output));
  assert.equal(restored.proof.restored_cubic_tracks, 1);
  const document = await readFrontendDocument(restored.bytes),
    root = document.getRoot();
  const track = root.listAnimations()[0]!.listSamplers()[0]!;
  assert.equal(track.getInterpolation(), 'CUBICSPLINE');
  const sourceTrack = (await readFrontendDocument(f.source))
    .getRoot()
    .listAnimations()[0]!
    .listSamplers()[0]!;
  assert.deepEqual(track.getInput()!.getArray(), sourceTrack.getInput()!.getArray());
  assert.deepEqual(track.getOutput()!.getArray(), sourceTrack.getOutput()!.getArray());
  for (const time of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75]) {
    const u = time / 2,
      values = track.getOutput()!;
    const value =
      (2 * u ** 3 - 3 * u ** 2 + 1) * values.getElement(1, [])[0]! +
      (u ** 3 - 2 * u ** 2 + u) * 2 * values.getElement(2, [])[0]! +
      (-2 * u ** 3 + 3 * u ** 2) * values.getElement(4, [])[0]! +
      (u ** 3 - u ** 2) * 2 * values.getElement(3, [])[0]!;
    const expected = (u ** 3 - 2 * u ** 2 + u) * 2 + (-2 * u ** 3 + 3 * u ** 2) * 2 - (u ** 3 - u ** 2);
    assert.equal(value, expected);
    assert.notEqual(value, time);
  }
  assert.equal((await verifyStudioFrontend(f.source, restored.bytes, metadata)).faces, 1);
  track.getOutput()!.setElement(2, [0, 0, 0]);
  await assert.rejects(verifyStudioFrontend(f.source, await encode(document), metadata), {
    code: 'FRONTEND_EXPORT_UNVERIFIED',
  });
});

test('cubic recovery rejects altered engine keyframe values and times', async () => {
  for (const change of ['time', 'value']) {
    const f = await fixture();
    if (change === 'time') f.target.getInput()!.setScalar(1, 2.1);
    else f.target.getOutput()!.setElement(1, [2.1, 0, 0]);
    await assert.rejects(restoreFrontendDefaults(f.source, await encode(f.output)), {
      code: 'FRONTEND_EXPORT_UNVERIFIED',
    });
  }
});

test('cubic recovery rejects truncated tangent triples, changed vector shape and nonfinite derivatives', async () => {
  for (const mutation of ['count', 'type', 'finite']) {
    const f = await fixture(),
      source = await io.readBinary(f.source),
      values = source.getRoot().listAnimations()[0]!.listSamplers()[0]!.getOutput()!;
    if (mutation === 'count') values.setArray(new Float32Array(15));
    else if (mutation === 'type') values.setType('VEC4').setArray(new Float32Array(24));
    else values.setElement(2, [Infinity, 0, 0]);
    await assert.rejects(restoreFrontendDefaults(await encode(source), await encode(f.output)), {
      code: 'FRONTEND_EXPORT_UNVERIFIED',
    });
  }
});

test('cubic quaternion tangents are finite derivatives while keyframe quaternion values must be unit length', async () => {
  const f = await fixture(true),
    restored = await restoreFrontendDefaults(f.source, await encode(f.output));
  await verifyStudioFrontend(f.source, restored.bytes, metadata);
  const broken = await io.readBinary(f.source);
  broken.getRoot().listAnimations()[0]!.listSamplers()[0]!.getOutput()!.setElement(1, [0, 0, 0, 0.8]);
  await assert.rejects(verifyStudioFrontend(await encode(broken), restored.bytes, metadata), {
    code: 'FRONTEND_EXPORT_UNVERIFIED',
  });
});

test('frontend attribution keeps every observed AIGC field and the original string bytes', async () => {
  const f = await fixture();
  const source = editJson(f.source, (json) => {
    (json.asset as Record<string, unknown>).extras = { AIGC: aigc };
  });
  await readFrontendDocument(source);
  const restored = await restoreFrontendDefaults(source, await encode(f.output));
  assert.equal(frontendAssetAigc(restored.bytes), aigc);
  assert.equal(restored.proof.restored_asset_aigc, true);
  assert.equal(
    (await verifyStudioFrontend(source, restored.bytes, metadata)).original_asset_aigc_preserved,
    true,
  );
  const untouched = preserveFrontendAssetAigc(source, restored.bytes);
  assert.equal(untouched, restored.bytes);
  const changed = editJson(restored.bytes, (json) => {
    (json.asset as Record<string, unknown>).extras = {
      AIGC: aigc.replace('original-production', 'different-production'),
    };
  });
  assert.throws(() => preserveFrontendAssetAigc(source, changed), { code: 'FRONTEND_EXPORT_UNVERIFIED' });
  await assert.rejects(verifyStudioFrontend(source, changed, metadata), {
    code: 'FRONTEND_EXPORT_UNVERIFIED',
  });
});

test('unknown extras and unverified AIGC field shapes remain rejected', async () => {
  const { source } = await fixture();
  for (const extras of [
    { custom: 1 },
    { AIGC: '{}' },
    { AIGC: aigc, custom: 1 },
    { AIGC: aigc.replace('"1"', '1') },
    { AIGC: aigc.replace('ReservedCode2', 'unknownField') },
  ]) {
    const value = editJson(source, (json) => {
      (json.asset as Record<string, unknown>).extras = extras;
    });
    await assert.rejects(readFrontendDocument(value), { code: 'FRONTEND_EXPORT_UNVERIFIED' });
  }
  const nodeExtra = editJson(source, (json) => {
    (json.nodes as Record<string, unknown>[])[0]!.extras = { AIGC: aigc };
  });
  await assert.rejects(readFrontendDocument(nodeExtra), { code: 'FRONTEND_EXPORT_UNVERIFIED' });
});

test('attribution helpers reject malformed GLB with structured errors before parsing metadata', async () => {
  const { source } = await fixture(),
    invalidJson = Buffer.from(source);
  invalidJson[20] = 0;
  for (const invalid of [Buffer.alloc(4), source.subarray(0, 24), invalidJson]) {
    assert.throws(() => frontendAssetAigc(invalid), { code: 'INVALID_ARTIFACT' });
    assert.throws(() => preserveFrontendAssetAigc(source, invalid), { code: 'INVALID_ARTIFACT' });
  }
});
