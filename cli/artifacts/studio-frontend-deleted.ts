/** 原网页GLB exporter会保留已删节点的孤立mesh；只接纳明确来源且逐面不变的这种原厂行为。 */
import type { Mesh, Node, Root } from '@gltf-transform/core';
import { frontendFail as fail } from './studio-assimp-normalize.ts';
import { verifyFrontendDetachedMesh } from './studio-assimp-surface.ts';
import type { StudioFrontendMetadata } from '../../studio/contracts/frontend-export.ts';
import { TripoError } from '../../studio/contracts/errors.ts';

function deletedSurface(source: Node, target: Mesh, metadata: StudioFrontendMetadata) {
  const position = source.getMesh()!.listPrimitives()[0]?.getAttribute('POSITION');
  if (!position) return fail('The detached source mesh has no positions.');
  const min = position.getMin([]),
    max = position.getMax([]);
  const extent = Math.max(...max.map((value, index) => value - min[index]!));
  return verifyFrontendDetachedMesh(source, target, Math.max(1, extent) * 1e-6, metadata.material_factor);
}

export function verifyFrontendDeletedMeshes(source: Root, target: Root, metadata: StudioFrontendMetadata) {
  const allowed = new Set<Mesh>(),
    proof: Record<string, unknown>[] = [];
  const deleted = metadata.children_deleted ?? [];
  let faces = 0;
  if (!deleted.length) return { allowed, proof, faces };
  const visible = new Set(target.listNodes().map((node) => node.getMesh()));
  const originals = source.listNodes().filter((node) => deleted.includes(node.getName()));
  const used = new Set<Node>();
  let comparisons = 0;
  for (const mesh of target.listMeshes()) {
    if (visible.has(mesh)) continue;
    // 原始局部表面不应用root/child/pivot：当前引擎只变换仍在scene中的mesh，孤立原网格保持原坐标。
    // 实际Studio分割GLB常无mesh名。只能按完整原表面唯一匹配，不用数组顺序或猜测生成名称。
    const named = mesh.getName()
      ? originals.filter((node) => node.getMesh()?.getName() === mesh.getName())
      : [];
    const candidates = named.length === 1 ? named : originals;
    const matches: Array<{ original: Node; surfaces: ReturnType<typeof deletedSurface> }> = [];
    for (const original of candidates) {
      if (used.has(original)) continue;
      if (++comparisons > 4096)
        return fail('Detached mesh identity matching exceeds its bounded work limit.');
      try {
        matches.push({ original, surfaces: deletedSurface(original, mesh, metadata) });
      } catch (error) {
        if (!(error instanceof TripoError) || error.code !== 'FRONTEND_EXPORT_UNVERIFIED') throw error;
      }
    }
    if (matches.length !== 1)
      return fail(
        'A detached output mesh has no unique complete-surface match among deliberately deleted source nodes.',
      );
    const { original, surfaces } = matches[0]!;
    used.add(original);
    faces += surfaces.reduce((sum, surface) => sum + surface.faces, 0);
    if (faces > 100000) return fail('Detached deleted meshes exceed the original frontend face budget.');
    allowed.add(mesh);
    proof.push({
      source_node: original.getName(),
      retained_unreferenced_mesh: mesh.getName(),
      matching:
        named.length === 1
          ? 'unique_original_mesh_name_and_complete_surface'
          : 'unique_complete_original_surface',
      primitives: surfaces,
      interpretation:
        'The original webpage engine removed the scene node but retained verified raw mesh data in the GLB. This is visible-scene deletion, not removal of geometry bytes from the file.',
    });
  }
  return { allowed, proof, faces };
}
