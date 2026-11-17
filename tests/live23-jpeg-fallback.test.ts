import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { Document } from '@gltf-transform/core';
import { modelIO } from '../cli/local/gltf.ts';
import { inspectGlbJpeg, encodeGlbJpeg } from '../cli/artifacts/glb-jpeg.ts';
import { uvFixtureGlb as glb, uvFixtureChunks as chunks } from './uv-import-fixture.ts';
import { array, object } from '../studio/contracts/errors.ts';

async function fixture(options: { different?: boolean; alpha?: number; required?: boolean } = {}) {
  const sourcePixels = Buffer.from([255, 80, 30, options.alpha ?? 255, 30, 128, 255, 255]);
  const fallbackPixels = Buffer.from(sourcePixels);
  if (options.different) fallbackPixels[0] = 254;
  const webp = await sharp(sourcePixels, { raw: { width: 2, height: 1, channels: 4 } })
    .webp({ lossless: true })
    .toBuffer();
  const png = await sharp(fallbackPixels, { raw: { width: 2, height: 1, channels: 4 } })
    .png()
    .toBuffer();
  const doc = new Document(),
    buffer = doc.createBuffer();
  const positions = doc
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setBuffer(buffer);
  const uv = doc
    .createAccessor()
    .setType('VEC2')
    .setArray(new Float32Array([0, 0, 1, 0, 0, 1]))
    .setBuffer(buffer);
  const texture = doc.createTexture('fallback').setImage(png).setMimeType('image/png');
  const material = doc
    .createMaterial('plain')
    .setBaseColorTexture(texture)
    .setBaseColorFactor([0.6, 0.8, 0.9, 0.7])
    .setAlphaMode('BLEND');
  doc
    .createScene()
    .addChild(
      doc
        .createNode('triangle')
        .setMesh(
          doc
            .createMesh()
            .addPrimitive(
              doc
                .createPrimitive()
                .setAttribute('POSITION', positions)
                .setAttribute('TEXCOORD_0', uv)
                .setMaterial(material),
            ),
        ),
    );
  const original = chunks(Buffer.from(await (await modelIO()).writeBinary(doc)));
  const offset = Math.ceil(original.binary.length / 4) * 4;
  const binary = Buffer.concat([original.binary, Buffer.alloc(offset - original.binary.length), webp]);
  const views = array(original.json.bufferViews),
    images = array(original.json.images),
    textures = array(original.json.textures);
  images.push({ mimeType: 'image/webp', bufferView: views.length });
  views.push({ buffer: 0, byteOffset: offset, byteLength: webp.length });
  object(textures[0]).extensions = { EXT_texture_webp: { source: 1 } };
  original.json.extensionsUsed = ['EXT_texture_webp'];
  if (options.required) original.json.extensionsRequired = ['EXT_texture_webp'];
  object(array(original.json.buffers)[0]).byteLength = binary.length;
  return { bytes: glb(original.json, binary), json: original.json, binary };
}

test('identical opaque WebP/core fallback pixels preserve geometry and material semantics through JPEG', async () => {
  for (const required of [false, true]) {
    const source = await fixture({ required }),
      result = await encodeGlbJpeg(source.bytes),
      output = chunks(result.bytes);
    assert.deepEqual(output.binary.subarray(0, source.binary.length), source.binary);
    for (const key of ['meshes', 'nodes', 'materials', 'accessors', 'samplers'])
      assert.deepEqual(output.json[key], source.json[key]);
    assert.equal(object(array(output.json.textures)[0]).source, 1);
    assert.equal(object(array(output.json.textures)[0]).extensions, undefined);
    assert.equal(array(output.json.extensionsUsed).includes('EXT_texture_webp'), false);
    assert.deepEqual(
      (await inspectGlbJpeg(result.bytes)).images.map((image) => image.mime),
      ['image/jpeg', 'image/jpeg'],
    );
  }
});

test('one different fallback pixel or real alpha prevents equivalence before encoding', async () => {
  for (const options of [{ different: true }, { alpha: 254 }]) {
    const source = await fixture(options);
    await assert.rejects(inspectGlbJpeg(source.bytes), { code: 'TEXTURE_ENCODING_UNSUPPORTED' });
    await assert.rejects(encodeGlbJpeg(source.bytes), { code: 'TEXTURE_ENCODING_UNSUPPORTED' });
  }
});

test('dual fallback still rejects invalid core references, unknown extensions and external resources', async () => {
  for (const mutate of [
    (json: Record<string, unknown>) => {
      object(array(json.textures)[0]).source = 5;
    },
    (json: Record<string, unknown>) => {
      object(array(json.images)[0]).mimeType = 'image/webp';
    },
    (json: Record<string, unknown>) => {
      object(array(json.images)[1]).uri = 'https://example.invalid/image.webp';
    },
    (json: Record<string, unknown>) => {
      object(object(array(json.textures)[0]).extensions).CUSTOM_texture = { source: 0 };
    },
  ]) {
    const source = await fixture();
    mutate(source.json);
    await assert.rejects(inspectGlbJpeg(glb(source.json, source.binary)), {
      code: 'TEXTURE_ENCODING_UNSUPPORTED',
    });
  }
});
