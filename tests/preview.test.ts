/** 视口关键边界：选择真实片段、保留原文件、禁用无效组合及限制公开 HDR 读取。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Document, NodeIO } from '@gltf-transform/core';
import { preparePreviewModel } from '../cli/local/preview-model.ts';
import { localOperations } from '../cli/local/operations.ts';
import { fetchEnvironment, validateHDR } from '../studio/api/preview-assets.ts';
import { modelIO } from '../cli/local/gltf.ts';

async function animated() {
  const doc = new Document(),
    buffer = doc.createBuffer();
  const accessor = (values: number[], type: 'SCALAR' | 'VEC3') =>
    doc.createAccessor().setBuffer(buffer).setType(type).setArray(new Float32Array(values));
  const node = doc
    .createNode('animated-part')
    .setMesh(
      doc
        .createMesh()
        .addPrimitive(
          doc.createPrimitive().setAttribute('POSITION', accessor([0, 0, 0, 1, 0, 0, 0, 1, 0], 'VEC3')),
        ),
    );
  doc.createScene().addChild(node);
  for (const [name, duration] of [
    ['idle', 2],
    ['walk', 4],
  ] as const) {
    const sampler = doc
      .createAnimationSampler()
      .setInput(accessor([0, duration], 'SCALAR'))
      .setOutput(accessor([0, 0, 0, 1, 0, 0], 'VEC3'));
    doc
      .createAnimation(name)
      .addSampler(sampler)
      .addChannel(
        doc.createAnimationChannel().setTargetNode(node).setTargetPath('translation').setSampler(sampler),
      );
  }
  return Buffer.from(await new NodeIO().writeBinary(doc));
}
test('preview selects original glTF names or indices and never rewrites the source clips', async () => {
  const source = await animated(),
    original = Buffer.from(source),
    io = await modelIO();
  for (const selection of ['walk', '1']) {
    const result = await preparePreviewModel(source, 'glb', { animation: selection });
    assert.equal(result.animation?.name, 'walk');
    assert.equal(result.animation?.duration, 4);
    assert.deepEqual(
      (await io.readBinary(result.bytes))
        .getRoot()
        .listAnimations()
        .map((a) => a.getName()),
      ['walk'],
    );
  }
  const rest = await preparePreviewModel(source, 'glb', {});
  assert.equal((await io.readBinary(rest.bytes)).getRoot().listAnimations().length, 0);
  assert.deepEqual(source, original);
  assert.equal((await io.readBinary(source)).getRoot().listAnimations().length, 2);
  const embedded = await io.writeJSON(await io.readBinary(source));
  for (const buffer of embedded.json.buffers ?? []) {
    const bytes = embedded.resources[buffer.uri!];
    assert.ok(bytes);
    buffer.uri = 'data:application/octet-stream;base64,' + Buffer.from(bytes).toString('base64');
  }
  const gltf = await preparePreviewModel(Buffer.from(JSON.stringify(embedded.json)), 'gltf', {
    animation: 'walk',
  });
  assert.equal(gltf.animation?.duration, 4);
  assert.equal((await io.readBinary(gltf.bytes)).getRoot().listMeshes().length, 1);
  await assert.rejects(preparePreviewModel(source, 'glb', { animation: 'missing' }), /missing, ambiguous/);
  await assert.rejects(preparePreviewModel(source, 'glb', { skeleton: true }), /skinned model/);
  await assert.rejects(preparePreviewModel(source, 'glb', { display_mode: 'toon' }), /base-color texture/);
});
test('preview rejects settings that would silently have no effect', () => {
  const snapshot = localOperations.find((x) => x.name === 'snapshot')!.schema;
  const base = { model_path: 'a.glb', destination_path: 'a.png' };
  for (const invalid of [
    { animation_time: 1 },
    { environment_rotation: 20 },
    { environment: 'night', environment_path: 'other.hdr' },
    { environment: 'studio', environment_auto_rotate: true },
    { animation: 'walk', animation_speed: 2 },
  ])
    assert.equal(snapshot.safeParse({ ...base, ...invalid }).success, false);
  assert.equal(
    snapshot.safeParse({
      ...base,
      animation: 'walk',
      animation_time: 5,
      environment: 'studio',
      environment_rotation: 20,
    }).success,
    true,
  );
  const share = localOperations.find((x) => x.name === 'share_image')!.schema;
  const image = {
    image_path: 'a.png',
    destination_path: 'b.png',
    project_id: '00000000-0000-4000-8000-000000000000',
  };
  assert.equal(share.safeParse(image).success, true);
  for (const invalid of [
    { wireframe: true },
    { pbr: false },
    { azimuth: 60 },
    { shading: 'flat' },
    { projection: 'perspective' },
    { metalness: 0.5 },
  ])
    assert.equal(share.safeParse({ ...image, ...invalid }).success, false);
  const video = localOperations.find((x) => x.name === 'showcase_video')!.schema;
  assert.equal(
    video.safeParse({
      ...base,
      environment: 'studio',
      environment_auto_rotate: true,
      animation: 'walk',
      camera_motion: 'fixed',
    }).success,
    true,
  );
});
test('HDR loader bounds content and redirects without sending account headers', async () => {
  const hdr = Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n\x80\x80\x80\x80', 'latin1');
  validateHDR(hdr);
  assert.throws(() => validateHDR(Buffer.from('<html>bad download</html>')), /Radiance/);
  let calls = 0;
  assert.deepEqual(
    await fetchEnvironment('night', async (url, options) => {
      calls++;
      assert.match(String(url), /^https:\/\/tripo-webapp-assets\.tripo3d\.ai\/studio-prod\/images\//);
      assert.equal(options?.headers, undefined);
      return new Response(hdr);
    }),
    hdr,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    fetchEnvironment(
      'studio',
      async () =>
        new Response(null, { status: 302, headers: { location: 'https://unrelated.example/file' } }),
    ),
    /outside Studio/,
  );
  await assert.rejects(
    fetchEnvironment('night', async () => new Response('unavailable', { status: 404 })),
    /download failed/,
  );
});
