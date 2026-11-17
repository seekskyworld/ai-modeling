/** 网页临时 PBR 覆盖：只改送入渲染器的副本，保持贴图与几何，不参与正式模型导出。 */
import { object } from '../../studio/contracts/errors.ts';

export interface PreviewMaterial {
  pbr?: boolean;
  metalness?: number;
  roughness?: number;
}

/** 输入已经通过 readModelInput 校验；重写 GLB JSON 块时保留后续二进制块及其内部偏移。 */
export function previewMaterialModel(bytes: Buffer, format: string, settings: PreviewMaterial): Buffer {
  if (settings.pbr === undefined && settings.metalness === undefined && settings.roughness === undefined)
    return bytes;
  const binary = format === 'glb';
  const oldLength = binary ? bytes.readUInt32LE(12) : 0;
  const json = object(
    JSON.parse(binary ? bytes.toString('utf8', 20, 20 + oldLength) : bytes.toString('utf8')),
  );
  const materials = Array.isArray(json.materials) ? json.materials.map(object) : [];
  // 没有显式材质的 primitive 使用一个独立默认材质，才会与网页的预览覆盖同时生效。
  let fallback: number | undefined;
  for (const mesh of Array.isArray(json.meshes) ? json.meshes : []) {
    for (const primitive of Array.isArray(object(mesh).primitives)
      ? (object(mesh).primitives as unknown[])
      : []) {
      const value = object(primitive);
      if (value.material !== undefined) continue;
      if (fallback === undefined) {
        fallback = materials.length;
        materials.push({ pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 1 } });
      }
      value.material = fallback;
    }
  }
  for (const material of materials) {
    const pbr = object(material.pbrMetallicRoughness);
    // DGmL_an_ 的预览函数关闭 PBR 时清除金属/粗糙贴图并把两个因子置零；开启时替换因子，保留贴图。
    if (settings.pbr === false) {
      pbr.metallicFactor = 0;
      pbr.roughnessFactor = 0;
      delete pbr.metallicRoughnessTexture;
    } else {
      if (settings.metalness !== undefined) pbr.metallicFactor = settings.metalness;
      if (settings.roughness !== undefined) pbr.roughnessFactor = settings.roughness;
    }
    material.pbrMetallicRoughness = pbr;
  }
  json.materials = materials;
  const encoded = Buffer.from(JSON.stringify(json));
  if (!binary) return encoded;
  const padded = Buffer.alloc(Math.ceil(encoded.length / 4) * 4, 0x20);
  encoded.copy(padded);
  const header = Buffer.from(bytes.subarray(0, 20));
  const rest = bytes.subarray(20 + oldLength);
  header.writeUInt32LE(20 + padded.length + rest.length, 8);
  header.writeUInt32LE(padded.length, 12);
  return Buffer.concat([header, padded, rest]);
}
