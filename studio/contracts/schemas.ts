/** 严格的公共输入阻止任意网页参数透传；默认值在指纹计算前统一归一化。 */
import { z } from 'zod';
import { metadataSchema } from './metadata.ts';
import type { Operation } from './types.ts';

import { id, imageSource } from './primitives.ts';
import { textureSchema } from './texture.ts';
import { localExportFields, needsExportTransform, supportsExportTexture } from './export-options.ts';
export { textureSchema } from './texture.ts';
import { advancedSchemas } from './advanced.ts';
import { canvasAgentSchemas } from './canvas-agent.ts';
import { exportBatchSchema } from './export-batch.ts';
import { serviceActionSchemas } from './service-actions.ts';
export { id } from './primitives.ts';
export const DEFAULT_IMAGE_MODEL = 'gpt_image_2.5_sunburst';
// 本机文件与已审核网页素材可出现在同一有序引用列表；空槽只适用于模型多视图。
const mixedImageSource = z.union([z.object({ image_path: z.string().min(1) }).strict(), imageSource]);
export const imageSchema = z
  .object({
    prompt: z.string().trim().min(1).max(10000).optional(),
    model_version: z
      .enum([
        'flux.1_dev',
        'flux.1_kontext_pro',
        'gemini_2.5_flash_image_preview',
        'gemini_3.1_flash_image_preview',
        'gemini_3_pro_image_preview',
        'gpt_4o',
        'gpt_image_1.5',
        'gpt_image_2',
        'gpt_image_2.5_sunburst',
        'midjourney',
      ])
      .default(DEFAULT_IMAGE_MODEL),
    amount: z.number().int().min(1).max(4).default(1),
    resolution: z.enum(['1K', '2K', '4K']).default('1K'),
    // auto 表示网页取消比例选择后的省略字段，不把字面 auto 发给上游枚举。
    // 保持既有默认值，避免旧 request_id 在升级后变成不同的输入指纹。
    scale: z
      .enum(['auto', '1:1', '3:4', '4:3', '9:16', '16:9'])
      .default('1:1')
      .describe(
        'Aspect ratio. auto omits the field like Studio with no selected reference-image ratio; it does not guarantee pixel dimensions. Omitted keeps 1:1 for existing request compatibility.',
      ),
    t_pose: z.boolean().default(false),
    sketch_to_render: z.boolean().default(false).describe('Render the primary image as a sketch.'),
    template_id: id.optional(),
    template_name: z
      .enum([
        'asset_extraction',
        'character_completion',
        't_pose',
        'variants',
        'figure',
        '3d_enhance',
        'character_extraction',
        'head_extraction',
        'print_clay',
      ])
      .optional()
      .describe('Resolve a named template from the current Studio template catalog.'),
    image_paths: z
      .array(z.string().min(1))
      .min(1)
      .max(16)
      .optional()
      .describe(
        'Ordered image files. GPT Image 2 and 2.5 Sunburst support 16 without a primary or 15 additional with a primary (16 total); other models retain at most 10 additional references.',
      ),
    image_path: z.string().optional(),
    image_asset: imageSource.optional(),
    image_assets: z
      .array(imageSource)
      .min(1)
      .max(16)
      .optional()
      .describe(
        'Ordered image assets. GPT Image 2 and 2.5 Sunburst support 16 without a primary or 15 additional with a primary (16 total); other models retain at most 10 additional references.',
      ),
    image_sources: z
      .array(mixedImageSource)
      .min(1)
      .max(16)
      .optional()
      .describe(
        'Ordered references mixing image_path and asset_id/output_index; primary stays separate. GPT Image 2 and 2.5 Sunburst support 16 without a primary or 15 additional with a primary (16 total); other models retain at most 10 additional references.',
      ),
  })
  .strict()
  .superRefine((x, ctx) => {
    // DialogEditImage 保留独立主图，并将完整追加数组发给 gen_image_v2。
    // 当前网页 GPT Image 2/2.5 Sunburst 两种角色都计入总16张；其它模型仍沿用10张追加上限。
    const hasPrimary = Boolean(x.image_path || x.image_asset);
    const maximum = ['gpt_image_2', 'gpt_image_2.5_sunburst'].includes(x.model_version)
      ? hasPrimary
        ? 15
        : 16
      : 10;
    for (const key of ['image_paths', 'image_assets', 'image_sources'] as const) {
      if ((x[key]?.length ?? 0) > maximum)
        ctx.addIssue({
          code: 'too_big',
          origin: 'array',
          maximum,
          inclusive: true,
          path: [key],
          message: `This Studio image input allows at most ${maximum} ${hasPrimary ? 'additional references, with the primary counted separately' : 'references'}.`,
        });
    }
  })
  .refine(
    (x) =>
      x.resolution !== '2K' ||
      ![
        'gemini_2.5_flash_image_preview',
        'gemini_3.1_flash_image_preview',
        'gemini_3_pro_image_preview',
      ].includes(x.model_version),
    'Studio returned 1K for 2K requests on Nano Banana models in live verification; choose 1K or 4K explicitly.',
  )
  .refine(
    (x) =>
      !(x.image_path && x.image_asset) &&
      [x.image_paths, x.image_assets, x.image_sources].filter(Boolean).length <= 1,
    'Choose one primary image source and one additional reference source.',
  )
  .refine(
    (x) =>
      Boolean(x.prompt) ||
      Boolean(
        (x.template_id || x.template_name || x.t_pose) &&
        (x.image_path || x.image_asset || x.image_paths || x.image_assets || x.image_sources),
      ),
    'A prompt is required unless editing with a template.',
  )
  .refine((x) => !(x.template_id && x.template_name), 'Choose template_id or template_name.')
  .refine(
    (x) => !x.sketch_to_render || Boolean(x.image_path || x.image_asset),
    'sketch_to_render requires a primary image.',
  )
  // 网页切换 Midjourney 会清空并禁用参考图，不能沿用通用图片模型入口默默上传。
  .refine(
    (x) =>
      x.model_version !== 'midjourney' ||
      !(x.image_path || x.image_asset || x.image_paths || x.image_assets || x.image_sources),
    'Studio Midjourney supports text-to-image only; choose another model for image inputs.',
  );
function validateModelFaces(
  x: { mode?: string; model_version: string; quad: boolean; face_limit: number },
  ctx: z.RefinementCtx,
): void {
  const error = (message: string): void => ctx.addIssue({ code: 'custom', message });
  // P2 单图 100 面的最小网页请求实测 400；UI 下限 500。文生 100 面历史成功，不能跨模式收紧。
  const range = x.model_version.startsWith('Nexus-v2')
    ? [x.mode === 'image' ? 500 : 48, x.quad ? 25000 : 50000]
    : x.model_version.startsWith('Nexus-v1')
      ? [50, 20000]
      : [500, 2000000];
  if (x.face_limit < range[0]! || x.face_limit > range[1]!)
    error(
      `face_limit must be within ${range[0]}–${range[1]} for ${x.model_version}${x.mode ? ` ${x.mode}` : ''}${x.quad ? ' (quad)' : ''}.`,
    );
}
export const modelSchema = z
  .object({
    mode: z.enum(['text', 'image', 'multiview', 'batch']),
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(1024)
      .optional()
      .describe('Text mode only; image inputs have no verified text-prompt mapping.'),
    negative_prompt: z
      .string()
      .max(255)
      .optional()
      .describe('Text-to-model negative guidance; advisory, not a guaranteed constraint.'),
    export_uv: z
      .boolean()
      .optional()
      .describe(
        'Unwrap UVs during model generation; false returns untextured geometry without UVs when texture=false.',
      ),
    image_path: z.string().optional(),
    image_asset: imageSource.optional(),
    image_assets: z.array(imageSource.nullable()).min(1).max(10).optional(),
    image_paths: z.array(z.string().min(1).nullable()).min(1).max(10).optional(),
    image_sources: z
      .array(mixedImageSource.nullable())
      .min(1)
      .max(10)
      .optional()
      .describe(
        'Mixed file/asset references for batch or multiview; multiview order is front, left, back, right with null slots.',
      ),
    model_version: z
      .enum(['v3.1-20260211', 'v3.0-20250812', 'v2.5-20250123', 'Nexus-v1.0-20260214', 'Nexus-v2.0-20260801'])
      .default('v3.1-20260211'),
    face_limit: z.number().int().min(48).max(2000000).default(8000),
    variations: z
      .array(z.object({ face_limit: z.number().int().min(48).max(50000) }).strict())
      .min(2)
      .max(4)
      .optional()
      .describe('P2 face-count variations in one native submission; replaces top-level face_limit.'),
    texture: z.boolean().default(false),
    pbr: z.boolean().default(false),
    texture_quality: z
      .enum(['fast', 'standard', 'detailed', 'ultra'])
      .default('standard')
      .describe('Used when texture=true; the standard default is inactive otherwise.'),
    geometry_quality: z
      .enum(['standard', 'detailed'])
      .default('standard')
      .describe('HD v3.1 only; the standard default is inactive for other model versions.'),
    quad: z.boolean().default(false),
    visibility: z.enum(['private', 'public', 'shareable']).default('private'),
    smart_poly: z.boolean().default(false),
    generate_parts: z.boolean().default(false),
    generate_parts_level: z
      .enum(['coarse', 'medium', 'fine'])
      .default('medium')
      .describe('Used when generate_parts=true: coarse/simple, medium/balanced, fine/detailed.'),
    t_pose: z.boolean().optional().describe('Generate a T-pose reference in text-to-model mode.'),
    symmetry: z
      .boolean()
      .optional()
      .describe(
        'P2 symmetry override. Omit to check the audited primary/front image like Studio; the 1.5s precheck falls back to false. Text/batch modes use false.',
      ),
    model_seed: z.number().int().min(0).max(2147483647).optional(),
    texture_seed: z.number().int().min(0).max(2147483647).optional(),
    enable_image_autofix: z.boolean().default(false).describe('Image and batch modes only.'),
    texture_alignment: z
      .enum(['original_image', 'geometry'])
      .default('original_image')
      .describe('Used when texture=true; the default is inactive otherwise.'),
    delight: z.boolean().default(true).describe('Used when texture=true; the default is inactive otherwise.'),
  })
  .strict()
  .refine(
    (x) => x.negative_prompt === undefined || x.mode === 'text',
    'negative_prompt requires text-to-model mode.',
  )
  // 不改变共享默认值，但拒绝不会进入所选网页分支的显式非默认设置，避免付费后才发现参数未生效。
  .superRefine((x, ctx) => {
    const error = (message: string): void => ctx.addIssue({ code: 'custom', message });
    if (x.prompt !== undefined && x.mode !== 'text') error('prompt requires text-to-model mode.');
    if (x.enable_image_autofix && !['image', 'batch'].includes(x.mode))
      error('enable_image_autofix requires image or batch mode.');
    if (x.geometry_quality !== 'standard' && x.model_version !== 'v3.1-20260211')
      error('Non-default geometry_quality requires HD v3.1.');
    if (
      !x.texture &&
      (x.texture_quality !== 'standard' || x.texture_alignment !== 'original_image' || !x.delight)
    )
      error('Non-default texture_quality, texture_alignment and delight require texture=true.');
    if (!x.generate_parts && x.generate_parts_level !== 'medium')
      error('Non-default generate_parts_level requires generate_parts=true.');
  })
  .superRefine(validateModelFaces)
  .superRefine((x, ctx) => {
    if (x.variations) {
      if (x.model_version !== 'Nexus-v2.0-20260801' || x.mode === 'batch')
        ctx.addIssue({ code: 'custom', message: 'variations requires P2 text/image/multiview mode.' });
      for (const variation of x.variations) validateModelFaces({ ...x, ...variation }, ctx);
    }
    if (
      x.mode === 'batch' &&
      ([x.image_paths, x.image_assets, x.image_sources].filter(Boolean).length !== 1 ||
        x.image_path ||
        x.image_asset ||
        x.prompt ||
        x.image_paths?.some((path) => !path) ||
        x.image_assets?.some((asset) => !asset) ||
        x.image_sources?.some((source) => !source))
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'Batch mode requires one image_paths, image_assets or image_sources list, without empty slots.',
      });
  })
  .superRefine((x, ctx) => {
    if (
      x.mode === 'multiview' &&
      ((x.image_paths?.length ?? x.image_assets?.length ?? x.image_sources?.length ?? 0) > 4 ||
        (x.image_assets && (!x.image_assets[0] || x.image_assets.filter(Boolean).length < 2)) ||
        (x.image_sources && (!x.image_sources[0] || x.image_sources.filter(Boolean).length < 2)))
    )
      ctx.addIssue({ code: 'custom', message: 'Multiview requires two to four views.' });
  })
  .superRefine((x, ctx) => {
    const error = (message: string): void => ctx.addIssue({ code: 'custom', message });
    const primaryCount = [x.image_path, x.image_asset].filter(Boolean).length;
    const referenceCount = [x.image_paths, x.image_assets, x.image_sources].filter(Boolean).length;
    if (x.mode === 'text' && (!x.prompt || primaryCount || referenceCount))
      error('Text mode requires only a prompt.');
    if (x.mode === 'image' && (primaryCount !== 1 || referenceCount))
      error('Image mode requires exactly one image_path or image_asset.');
    if (x.mode === 'multiview' && (referenceCount !== 1 || primaryCount))
      error(
        'Multiview mode requires image_paths, image_assets or image_sources ordered front, left, back, right.',
      );
    if (!x.texture && x.pbr) error('PBR requires texture.');
    if (x.quad && x.face_limit > 50000) error('Quad topology supports at most 50000 faces.');
  })
  .superRefine((x, ctx) => {
    if (x.t_pose && x.mode !== 'text')
      ctx.addIssue({ code: 'custom', message: 't_pose is available in text mode only.' });
    if (x.symmetry !== undefined && x.model_version !== 'Nexus-v2.0-20260801')
      ctx.addIssue({ code: 'custom', message: 'symmetry is available for P2 models only.' });
    if (
      x.mode === 'multiview' &&
      x.image_paths &&
      (!x.image_paths[0] || x.image_paths.filter(Boolean).length < 2)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Multiview requires a front image and at least one other view.',
      });
  });
export const rigSchema = z
  .object({
    project_id: id,
    expected_operator_id: id.optional(),
    model_version: z.enum(['v3.0-20260909', 'v2.5-20260210', 'v1.0-20240301']).default('v3.0-20260909'),
    rig_type: z
      .enum(['biped', 'quadruped', 'hexapod', 'octopod', 'avian', 'serpentine', 'aquatic', 'others', 'auto'])
      .default('biped'),
    force: z.boolean().default(false),
    skeleton_preset: z.enum(['tripo', 'actorcore', 'mixamo', 'unreal', 'vrm', 'unity']).default('mixamo'),
  })
  .strict()
  .superRefine((x, ctx) => {
    const error = (message: string): void => ctx.addIssue({ code: 'custom', message });
    if (!['biped', 'auto'].includes(x.rig_type) && !['mixamo', 'tripo'].includes(x.skeleton_preset))
      error('Non-default skeleton_preset requires biped rigging.');
    if (!['mixamo', 'tripo'].includes(x.skeleton_preset) && x.model_version !== 'v3.0-20260909')
      error('skeleton_preset actorcore/unity/unreal/vrm requires rig v3.0.');
    if (x.model_version === 'v1.0-20240301' && !['biped', 'auto'].includes(x.rig_type))
      error('Rig v1.0 only supports biped.');
    if (x.rig_type === 'others' && x.model_version !== 'v3.0-20260909')
      error('rig_type others requires rig v3.0.');
  });
export const animateSchema = z
  .object({
    project_id: id,
    animation: z
      .string()
      .regex(/^preset:(biped|quadruped|avian|aquatic|hexapod|octopod|serpentine):[a-zA-Z0-9_.-]+$/)
      .optional(),
    motion_asset_id: id.optional(),
    rig_type: z
      .enum(['biped', 'quadruped', 'hexapod', 'octopod', 'avian', 'serpentine', 'aquatic'])
      .optional()
      .describe(
        'Must match a selected preset family; defaults to that family, or biped for generated motion.',
      ),
  })
  .strict()
  .refine(
    (x) => Boolean(x.animation) !== Boolean(x.motion_asset_id),
    'Choose a preset animation or a generated motion_asset_id.',
  )
  .refine(
    (x) => !x.animation || !x.rig_type || x.animation.split(':')[1] === x.rig_type,
    'rig_type must match the preset animation family.',
  )
  .refine(
    (x) => !x.motion_asset_id || !x.rig_type || x.rig_type === 'biped',
    'Generated motion requires a biped rig.',
  )
  .overwrite((x) => ({
    ...x,
    rig_type: (x.rig_type ?? x.animation?.split(':')[1] ?? 'biped') as NonNullable<typeof x.rig_type>,
  }));
// 兼容 CLI 可先规划自动关联动作；提交契约仍强制要求已解析的真实 operator ID。
export const exportIntentSchema = z
  .object({
    project_id: id,
    expected_operator_id: id.optional(),
    bake: z
      .literal(false)
      .optional()
      .describe(
        'Verify an existing static native GLB preserves original texture bytes and basic PBR/UV values; advanced materials, animation and material baking are not supported.',
      ),
    public_model: z
      .boolean()
      .default(false)
      .describe('Use the Studio public-model export route for an accessible model you do not own.'),
    format: z.enum(['glb', 'fbx', 'obj', 'stl', 'usdz', '3mf']).default('glb'),
    name: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,100}$/)
      .default('ai-modeling-model'),
    with_animation: z.boolean().default(false),
    // 导出选择已生成的动作实例；预设名称只用于 animate，不能传给导出接口。
    animations: z
      .array(z.uuid())
      .max(50)
      .default([])
      .describe(
        'Completed animation remote_ids.operator_id values belonging to this project, not preset names.',
      ),
    // 服务实测保留 1023/1536 等整数尺寸，不能用网页五个预设值限制官方 CLI 输入。
    texture_size: z
      .number()
      .int()
      .min(1)
      .max(8192)
      .default(2048)
      .describe(
        'Native texture size cap in pixels; Studio may retain smaller source textures without upscaling.',
      ),
    texture_packaging: z.enum(['embedded', 'zip']).default('embedded'),
    animate_in_place: z.boolean().default(true),
    fbx_preset: z.enum(['blender', '3dsmax', 'mixamo', 'bake_scale']).default('blender'),
    export_orientation: z.enum(['+x', '-x', '+y', '-y']).default('-y'),
    pack_uv: z.boolean().default(false),
    enable_bake_animation: z.boolean().default(false),
    bake_animation_frame: z.number().int().min(0).default(0),
    export_vertex_colors: z.boolean().default(false),
    ...localExportFields,
    scale_factor: z.number().positive().optional(),
    pivot_to_center_bottom: z.boolean().optional(),
    flatten_bottom: z.boolean().optional(),
    flatten_bottom_threshold: z
      .number()
      .positive()
      .optional()
      .describe('Local bottom clipping depth in model units after scale (default 0.01).'),
  })
  .strict()
  .refine(
    (x) =>
      x.bake !== false ||
      (Boolean(x.expected_operator_id) &&
        x.format === 'glb' &&
        x.texture_packaging === 'embedded' &&
        x.export_orientation === '-y' &&
        !x.public_model &&
        !x.with_animation &&
        !x.enable_bake_animation &&
        !x.animations.length &&
        !x.pack_uv &&
        !x.export_vertex_colors &&
        !needsExportTransform(x)),
    'bake=false requires an owned exact source operator and static embedded GLB without UV repacking, pose baking, vertex-color export or local conversion.',
  )
  .refine(
    (x) => x.with_animation || x.enable_bake_animation || x.animations.length === 0,
    'animations requires with_animation or enable_bake_animation.',
  )
  .refine(
    (x) => !x.enable_bake_animation || (!x.with_animation && x.animations.length === 1),
    'Static pose baking requires exactly one animation and with_animation=false.',
  )
  .refine((x) => !x.flatten_bottom || !x.with_animation, 'Bottom clipping requires a static export.')
  .refine(supportsExportTexture, 'texture_format supports OBJ/FBX, GLB PNG/JPEG/WEBP, and USDZ PNG only.')
  // 朝向由原生导出先应用；本地编码/缩放保留读入的几何方向，不再限定为网页默认 -y。
  .refine(
    (x) => !needsExportTransform(x) || x.format !== 'fbx' || x.fbx_preset === 'blender',
    'Local export processing with FBX supports the Blender preset; other presets require a separate native export.',
  );
// 网页允许保留骨骼但不选动作；空数组是否有效由当前来源的绑定状态在提交前核实。
export const exportSchema = exportIntentSchema;
export const operationSchemas = {
  project_edit: metadataSchema.safeExtend({
    export_edits: z
      .object({ part_names: z.array(z.string()).optional(), scale_factor: z.number().positive().optional() })
      .strict()
      .optional(),
  }),
  ...serviceActionSchemas,
  export_batch: exportBatchSchema,
  ...canvasAgentSchemas,
  ...advancedSchemas,
  image: imageSchema,
  model: modelSchema,
  texture: textureSchema,
  rig: rigSchema,
  animate: animateSchema,
  export: exportSchema,
};
export const submissionSchema = z
  .object({
    request_id: id,
    max_estimated_credits: z.number().min(0).max(100000),
    parameters: z.record(z.string(), z.unknown()),
  })
  .strict();
export function normalize(operation: Operation, parameters: unknown): Record<string, unknown> {
  return operationSchemas[operation].parse(parameters);
}
