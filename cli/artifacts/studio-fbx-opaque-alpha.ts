/** 只解释原生导入器添加的恒定不透明别名；不改写源字节，也不接受一般透明贴图。 */
import { type FbxNode } from '../../studio/fbx/structure.ts';
import { frontendFail as fail } from './studio-assimp-normalize.ts';
import {
  fbxEmbeddedImageMime,
  fbxEmbeddedVideoBytes,
  fbxTextureProperties,
  validateFbxEmbeddedTexture,
} from './studio-fbx-texture.ts';

interface AlphaAliases {
  entries: Map<number, FbxNode>;
  links: FbxNode[];
  materials: Set<number>;
}
function id(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    return fail('Opaque FBX texture aliases require positive source object identities.');
  return value;
}
function exactLink(link: FbxNode, kind: 'OO' | 'OP', property?: string): [number, number] {
  if (
    link.name !== 'C' ||
    link.children.length ||
    link.properties[0] !== kind ||
    link.properties.length !== (kind === 'OP' ? 4 : 3) ||
    (kind === 'OP' && link.properties[3] !== property)
  )
    return fail('Opaque FBX alpha alias connections are not exact source links.');
  return [id(link.properties[1]), id(link.properties[2])];
}
function touching(links: FbxNode[], object: number): FbxNode[] {
  return links.filter((link) => link.properties[1] === object || link.properties[2] === object);
}
function videoFor(links: FbxNode[], texture: number, materialLink: FbxNode): [number, FbxNode] {
  const pair = touching(links, texture),
    incoming = pair.filter((link) => link.properties[2] === texture);
  if (pair.length !== 2 || !pair.includes(materialLink) || incoming.length !== 1)
    return fail('Opaque FBX texture aliases cannot have extra or ambiguous connections.');
  const link = incoming[0]!,
    [video] = exactLink(link, 'OO');
  return [video, link];
}
function texture(entries: Map<number, FbxNode>, textureId: number): FbxNode {
  const node = entries.get(textureId);
  if (!node || node.name !== 'Texture')
    return fail('Opaque FBX alpha alias does not reference an exact texture.');
  validateFbxEmbeddedTexture(node);
  return node;
}
function sameSampling(a: FbxNode, b: FbxNode): void {
  const first = fbxTextureProperties(a, 'Texture'),
    second = fbxTextureProperties(b, 'Texture');
  if (
    first.size !== second.size ||
    [...first].some(([name, values]) => {
      const other = second.get(name);
      return (
        !other || values.length !== other.length || values.some((value, index) => value !== other[index])
      );
    })
  )
    return fail('Opaque FBX alpha aliases require identical default UV and sampling properties.');
}
function alias(
  entries: Map<number, FbxNode>,
  links: FbxNode[],
  alphaLink: FbxNode,
): { alpha: number; material: number; removed: FbxNode[] } {
  const [alpha, material] = exactLink(alphaLink, 'OP', 'TransparencyFactor'),
    attached = links.filter((link) => link.properties[2] === material),
    diffuse = attached.filter((link) => link.properties[0] === 'OP' && link.properties[3] === 'DiffuseColor');
  if (entries.get(material)?.name !== 'Material' || attached.length !== 2 || diffuse.length !== 1)
    return fail('Opaque FBX alpha alias requires one material and exactly one diffuse texture.');
  const baseLink = diffuse[0]!,
    [base] = exactLink(baseLink, 'OP', 'DiffuseColor');
  if (base === alpha) return fail('Opaque FBX alpha aliases require two distinct texture objects.');
  sameSampling(texture(entries, base), texture(entries, alpha));
  const [baseVideo] = videoFor(links, base, baseLink),
    [alphaVideo, alphaVideoLink] = videoFor(links, alpha, alphaLink),
    video = entries.get(baseVideo);
  if (baseVideo !== alphaVideo || touching(links, baseVideo).length !== 2 || video?.name !== 'Video')
    return fail('Opaque FBX alpha aliases require the same unique embedded Video object.');
  if (fbxEmbeddedImageMime(fbxEmbeddedVideoBytes(video)) !== 'image/png')
    return fail('Opaque FBX alpha aliases are only verified for an embedded PNG.');
  return { alpha, material, removed: [alphaLink, alphaVideoLink] };
}
export function interpretFbxOpaqueAlphaAliases(
  original: Map<number, FbxNode>,
  originalLinks: FbxNode[],
): AlphaAliases {
  const alphaLinks = originalLinks.filter(
      (link) => link.properties[0] === 'OP' && link.properties[3] === 'TransparencyFactor',
    ),
    entries = new Map(original),
    materials = new Set<number>(),
    removed = new Set<FbxNode>();
  for (const alphaLink of alphaLinks) {
    const verified = alias(original, originalLinks, alphaLink);
    if (materials.has(verified.material)) return fail('Repeated FBX alpha aliases are ambiguous.');
    materials.add(verified.material);
    entries.delete(verified.alpha);
    for (const link of verified.removed) removed.add(link);
  }
  // 完整 PNG 解码和全像素 alpha=255 在最终异步证明中执行；未经证明不能授权或交付。
  return { entries, links: originalLinks.filter((link) => !removed.has(link)), materials };
}
