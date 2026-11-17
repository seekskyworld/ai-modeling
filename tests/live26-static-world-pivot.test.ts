import test from 'node:test';
import assert from 'node:assert/strict';
import { Document, NodeIO } from '@gltf-transform/core';
import { staticFrontendWorld } from '../cli/artifacts/studio-frontend-world.ts';
import { verifyStudioFrontend } from '../cli/artifacts/studio-assimp-proof.ts';

const inputPoints = [0, 0, 0, 2, 0, 0, 0, 3, 5];
const outputPoints = [
  [-6, 0, -2.5, -4, 0, -2.5, -6, 3, 2.5],
  [4, 0, -2.5, 6, 0, -2.5, 4, 3, 2.5],
];

/** 用固定世界坐标控制文件核对轴心；不调用生产bounds/矩阵函数生成预期值。 */
function scene(kind: 'hierarchy' | 'multiprimitive', output = false): Document {
  const doc = new Document(),
    buffer = doc.createBuffer(),
    scene = doc.createScene('Scene');
  doc.getRoot().setDefaultScene(scene);
  const group = doc.createNode(kind === 'hierarchy' ? 'group' : 'nodeA');
  if (!output) group.setTranslation(kind === 'hierarchy' ? [3, 5, 7] : [4, 7, 10]);
  scene.addChild(group);
  const sharedMesh = kind === 'multiprimitive' ? doc.createMesh('meshA') : undefined;
  if (sharedMesh) group.setMesh(sharedMesh);
  for (let index = 0; index < 2; index++) {
    const points = output
        ? outputPoints[index]!
        : inputPoints.map(
            (value, axis) => value + (kind === 'multiprimitive' && axis % 3 === 0 ? index * 10 : 0),
          ),
      normal = [0, -5 / Math.sqrt(34), 3 / Math.sqrt(34)],
      material = doc
        .createMaterial('material' + index)
        .setBaseColorFactor(index ? [0, 0, 1, 1] : [1, 0, 0, 1]),
      primitive = doc
        .createPrimitive()
        .setAttribute(
          'POSITION',
          doc.createAccessor().setType('VEC3').setArray(new Float32Array(points)).setBuffer(buffer),
        )
        .setAttribute(
          'NORMAL',
          doc
            .createAccessor()
            .setType('VEC3')
            .setArray(new Float32Array([...normal, ...normal, ...normal]))
            .setBuffer(buffer),
        )
        .setAttribute(
          'TEXCOORD_0',
          doc
            .createAccessor()
            .setType('VEC2')
            .setArray(new Float32Array([0, 0, 1, 0, 0, 1]))
            .setBuffer(buffer),
        )
        .setMaterial(material);
    if (sharedMesh) sharedMesh.addPrimitive(primitive);
    else {
      const node = doc
        .createNode(index ? 'nodeB' : 'nodeA')
        .setMesh(doc.createMesh('mesh' + index).addPrimitive(primitive));
      if (!output) node.setTranslation([1 + index * 10, 2, 3]);
      group.addChild(node);
    }
  }
  return doc;
}
const bytes = async (doc: Document) => Buffer.from(await new NodeIO().writeBinary(doc));

for (const kind of ['hierarchy', 'multiprimitive'] as const) {
  test(`static ${kind} centers from world positions and keeps source bytes unchanged`, async () => {
    const source = scene(kind),
      input = await bytes(source),
      original = Buffer.from(input),
      bounds = staticFrontendWorld(source)!;
    assert.deepEqual(bounds.bounds.min, [4, 7, 10]);
    assert.deepEqual(bounds.bounds.max, [16, 10, 15]);
    assert.deepEqual(bounds.bounds.pivot, [10, 7, 12.5]);
    const proof = await verifyStudioFrontend(input, await bytes(scene(kind, true)), {
      forward_axis: '-x',
      pivot_to_center_bottom: true,
    });
    assert.deepEqual(proof.pivot_from_static_world_bounds, [10, 7, 12.5]);
    assert.equal(proof.faces, 2);
    assert.deepEqual(input, original);
  });

  test(`static ${kind} refuses an incorrect pivot or changed output surface`, async () => {
    const source = await bytes(scene(kind)),
      output = scene(kind, true),
      positions = output.getRoot().listMeshes()[0]!.listPrimitives()[0]!.getAttribute('POSITION')!;
    const correct = await bytes(output);
    await assert.rejects(() =>
      verifyStudioFrontend(source, correct, {
        forward_axis: '-x',
        pivot_to_center_bottom: false,
      }),
    );
    positions.setElement(0, [-5, 0, -2.5]);
    const bytesBuffer = await bytes(output);
    await assert.rejects(() =>
      verifyStudioFrontend(source, bytesBuffer, {
        forward_axis: '-x',
        pivot_to_center_bottom: true,
      }),
    );
  });
}

test('world bounds exclude shared instances, animation, reflection, morph and detached geometry', () => {
  const shared = scene('hierarchy'),
    meshes = shared.getRoot().listMeshes(),
    nodes = shared.getRoot().listNodes();
  nodes.find((node) => node.getName() === 'nodeB')!.setMesh(meshes[0]!);
  meshes[1]!.dispose();
  assert.equal(staticFrontendWorld(shared), undefined);
  const animated = scene('hierarchy');
  animated.createAnimation('clip');
  assert.equal(staticFrontendWorld(animated), undefined);
  const reflected = scene('hierarchy');
  reflected.getRoot().listScenes()[0]!.listChildren()[0]!.setScale([-1, 1, 1]);
  assert.equal(staticFrontendWorld(reflected), undefined);
  const morphed = scene('multiprimitive');
  morphed.getRoot().listMeshes()[0]!.listPrimitives()[0]!.addTarget(morphed.createPrimitiveTarget());
  assert.equal(staticFrontendWorld(morphed), undefined);
  const detached = scene('hierarchy');
  detached.createNode('detached');
  assert.equal(staticFrontendWorld(detached), undefined);
});

test('world pivot does not enable unproven editing of complex sources', async () => {
  const source = await bytes(scene('hierarchy')),
    target = await bytes(scene('hierarchy', true));
  await assert.rejects(() =>
    verifyStudioFrontend(source, target, {
      forward_axis: '-x',
      pivot_to_center_bottom: true,
      children_deleted: ['nodeA'],
    }),
  );
  await assert.rejects(() =>
    verifyStudioFrontend(source, target, {
      forward_axis: '-x',
      pivot_to_center_bottom: true,
      children_rename: { nodeA: 'name' },
    }),
  );
});
