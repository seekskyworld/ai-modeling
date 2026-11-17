/** 只读取原模型的名称及现有 delta 矩阵；几何修改交给网页 metadata 和 export 接口。 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mat4 } from 'gl-matrix';
import { existingArtifact } from '../../studio/api/existing-artifact.ts';
import { projectMetadataSnapshot } from '../../studio/api/discovery.ts';
import { object, text, array, TripoError } from '../../studio/contracts/errors.ts';
import type { StudioClient, Fetcher } from '../../studio/api/client.ts';
import { download } from '../artifacts/download.ts';
import { loadGLB } from '../local/gltf.ts';
export interface ExportEdits {
  part_names?: string[];
  scale_factor?: number;
}

/** 已有结果重用保存的 metadata；首次准备检查源 operator，未知名称拒绝，避免整模被误导出。 */
export async function prepareExportEdits(
  client: StudioClient,
  input: Record<string, unknown>,
  edits: ExportEdits,
  copiedFrom?: { project_id: string; operator_id: string },
  fetcher?: Fetcher,
): Promise<Record<string, unknown>> {
  const projectId = text(input.project_id),
    operatorId = text(input.expected_operator_id);
  const targetMetadata = await projectMetadataSnapshot(client, projectId, operatorId);
  // 原生 copy 只复制模型文件，实测丢失 metadata；编辑前读取原版本，持久任务保存快照供恢复。
  const metadata = copiedFrom
    ? await projectMetadataSnapshot(client, copiedFrom.project_id, copiedFrom.operator_id, true)
    : targetMetadata;
  const temp = await mkdtemp(path.join(tmpdir(), 'ai-modeling-native-export-'));
  try {
    const source = await existingArtifact(client, {
      kind: 'model',
      id: projectId,
      operator_id: operatorId,
      output_index: 0,
      destination_path: path.join(temp, 'source.glb'),
    });
    const file = await download(source.url, temp, 'source.glb', 'glb', fetcher);
    const { document } = await loadGLB(file.local_path, [temp]);
    const nodes = document
      .getRoot()
      .listNodes()
      .filter((node) => node.getMesh());
    const matches = (node: (typeof nodes)[number], name: string): boolean =>
      [node.getName(), node.getMesh()?.getName(), object(metadata.children_rename)[node.getName()]].includes(
        name,
      );
    const selected = edits.part_names;
    if (selected?.some((name) => !nodes.some((node) => matches(node, name))))
      throw new TripoError('INVALID_PART', 'A selected part is absent from the source model.');
    const deleted = new Set(array(metadata.children_deleted).map(text));
    const transforms = { ...object(metadata.children_transform_matrix) };
    for (const node of nodes) {
      if (selected && !selected.some((name) => matches(node, name))) deleted.add(node.getName());
      if (edits.scale_factor !== undefined && edits.scale_factor !== 1) {
        const previous = array(transforms[node.getName()]);
        const scale = mat4.fromScaling(mat4.create(), [
          edits.scale_factor,
          edits.scale_factor,
          edits.scale_factor,
        ]);
        transforms[node.getName()] = Array.from(
          mat4.multiply(mat4.create(), scale, previous.length === 16 ? previous.map(Number) : mat4.create()),
        );
      }
    }
    return {
      ...input,
      export_edits: edits,
      expected_metadata: {
        children_deleted: targetMetadata.children_deleted ?? [],
        children_transform_matrix: targetMetadata.children_transform_matrix ?? {},
        children_rename: targetMetadata.children_rename ?? {},
        material_factor: targetMetadata.material_factor ?? {},
      },
      children_deleted: [...deleted],
      children_transform_matrix: transforms,
      children_rename: metadata.children_rename ?? {},
      material_factor: metadata.material_factor ?? {},
      replace: true,
    };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
