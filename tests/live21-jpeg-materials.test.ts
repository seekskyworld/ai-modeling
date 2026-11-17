/** 图片alpha不变时，材质/顶点透明语义与规范WebP引用可保留；不能以普通GLB读取成功代替验收。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Document } from '@gltf-transform/core';
import sharp from 'sharp';
import { modelIO } from '../cli/local/gltf.ts';
import { encodeGlbJpeg, inspectGlbJpeg } from '../cli/artifacts/glb-jpeg.ts';
import { uvFixtureGlb as glb, uvFixtureChunks as chunks } from './uv-import-fixture.ts';
import { array, object } from '../studio/contracts/errors.ts';
import { fixture as serviceFixture, quote } from './helpers.ts';
import { applyDefaultExportJpeg } from '../cli/compat/export-jpeg-default.ts';
import { ensureExportJpeg } from '../cli/artifacts/export-jpeg-output.ts';
import { exportJpegPolicyKey, exportJpegProofKey } from '../cli/core/export-jpeg-policy.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import type { Gateway } from '../studio/api/gateway.ts';
import { readFile, rm } from 'node:fs/promises';

async function fixture(mime: 'png' | 'webp' = 'png', alpha = 255) {
  const doc = new Document(),
    buffer = doc.createBuffer();
  const accessor = (type: 'VEC2' | 'VEC3' | 'VEC4', values: number[]) =>
    doc.createAccessor().setType(type).setArray(new Float32Array(values)).setBuffer(buffer);
  const texture = doc
    .createTexture('opaque-source')
    .setMimeType(`image/${mime}`)
    .setImage(
      await sharp(Buffer.from([255, 80, 30, alpha, 30, 128, 255, 255]), {
        raw: { width: 2, height: 1, channels: 4 },
      })
        .toFormat(mime)
        .toBuffer(),
    );
  const material = doc
    .createMaterial('alpha-from-material-and-vertices')
    .setBaseColorTexture(texture)
    .setBaseColorFactor([0.6, 0.8, 0.9, 0.6]);
  const primitive = doc
    .createPrimitive()
    .setAttribute('POSITION', accessor('VEC3', [0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setAttribute('TEXCOORD_0', accessor('VEC2', [0, 0, 1, 0, 0, 1]))
    .setAttribute('COLOR_0', accessor('VEC4', [1, 1, 1, 0.25, 1, 1, 1, 0.5, 1, 1, 1, 1]))
    .setMaterial(material);
  doc
    .createScene()
    .addChild(doc.createNode('triangle').setMesh(doc.createMesh('triangle').addPrimitive(primitive)));
  return chunks(Buffer.from(await (await modelIO()).writeBinary(doc)));
}
const encode = (source: Awaited<ReturnType<typeof fixture>>) =>
  encodeGlbJpeg(glb(source.json, source.binary));
function stripped(json: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(json).filter(([key]) => !['buffers', 'bufferViews', 'images'].includes(key)),
  );
}

test('opaque textures retain BLEND/MASK material alpha, cutoff and per-vertex alpha after JPEG encoding', async () => {
  for (const mode of ['BLEND', 'MASK']) {
    const source = await fixture(),
      material = object(array(source.json.materials)[0]);
    material.alphaMode = mode;
    material.alphaCutoff = 0.4;
    const before = glb(source.json, source.binary),
      result = await encodeGlbJpeg(before),
      after = chunks(result.bytes);
    assert.deepEqual(stripped(after.json), stripped(source.json));
    assert.deepEqual(after.binary.subarray(0, source.binary.length), source.binary);
    const io = await modelIO(),
      a = (await io.readBinary(before)).getRoot(),
      b = (await io.readBinary(result.bytes)).getRoot();
    assert.equal(b.listMaterials()[0]!.getAlphaMode(), mode);
    assert.equal(b.listMaterials()[0]!.getAlphaCutoff(), 0.4);
    assert.deepEqual(b.listMaterials()[0]!.getBaseColorFactor(), a.listMaterials()[0]!.getBaseColorFactor());
    assert.deepEqual(
      b.listMeshes()[0]!.listPrimitives()[0]!.getAttribute('COLOR_0')!.getArray(),
      a.listMeshes()[0]!.listPrimitives()[0]!.getAttribute('COLOR_0')!.getArray(),
    );
    assert.equal((await inspectGlbJpeg(result.bytes)).images[0]!.mime, 'image/jpeg');
  }
  for (const mode of ['OPAQUE', 'BLEND', 'MASK']) {
    const source = await fixture('png', 254);
    object(array(source.json.materials)[0]).alphaMode = mode;
    await assert.rejects(encode(source), { code: 'TEXTURE_ENCODING_UNSUPPORTED' });
  }
});

test('known non-texture material extensions survive exactly, with no advanced material baking claim', async () => {
  const source = await fixture(),
    material = object(array(source.json.materials)[0]);
  material.extensions = {
    KHR_materials_unlit: {},
    KHR_materials_ior: { ior: 1.45 },
    KHR_materials_emissive_strength: { emissiveStrength: 2 },
  };
  source.json.extensionsUsed = Object.keys(object(material.extensions));
  const result = await encode(source),
    after = chunks(result.bytes),
    imported = await (await modelIO()).readBinary(result.bytes);
  assert.deepEqual(stripped(after.json), stripped(source.json));
  assert.deepEqual(after.binary.subarray(0, source.binary.length), source.binary);
  for (const name of Object.keys(object(material.extensions)))
    assert.ok(imported.getRoot().listMaterials()[0]!.getExtension(name));
  for (const extensions of [
    { KHR_materials_clearcoat: { clearcoatTexture: { index: 0 } } },
    { KHR_materials_unlit: { unknown: 1 } },
    { KHR_materials_ior: { ior: 0 } },
    { KHR_materials_emissive_strength: { emissiveStrength: -1 } },
    { UNKNOWN_material: {} },
  ]) {
    material.extensions = extensions;
    await assert.rejects(encode(source), { code: 'TEXTURE_ENCODING_UNSUPPORTED' });
  }
});

test('required embedded WebP source is rewritten explicitly, preserving sampler and all original model bytes', async () => {
  const source = await fixture('webp'),
    texture = object(array(source.json.textures)[0]);
  texture.extensions = { EXT_texture_webp: { source: texture.source } };
  delete texture.source;
  source.json.extensionsUsed = ['EXT_texture_webp'];
  source.json.extensionsRequired = ['EXT_texture_webp'];
  const before = glb(source.json, source.binary),
    result = await encodeGlbJpeg(before),
    after = chunks(result.bytes);
  assert.deepEqual(after.binary.subarray(0, source.binary.length), source.binary);
  const expectedTexture: Record<string, unknown> = { ...texture, source: 0 };
  delete expectedTexture.extensions;
  assert.deepEqual(object(array(after.json.textures)[0]), expectedTexture);
  assert.equal(after.json.extensionsUsed, undefined);
  assert.equal(after.json.extensionsRequired, undefined);
  for (const key of ['materials', 'accessors', 'meshes', 'nodes', 'samplers'])
    assert.deepEqual(after.json[key], source.json[key]);
  const io = await modelIO(),
    oldTexture = (await io.readBinary(before)).getRoot().listTextures()[0]!,
    newTexture = (await io.readBinary(result.bytes)).getRoot().listTextures()[0]!;
  assert.equal(oldTexture.getMimeType(), 'image/webp');
  assert.equal(newTexture.getMimeType(), 'image/jpeg');
  assert.deepEqual(
    await sharp(newTexture.getImage()!)
      .metadata()
      .then((x) => [x.width, x.height]),
    [2, 1],
  );
});

test('WebP fallback ambiguity, unregistered or foreign references, and true transparency stay rejected', async () => {
  for (const mode of ['fallback', 'undeclared', 'invalid-source', 'unknown-codec', 'wrong-mime', 'alpha']) {
    const source = await fixture(mode === 'wrong-mime' ? 'png' : 'webp', mode === 'alpha' ? 254 : 255),
      texture = object(array(source.json.textures)[0]);
    texture.extensions = { EXT_texture_webp: { source: mode === 'invalid-source' ? 8 : texture.source } };
    if (mode !== 'fallback') delete texture.source;
    source.json.extensionsUsed = ['EXT_texture_webp'];
    if (mode !== 'undeclared') source.json.extensionsRequired = ['EXT_texture_webp'];
    if (mode === 'unknown-codec') object(texture.extensions).UNKNOWN_texture = { source: 0 };
    await assert.rejects(encode(source), { code: 'TEXTURE_ENCODING_UNSUPPORTED' });
  }
});

test('WebP with material alpha enters the JPEG policy and preserves verified delivery across a database reopen', async () => {
  const f = await serviceFixture();
  let reopened: Awaited<ReturnType<typeof serviceFixture>> | undefined;
  let closed = false;
  try {
    const source = await fixture('webp'),
      texture = object(array(source.json.textures)[0]);
    texture.extensions = { EXT_texture_webp: { source: texture.source } };
    delete texture.source;
    source.json.extensionsUsed = ['EXT_texture_webp'];
    source.json.extensionsRequired = ['EXT_texture_webp'];
    object(array(source.json.materials)[0]).alphaMode = 'BLEND';
    const bytes = glb(source.json, source.binary),
      gateway: Gateway = f.gateway;
    gateway.jpegSource = async () => ({ operator_id: 'source', url: 'https://cdn.tripo3d.ai/source.glb' });
    const parameters = normalize('export', {
      project_id: 'project',
      format: 'glb',
      expected_operator_id: 'source',
    });
    await applyDefaultExportJpeg(
      { jobs: f.jobs, gateway, dataDir: f.dir, accountRef: () => 'test-account' },
      'webp-material',
      parameters,
      undefined,
      async () => bytes,
    );
    assert.equal(parameters.texture_format, 'JPEG');
    assert.equal(f.jobs.requestPolicy('test-account', exportJpegPolicyKey('webp-material'))?.mode, 'jpeg');
    const prepared = f.jobs.prepare('test-account', 'webp-material', 'export', parameters, quote);
    const job = f.jobs.update(prepared.job_id, 'succeeded', {
      remote_ids: { project_id: 'project', operator_id: 'export' },
      artifacts: [{ artifact_id: 'model', kind: 'model', format: 'glb', index: 0 }],
    });
    await ensureExportJpeg(job, f.jobs, f.dir, gateway, async () => new Response(new Uint8Array(bytes)));
    const saved = await f.service.download(job.job_id, 'model', 'first.glb'),
      proof = f.jobs.requestPolicy('test-account', exportJpegProofKey(job, job.artifacts[0]!));
    assert.equal(saved.sha256, proof?.sha256);
    assert.equal(f.gateway.posts, 0);
    f.jobs.close();
    closed = true;
    reopened = await serviceFixture(f.dir);
    reopened.gateway.artifactUrl = async () => {
      throw new Error('No new remote read after restart');
    };
    const restored = await reopened.service.get(job.job_id),
      second = await reopened.service.download(job.job_id, 'model', 'second.glb');
    assert.equal(object(restored.jpeg_output_validation).status, 'verified');
    assert.deepEqual(await readFile(String(second.local_path)), await readFile(String(saved.local_path)));
    assert.equal(second.sha256, saved.sha256);
    assert.deepEqual(
      reopened.jobs.requestPolicy('test-account', exportJpegProofKey(job, job.artifacts[0]!)),
      proof,
    );
    assert.equal(reopened.gateway.posts, 0);
  } finally {
    reopened?.jobs.close();
    if (!closed) f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
