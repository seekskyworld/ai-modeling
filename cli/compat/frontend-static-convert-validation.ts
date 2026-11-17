/** 官方静态导出意图与网页引擎逐面证明绑定；不以容器mime或请求参数冒充实际纹理效果。 */
import { createHash } from 'node:crypto';
import type { Accessor, Node, Primitive, Root } from '@gltf-transform/core';
import { vec3 } from 'gl-matrix';
import sharp from '../runtime/sharp.ts';
import { array, object, text, TripoError } from '../../studio/contracts/errors.ts';
import { isStudioFrontendMetadata } from '../../studio/contracts/frontend-export.ts';
import { readFrontendDocument } from '../artifacts/studio-assimp-normalize.ts';
import { frontendSourceContainerMatches, frontendSourceMetadataMatches } from '../core/frontend-output.ts';
import { frontendStaticConvertSchema, type FrontendStaticConvertIntent } from './frontend-static-convert.ts';
import { frontendOrientationProofMatches, type FrontendOrientationMapping } from './frontend-orientation.ts';

const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
function fail(message: string): never {
  throw new TripoError('FRONTEND_CONVERT_UNVERIFIED', message, 'not_submitted');
}

function staticSurfaceProof(conversion: Record<string, unknown>): boolean {
  const surfaces = array(conversion.surfaces);
  return (
    conversion.version === 1 &&
    conversion.transform_representation === 'verified_world_surface_bake' &&
    Array.isArray(conversion.clips) &&
    conversion.clips.length === 0 &&
    Number.isSafeInteger(conversion.faces) &&
    Number(conversion.faces) >= 1 &&
    Number(conversion.faces) <= 100000 &&
    surfaces.length > 0 &&
    surfaces.every(
      (value) => object(value).original_skin_joints === 0 && object(value).output_skin_joints === 0,
    )
  );
}

function verifyProof(
  proof: Record<string, unknown>,
  bytes: Buffer,
  intent: FrontendStaticConvertIntent,
  mapping?: FrontendOrientationMapping,
): Record<string, unknown> {
  const conversion = object(proof.conversion),
    metadata = object(conversion.metadata),
    input = object(proof.input);
  if (
    proof.version !== 2 ||
    !/^[a-f0-9]{64}$/.test(text(proof.source_sha256)) ||
    hash(bytes) !== proof.output_sha256 ||
    bytes.length !== proof.output_bytes ||
    conversion.output_sha256 !== proof.output_sha256 ||
    conversion.source_sha256 !== proof.source_sha256 ||
    !frontendSourceContainerMatches(proof, conversion) ||
    (proof.source_format ?? 'glb') !== 'glb' ||
    !isStudioFrontendMetadata(metadata) ||
    !frontendSourceMetadataMatches(proof) ||
    input.format !== 'glb' ||
    input.exclude_retarget !== true ||
    (mapping
      ? mapping.export_orientation !== intent.export_orientation ||
        !frontendOrientationProofMatches(proof, mapping)
      : metadata.forward_axis !== intent.export_orientation) ||
    metadata.pivot_to_center_bottom !== intent.pivot_to_center_bottom ||
    !staticSurfaceProof(conversion)
  )
    fail('Static convert requires a matching exact GLB source/output and static world-surface proof.');
  return conversion;
}

async function verifyTextures(
  root: Root,
  intent: FrontendStaticConvertIntent,
): Promise<Record<string, unknown>[]> {
  const textures = root.listTextures(),
    expected = { JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' }[intent.texture_format],
    rows: Record<string, unknown>[] = [];
  if (textures.length > 16) fail('Static texture verification supports at most 16 embedded images.');
  for (const texture of textures) {
    const image = texture.getImage();
    if (!image || texture.getMimeType() !== `image/${expected}`)
      fail('Every existing texture must already use the requested encoding; no image is re-encoded.');
    const decoder = sharp(image, {
        failOn: 'error',
        limitInputPixels: intent.texture_size * intent.texture_size,
      }),
      metadata = await decoder.metadata().catch(() => fail('The embedded texture cannot be decoded.'));
    if (
      metadata.format !== expected ||
      metadata.width !== intent.texture_size ||
      metadata.height !== intent.texture_size ||
      (metadata.pages ?? 1) !== 1
    )
      fail('Every existing texture must have the requested encoding and exact square dimensions.');
    await decoder
      .raw()
      .toBuffer()
      .catch(() => fail('The embedded texture pixel data is incomplete.'));
    rows.push({
      mime: texture.getMimeType(),
      width: metadata.width,
      height: metadata.height,
      sha256: hash(image),
      bytes: image.length,
    });
  }
  return rows;
}

type StaticBounds = { min: number[]; max: number[]; vertices: number; corners: number };
function renderedIndex(indices: Accessor | null, corner: number, vertices: number): number {
  const index = indices ? indices.getScalar(corner) : corner;
  if (!Number.isInteger(index) || index < 0 || index >= vertices)
    fail('Static geometry contains an invalid vertex index.');
  return index;
}
function primitiveBounds(node: Node, primitive: Primitive, bounds: StaticBounds): void {
  const positions = primitive.getAttribute('POSITION'),
    indices = primitive.getIndices(),
    count = indices?.getCount() ?? positions?.getCount() ?? 0;
  if (
    !positions ||
    positions.getType() !== 'VEC3' ||
    primitive.getMode() !== 4 ||
    primitive.listTargets().length ||
    primitive.listSemantics().some((name) => /^(JOINTS|WEIGHTS)_/.test(name)) ||
    !count ||
    count % 3
  )
    fail('Static conversion requires complete triangle geometry without skin or morph data.');
  bounds.vertices += positions.getCount();
  bounds.corners += count;
  if (bounds.vertices > 200000 || bounds.corners > 300000)
    fail('Static bounds exceed the verified 200000-vertex/100000-triangle budget.');
  const matrix = node.getWorldMatrix();
  for (let corner = 0; corner < count; corner++) {
    const index = renderedIndex(indices, corner, positions.getCount());
    const point = vec3.transformMat4(vec3.create(), positions.getElement(index, []), matrix);
    for (let axis = 0; axis < 3; axis++) {
      if (!Number.isFinite(point[axis])) fail('Static world positions must be finite.');
      bounds.min[axis] = Math.min(bounds.min[axis]!, point[axis]!);
      bounds.max[axis] = Math.max(bounds.max[axis]!, point[axis]!);
    }
  }
}

function staticBounds(
  root: Root,
  conversion: Record<string, unknown>,
  intent: FrontendStaticConvertIntent,
): Record<string, unknown> {
  if (root.listSkins().length || root.listAnimations().length)
    fail('Static convert cannot strip or silently retain embedded skeletons or animation clips.');
  const bounds: StaticBounds = {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
    vertices: 0,
    corners: 0,
  };
  let meshes = 0;
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (node.getSkin()) fail('Static convert cannot retain a skinned node.');
    if (!mesh) continue;
    meshes++;
    for (const primitive of mesh.listPrimitives()) primitiveBounds(node, primitive, bounds);
  }
  const { min, max, vertices, corners } = bounds;
  if (corners / 3 !== conversion.faces || meshes !== array(conversion.surfaces).length)
    fail('Every rendered static triangle must be covered by the original surface proof.');
  const extent = Math.max(...max.map((value, axis) => value - min[axis]!)),
    bottom = [(min[0]! + max[0]!) / 2, min[1]!, (min[2]! + max[2]!) / 2],
    tolerance = Math.max(1, extent) * 2e-5;
  if (!vertices || !Number.isFinite(extent) || extent <= 0)
    fail('The static output has no finite spatial extent.');
  if (intent.pivot_to_center_bottom && bottom.some((value) => Math.abs(value) > tolerance))
    fail('The actual rendered static bottom center does not match the requested origin.');
  return {
    min,
    max,
    center_bottom: bottom,
    tolerance,
    vertices,
    rendered_corners: corners,
    mesh_instances: meshes,
    pivot_to_center_bottom: intent.pivot_to_center_bottom,
  };
}

export async function validateFrontendStaticConvert(
  proof: Record<string, unknown>,
  bytes: Buffer,
  parameters: FrontendStaticConvertIntent,
  mapping?: FrontendOrientationMapping,
): Promise<Record<string, unknown>> {
  const intent = frontendStaticConvertSchema.parse(parameters),
    conversion = verifyProof(proof, bytes, intent, mapping),
    root = (await readFrontendDocument(bytes, true)).getRoot(),
    bounds = staticBounds(root, conversion, intent),
    textures = await verifyTextures(root, intent);
  return {
    version: mapping ? 2 : 1,
    ...(mapping ? { orientation_mapping: mapping } : {}),
    method:
      'Pinned webpage static world-surface preservation plus actual rendered bounds and full embedded-image decoding; no texture conversion or animation removal.',
    static_world_bounds: bounds,
    skeletons: 0,
    clip_names: [],
    textures,
    texture_encoding: intent.texture_format,
    texture_size: intent.texture_size,
    texture_reencoding: false,
    frontend_source_sha256: text(conversion.source_sha256),
    frontend_output_sha256: text(conversion.output_sha256),
  };
}
