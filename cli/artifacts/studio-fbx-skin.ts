/** 受限静态 FBX 绑定：独立读取 Cluster 权重/矩阵及 BindPose，不从导出结果反推来源。 */
import { mat4 } from 'gl-matrix';
import { singleNode, type FbxNode } from '../../studio/fbx/structure.ts';
import { frontendFail as fail } from './studio-assimp-normalize.ts';

export type FbxWeights = [string, number][];
export function fbxWebpageWeights(source: FbxWeights): FbxWeights {
  // 原固定 Assimp 实测：先转 Float32，移除 <=1e-6 的权重，再归一化剩余项；源证明保留原值。
  const retained = source
      .map(([name, weight]): [string, number] => [name, Math.fround(weight)])
      .filter(([, weight]) => weight > Math.fround(1e-6)),
    sum = retained.reduce((total, [, weight]) => total + weight, 0);
  if (!retained.length || !Number.isFinite(sum))
    return fail('FBX webpage skin mapping has no retained weights.');
  return retained.map(([name, weight]) => [name, weight / sum]);
}
export interface FbxSourceBone {
  name: string;
  parent?: string;
  world: mat4;
  inverse_bind: mat4;
}
export interface FbxSourceSkin {
  bones: FbxSourceBone[];
  weights: Map<number, FbxWeights>;
  maximum_source_bind_error: number;
  maximum_source_weight_sum_error: number;
}
interface SkinGraph {
  entries: Map<number, FbxNode>;
  parents: Map<number, number>;
  clusterBones: Map<number, number>;
  matrices: Map<number, mat4>;
}
function array(node: FbxNode, name: string, optional = false): Float64Array {
  const field = singleNode(node.children, name),
    value = field?.properties[0];
  if (!field && optional) return new Float64Array();
  if (!field || field.children.length || field.properties.length !== 1 || !(value instanceof Float64Array))
    return fail('FBX skin arrays are missing or ambiguous.');
  return value;
}
function matrix(node: FbxNode, name: string): mat4 {
  const values = array(node, name);
  if (values.length !== 16 || values.some((value) => !Number.isFinite(value)))
    return fail('FBX skin matrices must contain exactly sixteen finite values.');
  const result = mat4.fromValues(...(Array.from(values) as Parameters<typeof mat4.fromValues>));
  if (
    Math.abs(mat4.determinant(result)) < 1e-10 ||
    values[3] !== 0 ||
    values[7] !== 0 ||
    values[11] !== 0 ||
    values[15] !== 1
  )
    return fail('FBX skin matrices must be nonsingular affine transforms.');
  return result;
}
export function fbxMatrixError(left: ArrayLike<number>, right: ArrayLike<number>): number {
  return left.length === right.length
    ? Math.max(...Array.from(left, (value, index) => Math.abs(value - right[index]!)))
    : Infinity;
}
export function validateFbxBindPoses(entries: Map<number, FbxNode>, matrices: Map<number, mat4>): void {
  const poses = [...entries.values()].filter((node) => node.name === 'Pose');
  if (poses.length !== 1) return fail('Bound FBX requires one exact static BindPose.');
  const pose = poses[0]!;
  if (
    pose.properties[2] !== 'BindPose' ||
    singleNode(pose.children, 'Type')?.properties[0] !== 'BindPose' ||
    pose.children.some((node) => !['Type', 'Version', 'NbPoseNodes', 'PoseNode'].includes(node.name))
  )
    return fail('FBX poses include an unverified rest or animated pose.');
  const nodes = pose.children.filter((node) => node.name === 'PoseNode'),
    seen = new Set<number>();
  if (
    singleNode(pose.children, 'NbPoseNodes')?.properties[0] !== nodes.length ||
    nodes.length !== matrices.size
  )
    return fail('FBX BindPose must explicitly cover every source model.');
  for (const node of nodes) {
    const id = singleNode(node.children, 'Node')?.properties[0];
    if (
      typeof id !== 'number' ||
      seen.has(id) ||
      !matrices.has(id) ||
      node.properties.length ||
      node.children.length !== 2 ||
      node.children.some((child) => !['Node', 'Matrix'].includes(child.name)) ||
      fbxMatrixError(matrix(node, 'Matrix'), matrices.get(id)!) > 2e-6
    )
      return fail('FBX BindPose differs from the explicit source model rest hierarchy.');
    seen.add(id);
  }
}
export function readFbxSkin(
  geometry: FbxNode,
  meshMatrix: mat4,
  entries: Map<number, FbxNode>,
  parents: Map<number, number>,
  clusterBones: Map<number, number>,
  matrices: Map<number, mat4>,
): FbxSourceSkin | undefined {
  const skins = [...entries].filter(
    ([id, node]) => node.name === 'Deformer' && parents.get(id) === geometry.properties[0],
  );
  if (!skins.length) return undefined;
  if (skins.length !== 1 || skins[0]![1].properties[2] !== 'Skin')
    return fail('FBX geometry requires one unambiguous Skin deformer.');
  const [skinId, skin] = skins[0]!;
  if (
    skin.children.some((node) => !['Version', 'Link_DeformAcuracy'].includes(node.name)) ||
    (singleNode(skin.children, 'Link_DeformAcuracy') &&
      singleNode(skin.children, 'Link_DeformAcuracy')!.properties[0] !== 50)
  )
    return fail('FBX Skin deformer has unverified blending settings.');
  const clusters = [...entries].filter(
    ([id, node]) => node.name === 'Deformer' && parents.get(id) === skinId,
  );
  if (!clusters.length || clusters.length > 256) return fail('FBX skin exceeds its bounded joint count.');
  const vertices = array(geometry, 'Vertices').length / 3,
    weights = new Map<number, FbxWeights>(),
    bones: FbxSourceBone[] = [],
    graph = { entries, parents, clusterBones, matrices };
  let maximumBindError = 0;
  for (const [id, cluster] of clusters) {
    const { bone, bindError } = readClusterBone(id, cluster, meshMatrix, graph, bones);
    maximumBindError = Math.max(maximumBindError, bindError);
    collectClusterWeights(cluster, bone.name, vertices, weights);
    bones.push(bone);
  }
  const maximumWeightError = validateSourceWeights(weights, vertices);
  return {
    bones,
    weights,
    maximum_source_bind_error: maximumBindError,
    maximum_source_weight_sum_error: maximumWeightError,
  };
}
function readClusterBone(
  id: number,
  cluster: FbxNode,
  meshMatrix: mat4,
  graph: SkinGraph,
  bones: FbxSourceBone[],
): { bone: FbxSourceBone; bindError: number } {
  const { entries, parents, clusterBones, matrices } = graph,
    boneId = clusterBones.get(id),
    bone = boneId === undefined ? undefined : entries.get(boneId),
    world = boneId === undefined ? undefined : matrices.get(boneId);
  if (
    cluster.properties[2] !== 'Cluster' ||
    !bone ||
    bone.properties[2] !== 'LimbNode' ||
    !world ||
    cluster.children.some(
      (node) =>
        ![
          'Version',
          'UserData',
          'Indexes',
          'Weights',
          'Transform',
          'TransformLink',
          'TransformAssociateModel',
        ].includes(node.name),
    )
  )
    return fail('FBX skin cluster does not reference an exact source limb.');
  const name = String(bone.properties[1]),
    user = singleNode(cluster.children, 'UserData');
  if (
    bones.some((item) => item.name === name) ||
    (user && (user.properties.length !== 2 || user.properties.some((value) => value !== '')))
  )
    return fail('FBX skin has repeated joints or custom cluster data.');
  const inverse = matrix(cluster, 'Transform'),
    link = matrix(cluster, 'TransformLink'),
    associate = matrix(cluster, 'TransformAssociateModel');
  const bindError = Math.max(
    fbxMatrixError(link, world),
    fbxMatrixError(mat4.multiply(mat4.create(), world, inverse), meshMatrix),
  );
  if (bindError > 2e-6 || ![...matrices.values()].some((value) => fbxMatrixError(value, associate) <= 2e-6))
    return fail('FBX cluster rest/link/associate matrices differ from the exact source hierarchy.');
  const parent = entries.get(parents.get(boneId!)!);
  return {
    bone: {
      name,
      ...(parent?.name === 'Model' ? { parent: String(parent.properties[1]) } : {}),
      world,
      inverse_bind: inverse,
    },
    bindError,
  };
}
function collectClusterWeights(
  cluster: FbxNode,
  name: string,
  vertices: number,
  weights: Map<number, FbxWeights>,
): void {
  const indices = array(cluster, 'Indexes', true),
    values = array(cluster, 'Weights', true);
  if (indices.length !== values.length || indices.length > vertices)
    return fail('FBX skin index/weight arrays are incomplete.');
  const seen = new Set<number>();
  for (let index = 0; index < indices.length; index++) {
    const vertex = indices[index]!,
      weight = values[index]!;
    if (
      !Number.isSafeInteger(vertex) ||
      vertex < 0 ||
      vertex >= vertices ||
      seen.has(vertex) ||
      !Number.isFinite(weight) ||
      weight <= 0 ||
      weight > 1
    )
      return fail('FBX skin weights are nonpositive, repeated or outside the exact vertex domain.');
    seen.add(vertex);
    const value = weights.get(vertex) ?? [];
    value.push([name, weight]);
    weights.set(vertex, value);
  }
}
function validateSourceWeights(weights: Map<number, FbxWeights>, vertices: number): number {
  if (weights.size !== vertices) return fail('FBX skin does not explicitly weight every source vertex.');
  let maximumWeightError = 0;
  for (const value of weights.values()) {
    const error = Math.abs(value.reduce((sum, [, weight]) => sum + weight, 0) - 1);
    if (value.length > 4 || error > 1e-6)
      return fail('FBX skin needs a separate weight pruning/normalization contract.');
    maximumWeightError = Math.max(maximumWeightError, error);
    value.sort(([a], [b]) => a.localeCompare(b));
  }
  return maximumWeightError;
}
