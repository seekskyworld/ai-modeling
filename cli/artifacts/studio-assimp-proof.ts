/** 不用逐帧拟合：核对源节点/轨道/绑定矩阵，再核对明确的网页全局轴向与原始mesh底部pivot。 */
import type { AnimationChannel, AnimationSampler, Document, Mesh, Node, Root } from '@gltf-transform/core';
import { mat4 } from 'gl-matrix';
import { frontendFail as fail, readFrontendDocument } from './studio-assimp-normalize.ts';
import { verifyFrontendSurface } from './studio-assimp-surface.ts';
import { studioAssimpHash } from './studio-assimp-assets.ts';
import { frontendAssetAigc } from './studio-assimp-json.ts';
import {
  isStudioFrontendMetadata,
  effectiveFrontendGeometryMetadata,
  type StudioFrontendMetadata,
} from '../../studio/contracts/frontend-export.ts';
import { prepareFrontendEdits, supportsStaticFrontendWorld } from './studio-frontend-edits.ts';
import { verifyFrontendDeletedMeshes } from './studio-frontend-deleted.ts';
import { staticFrontendWorld, type FrontendStaticWorld } from './studio-frontend-world.ts';

export type { StudioFrontendMetadata } from '../../studio/contracts/frontend-export.ts';
export function validateFrontendMetadata(value: StudioFrontendMetadata): void {
  if (!isStudioFrontendMetadata(value))
    return fail(
      'Frontend export needs an explicit supported axis, boolean pivot and optional bounded material factors.',
    );
}
function verifyVisibleScene(root: Root, allowedDetached = new Set<Mesh>()): void {
  const scene = root.listScenes()[0],
    pending = [...(scene?.listChildren() ?? [])],
    reachable = new Set<Node>();
  while (pending.length) {
    const node = pending.pop()!;
    if (reachable.has(node)) continue;
    reachable.add(node);
    pending.push(...node.listChildren());
  }
  if (!reachable.size || root.listNodes().some((node) => !reachable.has(node)))
    return fail('Every verified node must be reachable from the single exported scene.');
  const meshes = new Set([...reachable].map((node) => node.getMesh())),
    skins = new Set([...reachable].map((node) => node.getSkin()));
  if (
    root.listMeshes().some((mesh) => !meshes.has(mesh) && !allowedDetached.has(mesh)) ||
    root.listSkins().some((skin) => !skins.has(skin))
  )
    return fail('Detached meshes or skeletons cannot be excluded from frontend verification.');
}
function nodes(root: Root, source: boolean): Map<string, Node> {
  const map = new Map<string, Node>();
  for (const node of root.listNodes()) {
    const name = node.getName();
    if (!name && !source) {
      if (node.getMesh() || node.getSkin())
        return fail('An unnamed added mesh or skin cannot be omitted from verification.');
      continue;
    }
    if (!name || map.has(name))
      return fail('Source node names must be nonempty and unique for preservation proof.');
    map.set(name, node);
  }
  return map;
}
function maximumDifference(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return Infinity;
  let maximum = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) return Infinity;
    maximum = Math.max(maximum, Math.abs(a[i]! - b[i]!));
  }
  return maximum;
}
function expectedTransform(
  root: Root,
  metadata: StudioFrontendMetadata,
  world?: FrontendStaticWorld,
): { matrix: mat4; extent: number; pivot: number[] } {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  let vertices = 0;
  // 此定制引擎按mesh原始坐标包围盒计算pivot；既有节点变换另由完整层级证明保留。
  for (const mesh of root.listMeshes())
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute('POSITION');
      if (!position) return fail('A mesh is missing POSITION.');
      vertices += position.getCount();
      if (vertices > 200000) return fail('Frontend proof supports at most 200000 source vertices.');
      for (let i = 0; i < position.getCount(); i++) {
        const point = position.getElement(i, []);
        for (let axis = 0; axis < 3; axis++) {
          min[axis] = Math.min(min[axis]!, point[axis]!);
          max[axis] = Math.max(max[axis]!, point[axis]!);
        }
      }
    }
  const extent = world?.bounds.extent ?? Math.max(...max.map((v, i) => v - min[i]!));
  if (!Number.isFinite(extent) || extent <= 0) return fail('Frontend source has no finite spatial extent.');
  const pivot = world?.bounds.pivot ?? [(min[0]! + max[0]!) / 2, min[1]!, (min[2]! + max[2]!) / 2],
    matrix = mat4.create();
  // 网页引擎的 +x 不是单位旋转：原生四向探针确认 +x=π、-x=0、+y=π/2、-y=-π/2。
  const angle = { '+x': Math.PI, '-x': 0, '+y': Math.PI / 2, '-y': -Math.PI / 2 }[metadata.forward_axis];
  mat4.rotateY(matrix, matrix, angle);
  if (metadata.pivot_to_center_bottom)
    mat4.translate(
      matrix,
      matrix,
      pivot.map((v) => -v),
    );
  return { matrix, extent, pivot };
}
function verifyNodes(
  source: Map<string, Node>,
  target: Map<string, Node>,
  matrix: mat4,
  tolerance: number,
  preserveTransforms: boolean,
): number {
  let maximum = 0;
  for (const [name, node] of source) {
    const other = target.get(name);
    if (
      !other ||
      Boolean(node.getMesh()) !== Boolean(other.getMesh()) ||
      Boolean(node.getSkin()) !== Boolean(other.getSkin())
    )
      return fail('The frontend engine lost or changed a source node, mesh or skin.');
    if (preserveTransforms && maximumDifference(node.getMatrix(), other.getMatrix()) > 2e-6)
      return fail('The frontend engine changed an original local node transform.');
    const expected = Array.from(mat4.multiply(mat4.create(), matrix, node.getWorldMatrix()));
    const error = maximumDifference(expected, other.getWorldMatrix());
    if (preserveTransforms && error > tolerance)
      return fail('Frontend axis or pivot differs from the explicitly requested transform.');
    if (preserveTransforms) maximum = Math.max(maximum, error);
    const parent = node.getParentNode();
    if (preserveTransforms && parent && other.getParentNode()?.getName() !== parent.getName())
      return fail('The frontend engine changed the original parent-child hierarchy.');
  }
  for (const [name, node] of target)
    if (!source.has(name) && (node.getMesh() || node.getSkin()))
      return fail('The frontend engine introduced an unverified mesh or skeleton.');
  return maximum;
}
function verifySkin(a: Node, b: Node): void {
  const source = a.getSkin(),
    target = b.getSkin();
  if (!source && !target) return;
  if (!source || !target || !source.getInverseBindMatrices() || !target.getInverseBindMatrices())
    return fail('Skin inverse-bind matrices must be explicit.');
  for (const [i, joint] of target.listJoints().entries()) {
    const index = source.listJoints().findIndex((node) => node.getName() === joint.getName());
    if (
      index < 0 ||
      maximumDifference(
        source.getInverseBindMatrices()!.getElement(index, []),
        target.getInverseBindMatrices()!.getElement(i, []),
      ) > 1e-6
    )
      return fail('The frontend engine changed a weighted joint or inverse-bind matrix.');
  }
}
function channelKey(channel: AnimationChannel): string {
  return `${channel.getTargetNode()?.getName()}\0${channel.getTargetPath()}`;
}
function channelSampler(channel: AnimationChannel): AnimationSampler {
  const sampler = channel.getSampler(),
    input = sampler?.getInput(),
    output = sampler?.getOutput(),
    cubic = sampler?.getInterpolation() === 'CUBICSPLINE';
  if (
    !sampler ||
    !input ||
    !output ||
    !['LINEAR', 'STEP', 'CUBICSPLINE'].includes(sampler.getInterpolation()) ||
    input.getType() !== 'SCALAR' ||
    output.getType() !== (channel.getTargetPath() === 'rotation' ? 'VEC4' : 'VEC3') ||
    input.getCount() * (cubic ? 3 : 1) !== output.getCount()
  )
    return fail('Frontend proof requires complete LINEAR, STEP or CUBICSPLINE TRS animation tracks.');
  return sampler;
}
function verifyChannelValues(channel: AnimationChannel, sampler: AnimationSampler): void {
  const input = sampler.getInput()!,
    output = sampler.getOutput()!,
    cubic = sampler.getInterpolation() === 'CUBICSPLINE';
  let previous = -Infinity;
  for (let i = 0; i < input.getCount(); i++) {
    const time = input.getScalar(i),
      value = output.getElement(cubic ? i * 3 + 1 : i, []);
    if (time < 0 || time <= previous)
      return fail('Animation times must be nonnegative and strictly increasing.');
    previous = time;
    if (channel.getTargetPath() === 'rotation' && Math.abs(Math.hypot(...value) - 1) > 0.001)
      return fail('Animation rotations contain non-unit or invalid quaternions.');
  }
}
function channels(list: AnimationChannel[]): Map<string, AnimationChannel> {
  const map = new Map<string, AnimationChannel>();
  for (const channel of list) {
    if (
      !channel.getTargetNode() ||
      !['translation', 'rotation', 'scale'].includes(channel.getTargetPath() ?? '')
    )
      return fail('Frontend proof only accepts named TRS animation channels.');
    const key = channelKey(channel);
    if (map.has(key)) return fail('Duplicate animation channels are ambiguous.');
    verifyChannelValues(channel, channelSampler(channel));
    map.set(key, channel);
  }
  return map;
}
function constantChannel(channel: AnimationChannel, source: Node): boolean {
  const expected =
    channel.getTargetPath() === 'rotation'
      ? source.getRotation()
      : channel.getTargetPath() === 'translation'
        ? source.getTranslation()
        : source.getScale();
  const output = channel.getSampler()!.getOutput()!;
  for (let i = 0; i < output.getCount(); i++)
    if (maximumDifference(expected, output.getElement(i, [])) > 2e-6) return false;
  return true;
}
function timeRange(list: AnimationChannel[]): number[] {
  let min = Infinity,
    max = -Infinity;
  for (const channel of list) {
    const input = channel.getSampler()!.getInput()!;
    for (let i = 0; i < input.getCount(); i++) {
      min = Math.min(min, input.getScalar(i));
      max = Math.max(max, input.getScalar(i));
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max))
    return fail('Animation clips must contain finite keyframes.');
  return [min, max];
}
function verifyAnimations(source: Root, target: Root, named: Map<string, Node>): Record<string, unknown>[] {
  const original = source.listAnimations(),
    output = target.listAnimations();
  if (original.length !== output.length || new Set(original.map((a) => a.getName())).size !== original.length)
    return fail('Frontend export changed clip names or counts.');
  return original.map((animation) => {
    const other = output.find((a) => a.getName() === animation.getName());
    if (!other) return fail('The frontend engine lost an animation clip.');
    const a = channels(animation.listChannels()),
      b = channels(other.listChannels());
    const sourceRange = timeRange(animation.listChannels()),
      targetRange = timeRange(other.listChannels());
    if (maximumDifference(sourceRange, targetRange) !== 0)
      return fail('The frontend engine changed the full clip time range.');
    let maximumValueError = 0,
      extras = 0;
    for (const [key, sourceChannel] of a) {
      const targetChannel = b.get(key),
        from = sourceChannel.getSampler()!,
        to = targetChannel?.getSampler();
      if (
        !to ||
        from.getInterpolation() !== to.getInterpolation() ||
        from.getInput()!.getCount() !== to.getInput()!.getCount()
      )
        return fail('The frontend engine changed animation samples or interpolation.');
      for (let i = 0; i < from.getInput()!.getCount(); i++) {
        if (from.getInput()!.getScalar(i) !== to.getInput()!.getScalar(i))
          return fail('The frontend engine changed a keyframe time.');
      }
      // 三次样条包含入切线/关键值/出切线，三者全部逐元素比较，不能只检查端点。
      for (let i = 0; i < from.getOutput()!.getCount(); i++) {
        const error = maximumDifference(
          from.getOutput()!.getElement(i, []),
          to.getOutput()!.getElement(i, []),
        );
        if (error > 2e-6) return fail('The frontend engine changed an animation sample or root motion.');
        maximumValueError = Math.max(maximumValueError, error);
      }
    }
    for (const [key, channel] of b)
      if (!a.has(key)) {
        const sourceNode = named.get(channel.getTargetNode()!.getName());
        if (!sourceNode || !constantChannel(channel, sourceNode))
          return fail('An added animation track changes the source rest transform.');
        extras++;
      }
    return {
      name: animation.getName(),
      original_channels: a.size,
      output_channels: b.size,
      added_constant_channels: extras,
      keyframe_times_exact: true,
      maximum_value_error: maximumValueError,
      time_range: sourceRange,
    };
  });
}
function editedSource(sourceBytes: Buffer, original: Document, metadata: StudioFrontendMetadata) {
  return Object.keys(effectiveFrontendGeometryMetadata(metadata)).length ||
    supportsStaticFrontendWorld(original)
    ? prepareFrontendEdits(sourceBytes, metadata)
    : undefined;
}
function originalStaticWorld(
  document: Document,
  metadata: StudioFrontendMetadata,
  edited: boolean,
): FrontendStaticWorld | undefined {
  return !edited &&
    metadata.pivot_to_center_bottom &&
    !Object.keys(effectiveFrontendGeometryMetadata(metadata)).length
    ? staticFrontendWorld(document)
    : undefined;
}
export async function verifyStudioFrontend(
  sourceBytes: Buffer,
  outputBytes: Buffer,
  metadata: StudioFrontendMetadata,
): Promise<Record<string, unknown>> {
  validateFrontendMetadata(metadata);
  const originalAigc = frontendAssetAigc(sourceBytes);
  if (originalAigc !== frontendAssetAigc(outputBytes))
    return fail('The frontend output did not preserve the exact original AIGC attribution.');
  const originalDocument = await readFrontendDocument(sourceBytes);
  verifyVisibleScene(originalDocument.getRoot());
  // 简单编辑沿用旧证明；无编辑的静态层级另核世界轴心，动画及共享实例不放宽。
  const edited = await editedSource(sourceBytes, originalDocument, metadata),
    world = originalStaticWorld(originalDocument, metadata, Boolean(edited)),
    source = (edited?.document ?? originalDocument).getRoot(),
    target = (await readFrontendDocument(outputBytes, true)).getRoot(),
    a = nodes(source, true),
    b = nodes(target, false),
    transform = expectedTransform(source, metadata, world),
    animated = source.listSkins().length > 0 || source.listAnimations().length > 0,
    tolerance = Math.max(1, transform.extent) * 2e-5;
  verifyVisibleScene(source);
  const detached = verifyFrontendDeletedMeshes(originalDocument.getRoot(), target, metadata);
  verifyVisibleScene(target, detached.allowed);
  const maximumTransformError = verifyNodes(a, b, transform.matrix, tolerance, animated),
    surfaces: unknown[] = [];
  let faces = 0;
  for (const [name, node] of a)
    if (node.getMesh()) {
      const other = b.get(name)!;
      verifySkin(node, other);
      const proofs = verifyFrontendSurface(
        node,
        other,
        Math.max(1, transform.extent) * 1e-6,
        animated ? undefined : mat4.multiply(mat4.create(), transform.matrix, node.getWorldMatrix()),
        animated ? undefined : other.getWorldMatrix(),
        metadata.material_factor,
      );
      faces += proofs.reduce((sum, proof) => sum + proof.faces, 0);
      if (faces + detached.faces > 100000)
        return fail('Frontend proof exceeds the total 100000 triangle budget.');
      surfaces.push({
        node: name,
        primitives: proofs,
        original_skin_joints: node.getSkin()?.listJoints().length ?? 0,
        output_skin_joints: other.getSkin()?.listJoints().length ?? 0,
      });
    }
  const clips = verifyAnimations(source, target, a);
  return {
    version: 1,
    source_sha256: studioAssimpHash(sourceBytes),
    output_sha256: studioAssimpHash(outputBytes),
    metadata,
    ...(edited
      ? { pivot_from_editor_world_bounds: transform.pivot, editor_metadata_mapping: edited.proof }
      : world
        ? { pivot_from_static_world_bounds: transform.pivot, static_world_mapping: world.proof }
        : { pivot_from_raw_mesh_bounds: transform.pivot }),
    expected_global_matrix: Array.from(transform.matrix),
    maximum_transform_error: maximumTransformError,
    transform_representation: animated ? 'additional_root_transform' : 'verified_world_surface_bake',
    source_nodes_preserved: a.size,
    faces,
    surfaces,
    clips,
    ...(detached.proof.length
      ? { deleted_meshes_retained_by_webpage: detached.proof, retained_unreferenced_faces: detached.faces }
      : {}),
    ...(metadata.material_factor
      ? {
          material_factor_mapping: {
            applied_to_all_source_materials: true,
            ...metadata.material_factor,
            effect:
              'Webpage is_pbr metadata overrides metallic/roughness factors; no texture baking or re-encoding.',
          },
        }
      : {}),
    ...(originalAigc !== undefined
      ? { original_asset_aigc_preserved: true, aigc_sha256: studioAssimpHash(Buffer.from(originalAigc)) }
      : {}),
    claim:
      'Verified oriented mesh surfaces, material/image values, named weighted joints, inverse binds and original TRS tracks; extra tracks must be constant. Root axis/pivot are explicit; node hierarchy and binary encoding need not be byte-identical.',
  };
}
