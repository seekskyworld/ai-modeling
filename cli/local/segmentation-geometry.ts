/** 网页手工分割几何对应：静态 indexed GLB，保留源顶点/三角面顺序，不做重拓扑。 */
import type { Accessor, Node, Primitive } from '@gltf-transform/core';
import { mat4, vec3 } from 'gl-matrix';
import { TripoError } from '../../studio/contracts/errors.ts';
import { segmentationMetadata, type SegmentationMetadata } from '../../studio/contracts/segmentation.ts';
import { loadGLB } from './gltf.ts';

export type Point3 = [number, number, number];
export interface SegmentMesh {
  name: string;
  node: Node;
  primitive: Primitive;
  positions: Accessor;
  indices: Uint32Array;
  world: Float64Array;
  inverse: mat4;
  scale: number;
  bounds: [Point3, Point3];
}
export async function segmentationGeometry(
  file: string,
  roots: string[],
  sourceMetadata?: SegmentationMetadata,
) {
  const loaded = await loadGLB(file, roots);
  const metadata = segmentationMetadata.parse(sourceMetadata ?? {});
  if (loaded.document.getRoot().listAnimations().length)
    throw new TripoError('SEGMENTATION_GEOMETRY', 'Use the original static GLB, without animation tracks.');
  const scenes = loaded.document.getRoot().listScenes();
  if (scenes.length !== 1) throw new TripoError('SEGMENTATION_GEOMETRY', 'Exactly one scene is required.');
  // 网页 DAKfiBWY 先删除隐藏节点，再以 metadata 矩阵左乘源节点矩阵；不改源顶点顺序。
  const originalNodes: Node[] = [];
  scenes[0]!.traverse((node) => originalNodes.push(node));
  const baseWorld = new Map(originalNodes.map((node) => [node, node.getWorldMatrix()]));
  for (const node of originalNodes) {
    if (metadata.children_deleted.includes(node.getName())) {
      if (node.getParentNode()) node.getParentNode()!.removeChild(node);
      else scenes[0]!.removeChild(node);
    }
    const transform = metadata.children_transform_matrix[node.getName()];
    if (transform)
      node.setMatrix(
        Array.from(mat4.multiply(mat4.create(), transform, node.getMatrix())) as ReturnType<
          Node['getMatrix']
        >,
      );
  }
  const meshes: SegmentMesh[] = [];
  const names = new Set<string>();
  scenes[0]!.traverse((node) => {
    const mesh = node.getMesh();
    if (!mesh) return;
    const name = node.getName() || mesh.getName();
    // Three.js 会重写特殊节点名；未确认同名/多材质拆分的服务端顺序时拒绝猜测映射。
    if (
      !name ||
      name.length > 256 ||
      /[\s[\].:/]/.test(name) ||
      names.has(name) ||
      node.getSkin() ||
      mesh.listPrimitives().length !== 1
    )
      throw new TripoError(
        'SEGMENTATION_GEOMETRY',
        'Use unique stable node names, one primitive per mesh, and no skin.',
      );
    names.add(name);
    meshes.push(readMesh(node, mesh.listPrimitives()[0]!, name));
  });
  const signature = Object.fromEntries(
    meshes.map((mesh) => [
      mesh.name,
      {
        vertices: mesh.positions.getCount(),
        faces: mesh.indices.length / 3,
      },
    ]),
  );
  if (
    !meshes.length ||
    meshes.length > 256 ||
    meshes.reduce((sum, m) => sum + m.positions.getCount() + m.indices.length / 3, 0) > 8000000
  )
    throw new TripoError('SEGMENTATION_LIMIT', 'Use 1–256 meshes and at most 8 million vertices + faces.');
  const sourceTransforms = Object.fromEntries(
    meshes.map((mesh) => {
      const inverse = mat4.invert(mat4.create(), baseWorld.get(mesh.node)!);
      if (!inverse) throw new TripoError('SEGMENTATION_GEOMETRY', 'Source transform is singular.');
      return [
        mesh.name,
        Array.from(mat4.multiply(mat4.create(), mesh.node.getWorldMatrix(), inverse)).map((v) =>
          Math.abs(v) < 1e-7 ? 0 : v,
        ),
      ];
    }),
  );
  return { ...loaded, meshes, signature, metadata, sourceTransforms };
}
export type SegmentGeometry = Awaited<ReturnType<typeof segmentationGeometry>>;

function readMesh(node: Node, primitive: Primitive, name: string): SegmentMesh {
  const positions = primitive.getAttribute('POSITION'),
    indices = primitive.getIndices();
  if (
    !positions ||
    positions.getType() !== 'VEC3' ||
    !indices ||
    primitive.getMode() !== 4 ||
    primitive.listTargets().length ||
    !indices.getCount() ||
    indices.getCount() % 3 ||
    indices.getCount() / 3 > 2000000 ||
    positions.getCount() > 2000000
  )
    throw new TripoError(
      'SEGMENTATION_GEOMETRY',
      'Expected static indexed triangles within the editing limit.',
    );
  const ordered = Uint32Array.from(indices.getArray()!);
  if (ordered.some((i) => i >= positions.getCount()))
    throw new TripoError('SEGMENTATION_GEOMETRY', 'Triangle references a missing vertex.');
  const matrix = node.getWorldMatrix(),
    inverse = mat4.create();
  const scale =
    (Math.hypot(...matrix.slice(0, 3)) +
      Math.hypot(...matrix.slice(4, 7)) +
      Math.hypot(...matrix.slice(8, 11))) /
    3;
  if (!mat4.invert(inverse, matrix) || !Number.isFinite(scale) || scale <= 0)
    throw new TripoError('SEGMENTATION_GEOMETRY', 'Mesh transform is singular or invalid.');
  const world = new Float64Array(positions.getCount() * 3);
  const bounds: [Point3, Point3] = [
    [Infinity, Infinity, Infinity],
    [-Infinity, -Infinity, -Infinity],
  ];
  const local: number[] = [],
    transformed = vec3.create();
  for (let i = 0; i < positions.getCount(); i++) {
    positions.getElement(i, local);
    vec3.transformMat4(transformed, local as Point3, matrix);
    for (let axis = 0; axis < 3; axis++) {
      const value = transformed[axis]!;
      if (!Number.isFinite(value)) throw new TripoError('SEGMENTATION_GEOMETRY', 'Invalid vertex position.');
      world[i * 3 + axis] = value;
      bounds[0][axis] = Math.min(bounds[0][axis]!, value);
      bounds[1][axis] = Math.max(bounds[1][axis]!, value);
    }
  }
  return { name, node, primitive, positions, indices: ordered, world, inverse, scale, bounds };
}

/** 网页保存按每个面的首顶点取标签；共享顶点涂色可能同时改变相邻面。 */
export function compiledLabels(
  meshes: SegmentMesh[],
  attributes: Record<string, Uint8Array>,
): Record<string, string> {
  return Object.fromEntries(
    meshes.map((mesh) => {
      const labels = attributes[mesh.name]!,
        faces = new Uint8Array(mesh.indices.length / 3);
      for (let face = 0; face < faces.length; face++) faces[face] = labels[mesh.indices[face * 3]!]!;
      return [mesh.name, Buffer.from(faces).toString('base64')];
    }),
  );
}
/** 复现网页球刷：半径为 brush_size / 平均世界缩放 × 0.8；命中任一顶点即刷整个三角形。 */
export function brushVertices(mesh: SegmentMesh, point: Point3, size: number): Set<number> {
  const center = vec3.transformMat4(vec3.create(), point, mesh.inverse);
  const radius2 = ((size / mesh.scale) * 0.8) ** 2;
  const inSphere = new Uint8Array(mesh.positions.getCount()),
    position: number[] = [];
  for (let i = 0; i < inSphere.length; i++) {
    mesh.positions.getElement(i, position);
    if (position.reduce((sum, n, axis) => sum + (n - center[axis]!) ** 2, 0) <= radius2) inSphere[i] = 1;
  }
  const selected = new Set<number>();
  for (let face = 0; face < mesh.indices.length; face += 3) {
    const tri = mesh.indices.subarray(face, face + 3);
    if (tri.some((index) => inSphere[index])) for (const index of tri) selected.add(index);
  }
  return selected;
}
export interface SegmentHit {
  mesh_name: string;
  face_index: number;
  point: Point3;
  distance: number;
}
/** 双面射线拾取最近三角形；命中点使用模型原始世界坐标，供后续 brush 直接使用。 */
export function pickSegment(meshes: SegmentMesh[], origin: Point3, direction: Point3): SegmentHit | null {
  if (Math.hypot(...direction) < 1e-12)
    throw new TripoError('INVALID_INPUT', 'Ray direction must be nonzero.');
  const ray = vec3.normalize(vec3.create(), direction);
  let hit: SegmentHit | null = null;
  const a = vec3.create(),
    b = vec3.create(),
    c = vec3.create(),
    edge1 = vec3.create(),
    edge2 = vec3.create();
  const p = vec3.create(),
    q = vec3.create(),
    delta = vec3.create();
  for (const mesh of meshes)
    for (let face = 0; face < mesh.indices.length / 3; face++) {
      for (const [corner, target] of [a, b, c].entries()) {
        const offset = mesh.indices[face * 3 + corner]! * 3;
        vec3.set(target, mesh.world[offset]!, mesh.world[offset + 1]!, mesh.world[offset + 2]!);
      }
      vec3.subtract(edge1, b, a);
      vec3.subtract(edge2, c, a);
      vec3.cross(p, ray, edge2);
      const determinant = vec3.dot(edge1, p);
      if (Math.abs(determinant) < 1e-10) continue;
      vec3.subtract(delta, origin, a);
      const u = vec3.dot(delta, p) / determinant;
      if (u < 0 || u > 1) continue;
      vec3.cross(q, delta, edge1);
      const v = vec3.dot(ray, q) / determinant;
      if (v < 0 || u + v > 1) continue;
      const distance = vec3.dot(edge2, q) / determinant;
      if (distance < 0 || (hit && distance >= hit.distance)) continue;
      hit = {
        mesh_name: mesh.name,
        face_index: face,
        distance,
        point: [0, 1, 2].map((i) => origin[i]! + ray[i]! * distance) as Point3,
      };
    }
  return hit;
}
