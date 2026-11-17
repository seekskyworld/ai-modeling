/** 静态层级的原网页轴心以可见世界表面计算；只读原件，不展平或改写交付模型。 */
import type { Document, Mesh, Node, Root } from '@gltf-transform/core';
import { vec3 } from 'gl-matrix';
import { frontendFail as fail } from './studio-assimp-normalize.ts';
import { validateFrontendPositiveTrs, type FrontendEditedBounds } from './studio-frontend-edits.ts';
import { TripoError } from '../../studio/contracts/errors.ts';

export interface FrontendStaticWorld {
  bounds: FrontendEditedBounds;
  proof: Record<string, unknown>;
}

function visibleStaticNodes(root: Root): Node[] {
  const scenes = root.listScenes(),
    nodes = root.listNodes();
  if (
    scenes.length !== 1 ||
    root.listSkins().length ||
    root.listAnimations().length ||
    !nodes.length ||
    nodes.length > 256
  )
    return fail('World-pivot verification requires one bounded static scene.');
  const reachable = new Set<Node>(),
    pending = [...scenes[0]!.listChildren()];
  while (pending.length) {
    const node = pending.pop()!;
    if (reachable.has(node)) return fail('World-pivot nodes must have an unambiguous scene path.');
    reachable.add(node);
    pending.push(...node.listChildren());
  }
  if (nodes.some((node) => !reachable.has(node)))
    return fail('World-pivot verification cannot omit detached source nodes.');
  return nodes;
}

function inspect(document: Document): FrontendStaticWorld {
  const root = document.getRoot(),
    nodes = visibleStaticNodes(root);
  const meshes = new Set<Mesh>(),
    min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  let vertices = 0,
    primitives = 0;
  for (const node of nodes) {
    if (node.getSkin()) return fail('World-pivot verification does not cover skin deformation.');
    validateFrontendPositiveTrs(Array.from(node.getMatrix()), 'Static source local transform');
    const matrix = validateFrontendPositiveTrs(
      Array.from(node.getWorldMatrix()),
      'Static source world transform',
    );
    const mesh = node.getMesh();
    if (!mesh) continue;
    // 固定原引擎会将共享mesh的不同实例折叠到同一位置，不能靠包围盒放宽该失真。
    if (meshes.has(mesh)) return fail('Shared mesh instances are outside the verified world-pivot subset.');
    meshes.add(mesh);
    if (!mesh.listPrimitives().length) return fail('A visible source mesh has no primitives.');
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute('POSITION');
      if (
        primitive.getMode() !== 4 ||
        primitive.listTargets().length ||
        !position ||
        position.getType() !== 'VEC3' ||
        position.getNormalized()
      )
        return fail('World-pivot verification requires static triangles and nonnormalized VEC3 positions.');
      vertices += position.getCount();
      if (++primitives > 64 || vertices > 200000)
        return fail('World-pivot verification exceeds its bounded primitive or vertex budget.');
      for (let index = 0; index < position.getCount(); index++) {
        const point = vec3.transformMat4(vec3.create(), position.getElement(index, []), matrix);
        if (Array.from(point).some((value) => !Number.isFinite(value)))
          return fail('The source has nonfinite world positions.');
        for (let axis = 0; axis < 3; axis++) {
          min[axis] = Math.min(min[axis]!, point[axis]!);
          max[axis] = Math.max(max[axis]!, point[axis]!);
        }
      }
    }
  }
  if (root.listMeshes().some((mesh) => !meshes.has(mesh)))
    return fail('World-pivot verification cannot omit detached source meshes.');
  const extent = Math.max(...max.map((value, index) => value - min[index]!));
  if (!Number.isFinite(extent) || extent <= 0) return fail('The source has no finite world extent.');
  const bounds = { min, max, pivot: [(min[0]! + max[0]!) / 2, min[1]!, (min[2]! + max[2]!) / 2], extent };
  return {
    bounds,
    proof: {
      kind: 'static_source_world_bounds',
      source_nodes: nodes.length,
      meshes: meshes.size,
      primitives,
      vertices,
      source_geometry_unchanged: true,
      bounds,
    },
  };
}

/** 不改变旧动画及未证明来源分支；最后仍逐有向面验证输出，包围盒本身不代表成功。 */
export function staticFrontendWorld(document: Document): FrontendStaticWorld | undefined {
  try {
    return inspect(document);
  } catch (error) {
    if (error instanceof TripoError && error.code === 'FRONTEND_EXPORT_UNVERIFIED') return;
    throw error;
  }
}
