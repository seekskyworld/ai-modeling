/** 手工分割文件契约；仅编译好的逐面 Uint8 标签进入网页请求，编辑历史留在本地。 */
import { z } from 'zod';
import { id } from './primitives.ts';
import { TripoError } from './errors.ts';

export const SEGMENTATION_FILE_LIMIT = 64 * 1024 * 1024;
export const SEGMENTATION_HISTORY_LIMIT = 16 * 1024 * 1024;
export const segmentLabel = z.number().int().min(0).max(255);
export const partName = z.string().min(1).max(256);
export const labelKey = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,2})$/)
  .refine((s) => Number(s) <= 255);
export const partNames = z.record(labelKey, partName);
export const segmentationMetadata = z
  .object({
    children_deleted: z.array(partName).max(10000).default([]),
    children_rename: z.record(partName, partName).default({}),
    children_transform_matrix: z.record(partName, z.array(z.number().finite()).length(16)).default({}),
  })
  .strict();
export type SegmentationMetadata = z.infer<typeof segmentationMetadata>;
const labels = z.record(partName, z.string().max(2800000));
export const segmentSnapshot = z
  .object({
    attribute_indices: labels,
    part_names: partNames,
    selection: z.array(segmentLabel).max(256),
  })
  .strict();
export const segmentationFile = z
  .object({
    format: z.literal('ai-modeling-segmentation-v1'),
    source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    source_metadata: segmentationMetadata,
    source_transforms: z.record(partName, z.array(z.number().finite()).length(16)),
    signature: z.record(
      partName,
      z
        .object({
          vertices: z.number().int().positive().max(2000000),
          faces: z.number().int().positive().max(2000000),
        })
        .strict(),
    ),
    binding: z.object({ project_id: id, operator_id: id }).strict().optional(),
    reserved_names: z.array(partName).max(4096),
    snapshot: segmentSnapshot,
    part_indices: labels,
    history: z
      .object({
        undo: z.array(segmentSnapshot).max(32),
        redo: z.array(segmentSnapshot).max(32),
      })
      .strict(),
  })
  .strict();
export type SegmentSnapshot = z.infer<typeof segmentSnapshot>;
export type SegmentationFile = z.infer<typeof segmentationFile>;

/** 严格解码，避免 Buffer 宽松解析把损坏的标签静默截断或补齐。 */
export function decodeLabels(value: string, length: number): Uint8Array {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== length || bytes.toString('base64') !== value)
    throw new TripoError('SEGMENTATION_INVALID', 'Invalid base64 labels or geometry count.');
  return new Uint8Array(bytes);
}
export function sameMeshKeys(left: object, right: object): boolean {
  return JSON.stringify(Object.keys(left).sort()) === JSON.stringify(Object.keys(right).sort());
}
/** 验证当前标签、历史和编译结果的名称/数量；几何首顶点对应关系由编辑器验证。 */
export function validateSegmentationFile(input: unknown): SegmentationFile {
  const state = segmentationFile.parse(input);
  const signature = Object.entries(state.signature);
  if (!sameMeshKeys(state.signature, state.source_transforms))
    throw new TripoError('SEGMENTATION_INVALID', 'Source transforms must match the visible mesh set.');
  if (
    !signature.length ||
    signature.length > 256 ||
    signature.reduce((sum, [, s]) => sum + s.vertices + s.faces, 0) > 8000000
  )
    throw new TripoError('SEGMENTATION_LIMIT', 'Use 1–256 meshes and at most 8 million vertices + faces.');
  for (const snapshot of [state.snapshot, ...state.history.undo, ...state.history.redo]) {
    if (!sameMeshKeys(state.signature, snapshot.attribute_indices))
      throw new TripoError('SEGMENTATION_INVALID', 'Snapshot mesh names differ from the source.');
    if (new Set(Object.values(snapshot.part_names)).size !== Object.keys(snapshot.part_names).length)
      throw new TripoError('SEGMENTATION_INVALID', 'Part names must be unique.');
    for (const [name, counts] of signature) {
      const values = decodeLabels(snapshot.attribute_indices[name]!, counts.vertices);
      assertNamedLabels(values, snapshot.part_names);
    }
    assertNamedLabels(snapshot.selection, snapshot.part_names);
  }
  if (!sameMeshKeys(state.signature, state.part_indices))
    throw new TripoError('SEGMENTATION_INVALID', 'Compiled mesh names differ from the source.');
  for (const [name, counts] of signature)
    assertNamedLabels(decodeLabels(state.part_indices[name]!, counts.faces), state.snapshot.part_names);
  return state;
}
function assertNamedLabels(values: Iterable<number>, names: Record<string, string>): void {
  for (const label of new Set(values))
    if (!Object.hasOwn(names, String(label)))
      throw new TripoError('SEGMENTATION_INVALID', `Segment ${label} has no part name.`);
}
