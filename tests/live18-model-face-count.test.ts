/** 来自完整网页 loader + Mi 对照的骨架、形变和场景元数据语义回归。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectModelFaceCount } from '../studio/model-face-count.ts';
import { asciiFbx, binaryFbx, staticFbxNodes } from './fixtures/fbx.ts';
import { faceGlb, skinnedFbxNodes, morphedFbxNodes } from './fixtures/model-faces.ts';

async function faces(bytes: Buffer, format: string, expected: number) {
  const before = Buffer.from(bytes);
  const result = await inspectModelFaceCount(bytes, format);
  assert.equal(result.verified, true, result.reason);
  assert.equal(result.face_count, expected);
  assert.deepEqual(bytes, before);
}

test('FBX Skin/Cluster and BindPose retain polygon counts across binary, ASCII and mesh instances', async () => {
  for (const encode of [binaryFbx, asciiFbx])
    for (const [names, expected] of [
      [['mesh'], 3],
      [['a', 'b'], 6],
      [['same', 'same'], 3],
      [['mesh', '__proto__'], 3],
      [['__proto__'], 3],
    ] as [string[], number][])
      await faces(encode(skinnedFbxNodes(names)), 'fbx', expected);
});

test('FBX BlendShape/Channel changes vertex positions without counting morph targets as separate meshes', async () => {
  for (const encode of [binaryFbx, asciiFbx]) await faces(encode(morphedFbxNodes()), 'fbx', 3);
});

test('FBX incomplete skin weights, bind matrices, poses, missing joints and bone-binding conflicts remain unverified', async () => {
  for (const mutation of [
    'matrix',
    'weights',
    'joint',
    'pose',
    'bone-mesh',
    'global-settings',
    'id-collision',
  ]) {
    const nodes = skinnedFbxNodes();
    const objects = nodes[1]!.children!,
      links = nodes[2]!.children!;
    const cluster = objects.find((node) => node.name === 'Deformer' && node.properties![2] === 'Cluster')!;
    if (mutation === 'matrix')
      cluster.children!.find((node) => node.name === 'TransformLink')!.properties = [new Float64Array(15)];
    if (mutation === 'weights')
      cluster.children!.find((node) => node.name === 'Weights')!.properties = [new Float64Array(1)];
    if (mutation === 'joint') nodes[2]!.children = links.filter((link) => link.properties![1] !== 400);
    if (mutation === 'pose') objects.find((node) => node.name === 'Pose')!.children![0]!.properties = [100];
    if (mutation === 'bone-mesh') links.push({ name: 'C', properties: ['OO', 200, 301] });
    if (mutation === 'global-settings')
      nodes.splice(
        nodes.findIndex((node) => node.name === 'GlobalSettings'),
        1,
      );
    if (mutation === 'id-collision') objects.find((node) => node.name === 'Deformer')!.properties![0] = 200;
    const result = await inspectModelFaceCount(binaryFbx(nodes), 'fbx');
    assert.equal(result.verified, false, mutation);
    assert.equal(result.face_count, null);
  }
});

test('GLB scene selection and nested multi-primitive groups follow metadata registration instead of summing all primitives', async () => {
  await faces(
    faceGlb({
      faces: [[1], [3]],
      nodes: [
        { name: 'first', mesh: 0 },
        { name: 'second', mesh: 1 },
      ],
      scenes: [
        { name: 'a', nodes: [0] },
        { name: 'b', nodes: [1] },
      ],
      scene: 1,
    }),
    'glb',
    3,
  );
  await faces(
    faceGlb({
      faces: [[1, 2], [3]],
      nodes: [
        { name: 'parent', mesh: 0, children: [1] },
        { name: 'child', mesh: 1 },
      ],
      scenes: [{ nodes: [0] }],
    }),
    'glb',
    3,
  );
  await faces(
    faceGlb({ nodes: [{ name: 'same', mesh: 0 }], scenes: [{ name: 'same', nodes: [0] }] }),
    'glb',
    1,
  );
});

test('GLB named bone/camera/light mesh groups have the proven webpage zero metadata count', async () => {
  await faces(faceGlb({ extra: { skins: [{ joints: [0] }] } }), 'glb', 0);
  await faces(
    faceGlb({
      nodes: [{ name: 'part', mesh: 0, camera: 0 }],
      extra: { cameras: [{ name: 'lens', type: 'perspective', perspective: { yfov: 1, znear: 0.1 } }] },
    }),
    'glb',
    0,
  );
  await faces(
    faceGlb({
      nodes: [{ name: 'part', mesh: 0, extensions: { KHR_lights_punctual: { light: 0 } } }],
      extra: {
        extensionsUsed: ['KHR_lights_punctual'],
        extensions: { KHR_lights_punctual: { lights: [{ type: 'point' }] } },
      },
    }),
    'glb',
    0,
  );
});

test('GLB special keys, normalized duplicates and equal-count suffix collisions preserve webpage counts', async () => {
  for (const [names, expected] of [
    [['__proto__'], 1],
    [['__proto__', '__proto__'], 2],
    [['part', '__proto__'], 1],
    [['part_1', 'part', 'part'], 2],
    [['toString', 'toString_NaN', 'toString'], 3],
    [['[]'], 1],
  ] as [string[], number][])
    await faces(faceGlb({ nodes: names.map((name) => ({ name, mesh: 0 })) }), 'glb', expected);
});

test('GLB ambiguous completion-order collisions and different scene dependencies remain explicit rather than guessed', async () => {
  for (const input of [
    faceGlb({
      faces: [[1], [2], [3]],
      nodes: [
        { name: 'part_1', mesh: 0 },
        { name: 'part', mesh: 1 },
        { name: 'part', mesh: 2 },
      ],
    }),
    faceGlb({
      nodes: [
        { name: 'shared', mesh: 0 },
        { name: 'extra', mesh: 0 },
      ],
      scenes: [{ nodes: [0, 1] }, { nodes: [0] }],
    }),
  ]) {
    const result = await inspectModelFaceCount(input, 'glb');
    assert.equal(result.verified, false);
    assert.equal(result.face_count, null);
    assert.match(result.reason!, /asynchronous/);
  }
});

test('GLB identical scene dependencies reparent shared nodes to the last scene', async () => {
  for (const [scene, expected] of [
    [0, 0],
    [1, 1],
  ])
    await faces(
      faceGlb({
        nodes: [{ name: 'part', mesh: 0 }],
        scenes: [
          { name: 'a', nodes: [0] },
          { name: 'b', nodes: [0] },
        ],
        scene,
      }),
      'glb',
      expected!,
    );
});

test('GLB child Group names participate in filtering even when their metadata comes from another scene', async () => {
  await faces(
    faceGlb({
      faces: [[1, 2], [3]],
      nodes: [
        { name: 'hidden', mesh: 0 },
        { name: '_instance_0', mesh: 1 },
        { name: 'bone', mesh: 0 },
      ],
      scenes: [
        { name: 'selected', nodes: [2] },
        { name: 'other', nodes: [0, 1] },
      ],
      extra: { skins: [{ joints: [2] }] },
    }),
    'glb',
    3,
  );
  await faces(
    faceGlb({
      faces: [[1, 2], [4]],
      nodes: [
        { name: 'camera-group', mesh: 0, camera: 0 },
        { name: '[]', mesh: 1 },
      ],
      scenes: [
        { name: 'selected', nodes: [0] },
        { name: 'other', nodes: [1] },
      ],
      extra: { cameras: [{ type: 'perspective', perspective: { yfov: 1, znear: 0.1 } }] },
    }),
    'glb',
    4,
  );
});

test('Model face inspection remains offline for self-contained images and rejects malformed dependencies without leaking URLs', async (context) => {
  let network = 0;
  context.mock.method(globalThis, 'fetch', () => {
    network++;
    throw new Error('Unexpected network');
  });
  await faces(binaryFbx(skinnedFbxNodes()), 'fbx', 3);
  await faces(
    faceGlb({ nodes: [{ name: 'part', mesh: 0, extensions: { CUSTOM_ignored: { value: 1 } } }] }),
    'glb',
    1,
  );
  const result = await inspectModelFaceCount(
    Buffer.from(
      JSON.stringify({
        asset: { version: '2.0' },
        buffers: [{ uri: 'https://example.com/private.bin?token=sensitive', byteLength: 4 }],
        scenes: [{}],
      }),
    ),
    'gltf',
  );
  assert.equal(result.verified, false);
  assert.doesNotMatch(result.reason!, /sensitive|private\.bin/);
  assert.equal(network, 0);
  const malformed = staticFbxNodes();
  malformed[1]!.children!.push({ name: 'Model', properties: [400, 'lamp', 'Light'], children: [] });
  assert.equal((await inspectModelFaceCount(binaryFbx(malformed), 'fbx')).verified, false);
});
