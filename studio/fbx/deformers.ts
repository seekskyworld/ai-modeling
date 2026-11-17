/** 骨架/形变只改变顶点姿态；只有被 Cluster 提升为 Bone 的 Model 会退出网页 Mesh 统计。 */
import { singleNode, type FbxNode } from './structure.ts';

export interface FbxConnection {
  child: number;
  parent: number;
  relationship?: string;
}

function numeric(node: FbxNode, name: string): Float64Array {
  const values = singleNode(node.children, name)?.properties[0];
  if (!(values instanceof Float64Array)) throw new Error(`FBX ${name} array is missing.`);
  return values;
}

function matrix(node: FbxNode, name: string): void {
  if (numeric(node, name).length !== 16) throw new Error('FBX bind matrices must have sixteen values.');
}

export function fbxBoneModels(
  objects: FbxNode,
  entries: (kind: string) => Map<number, FbxNode>,
  links: FbxConnection[],
): Set<number> {
  const deformers = entries('Deformer');
  const geometry = entries('Geometry');
  const models = entries('Model');
  const children = new Map<number, FbxConnection[]>();
  const parents = new Map<number, FbxConnection[]>();
  for (const link of links) {
    if (!children.has(link.parent)) children.set(link.parent, []);
    if (!parents.has(link.child)) parents.set(link.child, []);
    children.get(link.parent)!.push(link);
    parents.get(link.child)!.push(link);
  }
  const clusters = new Set<number>();
  const skinnedGeometry = new Set<number>();
  function skin(id: number): void {
    const destinations = parents.get(id) ?? [];
    if (
      !destinations.length ||
      destinations.some((link) => geometry.get(link.parent)?.properties[2] !== 'Mesh')
    )
      throw new Error('FBX skin has no resolvable mesh geometry.');
    for (const link of destinations) skinnedGeometry.add(link.parent);
    for (const link of children.get(id) ?? []) {
      const cluster = deformers.get(link.child);
      if (!cluster) throw new Error('FBX skin has an unresolved cluster.');
      matrix(cluster, 'TransformLink');
      if (cluster.properties[2] !== 'Cluster') continue;
      const indicesNode = singleNode(cluster.children, 'Indexes');
      const weightsNode = singleNode(cluster.children, 'Weights');
      if (!!indicesNode !== !!weightsNode) throw new Error('FBX skin indices and weights must be paired.');
      if (indicesNode) {
        const indices = numeric(cluster, 'Indexes');
        const weights = numeric(cluster, 'Weights');
        if (
          indices.length !== weights.length ||
          indices.some((value) => !Number.isSafeInteger(value) || value < 0)
        )
          throw new Error('FBX skin weights contain an invalid vertex layout.');
      }
      if (!(children.get(link.child) ?? []).some((bone) => models.has(bone.child)))
        throw new Error('FBX cluster has no resolvable bone model.');
      clusters.add(link.child);
    }
  }
  function morph(id: number): void {
    if (!(parents.get(id) ?? []).some((link) => geometry.get(link.parent)?.properties[2] === 'Mesh'))
      throw new Error('FBX blend shape has no resolvable base geometry.');
    for (const link of children.get(id) ?? []) {
      const channel = deformers.get(link.child);
      if (!channel || channel.properties[2] !== 'BlendShapeChannel')
        throw new Error('FBX blend shape channel is not supported by the webpage loader.');
      numeric(channel, 'FullWeights');
      const shapeLink = (children.get(link.child) ?? []).find((item) => item.relationship === undefined);
      const shape = shapeLink && geometry.get(shapeLink.child);
      if (!shape || shape.properties[2] !== 'Shape') throw new Error('FBX morph target geometry is missing.');
      const indices = numeric(shape, 'Indexes');
      if (
        numeric(shape, 'Vertices').length !== indices.length * 3 ||
        indices.some((value) => !Number.isSafeInteger(value) || value < 0)
      )
        throw new Error('FBX morph target has an invalid vertex layout.');
    }
  }
  for (const [id, deformer] of deformers) {
    if (!parents.has(id) && !children.has(id)) throw new Error('FBX deformer has no connections.');
    const type = deformer.properties[2];
    if (type === 'Skin') skin(id);
    else if (type === 'BlendShape') morph(id);
    else if (!['Cluster', 'BlendShapeChannel'].includes(String(type)))
      throw new Error('FBX contains an unverified deformer type.');
  }
  function poses(): void {
    for (const pose of objects.children.filter((node) => node.name === 'Pose')) {
      if (pose.properties[2] !== 'BindPose') continue;
      const count = singleNode(pose.children, 'NbPoseNodes')?.properties[0];
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
        throw new Error('FBX pose has an invalid node count.');
      if (!count) continue;
      const nodes = pose.children.filter((node) => node.name === 'PoseNode');
      if (nodes.length !== count) throw new Error('FBX pose node count is inconsistent.');
      for (const node of nodes) {
        const id = singleNode(node.children, 'Node')?.properties[0];
        if (typeof id !== 'number' || !models.has(id))
          throw new Error('FBX pose references an unknown model.');
        matrix(node, 'Matrix');
      }
    }
  }
  poses();
  const bones = new Set(
    links.filter((link) => clusters.has(link.parent) && models.has(link.child)).map((link) => link.child),
  );
  function bindable(): void {
    const lastGeometry = new Map<number, number>();
    for (const link of links)
      if (geometry.has(link.child) && models.has(link.parent)) lastGeometry.set(link.parent, link.child);
    for (const geometryId of skinnedGeometry)
      for (const link of parents.get(geometryId) ?? []) {
        if (!models.has(link.parent)) continue;
        if (
          models.get(link.parent)!.properties[2] !== 'Mesh' ||
          bones.has(link.parent) ||
          !skinnedGeometry.has(lastGeometry.get(link.parent)!)
        )
          throw new Error('FBX skin is connected to a model that cannot be bound by the webpage loader.');
      }
  }
  bindable();
  return bones;
}
