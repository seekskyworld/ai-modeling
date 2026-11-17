/** UV 查看器的本地几何：只读取模型，不重新展开 UV；接缝按网页的 UV/位置量化规则识别。 */
import type { Node, Primitive } from '@gltf-transform/core';
import { TripoError } from '../../studio/contracts/errors.ts';
import { loadGLB } from './gltf.ts';
import { uvPositionReader } from './uv-position.ts';

export interface UvGeometry {
  uv: number[];
  positions: number[];
  indices: number[];
  meshes: { name: string; faces: number; vertices: number }[];
  skipped_meshes: { name: string; primitive_index: number; reason: string }[];
  sha256: string;
}

function appendPrimitive(result: UvGeometry, node: Node, primitive: Primitive): void {
  const uv = primitive.getAttribute('TEXCOORD_0'),
    position = primitive.getAttribute('POSITION');
  if (!uv || !position || uv.getType() !== 'VEC2' || uv.getCount() !== position.getCount())
    throw new TripoError('UV_MISSING', 'Each selected primitive must have valid TEXCOORD_0 coordinates.');
  if (primitive.getMode() !== 4)
    throw new TripoError('UV_TOPOLOGY', 'UV layout requires triangulated GLB geometry.');
  const accessor = primitive.getIndices(),
    count = accessor?.getCount() ?? uv.getCount();
  if (!count || count % 3)
    throw new TripoError('UV_TOPOLOGY', 'UV triangles have an incomplete index buffer.');
  const vertices = new Map<number, number>(),
    readPosition = uvPositionReader(node, primitive);
  for (let i = 0; i < count; i++) {
    const index = accessor ? accessor.getScalar(i) : i;
    if (!Number.isInteger(index) || index < 0 || index >= uv.getCount())
      throw new TripoError('UV_TOPOLOGY', 'UV triangle references an absent vertex.');
    if (!vertices.has(index)) {
      const point = readPosition(index),
        coordinate = uv.getElement(index, []);
      if (![...point, ...coordinate].every(Number.isFinite))
        throw new TripoError('UV_TOPOLOGY', 'UV source contains non-finite coordinates.');
      vertices.set(index, result.uv.length / 2);
      // 网页只统计被面引用的顶点；GLB/glTF top-left 转成查看器 bottom-left，保留 Float32 精度。
      result.uv.push(Math.fround(coordinate[0]!), Math.fround(1 - coordinate[1]!));
      result.positions.push(...point);
    }
    result.indices.push(vertices.get(index)!);
  }
  result.meshes.push({ name: node.getName(), faces: count / 3, vertices: vertices.size });
  if (result.indices.length > 6000000 || result.uv.length > 12000000)
    throw new TripoError(
      'UV_LIMIT',
      'UV inspection supports at most 2 million triangles / 6 million vertices.',
    );
}

/** 输入当前 GLB；mesh_names 可限制网页可见部件，不猜测未随文件保存的网页显隐状态。 */
export async function uvGeometry(file: string, roots: string[], names?: string[]): Promise<UvGeometry> {
  const { document, sha256 } = await loadGLB(file, roots);
  const scene = document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0];
  if (!scene) throw new TripoError('UV_TOPOLOGY', 'Source has no scene.');
  const result: UvGeometry = { uv: [], positions: [], indices: [], meshes: [], skipped_meshes: [], sha256 };
  const foundNames = new Set<string>();
  scene.traverse((node) => {
    if (names && !names.includes(node.getName())) return;
    if (node.getMesh()) foundNames.add(node.getName());
    for (const [index, primitive] of (node.getMesh()?.listPrimitives() ?? []).entries()) {
      if (!primitive.getAttribute('TEXCOORD_0')) {
        result.skipped_meshes.push({ name: node.getName(), primitive_index: index, reason: 'UV_MISSING' });
        continue;
      }
      appendPrimitive(result, node, primitive);
    }
  });
  if (names?.some((name) => !foundNames.has(name)))
    throw new TripoError('INVALID_PART', 'A selected UV mesh is absent from the model.');
  if (!result.indices.length) throw new TripoError('UV_MISSING', 'No selected UV triangles were found.');
  return result;
}

function vertexKeys(geometry: UvGeometry): string[] {
  const minimum = [Infinity, Infinity, Infinity],
    maximum = [-Infinity, -Infinity, -Infinity];
  geometry.positions.forEach((value, i) => {
    minimum[i % 3] = Math.min(minimum[i % 3]!, value);
    maximum[i % 3] = Math.max(maximum[i % 3]!, value);
  });
  // 网页 UV 容差 1e-5，位置容差为包围盒对角线的 1e-4；防止重叠但不相连的 UV 岛误合并。
  const epsilon = Math.hypot(...maximum.map((value, i) => value - minimum[i]!)) * 1e-4;
  return Array.from({ length: geometry.uv.length / 2 }, (_, index) =>
    [
      ...geometry.uv.slice(index * 2, index * 2 + 2).map((v) => Math.round(v / 1e-5)),
      ...geometry.positions
        .slice(index * 3, index * 3 + 3)
        .map((v) => (epsilon > 0 ? Math.round(v / epsilon) : 0)),
    ].join(','),
  );
}

/** UV 岛为焊接后顶点的连通分量；返回原面索引供拾取，保留输入顺序。 */
export function uvIslands(geometry: UvGeometry) {
  const keys = vertexKeys(geometry),
    parents = keys.map((_, index) => index),
    first = new Map<string, number>();
  const root = (index: number): number => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]!]!;
      index = parents[index]!;
    }
    return index;
  };
  keys.forEach((key, index) => {
    const previous = first.get(key);
    if (previous === undefined) first.set(key, index);
    else parents[index] = root(previous);
  });
  for (let i = 0; i < geometry.indices.length; i += 3) {
    const a = root(geometry.indices[i]!);
    parents[root(geometry.indices[i + 1]!)] = a;
    parents[root(geometry.indices[i + 2]!)] = a;
  }
  const labels = new Map<number, number>();
  const vertices = keys.map((_, i) => {
    const r = root(i);
    if (!labels.has(r)) labels.set(r, labels.size);
    return labels.get(r)!;
  });
  const islands = [...labels.values()].map((id) => ({
    id,
    faces: 0,
    bounds: [Infinity, Infinity, -Infinity, -Infinity],
  }));
  vertices.forEach((label, index) => {
    const bounds = islands[label]!.bounds,
      u = geometry.uv[index * 2]!,
      v = geometry.uv[index * 2 + 1]!;
    bounds[0] = Math.min(bounds[0]!, u);
    bounds[1] = Math.min(bounds[1]!, v);
    bounds[2] = Math.max(bounds[2]!, u);
    bounds[3] = Math.max(bounds[3]!, v);
  });
  const faceIslands = geometry.indices.filter((_, i) => i % 3 === 0).map((index) => vertices[index]!);
  for (const label of faceIslands) islands[label]!.faces++;
  return { islands, faceIslands };
}
