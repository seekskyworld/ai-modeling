import test from 'node:test';
import assert from 'node:assert/strict';
import { Document, NodeIO } from '@gltf-transform/core';
import { mat4 } from 'gl-matrix';
import { prepareFrontendEdits, supportsStaticFrontendWorld } from '../cli/artifacts/studio-frontend-edits.ts';

function fixture(): Document {
  const doc = new Document(),
    buffer = doc.createBuffer(),
    scene = doc.createScene('Scene');
  doc.getRoot().setDefaultScene(scene);
  for (const [name, offset] of [
    ['A', 0],
    ['B', 10],
  ] as const) {
    const positions = doc
      .createAccessor()
      .setType('VEC3')
      .setArray(new Float32Array([0, 0, 0, 2, 0, 0, 0, 3, 5]))
      .setBuffer(buffer);
    const normal = [0, -5 / Math.sqrt(34), 3 / Math.sqrt(34)];
    const normals = doc
      .createAccessor()
      .setType('VEC3')
      .setArray(new Float32Array([...normal, ...normal, ...normal]))
      .setBuffer(buffer);
    const material = doc
      .createMaterial('material' + name)
      .setMetallicFactor(0.2)
      .setRoughnessFactor(0.4);
    const mesh = doc
      .createMesh('mesh' + name)
      .addPrimitive(
        doc
          .createPrimitive()
          .setAttribute('POSITION', positions)
          .setAttribute('NORMAL', normals)
          .setMaterial(material),
      );
    scene.addChild(
      doc
        .createNode('node' + name)
        .setMesh(mesh)
        .setTranslation([offset, 0, 0]),
    );
  }
  return doc;
}
const translate = Array.from(mat4.fromTranslation(mat4.create(), [7, 11, 13]));
const scale = Array.from(mat4.fromScaling(mat4.create(), [2, 3, 4]));
const bytes = async (document: Document): Promise<Buffer> =>
  Buffer.from(await new NodeIO().writeBinary(document));

test('frontend edit verification composes root × child × source without modifying source', async () => {
  const source = fixture();
  const originalNode = source.getRoot().listNodes()[1]!;
  const positions = originalNode.getMesh()!.listPrimitives()[0]!.getAttribute('POSITION')!;
  const originalPositions = Array.from(positions.getArray()!);
  const sourceBytes = await bytes(source),
    originalBytes = Buffer.from(sourceBytes);
  const result = await prepareFrontendEdits(sourceBytes, {
    transform_matrix: scale,
    children_transform_matrix: { nodeB: translate },
  });
  assert.deepEqual(result.bounds.min, [0, 0, 0]);
  assert.deepEqual(result.bounds.max, [38, 42, 72]);
  assert.deepEqual(result.bounds.pivot, [19, 0, 36]);
  const edited = result.document
    .getRoot()
    .listNodes()
    .find((n) => n.getName() === 'nodeB')!;
  assert.deepEqual(edited.getTranslation(), [0, 0, 0]);
  assert.deepEqual(
    edited.getMesh()!.listPrimitives()[0]!.getAttribute('POSITION')!.getElement(0, []),
    [34, 33, 52],
  );
  assert.deepEqual(Array.from(positions.getArray()!), originalPositions);
  assert.deepEqual(originalNode.getTranslation(), [10, 0, 0]);
  assert.equal(source.getRoot().listNodes().length, 2);
  assert.equal(result.proof.verification_copy_only, true);
  assert.deepEqual(sourceBytes, originalBytes);
});

test('frontend deletion recomputes the pivot from surviving edited world positions', async () => {
  const source = fixture(),
    result = await prepareFrontendEdits(await bytes(source), { children_deleted: ['nodeA'] });
  assert.deepEqual(result.bounds.min, [10, 0, 0]);
  assert.deepEqual(result.bounds.max, [12, 3, 5]);
  assert.deepEqual(result.bounds.pivot, [11, 0, 2.5]);
  assert.deepEqual(
    result.document
      .getRoot()
      .listNodes()
      .map((n) => n.getName()),
    ['nodeB'],
  );
  assert.equal(result.document.getRoot().listMeshes().length, 1);
  assert.equal(source.getRoot().listMeshes().length, 2);
});

test('one source root follows the original engine child × root order for noncommuting edits', async () => {
  const source = fixture(),
    second = source.getRoot().listNodes()[1]!,
    mesh = second.getMesh()!;
  second.dispose();
  mesh.dispose();
  source.getRoot().listNodes()[0]!.setTranslation([2, 3, 4]);
  const input = await bytes(source),
    result = await prepareFrontendEdits(input, {
      transform_matrix: scale,
      children_transform_matrix: { nodeA: translate },
    });
  assert.deepEqual(result.bounds.min, [11, 20, 29]);
  assert.deepEqual(result.bounds.max, [15, 29, 49]);
  assert.match(String(result.proof.composition), /^child × root/);
  assert.deepEqual(source.getRoot().listNodes()[0]!.getTranslation(), [2, 3, 4]);
});

test('deleting one of two source roots does not switch to the single-root transform order', async () => {
  const result = await prepareFrontendEdits(await bytes(fixture()), {
    transform_matrix: scale,
    children_transform_matrix: { nodeB: translate },
    children_deleted: ['nodeA'],
  });
  assert.deepEqual(result.bounds.min, [34, 33, 52]);
  assert.deepEqual(result.bounds.max, [38, 42, 72]);
  assert.match(String(result.proof.composition), /^root × child/);
});

test('frontend nonuniform scaling transforms normals with inverse transpose', async () => {
  const source = fixture(),
    result = await prepareFrontendEdits(await bytes(source), { transform_matrix: scale });
  const normal = result.document
    .getRoot()
    .listNodes()[0]!
    .getMesh()!
    .listPrimitives()[0]!
    .getAttribute('NORMAL')!
    .getElement(0, []);
  const expected = [0, -5 / 3, 3 / 4],
    length = Math.hypot(...expected);
  expected.forEach((v, i) => assert.ok(Math.abs(normal[i]! - v / length) < 1e-6));
});

test('frontend edited source rejects reflection, shear, perspective and singular inputs', async () => {
  const reflection = Array.from(mat4.fromScaling(mat4.create(), [-1, 1, 1]));
  const shear = Array.from(mat4.create());
  shear[4] = 0.2;
  const perspective = Array.from(mat4.create());
  perspective[3] = 0.1;
  const singular = Array.from(mat4.fromScaling(mat4.create(), [0, 1, 1]));
  const source = await bytes(fixture());
  for (const transform_matrix of [reflection, shear, perspective, singular])
    await assert.rejects(() => prepareFrontendEdits(source, { transform_matrix }));
});

test('frontend edited source refuses unknown, repeated and all-deleted names', async () => {
  const source = await bytes(fixture());
  for (const metadata of [
    { children_transform_matrix: { meshA: translate } },
    { children_deleted: ['missing'] },
    { children_deleted: ['nodeA', 'nodeA'] },
    { children_deleted: ['nodeA', 'nodeB'] },
    { children_rename: { missing: 'Renamed' } },
    { children_rename: { nodeA: '' } },
    { children_rename: { nodeA: 'x'.repeat(101) } },
    { children_rename: { nodeA: 1 } },
  ])
    await assert.rejects(() => prepareFrontendEdits(source, metadata));
});

test('webpage display labels are disclosed without changing the original file names or geometry', async () => {
  const input = await bytes(fixture()),
    original = Buffer.from(input),
    baseline = await prepareFrontendEdits(input, {}),
    names = { nodeA: '左部件', nodeB: 'Right Part' },
    result = await prepareFrontendEdits(input, { children_rename: names });
  assert.deepEqual(input, original);
  assert.deepEqual(result.bounds, baseline.bounds);
  assert.deepEqual(
    result.document
      .getRoot()
      .listNodes()
      .map((node) => node.getName()),
    ['nodeA', 'nodeB'],
  );
  assert.deepEqual(
    result.document
      .getRoot()
      .listMeshes()
      .map((mesh) => mesh.getName()),
    ['meshA', 'meshB'],
  );
  assert.deepEqual((result.proof.display_name_mapping as Record<string, unknown>).names, names);
  const deleted = await prepareFrontendEdits(input, {
    children_rename: names,
    children_deleted: ['nodeA'],
  });
  assert.deepEqual(
    deleted.document
      .getRoot()
      .listNodes()
      .map((node) => node.getName()),
    ['nodeB'],
  );
  assert.deepEqual((deleted.proof.display_name_mapping as Record<string, unknown>).names, names);
});

test('frontend edited source refuses hierarchy, animation, skin and shared-mesh ambiguity', async () => {
  const hierarchical = fixture(),
    [parent, child] = hierarchical.getRoot().listNodes();
  parent!.addChild(child!);
  const bytesToCheck = await bytes(hierarchical);
  await assert.rejects(() => prepareFrontendEdits(bytesToCheck, {}));
  const animated = fixture(),
    buffer = animated.getRoot().listBuffers()[0]!;
  const sampler = animated
    .createAnimationSampler()
    .setInput(
      animated
        .createAccessor()
        .setType('SCALAR')
        .setArray(new Float32Array([0, 1]))
        .setBuffer(buffer),
    )
    .setOutput(
      animated
        .createAccessor()
        .setType('VEC3')
        .setArray(new Float32Array([0, 0, 0, 1, 0, 0]))
        .setBuffer(buffer),
    );
  animated
    .createAnimation('walk')
    .addChannel(
      animated
        .createAnimationChannel()
        .setTargetNode(animated.getRoot().listNodes()[0]!)
        .setTargetPath('translation')
        .setSampler(sampler),
    );
  const animatedBytes = await bytes(animated);
  await assert.rejects(() => prepareFrontendEdits(animatedBytes, {}));
  const skinned = fixture(),
    joint = skinned.createNode('Joint');
  skinned.getRoot().listScenes()[0]!.addChild(joint);
  skinned.getRoot().listNodes()[0]!.setSkin(skinned.createSkin().addJoint(joint));
  const skinnedBytes = await bytes(skinned);
  await assert.rejects(() => prepareFrontendEdits(skinnedBytes, {}));
  const shared = fixture(),
    nodes = shared.getRoot().listNodes();
  nodes[1]!.setMesh(nodes[0]!.getMesh());
  const sharedBytes = await bytes(shared);
  await assert.rejects(() => prepareFrontendEdits(sharedBytes, {}));
});

test('static world bounds apply identically to absent and explicit identity edits', async () => {
  const source = fixture();
  assert.equal(supportsStaticFrontendWorld(source), true);
  const sourceBytes = await bytes(source),
    identity = Array.from(mat4.create());
  const results = await Promise.all([
    prepareFrontendEdits(sourceBytes, {}),
    prepareFrontendEdits(sourceBytes, { transform_matrix: identity }),
    prepareFrontendEdits(sourceBytes, { children_transform_matrix: { nodeB: identity } }),
  ]);
  for (const result of results) assert.deepEqual(result.bounds.pivot, [6, 0, 2.5]);
  source.createAnimation('animation');
  assert.equal(supportsStaticFrontendWorld(source), false);
});

test('static world classification keeps unsupported accessor representations on the prior path', () => {
  const normalized = fixture();
  normalized
    .getRoot()
    .listMeshes()[0]!
    .listPrimitives()[0]!
    .getAttribute('POSITION')!
    .setArray(new Int16Array([0, 0, 0, 2, 0, 0, 0, 3, 5]))
    .setNormalized(true);
  assert.equal(supportsStaticFrontendWorld(normalized), false);
  const mismatched = fixture();
  mismatched
    .getRoot()
    .listMeshes()[0]!
    .listPrimitives()[0]!
    .getAttribute('NORMAL')!
    .setArray(new Float32Array([0, 0, 1]));
  assert.equal(supportsStaticFrontendWorld(mismatched), false);
});
