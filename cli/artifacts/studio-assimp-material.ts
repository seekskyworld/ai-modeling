/** 仅验证原网页引擎已保留的标量材质；纹理扩展与烘焙仍需各自的效果证明。 */
import type { Material } from '@gltf-transform/core';
import type {
  Anisotropy,
  Clearcoat,
  EmissiveStrength,
  IOR,
  Sheen,
  Specular,
  Transmission,
} from '@gltf-transform/extensions';
import { array, object, TripoError } from '../../studio/contracts/errors.ts';

export const frontendMaterialExtensionNames = [
  'KHR_materials_unlit',
  'KHR_materials_clearcoat',
  'KHR_materials_ior',
  'KHR_materials_transmission',
  'KHR_materials_sheen',
  'KHR_materials_specular',
  'KHR_materials_emissive_strength',
  'KHR_materials_anisotropy',
];
const fail = (): never => {
  throw new TripoError(
    'FRONTEND_EXPORT_UNVERIFIED',
    'Frontend material proof accepts only verified unlit, scalar clearcoat, IOR, transmission, sheen, scalar/color specular, scalar emissive strength and scalar anisotropy without extension textures or unknown properties.',
    'not_submitted',
  );
};
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function unit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return fail();
  // 与已有PBR材质签名使用相同1e-6口径，不放宽几何、UV、法线或图片字节验证。
  return Math.round(value * 1e6) / 1e6;
}
function ior(value: unknown): number {
  // Khronos 的特殊值0表示无限IOR，其他合法值至少为1；不能误套[0,1]色值域。
  if (typeof value !== 'number' || !Number.isFinite(value) || (value !== 0 && value < 1)) return fail();
  return value > Number.MAX_VALUE / 1e6 ? value : Math.round(value * 1e6) / 1e6;
}
function color(value: unknown): number[] {
  if (!Array.isArray(value) || value.length !== 3) return fail();
  return value.map(unit);
}
function scalar(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fail();
  return Math.abs(value) > Number.MAX_VALUE / 1e6 ? value : Math.round(value * 1e6) / 1e6;
}
function emissiveStrength(value: unknown): number {
  if (typeof value !== 'number' || value < 0) return fail();
  return scalar(value);
}
const fields: Record<string, Record<string, (value: unknown) => unknown>> = {
  KHR_materials_unlit: {},
  KHR_materials_clearcoat: { clearcoatFactor: unit, clearcoatRoughnessFactor: unit },
  KHR_materials_ior: { ior },
  KHR_materials_transmission: { transmissionFactor: unit },
  KHR_materials_sheen: { sheenColorFactor: color, sheenRoughnessFactor: unit },
  KHR_materials_specular: { specularFactor: unit, specularColorFactor: color },
  KHR_materials_emissive_strength: { emissiveStrength },
  KHR_materials_anisotropy: { anisotropyStrength: unit, anisotropyRotation: scalar },
};
function validateExtension(name: string, value: unknown): void {
  if (!record(value)) return fail();
  if (!Object.hasOwn(fields, name)) return fail();
  for (const [key, raw] of Object.entries(value)) {
    if (!Object.hasOwn(fields[name]!, key)) return fail();
    fields[name]![key]!(raw);
  }
}

/** 先核原始JSON，避免loader静默丢弃未知键后再错误地证明“相同”。 */
export function validateFrontendMaterialExtensions(
  json: Record<string, unknown>,
  staticFbxOutput = false,
): Set<object> {
  const materials = new Set(array(json.materials).map(object)),
    declared = new Set(array(json.extensionsUsed));
  for (const material of materials) {
    if (material.extensions === undefined) continue;
    if (!record(material.extensions)) return fail();
    for (const [name, value] of Object.entries(material.extensions)) {
      if (!declared.has(name)) return fail();
      // 新GLB材料族不自动扩大FBX专用输出证明；FBX仍须另取原来源和逐项效果证据。
      if (staticFbxOutput && ['KHR_materials_emissive_strength', 'KHR_materials_anisotropy'].includes(name))
        return fail();
      if (staticFbxOutput && name === 'KHR_materials_specular') validateFbxSpecular(value);
      else validateExtension(name, value);
    }
  }
  return materials;
}
function validateFbxSpecular(value: unknown): void {
  // FBX独立证明仍只接受已验单标量；GLB的标量/颜色扩展另由逐面身份核实，不能混用边界。
  if (!record(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'specularFactor'))
    return fail();
  unit(value.specularFactor);
}

type MaterialDefaults = {
  specular?: boolean;
  ior?: boolean;
  emissiveStrength?: boolean;
  anisotropy?: boolean;
};
function emissiveAnisotropySignature(
  extension: ReturnType<Material['listExtensions']>[number],
  defaults: MaterialDefaults,
): unknown {
  const name = extension.extensionName;
  if (name === 'KHR_materials_emissive_strength') {
    const strength = emissiveStrength((extension as EmissiveStrength).getEmissiveStrength());
    // 只有1是无扩展的核心默认；0被省略后会发光，不能把丢值当等价。
    return defaults.emissiveStrength && strength === 1 ? null : { name, strength };
  }
  if (name === 'KHR_materials_anisotropy') {
    const anisotropy = extension as Anisotropy;
    if (anisotropy.getAnisotropyTexture()) return fail();
    const strength = unit(anisotropy.getAnisotropyStrength()),
      rotation = scalar(anisotropy.getAnisotropyRotation());
    // 强度为0时没有各向异性，旋转不产生效果；仅此前端比较器采用该等价。
    return defaults.anisotropy && strength === 0 ? null : { name, strength, rotation };
  }
}
function specularSignature(specular: Specular, defaults: MaterialDefaults): unknown {
  if (specular.getSpecularTexture() || specular.getSpecularColorTexture()) return fail();
  const factor = unit(specular.getSpecularFactor()),
    value = color(specular.getSpecularColorFactor());
  // 只有强度1且白色才等同核心默认；factor=0被省略会变成1，仍是必须拒绝的失真。
  return defaults.specular && factor === 1 && value.every((component) => component === 1)
    ? null
    : { name: 'KHR_materials_specular', factor, color: value };
}

/** 有向表面的材料身份包含扩展及其值；丢失扩展、换材质或改标量都不能通过。 */
export function frontendMaterialExtensions(material: Material, defaults: MaterialDefaults = {}): unknown[] {
  return material
    .listExtensions()
    .sort((a, b) => a.extensionName.localeCompare(b.extensionName))
    .map((extension) => {
      const name = extension.extensionName;
      const added = emissiveAnisotropySignature(extension, defaults);
      if (added !== undefined) return added;
      if (name === 'KHR_materials_unlit') return { name };
      if (name === 'KHR_materials_ior') {
        const value = ior((extension as IOR).getIOR());
        // glTF核心材质的默认IOR就是1.5；原引擎可省略等效扩展，不能误判为效果丢失。
        // 默认保留历史签名；只有明确选择效果等价的比较器才省略标准默认扩展。
        return defaults.ior && value === 1.5 ? null : { name, ior: value };
      }
      if (name === 'KHR_materials_transmission') {
        const transmission = extension as Transmission;
        if (transmission.getTransmissionTexture()) return fail();
        return { name, factor: unit(transmission.getTransmissionFactor()) };
      }
      if (name === 'KHR_materials_sheen') {
        const sheen = extension as Sheen;
        if (sheen.getSheenColorTexture() || sheen.getSheenRoughnessTexture()) return fail();
        return {
          name,
          color: color(sheen.getSheenColorFactor()),
          roughness: unit(sheen.getSheenRoughnessFactor()),
        };
      }
      if (name === 'KHR_materials_specular') {
        return specularSignature(extension as Specular, defaults);
      }
      if (name !== 'KHR_materials_clearcoat') return fail();
      const clearcoat = extension as Clearcoat;
      if (
        clearcoat.getClearcoatTexture() ||
        clearcoat.getClearcoatRoughnessTexture() ||
        clearcoat.getClearcoatNormalTexture()
      )
        return fail();
      return {
        name,
        factor: unit(clearcoat.getClearcoatFactor()),
        roughness: unit(clearcoat.getClearcoatRoughnessFactor()),
      };
    })
    .filter((value) => value !== null);
}
