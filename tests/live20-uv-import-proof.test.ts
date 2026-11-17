import assert from 'node:assert/strict';
import { test } from 'node:test';
import { vec3 } from 'gl-matrix';
import sharp from 'sharp';
import { modelIO } from '../cli/local/gltf.ts';
import {
  inspectUvCompressionInput,
  inspectUvImportSource,
  verifyUvImport,
} from '../cli/artifacts/uv-import-proof.ts';

import {
  uvImportFixture as fixture,
  uvFixtureGlb as glb,
  uvFixtureChunks as parse,
} from './uv-import-fixture.ts';

test('UV原生导入压缩按源固定规则还原世界坐标/名称，原压缩BIN与UV完全保持', async () => {
  const source = await fixture(false),
    imported = await fixture(true),
    result = await verifyUvImport(source, imported),
    io = await modelIO(),
    a = (await io.readBinary(source)).getRoot().listNodes()[0]!,
    b = (await io.readBinary(result.bytes)).getRoot().listNodes()[0]!;
  assert.ok(parse(result.bytes).binary.equals(parse(imported).binary));
  assert.equal(b.getName(), a.getName());
  assert.equal(b.getMesh()!.getName(), a.getMesh()!.getName());
  const p = a.getMesh()!.listPrimitives()[0]!,
    q = b.getMesh()!.listPrimitives()[0]!;
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(
      vec3.transformMat4(vec3.create(), p.getAttribute('POSITION')!.getElement(i, []), a.getWorldMatrix()),
      vec3.transformMat4(vec3.create(), q.getAttribute('POSITION')!.getElement(i, []), b.getWorldMatrix()),
    );
    assert.deepEqual(
      p.getAttribute('TEXCOORD_0')!.getElement(i, []),
      q.getAttribute('TEXCOORD_0')!.getElement(i, []),
    );
  }
  assert.equal(result.proof.matched_faces, 2);
  assert.equal(result.proof.maximum_position_error, 0);
  assert.equal(result.proof.maximum_uv_error, 0);
  assert.deepEqual((await inspectUvImportSource(source)).normalization_center, [3, 4, 4]);
});

test('错误UV关联、反转有向面、材质变化及非固定归一化不能借坐标恢复通过', async () => {
  const source = await fixture(false);
  for (const change of ['uv', 'winding', 'material', 'scale', 'geometry'])
    await assert.rejects(verifyUvImport(source, await fixture(true, change)), {
      code: 'UV_COMPRESSION_REQUIREMENT_FAILED',
    });
  await assert.rejects(verifyUvImport(source, source), { code: 'UV_COMPRESSION_REQUIREMENT_FAILED' });
});

test('UV上传前拒绝有贴图、骨骼或多节点来源，不让受限验收变成静默有损路径', async () => {
  for (const addition of [
    { images: [{ uri: 'image.png' }] },
    { skins: [{ joints: [0] }] },
    { nodes: [{ mesh: 0 }, {}] },
  ]) {
    const source = parse(await fixture(false));
    Object.assign(source.json, addition);
    await assert.rejects(inspectUvImportSource(glb(source.json, source.binary)), {
      code: 'UV_COMPRESSION_UNSUPPORTED',
    });
  }
});

test('首次UV付费前预检不要求已有UV，显式bake=false允许原内嵌纹理被网页移除', async () => {
  const io = await modelIO(),
    document = await io.readBinary(await fixture(false)),
    primitive = document.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
  primitive.setAttribute('TEXCOORD_0', null);
  const unwrapped = Buffer.from(await io.writeBinary(document));
  assert.equal((await inspectUvCompressionInput(unwrapped, { discardTextures: false })).has_uv, false);
  await assert.rejects(inspectUvImportSource(unwrapped), { code: 'UV_COMPRESSION_UNSUPPORTED' });
  const image = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'red' } })
      .png()
      .toBuffer(),
    texture = document.createTexture().setMimeType('image/png').setImage(image);
  primitive.getMaterial()!.setBaseColorTexture(texture);
  const textured = Buffer.from(await io.writeBinary(document));
  assert.equal((await inspectUvCompressionInput(textured, { discardTextures: true })).discard_textures, true);
  await assert.rejects(inspectUvCompressionInput(textured, { discardTextures: false }), {
    code: 'UV_COMPRESSION_UNSUPPORTED',
  });
  await assert.rejects(inspectUvImportSource(textured), { code: 'UV_COMPRESSION_UNSUPPORTED' });
});
