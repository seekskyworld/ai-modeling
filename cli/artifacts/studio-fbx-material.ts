/** 网页原 Assimp 的有限 Lambert/Phong 标量映射；已知有损行为显式披露，未知字段另需证明。 */
import { singleNode, type FbxNode, type FbxValue } from '../../studio/fbx/structure.ts';
import { frontendFail as fail } from './studio-assimp-normalize.ts';
import type { StaticFbxTexture } from './studio-fbx-texture.ts';

export interface StaticFbxMaterial {
  name: string;
  shading: 'default' | 'lambert' | 'phong';
  color: [number, number, number, number];
  emissive: [number, number, number];
  roughness: number;
  extensions?: { KHR_materials_specular?: { specularFactor: number }; KHR_materials_ior?: { ior: number } };
  source_properties: Record<string, FbxValue[]>;
  texture?: StaticFbxTexture;
}
export const defaultFbxMaterial = (): StaticFbxMaterial => ({
  name: 'DefaultMaterial',
  shading: 'default',
  color: [0.8, 0.8, 0.8, 1],
  emissive: [0, 0, 0],
  roughness: 1,
  source_properties: {},
});
const numericFields = new Set([
  'EmissiveColor',
  'EmissiveFactor',
  'AmbientColor',
  'AmbientFactor',
  'DiffuseColor',
  'DiffuseFactor',
  'TransparentColor',
  'TransparencyFactor',
  'Opacity',
  'NormalMap',
  'Bump',
  'BumpFactor',
  'DisplacementColor',
  'DisplacementFactor',
  'VectorDisplacementColor',
  'VectorDisplacementFactor',
  'SpecularColor',
  'SpecularFactor',
  'Shininess',
  'ShininessExponent',
  'ReflectionColor',
  'ReflectionFactor',
  'Emissive',
  'Ambient',
  'Diffuse',
  'MultiLayer',
]);
export function fbxMaterialProperties(node: FbxNode | undefined): Map<string, FbxValue[]> {
  const result = new Map<string, FbxValue[]>();
  for (const property of singleNode(node?.children ?? [], 'Properties70')?.children ?? []) {
    const [name, , , flags] = property.properties,
      values = property.properties.slice(4);
    if (
      property.name !== 'P' ||
      typeof name !== 'string' ||
      property.children.length ||
      result.has(name) ||
      (typeof flags === 'string' && flags.includes('U')) ||
      (!numericFields.has(name) && name !== 'ShadingModel')
    )
      return fail('FBX material contains repeated, custom or unverified properties.');
    if (name === 'ShadingModel') {
      if (values.length !== 1 || !['phong', 'lambert'].includes(String(values[0]).toLowerCase()))
        return fail('FBX material shader is outside the observed Lambert/Phong subset.');
    } else if (!values.length || values.some((value) => typeof value !== 'number' || !Number.isFinite(value)))
      return fail('FBX material properties require finite scalar/color values.');
    result.set(name, values);
  }
  return result;
}
function scalar(properties: Map<string, FbxValue[]>, name: string, fallback: number, maximum = 1): number {
  const raw = properties.get(name) ?? [fallback];
  if (raw.length !== 1 || typeof raw[0] !== 'number' || raw[0] < 0 || raw[0] > maximum)
    return fail('FBX material scalar is outside its verified range.');
  return raw[0];
}
function color(
  properties: Map<string, FbxValue[]>,
  name: string,
  fallback: number[],
): [number, number, number] {
  const raw = properties.get(name) ?? fallback;
  if (raw.length !== 3 || raw.some((value) => typeof value !== 'number' || value < 0 || value > 1))
    return fail('FBX material color is outside its verified range.');
  return raw as [number, number, number];
}
function inactiveChannels(properties: Map<string, FbxValue[]>): void {
  for (const name of [
    'NormalMap',
    'Bump',
    'DisplacementColor',
    'VectorDisplacementColor',
    'TransparentColor',
  ])
    if (color(properties, name, [0, 0, 0]).some((value) => value !== 0))
      return fail('FBX material contains unverified normal, displacement or transparency channels.');
  for (const name of ['BumpFactor', 'DisplacementFactor', 'VectorDisplacementFactor', 'AmbientFactor'])
    scalar(properties, name, 1);
  color(properties, 'AmbientColor', [0.2, 0.2, 0.2]);
  if (scalar(properties, 'MultiLayer', 0) !== 0 || scalar(properties, 'TransparencyFactor', 0) !== 0)
    return fail('FBX layered or colored transparency needs its own export mapping.');
  const reflection = color(properties, 'ReflectionColor', [0, 0, 0]),
    factor = scalar(properties, 'ReflectionFactor', 1);
  if (reflection.some((value) => value * factor !== 0))
    return fail('FBX reflection channels require a separate webpage material proof.');
}
function aliases(properties: Map<string, FbxValue[]>): void {
  for (const [alias, canonical] of [
    ['Diffuse', 'DiffuseColor'],
    ['Emissive', 'EmissiveColor'],
    ['Ambient', 'AmbientColor'],
  ]) {
    if (!properties.has(alias!)) continue;
    const value = color(properties, alias!, [0, 0, 0]),
      expected = color(properties, canonical!, [0, 0, 0]);
    if (value.some((item, i) => Math.abs(item - expected[i]!) > 1e-7))
      return fail('FBX legacy material aliases disagree with the canonical color.');
  }
}
function phongExtensions(properties: Map<string, FbxValue[]>): NonNullable<StaticFbxMaterial['extensions']> {
  // 固定原网页引擎实测忽略 SpecularColor，只读取 Float32 SpecularFactor；缺省为0.25。
  // 小于0.25映射specularFactor=4f，大于0.25用F0=0.16*min(f,0.5)换算IOR，RGB损失在证明中披露。
  color(properties, 'SpecularColor', [0.2, 0.2, 0.2]);
  const factor = Math.fround(scalar(properties, 'SpecularFactor', 0.25));
  if (factor < 0.25) return { KHR_materials_specular: { specularFactor: Math.fround(4 * factor) } };
  if (factor > 0.25) {
    const rootReflectance = Math.sqrt(0.16 * Math.min(factor, 0.5));
    return { KHR_materials_ior: { ior: (1 + rootReflectance) / (1 - rootReflectance) } };
  }
  return {};
}
export function readStaticFbxMaterial(node: FbxNode, defaults?: Map<string, FbxValue[]>): StaticFbxMaterial {
  if (
    node.children.some(
      (entry) => !['Version', 'ShadingModel', 'MultiLayer', 'Properties70'].includes(entry.name),
    )
  )
    return fail('FBX material has unverified shader structures.');
  const name = node.properties[1],
    shading = String(singleNode(node.children, 'ShadingModel')?.properties[0]).toLowerCase();
  if (typeof name !== 'string' || !name || name.length > 128 || !['phong', 'lambert'].includes(shading))
    return fail('FBX scalar material name or shader is invalid.');
  const directLayer = singleNode(node.children, 'MultiLayer');
  if (directLayer && directLayer.properties[0] !== 0) return fail('FBX layered shaders are not verified.');
  const properties = new Map([...(defaults ?? []), ...fbxMaterialProperties(node)]);
  if (properties.has('ShadingModel') && String(properties.get('ShadingModel')![0]).toLowerCase() !== shading)
    return fail('FBX shader declarations do not agree.');
  aliases(properties);
  inactiveChannels(properties);
  const diffuse = color(properties, 'DiffuseColor', [0.8, 0.8, 0.8]),
    diffuseFactor = scalar(properties, 'DiffuseFactor', 1),
    emissive = color(properties, 'EmissiveColor', [0, 0, 0]),
    emissiveFactor = scalar(properties, 'EmissiveFactor', 1);
  let roughness = 1;
  let extensions: StaticFbxMaterial['extensions'];
  if (shading === 'phong') {
    const shininess = scalar(properties, 'Shininess', 20, 100);
    if (scalar(properties, 'ShininessExponent', shininess, 100) !== shininess)
      return fail('FBX shininess declarations differ.');
    extensions = phongExtensions(properties);
    roughness = 1 - Math.sqrt(shininess) / 10;
  } else if (
    ['SpecularColor', 'SpecularFactor', 'Shininess', 'ShininessExponent'].some((key) => properties.has(key))
  )
    return fail('Lambert material cannot hide Phong channels.');
  return {
    name,
    shading: shading as 'phong' | 'lambert',
    color: [...diffuse.map((value) => value * diffuseFactor), scalar(properties, 'Opacity', 1)] as [
      number,
      number,
      number,
      number,
    ],
    emissive: emissive.map((value) => value * emissiveFactor) as [number, number, number],
    roughness,
    ...(extensions ? { extensions } : {}),
    source_properties: Object.fromEntries(properties),
  };
}
