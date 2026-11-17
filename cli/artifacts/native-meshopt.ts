/** 验收网页原生 Meshopt 实物，不编码、不修改模型；声明扩展或文件名含 meshopt 都不足以通过。 */
import { MeshoptDecoder } from 'meshoptimizer';
import { array, object, TripoError } from '../../studio/contracts/errors.ts';

function invalid(message: string): never {
  throw new TripoError('NATIVE_OUTPUT_REQUIREMENT_FAILED', message, 'read');
}

function glbChunks(bytes: Buffer): { json: Record<string, unknown>; binary: Buffer } {
  if (
    bytes.length < 28 ||
    bytes.toString('ascii', 0, 4) !== 'glTF' ||
    bytes.readUInt32LE(4) !== 2 ||
    bytes.readUInt32LE(8) !== bytes.length ||
    bytes.readUInt32LE(16) !== 0x4e4f534a
  )
    return invalid('compress=geometry requires a valid native GLB.');
  const length = bytes.readUInt32LE(12);
  const next = 20 + length;
  if (length > 16 * 1024 * 1024 || next + 8 > bytes.length || bytes.readUInt32LE(next + 4) !== 0x004e4942)
    return invalid('Native Meshopt GLB requires an embedded binary chunk and bounded JSON.');
  const binaryLength = bytes.readUInt32LE(next);
  if (next + 8 + binaryLength !== bytes.length)
    return invalid('Native Meshopt GLB binary chunk has an invalid length.');
  try {
    const json = object(JSON.parse(bytes.toString('utf8', 20, next)));
    const first = object(array(json.buffers)[0]),
      declared = Number(first.byteLength);
    if (
      object(json.asset).version !== '2.0' ||
      first.uri !== undefined ||
      !Number.isSafeInteger(declared) ||
      declared < 0 ||
      declared > binaryLength ||
      binaryLength - declared > 3
    )
      return invalid(
        'Native Meshopt must reference the declared embedded buffer, not an external URI or padding.',
      );
    return {
      json,
      binary: bytes.subarray(next + 8, next + 8 + declared),
    };
  } catch (error) {
    if (error instanceof TripoError) throw error;
    return invalid('Native Meshopt GLB JSON could not be read.');
  }
}

/** 每个几何属性/索引/形变目标都必须引用压缩视图；不允许仅压缩一个无关 bufferView。 */
function geometryAccessors(json: Record<string, unknown>): Set<number> {
  const references = new Set<number>();
  for (const mesh of array(json.meshes).map(object)) {
    for (const primitive of array(mesh.primitives).map(object)) {
      const values = [
        ...Object.values(object(primitive.attributes)),
        ...(primitive.indices === undefined ? [] : [primitive.indices]),
        ...array(primitive.targets).flatMap((target) => Object.values(object(target))),
      ];
      if (!values.length) invalid('Native GLB has a primitive without geometry accessors.');
      for (const value of values) {
        if (!Number.isSafeInteger(value) || Number(value) < 0)
          invalid('Native GLB has an invalid geometry accessor.');
        references.add(Number(value));
      }
    }
  }
  if (!references.size) invalid('Native GLB contains no geometry to verify.');
  return references;
}

function compressedViews(json: Record<string, unknown>, accessors: Set<number>): Set<number> {
  if (!array(json.extensionsUsed).includes('EXT_meshopt_compression'))
    invalid('Studio returned geometry without EXT_meshopt_compression; compress=geometry was not met.');
  const list = array(json.accessors).map(object);
  const views = array(json.bufferViews).map(object);
  const result = new Set<number>();
  for (const id of accessors) {
    const accessor = list[id];
    const index = accessor?.bufferView;
    if (!accessor || accessor.sparse || !Number.isSafeInteger(index) || Number(index) < 0)
      invalid('Native Meshopt verification requires nonsparse geometry backed by a bufferView.');
    const view = views[Number(index)];
    if (!view || !object(view.extensions).EXT_meshopt_compression)
      invalid('Some native geometry is uncompressed; compress=geometry was not met.');
    validateAccessor(accessor!, view!);
    result.add(Number(index));
  }
  return result;
}

function validateAccessor(accessor: Record<string, unknown>, view: Record<string, unknown>): void {
  const bytes = ({ 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 } as Record<number, number>)[
    Number(accessor.componentType)
  ];
  const components = (
    { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 } as Record<string, number>
  )[String(accessor.type)];
  const element = (bytes ?? 0) * (components ?? 0);
  const count = Number(accessor.count),
    start = Number(accessor.byteOffset ?? 0),
    stride = Number(view.byteStride ?? element);
  if (
    !element ||
    ![count, start, stride].every(Number.isSafeInteger) ||
    count <= 0 ||
    start < 0 ||
    stride < element ||
    start + (count - 1) * stride + element > Number(view.byteLength)
  )
    invalid('Native GLB geometry accessor exceeds its compressed bufferView.');
}

function decodedLength(extension: Record<string, unknown>, binary: Buffer): number {
  const { buffer, byteOffset = 0, byteLength, byteStride, count, mode, filter = 'NONE' } = extension;
  if (
    buffer !== 0 ||
    ![byteOffset, byteLength, byteStride, count].every((n) => Number.isSafeInteger(n) && Number(n) >= 0) ||
    !Number(byteStride) ||
    !Number(count) ||
    !Number(byteLength) ||
    Number(byteOffset) + Number(byteLength) > binary.length ||
    !['ATTRIBUTES', 'TRIANGLES', 'INDICES'].includes(String(mode)) ||
    !['NONE', 'OCTAHEDRAL', 'QUATERNION', 'EXPONENTIAL'].includes(String(filter))
  )
    return invalid('Native Meshopt buffer metadata is invalid or unsupported.');
  const length = Number(byteStride) * Number(count);
  if (!Number.isSafeInteger(length) || length > 256 * 1024 * 1024)
    return invalid('Native Meshopt decoded geometry exceeds the verification limit.');
  return length;
}

export async function verifyNativeMeshopt(
  bytes: Buffer,
  format = 'glb',
): Promise<{ compressed_buffer_views: number; geometry_accessors: number }> {
  if (format !== 'glb') invalid('compress=geometry requires native GLB output.');
  const { json, binary } = glbChunks(bytes);
  const accessors = geometryAccessors(json);
  const references = compressedViews(json, accessors);
  const views = array(json.bufferViews).map(object);
  let total = 0;
  await MeshoptDecoder.ready;
  for (const index of references) {
    const extension = object(object(views[index]!.extensions).EXT_meshopt_compression);
    const length = decodedLength(extension, binary);
    total += length;
    if (total > 256 * 1024 * 1024) invalid('Native Meshopt verification exceeds 256 MiB of decoded data.');
    if (views[index]!.byteLength !== length)
      invalid('Native Meshopt bufferView length differs from its decoded geometry.');
    const start = Number(extension.byteOffset ?? 0);
    try {
      MeshoptDecoder.decodeGltfBuffer(
        new Uint8Array(length),
        Number(extension.count),
        Number(extension.byteStride),
        binary.subarray(start, start + Number(extension.byteLength)),
        String(extension.mode),
        String(extension.filter ?? 'NONE'),
      );
    } catch {
      invalid('Native Meshopt geometry could not be decoded; compressed output was not verified.');
    }
  }
  return { compressed_buffer_views: references.size, geometry_accessors: accessors.size };
}
