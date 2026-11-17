/** 构造带真实压缩属性和独立源坐标的UV夹具，供效果与任务恢复测试共用。 */
import { MeshoptEncoder } from 'meshoptimizer';

export function uvFixtureGlb(json: Record<string, unknown>, binary: Buffer): Buffer {
  const raw = Buffer.from(JSON.stringify(json)),
    jp = (4 - (raw.length % 4)) % 4,
    bp = (4 - (binary.length % 4)) % 4,
    h = Buffer.alloc(20),
    b = Buffer.alloc(8);
  h.write('glTF');
  h.writeUInt32LE(2, 4);
  h.writeUInt32LE(28 + raw.length + jp + binary.length + bp, 8);
  h.writeUInt32LE(raw.length + jp, 12);
  h.writeUInt32LE(0x4e4f534a, 16);
  b.writeUInt32LE(binary.length + bp);
  b.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([h, raw, Buffer.alloc(jp, 32), b, binary, Buffer.alloc(bp)]);
}
export function uvFixtureChunks(bytes: Buffer): { json: Record<string, unknown>; binary: Buffer } {
  const end = bytes.readUInt32LE(12) + 20;
  return { json: JSON.parse(bytes.toString('utf8', 20, end)), binary: bytes.subarray(end + 8) };
}
export async function uvImportFixture(compressed: boolean, mutation = ''): Promise<Buffer> {
  await MeshoptEncoder.ready;
  const positions = new Float32Array(
      compressed
        ? [-0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0]
        : [0, 0, 0, 2, 0, 0, 0, 2, 0, 2, 2, 0],
    ),
    normal = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uv = new Float32Array(mutation === 'uv' ? [1, 0, 0, 0, 0, 1, 1, 1] : [0, 0, 1, 0, 0, 1, 1, 1]),
    indices = new Uint16Array(mutation === 'winding' ? [0, 2, 1, 2, 1, 3] : [0, 1, 2, 2, 1, 3]);
  if (mutation === 'scale') for (let i = 0; i < positions.length; i++) positions[i] = positions[i]! * 0.9;
  if (mutation === 'geometry') positions[9] = 0.25;
  const data = [positions, normal, uv, indices],
    strides = [12, 12, 8, 2],
    pieces: Buffer[] = [],
    views: Array<Record<string, unknown>> = [];
  let size = 0,
    decodedSize = 0;
  for (const [index, array] of data.entries()) {
    const pad = (4 - (size % 4)) % 4;
    pieces.push(Buffer.alloc(pad));
    size += pad;
    const bytes = Buffer.from(array.buffer),
      count = index === 3 ? 6 : 4,
      stride = strides[index]!,
      encoded = compressed
        ? Buffer.from(
            MeshoptEncoder.encodeGltfBuffer(bytes, count, stride, index === 3 ? 'TRIANGLES' : 'ATTRIBUTES'),
          )
        : bytes;
    views.push(
      compressed
        ? {
            buffer: 1,
            byteOffset: decodedSize,
            byteLength: bytes.length,
            extensions: {
              EXT_meshopt_compression: {
                buffer: 0,
                byteOffset: size,
                byteLength: encoded.length,
                byteStride: stride,
                count,
                mode: index === 3 ? 'TRIANGLES' : 'ATTRIBUTES',
              },
            },
          }
        : { buffer: 0, byteOffset: size, byteLength: bytes.length },
    );
    pieces.push(encoded);
    size += encoded.length;
    decodedSize += bytes.length;
  }
  return uvFixtureGlb(
    {
      asset: { version: '2.0' },
      ...(compressed
        ? { extensionsUsed: ['EXT_meshopt_compression'], extensionsRequired: ['EXT_meshopt_compression'] }
        : {}),
      buffers: [
        { byteLength: size },
        ...(compressed
          ? [{ byteLength: decodedSize, extensions: { EXT_meshopt_compression: { fallback: true } } }]
          : []),
      ],
      bufferViews: views,
      accessors: [
        { bufferView: 0, componentType: 5126, type: 'VEC3', count: 4 },
        { bufferView: 1, componentType: 5126, type: 'VEC3', count: 4 },
        { bufferView: 2, componentType: 5126, type: 'VEC2', count: 4 },
        { bufferView: 3, componentType: 5123, type: 'SCALAR', count: 6 },
      ],
      meshes: [
        {
          name: compressed ? 'truncated' : 'original-uv-mesh',
          primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }],
        },
      ],
      nodes: [
        {
          mesh: 0,
          name: compressed ? 'truncated' : 'original-uv-node',
          ...(compressed ? {} : { translation: [2, 3, 4] }),
        },
      ],
      materials: [
        {
          pbrMetallicRoughness: {
            baseColorFactor: mutation === 'material' ? [1, 0, 0, 1] : [0.8, 0.8, 0.8, 1],
            metallicFactor: 0,
            roughnessFactor: 0.9,
          },
        },
      ],
      scenes: [{ nodes: [0] }],
      scene: 0,
    },
    Buffer.concat(pieces),
  );
}
