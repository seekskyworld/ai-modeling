/** 网页批量导出最多 10 个自有项目，字段与逐项导出分开校验。 */
import { z } from 'zod';
export const exportBatchSchema = z
  .object({
    projects: z
      .array(z.uuid())
      .min(1)
      .max(10)
      .refine((ids) => new Set(ids).size === ids.length, 'Duplicate projects are not allowed.'),
    format: z.enum(['glb', 'fbx', 'obj', 'stl', 'usdz', '3mf']).default('glb'),
    texture_size: z
      .union([z.literal(512), z.literal(1024), z.literal(2048), z.literal(4096), z.literal(8192)])
      .default(2048),
    texture_packaging: z.enum(['embedded', 'zip']).default('embedded'),
    fbx_preset: z.enum(['blender', '3dsmax', 'mixamo']).default('blender'),
    export_orientation: z.enum(['+x', '-x', '+y', '-y']).default('-y'),
    pack_uv: z.boolean().default(false),
    export_vertex_colors: z.boolean().default(false),
  })
  .strict();
