/** 已属于 Studio 的独立 root 来源；冻结原世界基矩阵及完整可解释外观。 */
import { createHash } from 'node:crypto';
import type { Node, Primitive } from '@gltf-transform/core';
import { array, object, TripoError } from '../../studio/contracts/errors.ts';
import { checkedMetadataTransform } from './smartsegment-transform-matrix.ts';

const fail = (message: string): never => {
  throw new TripoError('SMARTSEGMENT_TRANSFORM_UNVERIFIED', message, 'not_submitted');
};
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export function validateScaleReferenceShape(json: Record<string, unknown>): void {
  const nodes = array(json.nodes).map(object),
    meshes = array(json.meshes).map(object),
    names = nodes.map((n) => n.name);
  if (
    names.some((name) => typeof name !== 'string' || !name.trim()) ||
    new Set(names).size !== nodes.length ||
    new Set(nodes.map((node) => node.mesh)).size !== nodes.length ||
    meshes.length !== nodes.length ||
    meshes.some((mesh) => array(mesh.primitives).length !== 1)
  )
    fail('Metadata reference requires unique named independent roots with one uninstanced primitive each.');
  for (const node of nodes) validateRawReferenceTransform(node);
  validateReferenceMaterials(json);
}

function validateRawReferenceTransform(node: Record<string, unknown>): void {
  if (node.matrix !== undefined) checkedMetadataTransform(node.matrix);
  const rotation = node.rotation;
  if (
    rotation !== undefined &&
    (!Array.isArray(rotation) || Math.abs(Math.hypot(...rotation.map(Number)) - 1) > 1e-7)
  )
    fail('Metadata reference rotations require complete normalized quaternions.');
}

function validateReferenceMaterials(json: Record<string, unknown>): void {
  const materials = array(json.materials).map(object),
    textures = array(json.textures).map(object),
    images = array(json.images).map(object);
  if (materials.length > 64 || textures.length > 64 || images.length > 64)
    fail('Metadata reference appearance is bounded to 64 scalar materials and embedded base-color images.');
  for (const material of materials) validateReferenceMaterial(material);
  if (
    textures.some((texture) => texture.extensions !== undefined) ||
    images.some((image) => image.uri !== undefined || image.extensions !== undefined)
  )
    fail('Metadata reference images must be embedded without unverified texture or image extensions.');
}

function validateReferenceMaterial(material: Record<string, unknown>): void {
  const pbr = object(material.pbrMetallicRoughness);
  if (
    material.extensions !== undefined ||
    material.normalTexture !== undefined ||
    material.occlusionTexture !== undefined ||
    material.emissiveTexture !== undefined ||
    pbr.metallicRoughnessTexture !== undefined ||
    object(pbr.baseColorTexture).extensions !== undefined ||
    (object(pbr.baseColorTexture).texCoord ?? 0) !== 0 ||
    (material.alphaMode ?? 'OPAQUE') !== 'OPAQUE'
  )
    fail('Metadata reference supports opaque scalar materials with embedded base-color JPEG/PNG and UV0.');
}

export function scaleReferenceWorld(node: Node, raw: Record<string, unknown>): number[] {
  const world = node.getWorldMatrix();
  checkedMetadataTransform(world);
  if (Array.isArray(raw.matrix)) {
    const scale = Math.max(1, ...world.map(Math.abs));
    if (raw.matrix.some((value, index) => Math.abs(Number(value) - world[index]!) > scale * 1e-7))
      fail('A metadata reference matrix changed while decoding; no decomposed replacement is accepted.');
  }
  return world;
}

export function scaleReferenceAppearance(primitive: Primitive): Record<string, unknown> {
  const material = primitive.getMaterial(),
    texture = material?.getBaseColorTexture(),
    info = material?.getBaseColorTextureInfo();
  if (texture && (!texture.getImage() || !['image/jpeg', 'image/png'].includes(texture.getMimeType())))
    return fail('Metadata reference base-color requires complete embedded JPEG or PNG bytes.');
  const factors = material
    ? {
        base: material.getBaseColorFactor(),
        metallic: material.getMetallicFactor(),
        roughness: material.getRoughnessFactor(),
        emissive: material.getEmissiveFactor(),
        double_sided: material.getDoubleSided(),
        alpha_mode: material.getAlphaMode(),
        alpha_cutoff: material.getAlphaCutoff(),
      }
    : null;
  if (
    factors &&
    [...factors.base, factors.metallic, factors.roughness, ...factors.emissive, factors.alpha_cutoff].some(
      (value) => !Number.isFinite(value) || value < 0 || value > 1,
    )
  )
    return fail('Metadata reference scalar material factors must be finite values in the unit interval.');
  return {
    material: factors,
    texture: texture
      ? {
          sha256: sha256(texture.getImage()!),
          mime: texture.getMimeType(),
          bytes: texture.getImage()!.byteLength,
        }
      : null,
    sampler: info
      ? {
          uv: info.getTexCoord(),
          mag: info.getMagFilter(),
          min: info.getMinFilter(),
          s: info.getWrapS(),
          t: info.getWrapT(),
        }
      : null,
  };
}
