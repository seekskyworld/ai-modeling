import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { NodeIO } from '@gltf-transform/core';
import { MeshoptEncoder } from 'meshoptimizer';
import { encodeGlbJpeg, inspectGlbJpeg } from '../cli/artifacts/glb-jpeg.ts';

interface TestGlb extends Record<string, unknown> {
  buffers: Array<{ byteLength: number }>;
  bufferViews: Array<{ buffer: number; byteOffset: number; byteLength: number }>;
  images?: Array<{ bufferView: number; mimeType: string; name?: string; uri?: string }>;
  textures?: Array<{ source: number; extensions?: Record<string, unknown> }>;
  materials: Array<{ alphaMode?: string; pbrMetallicRoughness: { baseColorTexture?: unknown } }>;
}
function chunks(bytes: Buffer): { json: TestGlb; binary: Buffer } {
  const end = 20 + bytes.readUInt32LE(12),
    json = JSON.parse(bytes.toString('utf8', 20, end)) as TestGlb;
  return { json, binary: bytes.subarray(end + 8, end + 8 + json.buffers[0]!.byteLength) };
}
function glb(json: Record<string, unknown>, binary: Buffer): Buffer {
  const data = Buffer.from(JSON.stringify(json)),
    jsonPad = (4 - (data.length % 4)) % 4,
    binaryPad = (4 - (binary.length % 4)) % 4,
    header = Buffer.alloc(20),
    binHeader = Buffer.alloc(8);
  header.write('glTF');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(28 + data.length + jsonPad + binary.length + binaryPad, 8);
  header.writeUInt32LE(data.length + jsonPad, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  binHeader.writeUInt32LE(binary.length + binaryPad);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([
    header,
    data,
    Buffer.alloc(jsonPad, 0x20),
    binHeader,
    binary,
    Buffer.alloc(binaryPad),
  ]);
}
/** 一个带真实权重、骨架和变化rotation轨道的三角形；文件结构可由独立glTF reader重新加载。 */
async function fixture(mime: 'png' | 'jpeg' = 'png', alpha = 255, orientation = 1): Promise<Buffer> {
  const sections: Buffer[] = [],
    views: Array<Record<string, number>> = [];
  let length = 0;
  const add = (bytes: Buffer): number => {
    const pad = (4 - (length % 4)) % 4;
    if (pad) sections.push(Buffer.alloc(pad));
    length += pad;
    const index = views.length;
    views.push({ buffer: 0, byteOffset: length, byteLength: bytes.length });
    sections.push(bytes);
    length += bytes.length;
    return index;
  };
  const float = (values: number[]): number => add(Buffer.from(new Float32Array(values).buffer));
  const position = float([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices = add(Buffer.from(new Uint16Array([0, 1, 2]).buffer)),
    joints = add(Buffer.alloc(12)),
    weights = float([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
    inverse = float([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    time = float([0, 1]),
    rotation = float([0, 0, 0, 1, 0, 0, 0.70710677, 0.70710677]),
    uv = float([0, 0, 1, 0, 0, 1]);
  const image = sharp(Buffer.from([255, 0, 0, alpha, 0, 128, 255, 255]), {
    raw: { width: 2, height: 1, channels: 4 },
  });
  if (orientation !== 1) image.withMetadata({ orientation });
  const imageView = add(await (mime === 'png' ? image.png() : image.jpeg()).toBuffer());
  return glb(
    {
      asset: { version: '2.0', generator: 'GLB JPEG structure proof' },
      buffers: [{ byteLength: length }],
      bufferViews: views,
      accessors: [
        { bufferView: position, componentType: 5126, type: 'VEC3', count: 3, min: [0, 0, 0], max: [1, 1, 0] },
        { bufferView: indices, componentType: 5123, type: 'SCALAR', count: 3 },
        { bufferView: joints, componentType: 5121, type: 'VEC4', count: 3 },
        { bufferView: weights, componentType: 5126, type: 'VEC4', count: 3 },
        { bufferView: inverse, componentType: 5126, type: 'MAT4', count: 1 },
        { bufferView: time, componentType: 5126, type: 'SCALAR', count: 2, min: [0], max: [1] },
        { bufferView: rotation, componentType: 5126, type: 'VEC4', count: 2 },
        { bufferView: uv, componentType: 5126, type: 'VEC2', count: 3 },
      ],
      images: [{ bufferView: imageView, mimeType: `image/${mime}`, name: 'fixture-image' }],
      samplers: [{ wrapS: 33071, wrapT: 33071 }],
      textures: [{ sampler: 0, source: 0 }],
      materials: [
        {
          pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0.3, roughnessFactor: 0.7 },
        },
      ],
      meshes: [
        {
          primitives: [
            {
              attributes: { POSITION: 0, JOINTS_0: 2, WEIGHTS_0: 3, TEXCOORD_0: 7 },
              indices: 1,
              material: 0,
            },
          ],
        },
      ],
      skins: [{ joints: [1], inverseBindMatrices: 4 }],
      nodes: [{ mesh: 0, skin: 0, name: 'weighted-triangle' }, { name: 'bone' }],
      animations: [
        {
          name: 'rotation',
          samplers: [{ input: 5, output: 6, interpolation: 'LINEAR' }],
          channels: [{ sampler: 0, target: { node: 1, path: 'rotation' } }],
        },
      ],
      scenes: [{ nodes: [0, 1] }],
      scene: 0,
      extras: { untouched: 'original metadata' },
    },
    Buffer.concat(sections),
  );
}

test('JPEG仅追加图像，完整保留几何/骨架/动作结构和原始BIN，独立加载仍有变化动作', async () => {
  const source = await fixture(),
    before = chunks(source),
    encoded = await encodeGlbJpeg(source),
    after = chunks(encoded.bytes);
  assert.ok(after.binary.subarray(0, before.binary.length).equals(before.binary));
  assert.deepEqual(after.json.bufferViews.slice(0, before.json.bufferViews.length), before.json.bufferViews);
  for (const key of Object.keys(before.json).filter(
    (key) => !['images', 'bufferViews', 'buffers'].includes(key),
  ))
    assert.deepEqual(after.json[key], before.json[key]);
  assert.equal(after.json.images![0]!.name, before.json.images![0]!.name);
  assert.equal(after.json.images![0]!.mimeType, 'image/jpeg');
  const view = after.json.bufferViews[after.json.images![0]!.bufferView]!,
    image = await sharp(after.binary.subarray(view.byteOffset, view.byteOffset + view.byteLength)).metadata();
  assert.equal(image.format, 'jpeg');
  assert.equal(image.width, 2);
  assert.equal(image.height, 1);
  const reader = new NodeIO(),
    imported = await reader.readBinary(encoded.bytes),
    root = imported.getRoot();
  assert.equal(root.listSkins()[0]!.listJoints().length, 1);
  assert.equal(root.listAnimations().length, 1);
  assert.equal(root.listMeshes()[0]!.listPrimitives()[0]!.getAttribute('WEIGHTS_0')!.getCount(), 3);
  const rotations = root.listAnimations()[0]!.listSamplers()[0]!.getOutput()!.getArray()!;
  assert.notEqual(rotations[3], rotations[7]);
  assert.match(encoded.processing, /original geometry, skins and animation bytes retained/);
});

test('已有JPEG与无图模型保持整个文件原字节，存在alpha通道但全不透明允许编码', async () => {
  const source = await fixture('jpeg');
  assert.ok((await encodeGlbJpeg(source)).bytes.equals(source));
  const empty = chunks(await fixture());
  delete empty.json.images;
  delete empty.json.textures;
  delete empty.json.materials[0]!.pbrMetallicRoughness.baseColorTexture;
  const noImages = glb(empty.json, empty.binary);
  assert.ok((await encodeGlbJpeg(noImages)).bytes.equals(noImages));
  assert.equal((await inspectGlbJpeg(await fixture('png', 255))).images[0]!.mime, 'image/png');
  await assert.rejects(inspectGlbJpeg(await fixture('png', 254)), { code: 'TEXTURE_ENCODING_UNSUPPORTED' });
});

test('拒绝无效透明模式、未验证图片扩展、外部依赖、旋转标记及损坏图片', async () => {
  for (const mutate of [
    (json: TestGlb) => {
      json.materials[0]!.alphaMode = 'UNKNOWN';
    },
    (json: TestGlb) => {
      json.textures![0]!.extensions = { EXT_texture_webp: { source: 0 } };
    },
    (json: TestGlb) => {
      json.images![0]!.uri = 'image.png';
    },
    (json: TestGlb) => {
      json.bufferViews[json.images![0]!.bufferView]!.byteLength = 12;
    },
  ]) {
    const value = chunks(await fixture());
    mutate(value.json);
    await assert.rejects(inspectGlbJpeg(glb(value.json, value.binary)), {
      code: 'TEXTURE_ENCODING_UNSUPPORTED',
    });
  }
  await assert.rejects(inspectGlbJpeg(await fixture('jpeg', 255, 6)), {
    code: 'TEXTURE_ENCODING_UNSUPPORTED',
  });
  const bad = await fixture();
  bad.writeUInt32LE(bad.length - 4, 8);
  await assert.rejects(encodeGlbJpeg(bad), { code: 'TEXTURE_ENCODING_UNSUPPORTED' });
});

test('Meshopt只接受已验证的原生fallback缓冲，编码后不改原压缩字节', async () => {
  await MeshoptEncoder.ready;
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    compressed = Buffer.from(
      MeshoptEncoder.encodeGltfBuffer(new Uint8Array(positions.buffer), 3, 12, 'ATTRIBUTES'),
    ),
    image = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'red' } })
      .png()
      .toBuffer(),
    json = {
      asset: { version: '2.0' },
      extensionsUsed: ['EXT_meshopt_compression'],
      extensionsRequired: ['EXT_meshopt_compression'],
      buffers: [
        { byteLength: compressed.length + image.length },
        { byteLength: 36, extensions: { EXT_meshopt_compression: { fallback: true } } },
      ],
      bufferViews: [
        {
          buffer: 1,
          byteLength: 36,
          extensions: {
            EXT_meshopt_compression: {
              buffer: 0,
              byteOffset: 0,
              byteLength: compressed.length,
              byteStride: 12,
              count: 3,
              mode: 'ATTRIBUTES',
            },
          },
        },
        { buffer: 0, byteOffset: compressed.length, byteLength: image.length },
      ],
      images: [{ mimeType: 'image/png', bufferView: 1 }],
      textures: [{ source: 0 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    },
    source = glb(json, Buffer.concat([compressed, image])),
    output = await encodeGlbJpeg(source);
  assert.ok(chunks(output.bytes).binary.subarray(0, compressed.length).equals(compressed));
  assert.equal((await inspectGlbJpeg(output.bytes)).images[0]!.mime, 'image/jpeg');
  json.buffers[1]!.extensions!.EXT_meshopt_compression.fallback = false;
  await assert.rejects(inspectGlbJpeg(glb(json, Buffer.concat([compressed, image]))), {
    code: 'TEXTURE_ENCODING_UNSUPPORTED',
  });
});
