/** 针对真实网页取证暴露的语义差异：球刷累加、整部件填色、原图擦除和可恢复历史。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Document, NodeIO } from '@gltf-transform/core';
import sharp from 'sharp';
import { surfaceMask } from '../cli/local/brush-surface.ts';
import { brushParts } from '../cli/local/brush-model.ts';
import { brushPaintOperations } from '../cli/local/brush-paint.ts';
import { brushPickOperations } from '../cli/local/brush-pick.ts';
import type { Config } from '../cli/core/config.ts';

async function source() {
  const document = new Document(),
    buffer = document.createBuffer();
  const attribute = (values: number[], type: 'VEC2' | 'VEC3') =>
    document.createAccessor().setBuffer(buffer).setType(type).setArray(new Float32Array(values));
  const primitive = document
    .createPrimitive()
    .setAttribute('POSITION', attribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 'VEC3'))
    .setAttribute('NORMAL', attribute([0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1], 'VEC3'))
    .setAttribute('TEXCOORD_0', attribute([0, 0, 1, 0, 1, 1, 0, 1], 'VEC2'))
    .setIndices(
      document
        .createAccessor()
        .setBuffer(buffer)
        .setType('SCALAR')
        .setArray(new Uint16Array([0, 1, 2, 0, 2, 3])),
    );
  const png = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#ffffff' } })
    .png()
    .toBuffer();
  primitive.setMaterial(
    document
      .createMaterial()
      .setBaseColorTexture(document.createTexture().setImage(png).setMimeType('image/png')),
  );
  document
    .createScene()
    .addChild(document.createNode('panel').setMesh(document.createMesh().addPrimitive(primitive)));
  return document;
}
test('surface brush accumulates byte weights and distinguishes feathered edges from a hard brush', async () => {
  const part = brushParts(await source())[0]!;
  const input = { points: [[-1, -1, 0] as [number, number, number]], size: 3, strength: 0.2, hardness: 0 };
  const first = surfaceMask(part, input),
    twice = surfaceMask(part, { ...input, points: [...input.points, ...input.points] });
  assert.equal(first[0], 51);
  assert.equal(first[1], 5);
  assert.equal(first[2], 0);
  assert.deepEqual([...twice], [102, 10, 0, 10]);
  assert.deepEqual([...surfaceMask(part, { ...input, hardness: 1 })], [51, 51, 51, 51]);
});
test('fill covers back-facing UVs, eraser restores source, and history survives reloading without rewriting old snapshots', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tripo-brush-'));
  try {
    const model = path.join(dir, 'source.glb'),
      doc = await source();
    await writeFile(model, await new NodeIO().writeBinary(doc));
    const config: Config = { dataDir: dir, outputDir: dir, inputRoots: [dir], keyringAccount: 'test' };
    const paint = async (name: string, actions: unknown[], history_path?: string) => {
      const destination_path = path.join(dir, name + '.json');
      await brushPaintOperations[0]!.run(config, {
        model_path: model,
        destination_path,
        actions,
        ...(history_path ? { history_path } : {}),
      });
      const manifest = JSON.parse(await readFile(destination_path, 'utf8')) as {
        history: { cursor: number; commands: unknown[] };
        image_map: { image_path: string }[];
        preview: { local_path: string };
      };
      const pixels = await sharp(manifest.image_map[0]!.image_path).ensureAlpha().raw().toBuffer();
      return { file: destination_path, manifest, pixels };
    };
    const fill = await paint('fill', [{ action: 'fill', color: '#4080c0', part_names: ['panel'] }]);
    assert.deepEqual([...fill.pixels.slice(0, 4)], [64, 128, 192, 255]);
    assert.equal(fill.manifest.history.cursor, 1);
    const erased = await paint(
      'erased',
      [{ action: 'erase', points: [[0, 0, 0]], size: 10, strength: 1, hardness: 1 }],
      fill.file,
    );
    assert.ok(erased.pixels.every((value) => value === 255));
    const undone = await paint('undo', [{ action: 'undo' }], erased.file);
    assert.deepEqual(undone.pixels, fill.pixels);
    const redone = await paint('redo', [{ action: 'redo' }], undone.file);
    assert.deepEqual(redone.pixels, erased.pixels);
    const branch = await paint(
      'branch',
      [{ action: 'fill', color: '#ff0000' }, { action: 'redo' }],
      undone.file,
    );
    assert.equal(branch.manifest.history.commands.length, 2);
    assert.deepEqual([...branch.pixels.slice(0, 4)], [255, 0, 0, 255]);
    const picked = (await brushPickOperations[0]!.run(config, {
      model_path: fill.manifest.preview.local_path,
      ray: { origin: [0, 0, 2], direction: [0, 0, -1] },
    })) as { picked: { color: string; uv: number[] } };
    assert.equal(picked.picked.color, '#4080c0');
    assert.deepEqual(picked.picked.uv, [0.5, 0.5]);
    const reset = await paint('reset', [{ action: 'reset' }], branch.file);
    assert.ok(reset.pixels.every((value) => value === 255));
    assert.equal(JSON.parse(await readFile(fill.file, 'utf8')).history.cursor, 1);
    await assert.rejects(paint('bad-part', [{ action: 'fill', color: '#ff0000', part_names: ['missing'] }]));
    doc.getRoot().listNodes()[0]!.setTranslation([1, 0, 0]);
    await writeFile(model, await new NodeIO().writeBinary(doc));
    await assert.rejects(paint('changed-source', [{ action: 'undo' }], fill.file), { code: 'INPUT_CHANGED' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('painting mesh instances and reused primitives does not alter the other instance', async () => {
  const doc = await source(),
    original = doc.getRoot().listNodes()[0]!,
    mesh = original.getMesh()!;
  doc.getRoot().listScenes()[0]!.addChild(doc.createNode('second').setMesh(mesh));
  doc
    .getRoot()
    .listScenes()[0]!
    .addChild(doc.createNode('third').setMesh(doc.createMesh().addPrimitive(mesh.listPrimitives()[0]!)));
  const parts = brushParts(doc);
  assert.equal(parts.length, 3);
  assert.notEqual(parts[0]!.primitive, parts[1]!.primitive);
  assert.notEqual(parts[1]!.primitive, parts[2]!.primitive);
  const previous = parts[1]!.primitive.getMaterial();
  parts[0]!.primitive.setMaterial(doc.createMaterial('new'));
  assert.equal(parts[1]!.primitive.getMaterial(), previous);
  assert.equal(parts[2]!.primitive.getMaterial(), previous);
});
