/** 真正运行Blender：零图片编码是空操作，声明过图片/纹理却未导入时仍必须失败。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import sharp from 'sharp';
import { processModel } from '../cli/local/blender.ts';
import { validateGlb } from '../studio/files.ts';
import { uvFixtureGlb } from './uv-import-fixture.ts';
import { object } from '../studio/contracts/errors.ts';

const blender = process.env.AI_MODELING_TEST_BLENDER ?? process.env.AI_MODELING_BLENDER;
const integration = {
  skip: blender ? false : 'Set AI_MODELING_TEST_BLENDER for the actual Blender regression.',
};
async function source(kind: 'absent' | 'empty' | 'unused-image' | 'unused-texture' | 'textured') {
  const positions = Buffer.from(new Float32Array([2, 3, 4, 4, 3, 4, 2, 5, 4]).buffer);
  const uv = Buffer.from(new Float32Array([0, 0, 1, 0, 0, 1]).buffer);
  const binary = Buffer.concat([positions, uv]);
  const primitive: Record<string, unknown> = { attributes: { POSITION: 0, TEXCOORD_0: 1 } };
  const json: Record<string, unknown> = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: binary.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.length },
      { buffer: 0, byteOffset: positions.length, byteLength: uv.length },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [2, 3, 4], max: [4, 5, 4] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
    ],
    meshes: [{ name: 'part', primitives: [primitive] }],
    nodes: [{ name: 'part', mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  if (kind !== 'absent') {
    json.images = [];
    json.textures = [];
  }
  if (kind === 'unused-image' || kind === 'textured') {
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: 60, g: 120, b: 180 } },
    })
      .png()
      .toBuffer();
    json.images = [{ uri: 'data:image/png;base64,' + png.toString('base64') }];
  }
  if (kind === 'unused-texture') json.textures = [{}];
  if (kind === 'textured') {
    json.textures = [{ source: 0 }];
    json.materials = [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }];
    primitive.material = 0;
  }
  return { json, binary };
}
async function run(kind: Parameters<typeof source>[0], format = 'glb') {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'tripo-empty-texture-test-')));
  try {
    const { json, binary } = await source(kind);
    if (format === 'gltf')
      object((json.buffers as unknown[])[0]).uri =
        'data:application/octet-stream;base64,' + binary.toString('base64');
    const input = path.join(directory, 'source.' + format);
    const bytes = format === 'glb' ? uvFixtureGlb(json, binary) : Buffer.from(JSON.stringify(json));
    await writeFile(input, bytes);
    const result = await processModel({ model_path: input, blender }, [directory], {
      action: 'convert',
      format: 'glb',
      output_format: 'glb',
      texture_format: 'JPEG',
      pivot_to_center_bottom: true,
      // 内部许可不得由调用方覆盖真实原始文件事实。
      source_without_images_or_textures: true,
    });
    assert.deepEqual(await readFile(input), bytes);
    return result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
async function verifyPivot(bytes: Buffer) {
  const document = await new NodeIO().readBinary(bytes),
    points: number[][] = [];
  for (const node of document.getRoot().listNodes())
    for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
      const position = primitive.getAttribute('POSITION')!,
        matrix = node.getWorldMatrix();
      assert.equal(primitive.getIndices()?.getCount() ?? position.getCount(), 3);
      for (let i = 0; i < position.getCount(); i++) {
        const p = position.getElement(i, []);
        points.push(
          [0, 1, 2].map(
            (axis) =>
              matrix[axis]! * p[0]! +
              matrix[4 + axis]! * p[1]! +
              matrix[8 + axis]! * p[2]! +
              matrix[12 + axis]!,
          ),
        );
      }
    }
  assert.equal(points.length, 3);
  const min = [0, 1, 2].map((axis) => Math.min(...points.map((p) => p[axis]!))),
    max = [0, 1, 2].map((axis) => Math.max(...points.map((p) => p[axis]!)));
  for (const value of [(min[0]! + max[0]!) / 2, min[1]!, (min[2]! + max[2]!) / 2])
    assert.ok(Math.abs(value) < 2e-6);
}
for (const [kind, format] of [
  ['absent', 'glb'],
  ['empty', 'gltf'],
] as const)
  test(
    `actual Blender explicit JPEG and pivot accepts original zero-texture ${format}`,
    integration,
    async () => {
      const bytes = await run(kind, format),
        json = validateGlb(bytes);
      assert.equal((json.images as unknown[] | undefined)?.length ?? 0, 0);
      assert.equal((json.textures as unknown[] | undefined)?.length ?? 0, 0);
      await verifyPivot(bytes);
    },
  );
for (const kind of ['unused-image', 'unused-texture'] as const)
  test(`actual Blender does not treat declared ${kind} as original zero textures`, integration, async () => {
    await assert.rejects(run(kind), { code: 'LOCAL_MODEL_FAILED' });
  });
test('actual Blender still encodes a loaded opaque image to JPEG with pivot', integration, async () => {
  const bytes = await run('textured'),
    json = validateGlb(bytes);
  assert.equal((json.images as unknown[]).length, 1);
  assert.equal(object((json.images as unknown[])[0]).mimeType, 'image/jpeg');
  await verifyPivot(bytes);
});
