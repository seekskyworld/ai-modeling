/** 仅改变 glTF 动画数据的存储表示；不修改时间、插值、骨骼坐标或根运动。 */
import { Logger, type Document } from '@gltf-transform/core';
import { modelIO, removeCompression } from '../local/gltf.ts';
import { validateGlb } from '../../studio/files.ts';
import { array, object, TripoError } from '../../studio/contracts/errors.ts';
import { preserveSourceNodeTrs, studioAigcExtras } from './studio-assimp-json.ts';
import {
  frontendMaterialExtensionNames,
  validateFrontendMaterialExtensions,
} from './studio-assimp-material.ts';

export function frontendFail(message: string): never {
  throw new TripoError('FRONTEND_EXPORT_UNVERIFIED', message, 'not_submitted');
}
export function validateFrontendGlb(bytes: Buffer, output = false, kind?: 'static-fbx-output'): void {
  if (bytes.length < 28) return frontendFail('Frontend export requires a complete GLB 2.0 file.');
  if (bytes.length > 150 * 1024 * 1024 || bytes.readUInt32LE(12) > 16 * 1024 * 1024)
    return frontendFail('Frontend export supports at most 150 MiB GLB and 16 MiB JSON.');
  const staticFbxOutput = output && kind === 'static-fbx-output',
    json = validateGlb(bytes),
    allowed = new Set(['KHR_mesh_quantization', 'EXT_meshopt_compression']),
    materialObjects = validateFrontendMaterialExtensions(json, staticFbxOutput);
  // FBX 原引擎的有限标记单独校验；不扩大普通 GLB 源/输出的 extras 与扩展准入。
  const fbxNodes = new Set(staticFbxOutput ? array(json.nodes) : []),
    fbxPrimitives = new Set(
      staticFbxOutput ? array(json.meshes).flatMap((mesh) => array(object(mesh).primitives)) : [],
    );
  const fbxExtras = (owner: unknown, raw: unknown): boolean => {
    if (!fbxNodes.has(owner)) return false;
    const value = object(raw);
    return (
      Object.keys(value).every((key) =>
        [
          'UserProperties',
          'IsNull',
          'DefaultAttributeIndex',
          'InheritType',
          'RotationActive',
          'ScalingMax',
        ].includes(key),
      ) &&
      value.UserProperties === '' &&
      typeof value.IsNull === 'boolean' &&
      [-1, 0].includes(Number(value.DefaultAttributeIndex)) &&
      [0, 1].includes(Number(value.InheritType)) &&
      typeof value.DefaultAttributeIndex === 'number' &&
      typeof value.InheritType === 'number' &&
      (value.RotationActive === undefined || value.RotationActive === true) &&
      (value.ScalingMax === undefined || value.ScalingMax === null)
    );
  };
  const binary = 20 + bytes.readUInt32LE(12);
  if (
    binary + 8 > bytes.length ||
    bytes.readUInt32LE(binary + 4) !== 0x004e4942 ||
    binary + 8 + bytes.readUInt32LE(binary) !== bytes.length
  )
    return frontendFail('Frontend export verifies exactly one JSON and one embedded binary chunk.');
  // 原厂 exporter 声明这两个可选扩展，即使没有对象实际使用；不能因此允许任意扩展对象。
  const declarations = new Set([
    ...allowed,
    ...frontendMaterialExtensionNames,
    ...(output ? ['KHR_materials_volume', 'FB_ngon_encoding'] : []),
  ]);
  if (
    [...array(json.extensionsUsed), ...array(json.extensionsRequired)].some(
      (x) => !declarations.has(String(x)),
    )
  )
    return frontendFail('Source GLB has an extension outside the verified frontend-export subset.');
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === 'number' && !Number.isFinite(child))
        return frontendFail('GLB properties must be finite.');
      if (
        key === 'extensions' &&
        !materialObjects.has(value) &&
        Object.entries(object(child)).some(
          ([name, data]) =>
            !allowed.has(name) &&
            !(
              name === 'FB_ngon_encoding' &&
              fbxPrimitives.has(value) &&
              data !== null &&
              typeof data === 'object' &&
              !Array.isArray(data) &&
              Object.keys(data).length === 0
            ),
        )
      )
        return frontendFail('Frontend export cannot discard unverified extension properties.');
      if (
        key === 'extras' &&
        child !== undefined &&
        JSON.stringify(child) !== '{}' &&
        !(value === json.asset && studioAigcExtras(child)) &&
        !fbxExtras(value, child)
      )
        return frontendFail('Custom glTF extras require a separate preservation proof.');
      visit(child);
    }
  };
  visit(json);
  if (
    array(json.scenes).length !== 1 ||
    array(json.nodes).length > 2048 ||
    array(json.animations).length > 32 ||
    array(json.buffers).some((x) => object(x).uri !== undefined) ||
    array(json.images).some((x) => object(x).uri !== undefined) ||
    array(json.cameras).length
  )
    return frontendFail('Frontend export requires one bounded scene with embedded resources and no cameras.');
  validateDecodeBudget(json);
}
function validateDecodeBudget(json: Record<string, unknown>): void {
  let values = 0;
  const sizes: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
  for (const raw of array(json.accessors)) {
    const accessor = object(raw),
      size = sizes[String(accessor.type)],
      count = Number(accessor.count);
    if (!size || !Number.isSafeInteger(count) || count < 1) return frontendFail('Accessor shape is invalid.');
    values += size * count;
  }
  if (values > 10000000 || array(json.buffers).some((x) => Number(object(x).byteLength) > 300 * 1024 * 1024))
    return frontendFail('Frontend decoding exceeds its bounded accessor or buffer budget.');
}
export async function readFrontendDocument(
  bytes: Buffer,
  output = false,
  kind?: 'static-fbx-output',
): Promise<Document> {
  validateFrontendGlb(bytes, output, kind);
  const io = (await modelIO()).setLogger(new Logger(Logger.Verbosity.SILENT));
  const document = await io.readBinary(bytes);
  let elements = 0;
  for (const accessor of document.getRoot().listAccessors()) {
    elements += accessor.getCount() * accessor.getElementSize();
    if (elements > 10_000_000) return frontendFail('Frontend verification exceeds its accessor work limit.');
    const values = accessor.getArray();
    if (!values || values.some((x) => !Number.isFinite(x)))
      return frontendFail('The model contains a missing or non-finite accessor.');
  }
  return document;
}
export async function normalizeFrontendAnimation(bytes: Buffer): Promise<{
  bytes: Buffer;
  proof: Record<string, unknown>;
}> {
  const document = await readFrontendDocument(bytes),
    changed: Record<string, unknown>[] = [];
  const accessors = new Set(
    document
      .getRoot()
      .listAnimations()
      .flatMap((animation) => animation.listChannels().map((channel) => channel.getSampler()?.getOutput())),
  );
  for (const accessor of accessors) {
    if (!accessor) return frontendFail('Animation is missing its output accessor.');
    if (accessor.getComponentType() === 5126) continue;
    if (!accessor.getNormalized()) return frontendFail('Integer animation must use normalized glTF values.');
    const count = accessor.getCount(),
      size = accessor.getElementSize(),
      values = new Float32Array(count * size);
    let maximumError = 0;
    for (let i = 0; i < count; i++) {
      const source = accessor.getElement(i, []);
      for (let j = 0; j < size; j++) {
        values[i * size + j] = source[j]!;
        maximumError = Math.max(maximumError, Math.abs(values[i * size + j]! - source[j]!));
      }
    }
    changed.push({
      component_type: accessor.getComponentType(),
      count,
      element_size: size,
      maximum_representation_error: maximumError,
    });
    accessor.setArray(values).setNormalized(false);
  }
  // 未发生整数动画修复时保原字节，使静态网页引擎重放可逐字节对照。
  if (!changed.length) return { bytes, proof: { changed_accessors: 0, accessors: [] } };
  removeCompression(document);
  const io = (await modelIO()).setLogger(new Logger(Logger.Verbosity.SILENT));
  return {
    bytes: preserveSourceNodeTrs(bytes, Buffer.from(await io.writeBinary(document))),
    proof: {
      changed_accessors: changed.length,
      accessors: changed,
      method:
        'Standard glTF normalized integer decoding to Float32; keyframe times, interpolation and node transforms unchanged.',
    },
  };
}
