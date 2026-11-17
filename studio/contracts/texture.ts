/** 贴图的内容参考、风格参考和部件选择分别建模；四视图空位不可压缩。 */
import { z } from 'zod';
import { id, prompt, imageSource } from './primitives.ts';

export const textureStyles = {
  mecha_pop: 'tripo-studio/style_image/mecha_pop.png',
  heritage: 'tripo-studio/style_image/heritage.png',
  mecha: 'tripo-studio/style_image/mecha.png',
  wood: 'tripo-studio/style_image/wood.jpg',
} as const;
export const textureSchema = z
  .object({
    project_id: id,
    expected_operator_id: id.optional(),
    prompt: prompt.optional(),
    texture_quality: z
      .enum(['fast', 'standard', 'detailed', 'ultra'])
      .default('standard')
      .describe('Generate/upscale quality; PBR uses its fixed engine and ignores the standard default.'),
    texture_seed: z
      .number()
      .int()
      .min(0)
      .max(2147483647)
      .optional()
      .describe(
        'Native texture seed. Studio stores it, but repeated seeds did not reproduce identical textures in live verification.',
      ),
    action: z.enum(['generate', 'pbr', 'upscale']).default('generate'),
    texture_alignment: z
      .enum(['original_image', 'geometry'])
      .default('original_image')
      .describe('Generate only; the default is inactive for PBR/upscale.'),
    image_path: z.string().min(1).optional(),
    image_asset: imageSource.optional(),
    image_paths: z.array(z.string().min(1).nullable()).min(2).max(4).optional(),
    image_assets: z.array(imageSource.nullable()).min(2).max(4).optional(),
    style_image_path: z.string().min(1).optional().describe('Independent style image, billed separately.'),
    style_image_asset: imageSource.optional(),
    style_preset: z.enum(['mecha_pop', 'heritage', 'mecha', 'wood']).optional(),
    part_names: z
      .array(z.string().min(1).max(256))
      .max(200)
      .default([])
      .describe('Original mesh names to texture; empty selects the entire model.'),
    delight: z.boolean().default(true).describe('Generate only; the default is inactive for PBR/upscale.'),
  })
  .strict()
  .refine(
    (x) => x.action === 'generate' || (x.delight && x.texture_alignment === 'original_image'),
    'Non-default delight and texture_alignment require texture action=generate.',
  )
  .refine(
    (x) => x.action !== 'pbr' || x.texture_quality === 'standard',
    'PBR uses a fixed engine and does not accept non-default texture_quality.',
  )
  .superRefine((x, ctx) => {
    const error = (message: string): void => ctx.addIssue({ code: 'custom', message });
    const guides = [x.prompt, x.image_path, x.image_asset, x.image_paths, x.image_assets];
    if (guides.filter(Boolean).length > 1) error('Choose text, one image or multiview content guidance.');
    if ([x.style_image_path, x.style_image_asset, x.style_preset].filter(Boolean).length > 1)
      error('Choose one style source.');
    const views = x.image_paths ?? x.image_assets;
    if (x.action !== 'generate' && x.texture_quality === 'fast')
      error('Fast quality is supported only for texture generation.');
    if (views && (!views[0] || views.filter(Boolean).length < 2))
      error('Multiview requires the front and at least one other view; preserve missing slots as null.');
    if (
      x.action !== 'generate' &&
      ([...guides, x.style_image_path, x.style_image_asset, x.style_preset, x.part_names.length].some(
        Boolean,
      ) ||
        x.texture_seed !== undefined)
    )
      error('PBR and upscale do not accept content/style guidance, texture seeds or selected parts.');
  });
