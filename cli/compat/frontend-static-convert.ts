/** 静态兼容导出仅匹配明确选择的组合；不改变缺省请求及旧原生导出义务。 */
import { z } from 'zod';

export const frontendStaticConvertSchema = z
  .object({
    format: z.literal('GLTF'),
    export_orientation: z.enum(['+x', '-x', '+y', '-y']),
    pivot_to_center_bottom: z.boolean(),
    with_animation: z.literal(false),
    animate_in_place: z.literal(false).default(false),
    bake: z.literal(false),
    texture_format: z.enum(['JPEG', 'PNG', 'WEBP']),
    texture_size: z.number().int().min(1).max(8192),
    pack_uv: z.literal(false).default(false),
    export_vertex_colors: z.literal(false).default(false),
    scale_factor: z.literal(1).default(1),
  })
  .strict();

export type FrontendStaticConvertIntent = z.infer<typeof frontendStaticConvertSchema>;

export const frontendStaticConvertWarning =
  'Explicit static GLTF bake=false with a supported axis, an explicit bottom-center pivot switch, texture encoding and size uses the pinned Studio frontend engine plus persistent export-lite authorization. It requires a static exact GLB source and verifies every oriented surface, material, image and supported saved webpage edit. Existing textures must already have the requested JPEG/PNG/WEBP encoding and exact square dimensions; zero-texture sources need no image conversion. It excludes separate retarget motions and rejects embedded skins/clips instead of removing them. Other processing combinations and omitted options retain the native route. The delivered transform creates no new Studio model operator; continue web editing from the original project/operator.';
