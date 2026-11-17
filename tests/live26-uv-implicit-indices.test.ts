/** 标准非索引三角形与显式索引同一表面；不改输入字节、不放宽材质或属性比较。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelIO } from '../cli/local/gltf.ts';
import {
  inspectUvCompressionInput,
  inspectUvImportSource,
  verifyUvImport,
} from '../cli/artifacts/uv-import-proof.ts';
import { splitUvImportSource } from '../cli/artifacts/uv-import-layout.ts';
import { array, object } from '../studio/contracts/errors.ts';
import { uvFixtureChunks, uvFixtureGlb, uvImportFixture } from './uv-import-fixture.ts';

async function nonindexed(grouped = false): Promise<Buffer> {
  const io = await modelIO(),
    doc = await io.readBinary(await uvImportFixture(false)),
    mesh = doc.getRoot().listMeshes()[0]!,
    primitive = mesh.listPrimitives()[0]!,
    indices = Array.from(primitive.getIndices()!.getArray()!);
  for (const semantic of primitive.listSemantics()) {
    const attribute = primitive.getAttribute(semantic)!,
      values = indices.flatMap((index) => attribute.getElement(index, []));
    primitive.setAttribute(
      semantic,
      doc
        .createAccessor()
        .setType(attribute.getType())
        .setArray(new Float32Array(values))
        .setBuffer(attribute.getBuffer()),
    );
  }
  primitive.setIndices(null);
  if (grouped) {
    const material = primitive.getMaterial()!.clone().setBaseColorFactor([0.2, 0.4, 0.7, 1]);
    mesh.addPrimitive(primitive.clone().setMaterial(material));
  }
  return Buffer.from(await io.writeBinary(doc));
}

test('implicit sequential triangles preserve exact input and native compressed binary after verification', async () => {
  const source = await nonindexed(),
    frozen = Buffer.from(source),
    imported = await uvImportFixture(true),
    result = await verifyUvImport(source, imported);
  assert.ok(source.equals(frozen));
  assert.equal((await inspectUvImportSource(source)).triangles, 2);
  assert.equal((await inspectUvCompressionInput(source, { discardTextures: false })).triangles, 2);
  assert.equal(result.proof.matched_faces, 2);
  assert.equal(result.proof.maximum_position_error, 0);
  assert.equal(result.proof.maximum_normal_error, 0);
  assert.equal(result.proof.maximum_uv_error, 0);
  assert.ok(uvFixtureChunks(result.bytes).binary.equals(uvFixtureChunks(imported).binary));
  const primitive = object(array(object(array(uvFixtureChunks(source).json.meshes)[0]).primitives)[0]);
  assert.equal(primitive.indices, undefined);
});

test('implicit triangles still reject changed UV associations, winding, normals and material', async () => {
  const source = await nonindexed();
  for (const change of ['uv', 'winding', 'material', 'scale', 'geometry'])
    await assert.rejects(verifyUvImport(source, await uvImportFixture(true, change)), {
      code: 'UV_COMPRESSION_REQUIREMENT_FAILED',
    });
  const io = await modelIO(),
    doc = await io.readBinary(source),
    normals = doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!.getAttribute('NORMAL')!;
  for (let index = 0; index < normals.getCount(); index++) normals.setElement(index, [0, 0, -1]);
  await assert.rejects(verifyUvImport(Buffer.from(await io.writeBinary(doc)), await uvImportFixture(true)), {
    code: 'UV_COMPRESSION_REQUIREMENT_FAILED',
  });
});

test('partial implicit triangles or mismatched normal and UV counts fail before import', async () => {
  for (const changed of ['POSITION', 'NORMAL', 'TEXCOORD_0']) {
    const { json, binary } = uvFixtureChunks(await nonindexed()),
      primitive = object(array(object(array(json.meshes)[0]).primitives)[0]),
      index = Number(object(primitive.attributes)[changed]);
    object(array(json.accessors)[index]).count = 5;
    const bytes = uvFixtureGlb(json, binary);
    await assert.rejects(inspectUvImportSource(bytes), { code: 'UV_COMPRESSION_UNSUPPORTED' });
    if (changed === 'POSITION')
      await assert.rejects(inspectUvCompressionInput(bytes, { discardTextures: false }), {
        code: 'UV_COMPRESSION_UNSUPPORTED',
      });
  }
});

test('multi-primitive implicit sources restore groups from unique material surfaces without changing BIN', async () => {
  const source = await nonindexed(true),
    { json, binary } = uvFixtureChunks(await uvImportFixture(true)),
    materials = array(json.materials),
    primitives = array(object(array(json.meshes)[0]).primitives);
  materials.push({
    pbrMetallicRoughness: { baseColorFactor: [0.2, 0.4, 0.7, 1], metallicFactor: 0, roughnessFactor: 0.9 },
  });
  primitives.push({ ...object(primitives[0]), material: 1 });
  const imported = (await splitUvImportSource(uvFixtureGlb(json, binary))).bytes,
    prepared = await splitUvImportSource(source),
    result = await verifyUvImport(source, imported),
    output = uvFixtureChunks(result.bytes);
  assert.ok(uvFixtureChunks(source).binary.equals(uvFixtureChunks(prepared.bytes).binary));
  assert.ok(output.binary.equals(uvFixtureChunks(imported).binary));
  assert.equal(result.proof.restored_primitive_groups, true);
  assert.equal(result.proof.matched_faces, 4);
  assert.equal(array(object(array(output.json.meshes)[0]).primitives).length, 2);
  for (const primitive of array(object(array(json.meshes)[0]).primitives)) object(primitive).material = 0;
  await assert.rejects(verifyUvImport(source, uvFixtureGlb(json, binary)), {
    code: 'UV_COMPRESSION_REQUIREMENT_FAILED',
  });
});
