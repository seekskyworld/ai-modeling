/** 零纹理新材质不需图像编码；验证原字节交付、付费前拒绝边界及旧意图不变。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { test } from 'node:test';
import sharp from 'sharp';
import { array, object } from '../studio/contracts/errors.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import type { Gateway } from '../studio/api/gateway.ts';
import { inspectGlbJpeg, encodeGlbJpeg } from '../cli/artifacts/glb-jpeg.ts';
import { applyDefaultExportJpeg } from '../cli/compat/export-jpeg-default.ts';
import { ensureExportJpeg } from '../cli/artifacts/export-jpeg-output.ts';
import { exportJpegIntent, exportJpegPolicyKey, exportJpegProofKey } from '../cli/core/export-jpeg-policy.ts';
import { fixture as serviceFixture, quote } from './helpers.ts';
import { uvFixtureChunks as chunks, uvFixtureGlb as glb, uvImportFixture } from './uv-import-fixture.ts';

const specular = 'KHR_materials_specular';
const anisotropy = 'KHR_materials_anisotropy';
const firstMaterial = (json: Record<string, unknown>) => object(array(json.materials)[0]);
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
type Source = ReturnType<typeof chunks>;
async function source(extensions: Record<string, unknown> = { [specular]: { specularFactor: 0.4 } }) {
  const result = chunks(await uvImportFixture(false));
  firstMaterial(result.json).extensions = extensions;
  result.json.extensionsUsed = Object.keys(extensions);
  result.json.extensionsRequired = Object.keys(extensions);
  return result;
}
const bytes = (value: Source) => glb(value.json, value.binary);
const reject = (value: Source) =>
  assert.rejects(inspectGlbJpeg(bytes(value)), { code: 'TEXTURE_ENCODING_UNSUPPORTED' });

test('zero-image specular/anisotropy retains the exact GLB and the original v1 inspection shape', async () => {
  for (const extensions of [
    { [specular]: {} },
    { [specular]: { specularFactor: 0, specularColorFactor: [0.2, 0.4, 0.8] } },
    { [specular]: { specularFactor: 1, specularColorFactor: [1, 1, 1] } },
    { [anisotropy]: {} },
    { [anisotropy]: { anisotropyStrength: 0.7, anisotropyRotation: -4 } },
    {
      [specular]: { specularFactor: 0.4 },
      [anisotropy]: { anisotropyStrength: 1, anisotropyRotation: 0.4 },
      KHR_materials_ior: { ior: 1.8 },
      KHR_materials_emissive_strength: { emissiveStrength: 0 },
    },
  ]) {
    for (const alphaMode of ['OPAQUE', 'MASK', 'BLEND']) {
      const input = await source(extensions);
      firstMaterial(input.json).alphaMode = alphaMode;
      firstMaterial(input.json).alphaCutoff = 0.4;
      const before = bytes(input),
        encoded = await encodeGlbJpeg(before);
      assert.deepEqual(encoded.bytes, before);
      assert.deepEqual(encoded.inspection, {
        version: 1,
        source_sha256: digest(before),
        source_bytes: before.length,
        binary_sha256: digest(input.binary),
        binary_bytes: input.binary.length,
        images: [],
      });
      assert.equal(encoded.processing, 'Verified native GLB JPEG textures; original model bytes retained');
    }
  }
  const empty = await source();
  empty.json.images = [];
  empty.json.textures = [];
  assert.deepEqual((await encodeGlbJpeg(bytes(empty))).bytes, bytes(empty));
});

test('new zero-image material scope rejects malformed declarations, texture references and extra properties', async () => {
  const mutations: Array<(json: Record<string, unknown>) => void> = [
    (json) => delete json.extensionsUsed,
    (json) => (json.extensionsUsed = specular),
    (json) => (json.extensionsUsed = [specular, specular]),
    (json) => (json.extensionsRequired = [specular, anisotropy]),
    (json) => (json.extensionsRequired = null),
    (json) => (json.images = null),
    (json) => (json.images = {}),
    (json) => (json.textures = null),
    (json) => (json.textures = {}),
    (json) => (firstMaterial(json).alphaMode = 'UNKNOWN'),
    (json) => (firstMaterial(json).pbrMetallicRoughness = null),
    (json) => array(json.materials).push(null),
    (json) => (firstMaterial(json).normalTexture = { index: 0 }),
    (json) => (firstMaterial(json).occlusionTexture = { index: 0 }),
    (json) => (firstMaterial(json).emissiveTexture = { index: 0 }),
    (json) => (object(firstMaterial(json).pbrMetallicRoughness).baseColorTexture = { index: 0 }),
    (json) => (object(firstMaterial(json).pbrMetallicRoughness).metallicRoughnessTexture = { index: 0 }),
    (json) => (object(firstMaterial(json).pbrMetallicRoughness).extensions = {}),
  ];
  for (const mutate of mutations) {
    const input = await source();
    mutate(input.json);
    await reject(input);
  }
  for (const [name, value] of [
    [specular, { specularFactor: -0.1 }],
    [specular, { specularFactor: 1.1 }],
    [specular, { specularFactor: null }],
    [specular, { specularColorFactor: [0.2, 0.4] }],
    [specular, { specularColorFactor: [0.2, 0.4, 1.1] }],
    [specular, { specularTexture: { index: 0 } }],
    [specular, { specularColorTexture: { index: 0 } }],
    [specular, { unknown: 1 }],
    [anisotropy, { anisotropyStrength: 1.1 }],
    [anisotropy, { anisotropyRotation: null }],
    [anisotropy, { anisotropyRotation: '0.4' }],
    [anisotropy, { anisotropyTexture: { index: 0 } }],
    [anisotropy, []],
  ] as const)
    await reject(await source({ [name]: value }));
  for (const extra of [
    { KHR_materials_ior: { ior: 0 } },
    { KHR_materials_clearcoat: { clearcoatFactor: 0.3 } },
    { KHR_materials_transmission: { transmissionFactor: 0.3 } },
    { KHR_materials_sheen: { sheenColorFactor: [0.2, 0.4, 0.8] } },
    { UNKNOWN_material: {} },
  ])
    await reject(await source({ [specular]: {}, ...extra }));
});

test('an actual opaque embedded image still cannot enter the new untextured material scope', async () => {
  const input = await source();
  const image = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#2840cc' } })
    .png()
    .toBuffer();
  const view = array(input.json.bufferViews).length;
  array(input.json.bufferViews).push({
    buffer: 0,
    byteOffset: input.binary.length,
    byteLength: image.length,
  });
  input.binary = Buffer.concat([input.binary, image]);
  object(array(input.json.buffers)[0]).byteLength = input.binary.length;
  input.json.images = [{ mimeType: 'image/png', bufferView: view }];
  await reject(input);
  input.json.textures = [{ source: 0 }];
  object(firstMaterial(input.json).pbrMetallicRoughness).baseColorTexture = { index: 0 };
  await reject(input);
  delete firstMaterial(input.json).extensions;
  delete input.json.extensionsRequired;
  delete input.json.extensionsUsed;
  const result = await encodeGlbJpeg(bytes(input));
  assert.equal((await inspectGlbJpeg(result.bytes)).images[0]!.mime, 'image/jpeg');
});

test('new explicit zero-texture JPEG freezes source and retains native result bytes after database reopen', async () => {
  const f = await serviceFixture();
  let reopened: Awaited<ReturnType<typeof serviceFixture>> | undefined,
    closed = false;
  try {
    const input = await source({
        [specular]: { specularFactor: 0.4 },
        [anisotropy]: { anisotropyStrength: 0.7 },
      }),
      original = bytes(input),
      parameters = normalize('export', {
        project_id: 'project',
        expected_operator_id: 'source',
        format: 'glb',
        texture_format: 'JPEG',
      });
    (f.gateway as Gateway).jpegSource = async () => ({
      operator_id: 'source',
      url: 'https://cdn.tripo3d.ai/source.glb',
    });
    await applyDefaultExportJpeg(
      { jobs: f.jobs, gateway: f.gateway, dataDir: f.dir, accountRef: () => 'test-account' },
      'zero-texture-explicit',
      parameters,
      undefined,
      async () => original,
    );
    const policy = f.jobs.requestPolicy('test-account', exportJpegPolicyKey('zero-texture-explicit'));
    assert.equal(policy?.mode, 'jpeg');
    assert.equal(policy?.explicit, true);
    assert.equal(policy?.source_sha256, digest(original));
    const prepared = f.jobs.prepare('test-account', 'zero-texture-explicit', 'export', parameters, quote),
      job = f.jobs.update(prepared.job_id, 'succeeded', {
        remote_ids: { project_id: 'project', operator_id: 'export' },
        artifacts: [{ artifact_id: 'model', kind: 'model', format: 'glb', index: 0 }],
      });
    await ensureExportJpeg(job, f.jobs, f.dir, f.gateway, async () => new Response(new Uint8Array(original)));
    const first = await f.service.download(job.job_id, 'model', 'first.glb'),
      proofKey = exportJpegProofKey(job, job.artifacts[0]!),
      proof = f.jobs.requestPolicy('test-account', proofKey);
    assert.deepEqual(await readFile(String(first.local_path)), original);
    assert.equal(proof?.sha256, proof?.source_sha256);
    assert.deepEqual(object(proof?.inspection).images, []);
    f.jobs.close();
    closed = true;
    reopened = await serviceFixture(f.dir);
    reopened.gateway.artifactUrl = async () => {
      throw Error('No new upstream reads after restart');
    };
    const restored = await reopened.service.get(job.job_id),
      second = await reopened.service.download(job.job_id, 'model', 'second.glb');
    assert.equal(object(restored.jpeg_output_validation).status, 'verified');
    assert.deepEqual(await readFile(String(second.local_path)), original);
    assert.deepEqual(reopened.jobs.requestPolicy('test-account', proofKey), proof);
    assert.deepEqual(
      reopened.jobs.requestPolicy('test-account', exportJpegPolicyKey(job.request_id)),
      policy,
    );
    assert.equal(reopened.gateway.posts, 0);
    assert.equal(f.gateway.posts, 0);
  } finally {
    reopened?.jobs.close();
    if (!closed) f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('a previous native fallback policy never upgrades when zero-texture JPEG support is added', async () => {
  const f = await serviceFixture();
  try {
    const parameters = normalize('export', {
      project_id: 'project',
      expected_operator_id: 'source',
      format: 'glb',
    });
    const previous = {
      version: 1,
      mode: 'native',
      project_id: 'project',
      operator_id: 'source',
      intent: exportJpegIntent(parameters),
      reason: 'The original material was outside the old JPEG scope.',
    };
    f.jobs.bindRequestPolicy('test-account', exportJpegPolicyKey('legacy-native'), previous);
    (f.gateway as Gateway).jpegSource = async () => {
      throw Error('Frozen source must not be read again');
    };
    await applyDefaultExportJpeg(
      { jobs: f.jobs, gateway: f.gateway, dataDir: f.dir, accountRef: () => 'test-account' },
      'legacy-native',
      parameters,
    );
    assert.equal(parameters.texture_format, undefined);
    assert.deepEqual(f.jobs.requestPolicy('test-account', exportJpegPolicyKey('legacy-native')), previous);
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
