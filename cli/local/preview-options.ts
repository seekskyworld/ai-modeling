/** 网页视口的临时设置；只控制本地预览，不混入持久编辑或官方导出参数。 */
import { z } from 'zod';

export const previewFields = {
  size: z.number().int().min(128).max(4096).default(1024),
  azimuth: z.number().min(-360).max(360).default(30),
  elevation: z.number().min(-90).max(90).default(15),
  projection: z.enum(['orthographic', 'perspective']).default('orthographic'),
  fov: z.number().min(10).max(120).default(50).describe('Perspective vertical field of view in degrees.'),
  zoom: z.number().min(0.1).max(10).default(1).describe('Magnification relative to the fitted camera.'),
  pan_x: z
    .number()
    .min(-2)
    .max(2)
    .default(0)
    .describe('Horizontal camera pan as a fraction of the fitted view width.'),
  pan_y: z
    .number()
    .min(-2)
    .max(2)
    .default(0)
    .describe('Vertical camera pan as a fraction of the fitted view height.'),
  shading: z.enum(['original', 'flat', 'smooth']).default('original'),
  display_mode: z
    .enum(['material', 'normal', 'solid', 'unlit', 'toon', 'sketch', 'hologram'])
    .default('material')
    .describe('Local equivalents of Studio viewport modes; not pixel-identical shaders.'),
  wireframe: z.boolean().default(false),
  skeleton: z
    .boolean()
    .default(false)
    .describe('Overlay projected joint connections from the evaluated pose.'),
  explode: z
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe('Separate mesh parts radially; 1 is fully expanded, without random spinning.'),
  grid: z.boolean().default(false).describe('Show a ground grid in the preview.'),
  pbr: z.boolean().optional().describe('Temporary PBR switch; does not change source materials.'),
  metalness: z.number().min(0).max(1).optional(),
  roughness: z.number().min(0).max(1).optional(),
  environment: z
    .enum(['beach', 'desert', 'forest', 'interior', 'night', 'studio'])
    .optional()
    .describe('Fetch a public Studio HDR preset at runtime; overrides the local three-light setup.'),
  environment_path: z
    .string()
    .min(1)
    .optional()
    .describe('Caller-provided Radiance HDR file instead of a preset.'),
  environment_intensity: z.number().min(0).max(2).default(1),
  environment_rotation: z
    .number()
    .min(-360)
    .max(360)
    .default(0)
    .describe('Environment rotation in degrees around the vertical axis.'),
  environment_auto_rotate: z
    .boolean()
    .default(false)
    .describe('Rotate HDR by 0.5 radians per second during video, matching Studio.'),
  animation: z
    .string()
    .min(1)
    .optional()
    .describe('Exact embedded animation name or zero-based index; omit for the binding pose.'),
  animation_time: z.number().min(0).max(86400).default(0).describe('Seconds from the selected clip start.'),
  animation_speed: z.number().positive().max(4).default(1),
  animation_loop: z.boolean().default(true).describe('Loop the clip, or hold its last pose when false.'),
};

/** 共享截图/视频/分享图的组合约束，避免某个入口悄悄忽略传入的设置。 */
export function validPreviewOptions(x: Record<string, unknown>): boolean {
  if (x.environment && x.environment_path) return false;
  if (
    !x.environment &&
    !x.environment_path &&
    (x.environment_auto_rotate || x.environment_rotation || x.environment_intensity !== 1)
  )
    return false;
  if (!x.animation && (x.animation_time || x.animation_speed !== 1 || x.animation_loop === false))
    return false;
  return true;
}
export const previewConstraint =
  'Choose one HDR source before setting its controls; choose an animation before setting playback controls.';

/** 静帧的时间由 animation_time 决定，速度和自动旋转只有视频才会推进。 */
export function validStillPreview(x: Record<string, unknown>): boolean {
  return !x.environment_auto_rotate && x.animation_speed === 1;
}

const previewDefaults = z.object(previewFields).parse({}) as Record<string, unknown>;
/** 已有图片只参与合成，拒绝被忽略的模型视口设置；size 仍控制输出分辨率。 */
export function validImagePreview(x: Record<string, unknown>): boolean {
  return (
    !x.image_path ||
    Object.keys(previewFields).every((key) => key === 'size' || x[key] === previewDefaults[key])
  );
}
