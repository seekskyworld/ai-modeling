/** 笔刷共用的原始部件与像素读取；使用默认场景，拒绝无法与网页部件名称对应的输入。 */
import type { Document, Node, Primitive } from '@gltf-transform/core';
import sharp from 'sharp';
import { TripoError } from '../../studio/contracts/errors.ts';
import type { Pixels } from './brush-raster.ts';

export interface BrushPart {
  name: string;
  node: Node;
  primitive: Primitive;
}
export function brushParts(document: Document): BrushPart[] {
  const parts: BrushPart[] = [],
    names = new Set<string>();
  const scene = document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0];
  scene?.traverse((node) => {
    const source = node.getMesh();
    if (!source) return;
    // 实例化 mesh/primitive，防止编辑一个部件时连带改掉共享网格的其他实例。
    const shared = source.listParents().filter((parent) => parent.propertyType === 'Node').length > 1;
    const mesh = shared ? source.clone() : source;
    if (shared) {
      for (const primitive of mesh.listPrimitives())
        mesh.removePrimitive(primitive).addPrimitive(primitive.clone());
      node.setMesh(mesh);
    }
    for (const primitive of mesh.listPrimitives()) {
      if (primitive.listParents().filter((parent) => parent.propertyType === 'Mesh').length > 1)
        mesh.removePrimitive(primitive).addPrimitive(primitive.clone());
    }
    const primitives = mesh.listPrimitives();
    primitives.forEach((primitive, index) => {
      const name =
        (node.getName() || mesh.getName() || 'mesh').replace(/[\s[\].:/]/g, '_') +
        (primitives.length > 1 ? `_${index}` : '');
      if (names.has(name)) throw new TripoError('BRUSH_PART_AMBIGUOUS', 'Use unique Studio mesh part names.');
      names.add(name);
      parts.push({ name, node, primitive });
    });
  });
  if (!parts.length) throw new TripoError('BRUSH_GEOMETRY', 'Model has no mesh parts.');
  return parts;
}
export async function brushPixels(bytes: Uint8Array): Promise<Pixels> {
  const result = await sharp(bytes, { limitInputPixels: 4096 * 4096 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: result.data, width: result.info.width, height: result.info.height };
}
export async function brushTexture(part: BrushPart): Promise<Pixels> {
  const material = part.primitive.getMaterial(),
    texture = material?.getBaseColorTexture();
  const info = material?.getBaseColorTextureInfo();
  if (!texture?.getImage())
    throw new TripoError('BRUSH_TEXTURE_MISSING', 'Magic Brush requires an existing color texture.');
  if (info?.getTexCoord() !== 0 || info.listExtensions().length)
    throw new TripoError(
      'BRUSH_TEXTURE_COORDINATES',
      'Use the original Studio UV0 texture without texture-transform extensions.',
    );
  return await brushPixels(texture.getImage()!);
}
