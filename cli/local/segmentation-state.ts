/** 分割编辑状态与有界撤销历史；每个产物是独立快照，不覆盖上一步或原始模型。 */
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import {
  partName,
  segmentLabel,
  decodeLabels,
  validateSegmentationFile,
  SEGMENTATION_HISTORY_LIMIT,
  type SegmentationFile,
  type SegmentSnapshot,
} from '../../studio/contracts/segmentation.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import { readSegmentation } from '../../studio/segmentation.ts';
import {
  brushVertices,
  compiledLabels,
  pickSegment,
  type SegmentGeometry,
  type SegmentMesh,
} from './segmentation-geometry.ts';

const point = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
export const ray = z.object({ origin: point, direction: point }).strict();
const selectionMode = z.enum(['set', 'add', 'remove', 'toggle']).default('set');
const faceSelection = {
  mesh_name: partName,
  face_indices: z.array(z.number().int().nonnegative()).min(1).max(2000000),
};
export const segmentAction = z.discriminatedUnion('action', [
  z
    .object({ action: z.literal('select'), labels: z.array(segmentLabel).max(256), mode: selectionMode })
    .strict(),
  z.object({ action: z.literal('pick'), ray, mode: selectionMode }).strict(),
  z.object({ action: z.literal('paint'), ...faceSelection, label: segmentLabel }).strict(),
  z
    .object({
      action: z.literal('brush'),
      point,
      brush_size: z.number().positive().finite(),
      label: segmentLabel.optional(),
      mesh_names: z.array(partName).min(1).max(256).optional(),
    })
    .strict(),
  z.object({ action: z.literal('merge'), labels: z.array(segmentLabel).min(2).max(256).optional() }).strict(),
  z.object({ action: z.literal('split'), ...faceSelection, name: partName.optional() }).strict(),
  z.object({ action: z.literal('rename'), label: segmentLabel, name: partName }).strict(),
  z.object({ action: z.literal('undo') }).strict(),
  z.object({ action: z.literal('redo') }).strict(),
  z.object({ action: z.literal('reset') }).strict(),
]);
export type SegmentAction = z.infer<typeof segmentAction>;
export function attributesOf(state: SegmentationFile): Record<string, Uint8Array> {
  return Object.fromEntries(
    Object.entries(state.signature).map(([name, counts]) => [
      name,
      decodeLabels(state.snapshot.attribute_indices[name]!, counts.vertices),
    ]),
  );
}
export function initialSnapshot(geometry: SegmentGeometry): SegmentSnapshot {
  return {
    attribute_indices: Object.fromEntries(
      geometry.meshes.map((mesh, label) => [
        mesh.name,
        Buffer.alloc(mesh.positions.getCount(), label).toString('base64'),
      ]),
    ),
    part_names: Object.fromEntries(geometry.meshes.map((mesh, label) => [label, mesh.name])),
    selection: [],
  };
}
/** 恢复要求原 GLB 摘要、mesh 集合及计数一致；不得把重导出的同形模型当成同序数据。 */
export async function loadSegmentState(
  geometry: SegmentGeometry,
  file: string | undefined,
  roots: string[],
): Promise<SegmentationFile> {
  if (file) {
    const { state } = await readSegmentation(file, roots);
    if (
      state.source_sha256 !== geometry.sha256 ||
      !isDeepStrictEqual(state.source_metadata, geometry.metadata) ||
      !isDeepStrictEqual(state.source_transforms, geometry.sourceTransforms) ||
      JSON.stringify(Object.entries(state.signature).sort()) !==
        JSON.stringify(Object.entries(geometry.signature).sort())
    )
      throw new TripoError('SEGMENTATION_SOURCE_CHANGED', 'Use the exact original GLB for this edit state.');
    const compiled = compiledLabels(geometry.meshes, attributesOf(state));
    if (Object.entries(compiled).some(([name, value]) => state.part_indices[name] !== value))
      throw new TripoError('SEGMENTATION_INVALID', 'Compiled face labels disagree with vertex labels.');
    return state;
  }
  const state: SegmentationFile = {
    format: 'ai-modeling-segmentation-v1',
    source_sha256: geometry.sha256,
    source_metadata: geometry.metadata,
    source_transforms: geometry.sourceTransforms,
    signature: geometry.signature,
    snapshot: initialSnapshot(geometry),
    reserved_names: [
      ...new Set([
        ...geometry.meshes.map((mesh) => mesh.name),
        ...geometry.metadata.children_deleted,
        ...Object.keys(geometry.metadata.children_rename),
        ...Object.keys(geometry.metadata.children_transform_matrix),
      ]),
    ],
    history: { undo: [], redo: [] },
    part_indices: {},
  };
  state.part_indices = compiledLabels(geometry.meshes, attributesOf(state));
  return state;
}
function assertLabel(snapshot: SegmentSnapshot, label: number | undefined): number {
  if (label === undefined || !Object.hasOwn(snapshot.part_names, String(label)))
    throw new TripoError('SEGMENTATION_SELECTION', 'Select an existing target part label.');
  return label;
}
function select(snapshot: SegmentSnapshot, labels: number[], mode: string): void {
  for (const label of labels) assertLabel(snapshot, label);
  const selected = new Set(mode === 'set' ? [] : snapshot.selection);
  for (const label of labels) {
    if (mode === 'remove' || (mode === 'toggle' && selected.has(label))) selected.delete(label);
    else selected.add(label);
  }
  snapshot.selection = [...selected];
}
function meshByName(geometry: SegmentGeometry, name: string): SegmentMesh {
  const mesh = geometry.meshes.find((m) => m.name === name);
  if (!mesh) throw new TripoError('SEGMENTATION_SELECTION', `Unknown mesh: ${name}`);
  return mesh;
}
function faceVertices(mesh: SegmentMesh, faces: number[]): Set<number> {
  const vertices = new Set<number>();
  for (const face of faces) {
    if (face >= mesh.indices.length / 3)
      throw new TripoError('SEGMENTATION_SELECTION', `Face ${face} is outside mesh ${mesh.name}.`);
    for (let corner = 0; corner < 3; corner++) vertices.add(mesh.indices[face * 3 + corner]!);
  }
  return vertices;
}
function newPart(
  state: SegmentationFile,
  attributes: Record<string, Uint8Array>,
  requested?: string,
): number {
  const used = new Set(Object.values(attributes).flatMap((values) => [...new Set(values)]));
  const label = Array.from({ length: 256 }, (_, i) => i).find((i) => !used.has(i));
  if (label === undefined) throw new TripoError('SEGMENTATION_LIMIT', 'All 256 part labels are in use.');
  let suffix = 0;
  const reserved = new Set([...state.reserved_names, ...Object.values(state.snapshot.part_names)]);
  while (reserved.has(`ai_modeling_part_new_${suffix}`)) suffix++;
  const name = requested ?? `ai_modeling_part_new_${suffix}`;
  if (reserved.has(name)) throw new TripoError('SEGMENTATION_NAME', 'Choose a new, unused part name.');
  state.snapshot.part_names[label] = name;
  state.reserved_names = [...new Set([...reserved, name])];
  return label;
}
function mergeLabels(
  snapshot: SegmentSnapshot,
  attributes: Record<string, Uint8Array>,
  requested?: number[],
): void {
  const labels = [...new Set(requested ?? snapshot.selection)];
  if (labels.length < 2)
    throw new TripoError('SEGMENTATION_SELECTION', 'Merge needs at least two distinct parts.');
  for (const label of labels) assertLabel(snapshot, label);
  for (const values of Object.values(attributes))
    for (let i = 0; i < values.length; i++) if (labels.includes(values[i]!)) values[i] = labels[0]!;
  snapshot.selection = [labels[0]!];
}
function mutate(geometry: SegmentGeometry, state: SegmentationFile, action: SegmentAction): void {
  const snapshot = state.snapshot,
    attributes = attributesOf(state);
  if (action.action === 'rename') {
    assertLabel(snapshot, action.label);
    if (snapshot.part_names[action.label] !== action.name && state.reserved_names.includes(action.name))
      throw new TripoError('SEGMENTATION_NAME', 'Name is reserved by a current or previous part.');
    snapshot.part_names[action.label] = action.name;
    state.reserved_names = [...new Set([...state.reserved_names, action.name])];
  } else if (action.action === 'merge') {
    mergeLabels(snapshot, attributes, action.labels);
  } else if (action.action === 'paint' || action.action === 'split') {
    const mesh = meshByName(geometry, action.mesh_name),
      vertices = faceVertices(mesh, action.face_indices);
    const label =
      action.action === 'split'
        ? newPart(state, attributes, action.name)
        : assertLabel(snapshot, action.label);
    for (const i of vertices) attributes[mesh.name]![i] = label;
    snapshot.selection = [label];
  } else if (action.action === 'brush') {
    const label = assertLabel(snapshot, action.label ?? snapshot.selection[0]);
    const meshes = action.mesh_names?.map((name) => meshByName(geometry, name)) ?? geometry.meshes;
    for (const mesh of meshes)
      for (const vertex of brushVertices(mesh, action.point, action.brush_size))
        attributes[mesh.name]![vertex] = label;
  }
  snapshot.attribute_indices = Object.fromEntries(
    Object.entries(attributes).map(([name, values]) => [name, Buffer.from(values).toString('base64')]),
  );
}
function trimHistory(state: SegmentationFile): void {
  // 最多 32 步、16 MiB；大模型自动保留较少撤销步，避免序列化历史无限增长。
  while (
    state.history.undo.length > 32 ||
    (state.history.undo.length &&
      Buffer.byteLength(JSON.stringify(state.history)) > SEGMENTATION_HISTORY_LIMIT)
  )
    state.history.undo.shift();
}
/** 单个 actions 批次失败不会发布半成品；undo/redo 只改本地，reset 清空历史。 */
export function applySegmentActions(
  geometry: SegmentGeometry,
  state: SegmentationFile,
  actions: SegmentAction[],
): void {
  for (const action of actions) {
    if (action.action === 'select') select(state.snapshot, action.labels, action.mode);
    else if (action.action === 'pick') {
      const hit = pickSegment(geometry.meshes, action.ray.origin, action.ray.direction);
      const label = hit && Buffer.from(state.part_indices[hit.mesh_name]!, 'base64')[hit.face_index]!;
      if (!hit) state.snapshot.selection = [];
      else select(state.snapshot, [label!], action.mode);
    } else if (action.action === 'undo' || action.action === 'redo') {
      const source = state.history[action.action],
        target = state.history[action.action === 'undo' ? 'redo' : 'undo'];
      const previous = source.pop();
      if (!previous) throw new TripoError('SEGMENTATION_HISTORY', `Nothing to ${action.action}.`);
      target.push(structuredClone(state.snapshot));
      state.snapshot = previous;
    } else if (action.action === 'reset') {
      state.snapshot = initialSnapshot(geometry);
      state.history = { undo: [], redo: [] };
    } else {
      const before = structuredClone(state.snapshot);
      mutate(geometry, state, action);
      if (JSON.stringify(before) !== JSON.stringify(state.snapshot)) {
        state.history.undo.push(before);
        state.history.redo = [];
        trimHistory(state);
      }
    }
    state.part_indices = compiledLabels(geometry.meshes, attributesOf(state));
  }
  validateSegmentationFile(state);
}
