/** 项目编辑的显式契约，资源命令与持久任务共用相同冲突和字段校验。 */
import { z } from 'zod';
import { id } from './primitives.ts';
import { matrix } from './advanced.ts';
export const metadataFields = {
  children_deleted: z.array(z.string().min(1)).max(10000),
  children_rename: z.record(z.string().min(1), z.string().min(1).max(100)),
  children_transform_matrix: z.record(z.string().min(1), matrix),
  material_factor: z
    .object({ metallic: z.number().min(0).max(1).optional(), roughness: z.number().min(0).max(1).optional() })
    .strict(),
};
export const metadataSchema = z
  .object(metadataFields)
  .partial()
  .extend({
    project_id: id,
    expected_operator_id: id,
    expected_metadata: z
      .object(metadataFields)
      .strict()
      .optional()
      .describe(
        'Previously read metadata for a local conflict check; upstream has no atomic compare-and-swap.',
      ),
    replace: z
      .boolean()
      .default(false)
      .describe('Restore supplied maps as a complete edit snapshot, including empty maps.'),
    children_visibility: z
      .record(z.string().min(1), z.boolean())
      .optional()
      .describe(
        'Original mesh name → visible; false deletes, true restores without replacing unrelated selections.',
      ),
  })
  .strict()
  .refine(
    (x) => !(x.children_deleted && x.children_visibility),
    'Choose children_deleted or children_visibility.',
  );
