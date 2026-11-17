/** 验证官方候选的实际交付效果；蒙皮边界必须使用jointWorld×inverseBind，不能多乘meshWorld。 */
import { createHash } from 'node:crypto';
import type { Node, Primitive, Root } from '@gltf-transform/core';
import { mat4, vec3 } from 'gl-matrix';
import sharp from '../runtime/sharp.ts';
import { readFrontendDocument } from '../artifacts/studio-assimp-normalize.ts';
import { array, object, text, TripoError } from '../../studio/contracts/errors.ts';
import {
  effectiveFrontendGeometryMetadata,
  isStudioFrontendMetadata,
} from '../../studio/contracts/frontend-export.ts';
import { frontendSourceMetadataMatches } from '../core/frontend-output.ts';
import { frontendOrientationProofMatches, type FrontendOrientationMapping } from './frontend-orientation.ts';

function fail(message: string): never {
  throw new TripoError('FRONTEND_CONVERT_UNVERIFIED', message, 'not_submitted');
}
function verifyProof(
  proof: Record<string, unknown>,
  bytes: Buffer,
  mapping?: FrontendOrientationMapping,
): Record<string, unknown> {
  const conversion = object(proof.conversion),
    metadata = object(conversion.metadata);
  if (
    createHash('sha256').update(bytes).digest('hex') !== proof.output_sha256 ||
    bytes.length !== proof.output_bytes ||
    conversion.output_sha256 !== proof.output_sha256 ||
    conversion.source_sha256 !== proof.source_sha256 ||
    (mapping !== undefined && !frontendOrientationProofMatches(proof, mapping)) ||
    !isStudioFrontendMetadata(metadata) ||
    Object.keys(effectiveFrontendGeometryMetadata(metadata)).length > 0 ||
    (proof.version === 2
      ? !frontendSourceMetadataMatches(proof)
      : metadata.forward_axis !== '-y' ||
        metadata.pivot_to_center_bottom !== true ||
        metadata.material_factor !== undefined) ||
    conversion.transform_representation !== 'additional_root_transform'
  )
    fail('Animated convert needs the matching original source/output preservation proof.');
  return conversion;
}
function verifyAnimationProof(root: Root, conversion: Record<string, unknown>): void {
  const clips = array(conversion.clips).map(object),
    animations = root.listAnimations();
  if (!root.listSkins().length || !animations.length || clips.length !== animations.length)
    fail('This convert mapping requires embedded skeletons and animation clips.');
  for (const animation of animations) {
    const clip = clips.find((candidate) => candidate.name === animation.getName());
    if (
      !clip ||
      clip.keyframe_times_exact !== true ||
      typeof clip.maximum_value_error !== 'number' ||
      !Number.isFinite(clip.maximum_value_error) ||
      clip.maximum_value_error < 0 ||
      clip.maximum_value_error > 2e-6
    )
      fail('Every original clip must retain its keyframe times, interpolation and sampled values.');
  }
}
async function verifyTextures(root: Root): Promise<Record<string, unknown>[]> {
  const textures = root.listTextures(),
    rows: Record<string, unknown>[] = [];
  if (!textures.length || textures.length > 16)
    fail('This explicit JPEG 2048 mapping requires 1–16 existing embedded textures.');
  for (const texture of textures) {
    const bytes = texture.getImage();
    if (!bytes || texture.getMimeType() !== 'image/jpeg')
      fail('All textures must already be embedded JPEG; this path does not re-encode images.');
    const decoder = sharp(bytes, { failOn: 'error', limitInputPixels: 2048 * 2048 }),
      metadata = await decoder.metadata().catch(() => fail('The embedded JPEG cannot be decoded.'));
    if (
      metadata.format !== 'jpeg' ||
      metadata.width !== 2048 ||
      metadata.height !== 2048 ||
      (metadata.pages ?? 1) !== 1
    )
      fail('Every existing texture must be an actual single JPEG image of exactly 2048×2048.');
    await decoder
      .raw()
      .toBuffer()
      .catch(() => fail('The embedded JPEG pixel data is incomplete.'));
    rows.push({
      mime: 'image/jpeg',
      width: 2048,
      height: 2048,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    });
  }
  if (root.listMaterials().some((material) => material.listExtensions().length))
    fail('Advanced materials do not have a verified bake=false mapping.');
  return rows;
}
function skinMatrices(node: Node, primitive: Primitive): mat4[] | undefined {
  const skin = node.getSkin(),
    joints = primitive.getAttribute('JOINTS_0'),
    weights = primitive.getAttribute('WEIGHTS_0');
  if (!skin && !joints && !weights) return;
  if (!skin || !joints || !weights || !skin.getInverseBindMatrices())
    fail('The rest-pivot proof requires complete skin, weights, joints and inverse-bind matrices.');
  const inverse = skin.getInverseBindMatrices()!;
  if (inverse.getCount() !== skin.listJoints().length)
    fail('The skin inverse-bind count does not match its joints.');
  return skin.listJoints().map((joint, index) => {
    const matrix = mat4.multiply(mat4.create(), joint.getWorldMatrix(), inverse.getElement(index, []));
    if (![...matrix].every(Number.isFinite)) fail('Skin matrices must contain finite values.');
    return matrix;
  });
}
function skinnedPoint(primitive: Primitive, index: number, point: number[], matrices: mat4[]): number[] {
  const joints = primitive.getAttribute('JOINTS_0')!.getElement(index, []),
    weights = primitive.getAttribute('WEIGHTS_0')!.getElement(index, []),
    result = [0, 0, 0];
  if (
    joints.length !== 4 ||
    weights.length !== 4 ||
    Math.abs(weights.reduce((sum, value) => sum + value, 0) - 1) > 1e-4
  )
    fail('The rest-pivot proof needs four normalized skin influences per vertex.');
  for (let influence = 0; influence < 4; influence++) {
    const joint = joints[influence]!,
      weight = weights[influence]!;
    if (!Number.isInteger(joint) || !matrices[joint] || !Number.isFinite(weight) || weight < 0 || weight > 1)
      fail('A vertex contains invalid skin weights or joint indices.');
    if (!weight) continue;
    const position = vec3.transformMat4(vec3.create(), point, matrices[joint]!);
    for (let axis = 0; axis < 3; axis++) result[axis]! += position[axis]! * weight;
  }
  return result;
}
function primitivePoints(node: Node, primitive: Primitive): number[][] {
  const positions = primitive.getAttribute('POSITION');
  if (
    !positions ||
    primitive.listTargets().length ||
    primitive
      .listSemantics()
      .some(
        (semantic) => !['POSITION', 'NORMAL', 'TEXCOORD_0', 'JOINTS_0', 'WEIGHTS_0'].includes(semantic),
      ) ||
    primitive.listAttributes().some((attribute) => attribute.getCount() !== positions.getCount())
  )
    fail('Unverified vertex attributes or morph targets cannot be omitted from the rest-pivot proof.');
  const matrices = skinMatrices(node, primitive),
    world = node.getWorldMatrix(),
    points: number[][] = [];
  for (let index = 0; index < positions.getCount(); index++) {
    const point = positions.getElement(index, []);
    if (point.length !== 3 || !point.every(Number.isFinite)) fail('Position values must be finite VEC3.');
    points.push(
      matrices
        ? skinnedPoint(primitive, index, point, matrices)
        : [...vec3.transformMat4(vec3.create(), point, world)],
    );
  }
  return points;
}
function restBounds(
  root: Root,
  requireBottomCenter: boolean,
  recordPivotChoice: boolean,
): Record<string, unknown> {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  let vertices = 0,
    meshes = 0;
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    meshes++;
    for (const primitive of mesh.listPrimitives()) {
      const count = primitive.getAttribute('POSITION')?.getCount() ?? 0;
      vertices += count;
      if (!count || vertices > 200000) fail('Rest-pivot proof supports 1–200000 total rendered vertices.');
      for (const point of primitivePoints(node, primitive))
        for (let axis = 0; axis < 3; axis++) {
          if (!Number.isFinite(point[axis])) fail('Rest-pivot world positions must be finite.');
          min[axis] = Math.min(min[axis]!, point[axis]!);
          max[axis] = Math.max(max[axis]!, point[axis]!);
        }
    }
  }
  const extent = Math.max(...max.map((value, index) => value - min[index]!));
  if (!vertices || !Number.isFinite(extent) || extent <= 0) fail('The rest mesh has no spatial extent.');
  const center = [(min[0]! + max[0]!) / 2, min[1]!, (min[2]! + max[2]!) / 2],
    tolerance = Math.max(1, extent) * 2e-5;
  if (requireBottomCenter && center.some((value) => Math.abs(value) > tolerance))
    fail(
      'The webpage raw-mesh pivot does not place this source’s actual skinned rest bottom-center at the origin.',
    );
  return {
    min,
    max,
    center_bottom: center,
    tolerance,
    vertices,
    mesh_instances: meshes,
    // v1的冻结验证结果没有此字段；恢复时不得加入新默认导致原执行策略冲突。
    ...(recordPivotChoice ? { pivot_to_center_bottom: requireBottomCenter } : {}),
  };
}
export async function validateFrontendConvert(
  proof: Record<string, unknown>,
  bytes: Buffer,
  mapping?: FrontendOrientationMapping,
): Promise<Record<string, unknown>> {
  const conversion = verifyProof(proof, bytes, mapping),
    root = (await readFrontendDocument(bytes, true)).getRoot();
  verifyAnimationProof(root, conversion);
  const textures = await verifyTextures(root),
    bounds = restBounds(
      root,
      object(conversion.metadata).pivot_to_center_bottom === true,
      proof.version === 2,
    );
  return {
    version: mapping ? 2 : 1,
    ...(mapping ? { orientation_mapping: mapping } : {}),
    method:
      'Actual rest vertices use jointWorld × inverseBind × position, weighted once; animated poses retain their original root motion.',
    rest_world_bounds: bounds,
    skeletons: root.listSkins().length,
    clip_names: root.listAnimations().map((clip) => clip.getName()),
    textures,
    frontend_source_sha256: text(conversion.source_sha256),
    frontend_output_sha256: text(conversion.output_sha256),
  };
}
