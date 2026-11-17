/** JPEG只替换已完整验证为不透明的图片；保留材质透明语义，规范WebP引用需显式转成普通source。 */
import { array, object, TripoError } from '../../studio/contracts/errors.ts';
import { validateFrontendMaterialExtensions } from './studio-assimp-material.ts';

export interface JpegTextureRewrite {
  texture: number;
  source: number;
  fallback?: number;
}
const unsupported = (message: string): never => {
  throw new TripoError('TEXTURE_ENCODING_UNSUPPORTED', message, 'read');
};
const index = (value: unknown, count: number): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < count;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** 仅准入不包含额外贴图引用的明确扩展；这不是高级材质烘焙，也不删除扩展或修改其值。 */
function materialExtensions(value: unknown): boolean {
  if (value === undefined) return true;
  if (!record(value)) return false;
  return Object.entries(value).every(([name, data]) => {
    if (!record(data)) return false;
    if (name === 'KHR_materials_unlit') return Object.keys(data).length === 0;
    const scalar =
      name === 'KHR_materials_ior'
        ? { key: 'ior', minimum: 1 }
        : name === 'KHR_materials_emissive_strength'
          ? { key: 'emissiveStrength', minimum: 0 }
          : undefined;
    if (!scalar || Object.keys(data).some((key) => key !== scalar.key)) return false;
    const number = data[scalar.key];
    return (
      number === undefined ||
      (typeof number === 'number' && Number.isFinite(number) && number >= scalar.minimum)
    );
  });
}

const untexturedExtensions = new Set(['KHR_materials_specular', 'KHR_materials_anisotropy']);
const absentOrEmptyArray = (value: unknown): boolean =>
  value === undefined || (Array.isArray(value) && value.length === 0);
function validDeclarations(json: Record<string, unknown>): boolean {
  const used = json.extensionsUsed,
    required = json.extensionsRequired;
  const names = (value: unknown): boolean =>
    value === undefined ||
    (Array.isArray(value) &&
      value.every((name) => typeof name === 'string') &&
      new Set(value).size === value.length);
  return names(used) && names(required) && array(required).every((name) => array(used).includes(name));
}
function untexturedMaterial(value: unknown): boolean {
  if (!record(value)) return false;
  if (value.pbrMetallicRoughness !== undefined && !record(value.pbrMetallicRoughness)) return false;
  const pbr = object(value.pbrMetallicRoughness);
  if (
    ['normalTexture', 'occlusionTexture', 'emissiveTexture'].some((key) => value[key] !== undefined) ||
    ['baseColorTexture', 'metallicRoughnessTexture', 'extensions'].some((key) => pbr[key] !== undefined)
  )
    return false;
  // 新族只扩大零图片的准入；旧IOR下限及其它材质族保持原边界，不能借组合自动扩大。
  return materialExtensions(
    Object.fromEntries(
      Object.entries(object(value.extensions)).filter(([name]) => !untexturedExtensions.has(name)),
    ),
  );
}

/** 零图片时不做编码，完整原GLB逐字节交付；仍先检查声明、扩展原值和所有核心纹理引用。 */
function verifiedUntexturedMaterials(json: Record<string, unknown>): boolean {
  const materials = array(json.materials);
  if (
    !materials.some((value) =>
      Object.keys(object(object(value).extensions)).some((name) => untexturedExtensions.has(name)),
    ) ||
    !absentOrEmptyArray(json.images) ||
    !absentOrEmptyArray(json.textures) ||
    !validDeclarations(json) ||
    !materials.every(untexturedMaterial)
  )
    return false;
  try {
    validateFrontendMaterialExtensions(json);
    return true;
  } catch {
    return false;
  }
}

export function inspectJpegTextureLayout(
  json: Record<string, unknown>,
  images: Record<string, unknown>[],
): JpegTextureRewrite[] {
  if (
    images.some((image) => image.extensions !== undefined || image.uri !== undefined) ||
    [...array(json.extensionsUsed), ...array(json.extensionsRequired)].some((name) =>
      ['KHR_texture_basisu', 'MSFT_texture_dds', 'EXT_texture_avif'].includes(String(name)),
    )
  )
    unsupported('JPEG texture-only conversion does not support external images or special texture codecs.');
  const rewrites: JpegTextureRewrite[] = [];
  for (const [textureIndex, value] of array(json.textures).entries()) {
    const texture = object(value);
    if (texture.extensions === undefined) {
      if (!index(texture.source, images.length))
        unsupported('JPEG texture-only conversion requires valid ordinary image references.');
      continue;
    }
    const extensions = object(texture.extensions),
      webp = object(extensions.EXT_texture_webp),
      source = webp.source;
    const fallback = texture.source;
    // 双图只有在完整解码证明像素相同后才能改写；结构阶段先确保fallback是合法的核心图片。
    if (
      Object.keys(extensions).length !== 1 ||
      Object.keys(webp).length !== 1 ||
      !index(source, images.length) ||
      images[source]!.mimeType !== 'image/webp' ||
      !array(json.extensionsUsed).includes('EXT_texture_webp') ||
      (fallback === undefined
        ? !array(json.extensionsRequired).includes('EXT_texture_webp')
        : !index(fallback, images.length) ||
          !['image/png', 'image/jpeg'].includes(String(images[fallback]!.mimeType)))
    )
      unsupported(
        'JPEG conversion requires a declared WebP source and a valid core fallback or required WebP support.',
      );
    rewrites.push({
      texture: textureIndex,
      source: Number(source),
      ...(fallback === undefined ? {} : { fallback: Number(fallback) }),
    });
  }
  const untextured = verifiedUntexturedMaterials(json);
  if (
    array(json.materials).some((value) => {
      const material = object(value);
      return (
        !['OPAQUE', 'MASK', 'BLEND', undefined].includes(material.alphaMode as string) ||
        (!untextured && !materialExtensions(material.extensions))
      );
    })
  )
    unsupported(
      'JPEG conversion requires standard alpha modes and verified material extensions without new image references.',
    );
  return rewrites;
}

/** 所有源图完整解码且确认alpha=255后才应用；材质、采样器和纹理索引保持原值。 */
export function applyJpegTextureLayout(json: Record<string, unknown>, rewrites: JpegTextureRewrite[]): void {
  if (!rewrites.length) return;
  const textures = array(json.textures).map(object);
  for (const rewrite of rewrites) {
    textures[rewrite.texture]!.source = rewrite.source;
    delete textures[rewrite.texture]!.extensions;
  }
  for (const key of ['extensionsUsed', 'extensionsRequired']) {
    const remaining = array(json[key]).filter((name) => name !== 'EXT_texture_webp');
    if (remaining.length) json[key] = remaining;
    else delete json[key];
  }
}
