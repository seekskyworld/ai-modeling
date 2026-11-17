/** Upload Card 面数校验：格式口径、实例、严格边界与无法核实状态不得混为一谈。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Document, NodeIO } from '@gltf-transform/core';
import { inspectModelFaceCount } from '../studio/model-face-count.ts';
import { TripoError } from '../studio/contracts/errors.ts';

async function glb(
  count = 1,
  options: { copies?: number; mode?: 4 | 5 | 6; named?: boolean; multi?: boolean; names?: string[] } = {},
) {
  const document = new Document();
  const buffer = document.createBuffer();
  const position = document
    .createAccessor()
    .setType('VEC3')
    .setBuffer(buffer)
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  const indices = document
    .createAccessor()
    .setType('SCALAR')
    .setBuffer(buffer)
    .setArray(
      new Uint16Array(options.mode && options.mode !== 4 ? count + 2 : count * 3).map(
        (_, index) => index % 3,
      ),
    );
  const primitive = document
    .createPrimitive()
    .setAttribute('POSITION', position)
    .setIndices(indices)
    .setMode(options.mode ?? 4);
  const mesh = document.createMesh('geometry').addPrimitive(primitive);
  if (options.multi) mesh.addPrimitive(primitive.clone());
  const scene = document.createScene('selected');
  document.getRoot().setDefaultScene(scene);
  for (let index = 0; index < (options.copies ?? 1); index++)
    scene.addChild(
      document
        .createNode(options.names?.[index] ?? (options.named === false ? '' : `part-${index}`))
        .setMesh(mesh),
    );
  return Buffer.from(await new NodeIO().writeBinary(document));
}

test('OBJ uses webpage fan triangulation including quads, polygons, negative references and continued lines', async () => {
  const bytes = Buffer.from(
    'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nv 0 2 0\nmtllib do-not-open.mtl\nf 1 2 3 4\nf -5 -4 -3 \\\n-2 -1\nf 1/1/1 2/2/2 3/3/3\n',
  );
  const before = Buffer.from(bytes);
  assert.deepEqual(await inspectModelFaceCount(bytes, 'obj'), {
    limit: 3_000_000,
    face_count: 6,
    verified: true,
    method: 'web_obj_triangulated_faces',
  });
  assert.deepEqual(bytes, before);
});

test('OBJ unresolved indices and line/point groups stay explicitly unverified', async () => {
  for (const suffix of ['f 1 2 9', 'f 1 2 0', 'f 1 2', 'f 1 2 3\nl 1 2', 'f 1 2 3\np 1']) {
    const result = await inspectModelFaceCount(Buffer.from(`v 0 0 0\nv 1 0 0\nv 0 1 0\n${suffix}`), 'obj');
    assert.equal(result.verified, false);
    assert.equal(result.face_count, null);
    assert.ok(result.reason);
  }
});

test('STL counts actual binary records and ASCII facets without trusting an extension or truncated header', async () => {
  const binary = Buffer.alloc(84 + 2 * 50);
  binary.write('solid binary header');
  binary.writeUInt32LE(2, 80);
  assert.equal((await inspectModelFaceCount(binary, 'stl')).face_count, 2);
  const facet =
    'facet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\n';
  const ascii = Buffer.from(`solid a\n${facet}endsolid a\nsolid b\n${facet}endsolid b`);
  assert.equal((await inspectModelFaceCount(ascii, 'stl')).face_count, 2);
  for (const invalid of [
    binary.subarray(0, -1),
    Buffer.from(`solid a\n${facet}`),
    Buffer.from('not an STL'),
  ]) {
    const result = await inspectModelFaceCount(invalid, 'stl');
    assert.equal(result.verified, false);
    assert.equal(result.face_count, null);
  }
});

test('GLB counts named mesh instances in the selected scene and converts strip/fan topology', async () => {
  for (const mode of [4, 5, 6] as const) {
    const result = await inspectModelFaceCount(await glb(4, { mode, copies: 3 }), 'glb');
    assert.equal(result.verified, true);
    assert.equal(result.face_count, 12);
  }
});

test('GLB unnamed and multi-primitive nodes preserve the proven webpage metadata count of zero', async () => {
  for (const options of [{ named: false }, { multi: true }]) {
    const result = await inspectModelFaceCount(await glb(1, options), 'glb');
    assert.equal(result.verified, true);
    assert.equal(result.face_count, 0);
    assert.equal(result.method, 'web_gltf_scene_model_info');
  }
});

test('GLB duplicate names and prototype keys reproduce the webpage model-info enumeration', async () => {
  for (const [names, expected] of [
    [['part', 'part'], 2],
    [['part.1', 'part1'], 2],
    [['part 1', 'part_1'], 2],
    [['geometry_1', 'geometry'], 2],
    [['part', '__proto__'], 1],
  ] as [string[], number][]) {
    const result = await inspectModelFaceCount(await glb(1, { copies: 2, names }), 'glb');
    assert.equal(result.verified, true);
    assert.equal(result.face_count, expected);
  }
});

test('The webpage boundary accepts exactly 3,000,000 faces and rejects the next face before submission', async () => {
  assert.equal((await inspectModelFaceCount(await glb(3_000_000), 'glb')).face_count, 3_000_000);
  await assert.rejects(inspectModelFaceCount(await glb(3_000_001), 'glb'), (error: unknown) => {
    assert.ok(error instanceof TripoError);
    assert.equal(error.code, 'INPUT_SIZE');
    assert.equal(error.certainty, 'not_submitted');
    return true;
  });
});

test('FBX original polygon and connection semantics remain explicit until verified', async () => {
  const result = await inspectModelFaceCount(Buffer.from('; FBX 7.4\n'), 'fbx');
  assert.equal(result.verified, false);
  assert.equal(result.face_count, null);
  assert.equal(result.method, 'web_fbx_original_polygons');
});

test('glTF external resources are not fetched to obtain a face count', async (context) => {
  let requests = 0;
  context.mock.method(globalThis, 'fetch', () => {
    requests++;
    throw new Error('Unexpected network');
  });
  const json = {
    asset: { version: '2.0' },
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes: [{ name: 'mesh', mesh: 0 }],
    scenes: [{ nodes: [0] }],
    buffers: [{ uri: 'https://example.com/model.bin', byteLength: 100 }],
  };
  const result = await inspectModelFaceCount(Buffer.from(JSON.stringify(json)), 'gltf');
  assert.equal(result.verified, false);
  assert.equal(result.face_count, null);
  assert.equal(requests, 0);
});
