/** 网页高级操作的显式输入契约；不接受调用方任意指定路径或 HTTP 请求体。 */
import { z } from 'zod';
import { id, prompt } from './primitives.ts';
import { partNames } from './segmentation.ts';
const project = { project_id: id };
const parts = z.array(z.string().min(1).max(256)).max(200).default([]);
export const matrix = z.array(z.number().finite()).length(16);
const point = z.tuple([z.number().finite(), z.number().finite()]);
// 新版网页按 Unicode 字符计数，分割提示与普通生成的 UTF-16 长度边界不同。
const segmentationFields = {
  ...project,
  expected_operator_id: id.optional(),
  model_version: z.enum(['v1.0-20250506', 'v2.0-20260430']).default('v2.0-20260430'),
  segmentation_granularity: z.enum(['simple', 'balanced', 'detailed']).default('balanced'),
  prompt: z
    .string()
    .trim()
    .min(1)
    .refine((value) => Array.from(value).length <= 1000)
    .optional(),
};
const promptedV2 = (x: { prompt?: string; model_version: string }): boolean =>
  !x.prompt || x.model_version === 'v2.0-20260430';
export const advancedSchemas = {
  canvas_run: z
    .object({
      canvas_id: id,
      revision: z.string().regex(/^\d+$/),
      node_ids: z
        .array(id)
        .min(1)
        .max(100)
        .refine((nodes) => new Set(nodes).size === nodes.length, 'Canvas node IDs must be unique.'),
      action: z.enum(['generate', 'regenerate', 'retry', 'detect']).default('generate'),
      // 网页提取流程最多提交 12 个名称；命令行明确拒绝重复/超长项，避免静默截断改变报价和产物。
      parts: z
        .array(z.string().trim().min(1).max(200))
        .min(1)
        .max(12)
        .refine((names) => new Set(names).size === names.length, 'Canvas part names must be unique.')
        .optional(),
    })
    .strict()
    .refine(
      (x) => !x.parts || ['generate', 'regenerate'].includes(x.action),
      'parts only applies to generate or regenerate extraction runs.',
    ),
  modification: z
    .object({
      ...project,
      expected_operator_id: id.optional(),
      indices_path: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Segmentation editor state JSON, bound to this project/operator; alternative to inline labels.',
        ),
      // 网页保存 Uint8Array：每个原网格按三角面顺序存部件标签，不是选中的三角面序号列表。
      part_indices: z
        .record(z.string().min(1), z.array(z.number().int().min(0).max(255)).max(2000000))
        .describe('Mesh name → one segment label (0–255) for each triangle in original order.')
        .optional(),
      part_indices_name: partNames.optional().describe('Segment label → part display name.'),
    })
    .strict()
    .refine(
      (x) =>
        x.indices_path
          ? x.part_indices === undefined && x.part_indices_name === undefined
          : x.part_indices !== undefined && x.part_indices_name !== undefined,
      'Choose indices_path or both part_indices and part_indices_name.',
    ),
  retry: z.object({ ...project }).strict(),

  remesh: z
    .object({
      ...project,
      expected_operator_id: id.optional(),
      face_limit: z.number().int().min(100).max(1000000),
      quad: z.boolean().default(false),
      smart_poly: z.boolean().default(false),
      part_name_list: parts,
      bake: z.boolean().default(true),
    })
    .strict(),
  segment: z
    .object(segmentationFields)
    .strict()
    .refine(promptedV2, 'Custom prompts require segmentation v2.'),
  resegment: z
    .object({
      ...segmentationFields,
      model_version: z.literal('v2.0-20260430').default('v2.0-20260430'),
      operator_id: id,
    })
    .strict()
    .refine(promptedV2, 'Custom prompts require segmentation v2.'),
  complete: z
    .object({
      ...project,
      expected_operator_id: id.optional(),
      part_names: parts,
      completion_mode: z.enum(['ai_completion', 'quick_cap']).default('ai_completion'),
    })
    .strict(),
  local_edit: z
    .object({
      ...project,
      expected_operator_id: id.optional(),
      source_operator_id: id,
      face_limit: z.number().int().min(100).max(2000000).optional(),
      bbox: z.tuple([
        z.tuple([z.number().min(-1).max(1), z.number().min(-1).max(1), z.number().min(-1).max(1)]),
        z.tuple([z.number().min(-1).max(1), z.number().min(-1).max(1), z.number().min(-1).max(1)]),
      ]),
    })
    .strict()
    .refine(
      (x) => x.bbox[0].every((v, i) => v < x.bbox[1][i]!),
      'bbox minimum must be below maximum on each axis.',
    ),
  import_model: z
    .object({
      model_path: z.string().min(1),
      name: z.string().min(1).max(100),
      transform_matrix: matrix.default([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      use_original_uv: z.boolean().default(true),
    })
    .strict(),
  uv_generate: z
    .object({
      ...project,
      expected_operator_id: id.optional(),
      current_operator_id: id,
      action: z.enum(['generate', 'retry']).default('generate'),
    })
    .strict(),
  uv_commit: z.object({ ...project, current_operator_id: id, candidate_operator_id: id }).strict(),
  retexture: z
    .object({
      ...project,
      expected_operator_id: id.optional(),
      prompt,
      image_path: z.string().min(1),
      camera_matrix: matrix,
      strength: z.number().min(0).max(1).default(0.6),
    })
    .strict(),
  retexture_apply: z
    .object({
      ...project,
      expected_operator_id: id.optional(),
      image_map: z
        .array(z.object({ part_name: z.string().max(256), image_path: z.string().min(1) }).strict())
        .min(1)
        .max(200),
    })
    .strict(),
  motion: z
    .object({
      segments: z
        .array(
          z
            .object({
              prompt,
              duration_seconds: z.number().int().min(1).max(10),
              waypoints: z.tuple([point, point]).optional(),
            })
            .strict(),
        )
        .min(1)
        .max(5),
    })
    .strict()
    .refine(
      (x) =>
        x.segments.every(
          (v, i) =>
            !i ||
            !v.waypoints ||
            !x.segments[i - 1]?.waypoints ||
            v.waypoints[0].every((n, j) => n === x.segments[i - 1]!.waypoints![1][j]),
        ),
      'Adjacent motion waypoints must connect.',
    ),
  copy: z.object({ ...project, operator_id: id }).strict(),
  image_process: z
    .object({
      action: z.enum(['multiview', 'split', 'upscale', 'regenerate', 'regenerate_multiview']),
      asset_id: id.optional(),
      image_path: z.string().min(1).optional(),
      output_index: z
        .number()
        .int()
        .min(0)
        .max(15)
        .default(0)
        .describe('Asset image index for multiview, split or upscale; regeneration uses the whole asset.'),
      model_version: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe('For regenerate only: assert the original image model, without changing it.'),
    })
    .strict()
    .refine((x) => Boolean(x.asset_id) !== Boolean(x.image_path), 'Choose an image asset or a file.')
    .refine(
      (x) => !x.image_path || x.action === 'multiview',
      'File input is supported for multiview generation.',
    )
    // 网页后处理使用固定引擎，整批重生只接收 asset_id；不能静默吞掉调用方的模型或图片选择。
    .refine(
      (x) => x.model_version === undefined || x.action === 'regenerate',
      'Only regenerate accepts model_version, as an assertion of the original image model.',
    )
    .refine(
      (x) =>
        x.output_index === 0 ||
        (Boolean(x.asset_id) && !['regenerate', 'regenerate_multiview'].includes(x.action)),
      'A nonzero output_index requires an asset and multiview, split or upscale.',
    ),
};
