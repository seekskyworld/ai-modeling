/** Studio 手工分割的命令入口：本地拾取/刷选/合并历史，原生 modification 负责最终保存。 */
import { z } from 'zod';
import { id } from '../../studio/contracts/primitives.ts';
import {
  partName,
  segmentationMetadata,
  SEGMENTATION_FILE_LIMIT,
  type SegmentationFile,
} from '../../studio/contracts/segmentation.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import { readSegmentation } from '../../studio/segmentation.ts';
import type { Config } from '../core/config.ts';
import type { LocalSpec } from './operations.ts';
import { localTarget, publishLocal } from './files.ts';
import { segmentationGeometry, pickSegment, type SegmentGeometry } from './segmentation-geometry.ts';
import { loadSegmentState, applySegmentActions, segmentAction, ray } from './segmentation-state.ts';

const source = {
  model_path: z
    .string()
    .min(1)
    .describe('Original static indexed GLB; never use a re-exported preview as the source.'),
  state_path: z
    .string()
    .min(1)
    .optional()
    .describe('Previous segmentation state JSON; must match the exact source GLB.'),
  source_metadata: segmentationMetadata
    .optional()
    .describe(
      'Source operator children_deleted, children_rename and children_transform_matrix; reused from state when omitted.',
    ),
};
const inspectSchema = z
  .object({
    ...source,
    ray: ray.optional(),
    mesh_name: partName.optional(),
    face_index: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine(
    (x) => Boolean(x.mesh_name) === (x.face_index !== undefined),
    'Provide mesh_name and face_index together.',
  );
const editSchema = z
  .object({
    ...source,
    destination_path: z.string().min(1),
    project_id: id
      .optional()
      .describe('Bind a new state to the Studio project; required before native saving.'),
    expected_operator_id: id
      .optional()
      .describe('Source operator from project-get; prevents applying stale edits.'),
    reserved_names: z
      .array(partName)
      .max(4096)
      .optional()
      .describe('Names reserved by project metadata (deleted/renamed/transformed parts).'),
    actions: z
      .array(segmentAction)
      .max(100)
      .default([])
      .describe('Ordered edit actions; empty creates the initial state.'),
  })
  .strict()
  .refine(
    (x) => Boolean(x.project_id) === Boolean(x.expected_operator_id),
    'Provide both project_id and expected_operator_id.',
  );
const previewSchema = z.object({ ...source, destination_path: z.string().min(1) }).strict();

async function sourceGeometry(
  config: Config,
  input: Pick<z.infer<typeof previewSchema>, 'model_path' | 'state_path' | 'source_metadata'>,
): Promise<SegmentGeometry> {
  const previous = input.state_path
    ? (await readSegmentation(input.state_path, config.inputRoots)).state
    : undefined;
  return await segmentationGeometry(
    input.model_path,
    config.inputRoots,
    input.source_metadata ?? previous?.source_metadata,
  );
}
function summary(geometry: SegmentGeometry, state: SegmentationFile): Record<string, unknown> {
  const counts = new Map<number, number>();
  for (const encoded of Object.values(state.part_indices))
    for (const label of Buffer.from(encoded, 'base64')) counts.set(label, (counts.get(label) ?? 0) + 1);
  return {
    source_sha256: state.source_sha256,
    binding: state.binding,
    meshes: geometry.meshes.map((mesh) => ({
      name: mesh.name,
      ...state.signature[mesh.name],
      bounds: mesh.bounds,
    })),
    parts: [...counts]
      .sort(([a], [b]) => a - b)
      .map(([label, faces]) => ({ label, name: state.snapshot.part_names[label], faces })),
    selection: state.snapshot.selection,
    undo_steps: state.history.undo.length,
    redo_steps: state.history.redo.length,
    processing: 'local browser-equivalent vertex labels; native modification for saving',
    face_rule:
      'The first vertex determines each triangle label; painting shared vertices may affect adjacent faces.',
  };
}
async function inspect(config: Config, input: unknown): Promise<unknown> {
  const x = inspectSchema.parse(input);
  const geometry = await sourceGeometry(config, x);
  const state = await loadSegmentState(geometry, x.state_path, config.inputRoots);
  const hit = x.ray ? pickSegment(geometry.meshes, x.ray.origin, x.ray.direction) : undefined;
  const face = hit ?? (x.mesh_name ? { mesh_name: x.mesh_name, face_index: x.face_index! } : undefined);
  let detail;
  if (face) {
    const mesh = geometry.meshes.find((mesh) => mesh.name === face.mesh_name);
    if (!mesh || face.face_index >= mesh.indices.length / 3)
      throw new TripoError('SEGMENTATION_SELECTION', 'Selected mesh or face does not exist.');
    const label = Buffer.from(state.part_indices[face.mesh_name]!, 'base64')[face.face_index]!;
    const vertices = [...mesh.indices.subarray(face.face_index * 3, face.face_index * 3 + 3)];
    detail = {
      ...face,
      label,
      name: state.snapshot.part_names[label],
      vertex_indices: vertices,
      world_vertices: vertices.map((index) => [...mesh.world.subarray(index * 3, index * 3 + 3)]),
    };
  }
  return {
    ...summary(geometry, state),
    ...(x.ray ? { hit: hit ? detail : null } : {}),
    ...(x.mesh_name ? { face: detail } : {}),
  };
}
async function edit(config: Config, input: unknown): Promise<unknown> {
  const x = editSchema.parse(input),
    target = await localTarget(config.outputDir, x.destination_path, 'json');
  const geometry = await sourceGeometry(config, x);
  const state = await loadSegmentState(geometry, x.state_path, config.inputRoots);
  if (x.project_id) {
    if (
      state.binding &&
      (state.binding.project_id !== x.project_id || state.binding.operator_id !== x.expected_operator_id)
    )
      throw new TripoError('SEGMENTATION_TARGET', 'Cannot rebind an existing state to a different source.');
    state.binding = { project_id: x.project_id, operator_id: x.expected_operator_id! };
  }
  state.reserved_names = [...new Set([...state.reserved_names, ...(x.reserved_names ?? [])])];
  applySegmentActions(geometry, state, x.actions);
  const bytes = Buffer.from(JSON.stringify(state));
  if (bytes.length > SEGMENTATION_FILE_LIMIT)
    throw new TripoError('SEGMENTATION_LIMIT', 'State exceeds the 64 MiB input limit.');
  return {
    ...(await publishLocal(target, bytes, 'json')),
    ...summary(geometry, state),
    next_action: state.binding
      ? 'Save with studio modification --project-id … --indices-path <this file> and a stable request ID.'
      : 'Bind the state to its source project/operator before using studio modification.',
  };
}
/** 预览按编译后的逐面标签拆绘制组；颜色只供检查，不会上传或替换模型的正式材质。 */
async function preview(config: Config, input: unknown): Promise<unknown> {
  const x = previewSchema.parse(input),
    target = await localTarget(config.outputDir, x.destination_path, 'glb');
  const geometry = await sourceGeometry(config, x);
  const state = await loadSegmentState(geometry, x.state_path, config.inputRoots);
  const document = geometry.document,
    buffer = document.getRoot().listBuffers()[0]!;
  const materials = new Map<number, ReturnType<typeof document.createMaterial>>();
  for (const mesh of geometry.meshes) {
    const labels = Buffer.from(state.part_indices[mesh.name]!, 'base64');
    const groups = new Map<number, number[]>();
    for (let face = 0; face < labels.length; face++) {
      const label = labels[face]!;
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label)!.push(...mesh.indices.subarray(face * 3, face * 3 + 3));
    }
    const replacement = document.createMesh(mesh.name);
    for (const [label, indices] of groups) {
      if (!materials.has(label)) {
        // 标签→固定高区分颜色；只保证语义可辨，不复刻网页相邻部件配色算法。
        const color = [0, 2.094, 4.189].map(
          (phase) => 0.25 + (0.7 * (Math.sin(label * 2.4 + phase) + 1)) / 2,
        );
        materials.set(
          label,
          document
            .createMaterial(state.snapshot.part_names[label])
            .setBaseColorFactor([color[0]!, color[1]!, color[2]!, 1])
            .setMetallicFactor(0)
            .setRoughnessFactor(0.8)
            .setDoubleSided(true),
        );
      }
      const primitive = document
        .createPrimitive()
        .setMode(4)
        .setAttribute('POSITION', mesh.positions)
        .setIndices(
          document.createAccessor().setType('SCALAR').setArray(new Uint32Array(indices)).setBuffer(buffer),
        )
        .setMaterial(materials.get(label)!);
      const normal = mesh.primitive.getAttribute('NORMAL');
      if (normal) primitive.setAttribute('NORMAL', normal);
      replacement.addPrimitive(primitive);
    }
    mesh.node.setMesh(replacement);
  }
  // 移除不再被节点使用的源 mesh，避免预览文件暗含一份重复模型。
  const visibleNodes = new Set<ReturnType<typeof document.createNode>>();
  for (const scene of document.getRoot().listScenes()) scene.traverse((node) => visibleNodes.add(node));
  for (const node of document.getRoot().listNodes()) if (!visibleNodes.has(node)) node.dispose();
  for (const mesh of document.getRoot().listMeshes())
    if (
      !document
        .getRoot()
        .listNodes()
        .some((node) => node.getMesh() === mesh)
    )
      mesh.dispose();
  return {
    ...(await publishLocal(target, Buffer.from(await geometry.io.writeBinary(document)), 'glb')),
    ...summary(geometry, state),
    preview_only: true,
    source_replacement: false,
  };
}
export const segmentationOperations: LocalSpec[] = [
  {
    name: 'segmentation_inspect',
    description: 'inspect segment labels or pick the nearest face of an original static GLB',
    schema: inspectSchema,
    readOnly: true,
    run: inspect,
  },
  {
    name: 'segmentation_edit',
    description: 'select, brush, paint, merge, split, rename, undo or redo segment labels locally',
    schema: editSchema,
    run: edit,
  },
  {
    name: 'segmentation_preview',
    description: 'save a colored GLB preview of segment labels without changing the original model',
    schema: previewSchema,
    run: preview,
  },
];
