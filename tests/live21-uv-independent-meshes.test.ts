/** 多独立mesh放开必须有完整的逐面和部件身份对应；不能让名称或顺序冒充几何证明。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelIO } from '../cli/local/gltf.ts';
import {
  inspectUvCompressionInput,
  inspectUvImportSource,
  verifyUvImport,
} from '../cli/artifacts/uv-import-proof.ts';
import { uvFixtureChunks as parse, uvFixtureGlb as glb, uvImportFixture } from './uv-import-fixture.ts';

async function twoMeshes(compressed: boolean, ambiguous = false): Promise<Buffer> {
  const { json, binary } = parse(await uvImportFixture(compressed));
  const meshes = json.meshes as Array<Record<string, unknown>>,
    materials = json.materials as Array<Record<string, unknown>>;
  meshes.push(structuredClone(meshes[0]!));
  meshes[0]!.name = compressed ? 'truncated-left' : 'source-left-mesh';
  meshes[1]!.name = compressed ? 'truncated-right' : 'source-right-mesh';
  if (!ambiguous) {
    materials.push({
      pbrMetallicRoughness: {
        baseColorFactor: [0.1, 0.2, 0.3, 1],
        metallicFactor: 0.3,
        roughnessFactor: 0.4,
      },
    });
    (meshes[1]!.primitives as Array<Record<string, unknown>>)[0]!.material = 1;
  }
  json.nodes = compressed
    ? [
        {
          mesh: 1,
          name: 'native-1',
          translation: ambiguous ? [0, 0, 0] : [0.3, 0, 0],
          scale: ambiguous ? [1, 1, 1] : [0.4, 0.4, 0.4],
        },
        {
          mesh: 0,
          name: 'native-0',
          translation: ambiguous ? [0, 0, 0] : [-0.3, 0, 0],
          scale: ambiguous ? [1, 1, 1] : [0.4, 0.4, 0.4],
        },
      ]
    : [
        { mesh: 0, name: 'source-left', translation: [2, 3, 4] },
        { mesh: 1, name: 'source-right', translation: ambiguous ? [2, 3, 4] : [5, 3, 4] },
      ];
  json.scenes = [{ nodes: compressed ? [1, 0] : [0, 1] }];
  return glb(json, binary);
}

test('two independent root meshes retain per-face materials and restore names despite reordered native nodes', async () => {
  const source = await twoMeshes(false),
    native = await twoMeshes(true),
    result = await verifyUvImport(source, native);
  assert.equal((await inspectUvCompressionInput(source, { discardTextures: false })).triangles, 4);
  assert.deepEqual((await inspectUvImportSource(source)).normalization_center, [4.5, 4, 4]);
  assert.equal(result.proof.independent_meshes, 2);
  assert.equal(result.proof.matched_faces, 4);
  assert.deepEqual(result.proof.part_correspondence, [
    { source: 1, imported: 0 },
    { source: 0, imported: 1 },
  ]);
  assert.ok(parse(result.bytes).binary.equals(parse(native).binary));
  const io = await modelIO(),
    a = (await io.readBinary(source)).getRoot(),
    b = (await io.readBinary(result.bytes)).getRoot();
  for (const node of b.listNodes()) {
    const original = a.listNodes().find((n) => n.getName() === node.getName())!;
    assert.ok(original);
    assert.equal(node.getMesh()!.getName(), original.getMesh()!.getName());
    assert.equal(
      node.getMesh()!.listPrimitives()[0]!.getMaterial()!.getMetallicFactor(),
      original.getMesh()!.listPrimitives()[0]!.getMaterial()!.getMetallicFactor(),
    );
  }
  assert.equal(result.proof.uv_tolerance, 0.00025);
  assert.equal(result.proof.normal_tolerance, 0.01);
  assert.ok(Number(result.proof.maximum_position_error) < 1e-6);
});

test('changed material assignments, merged meshes and ambiguous overlapping parts cannot pass name restoration', async () => {
  const source = await twoMeshes(false),
    native = parse(await twoMeshes(true));
  for (const mesh of native.json.meshes as Array<{ primitives: Array<{ material: number }> }>)
    mesh.primitives[0]!.material = 1 - mesh.primitives[0]!.material;
  await assert.rejects(verifyUvImport(source, glb(native.json, native.binary)), {
    code: 'UV_COMPRESSION_REQUIREMENT_FAILED',
  });
  await assert.rejects(verifyUvImport(source, await uvImportFixture(true)), {
    code: 'UV_COMPRESSION_REQUIREMENT_FAILED',
  });
  await assert.rejects(verifyUvImport(await twoMeshes(false, true), await twoMeshes(true, true)), {
    code: 'UV_COMPRESSION_REQUIREMENT_FAILED',
    message: /ambiguous/,
  });
});

test('input preflight still rejects hierarchies, shared mesh instances and invalid roots before paid work', async () => {
  for (const change of ['hierarchy', 'instance', 'root']) {
    const input = parse(await twoMeshes(false)),
      nodes = input.json.nodes as Array<Record<string, unknown>>;
    if (change === 'hierarchy') {
      nodes[0]!.children = [1];
      input.json.scenes = [{ nodes: [0] }];
    }
    if (change === 'instance') nodes[1]!.mesh = 0;
    if (change === 'root') input.json.scenes = [{ nodes: [0, 0] }];
    const bytes = glb(input.json, input.binary);
    await assert.rejects(inspectUvImportSource(bytes), { code: 'UV_COMPRESSION_UNSUPPORTED' });
    await assert.rejects(inspectUvCompressionInput(bytes, { discardTextures: false }), {
      code: 'UV_COMPRESSION_UNSUPPORTED',
    });
  }
});

test('the 25000-face budget is shared across all independent meshes', async () => {
  const io = await modelIO(),
    doc = await io.readBinary(await twoMeshes(false)),
    buffer = doc.getRoot().listBuffers()[0]!;
  const indices = new Uint16Array(13000 * 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i % 3;
  for (const mesh of doc.getRoot().listMeshes())
    mesh
      .listPrimitives()[0]!
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(indices).setBuffer(buffer));
  const bytes = Buffer.from(await io.writeBinary(doc));
  await assert.rejects(inspectUvImportSource(bytes), {
    code: 'UV_COMPRESSION_UNSUPPORTED',
    message: /across all meshes/,
  });
  await assert.rejects(inspectUvCompressionInput(bytes, { discardTextures: false }), {
    code: 'UV_COMPRESSION_UNSUPPORTED',
    message: /across all meshes/,
  });
});
