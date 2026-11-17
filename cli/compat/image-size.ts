/** 把已实测的官方像素尺寸映射为网页分辨率/比例，不用生成后缩放伪装原生尺寸。 */
import { text, TripoError } from '../../studio/contracts/errors.ts';
import type { ImageSizeRequirement } from '../core/image-size-policy.ts';

const bananaSizes: Record<string, string> = {
  '1024x1024': '1:1',
  '864x1184': '3:4',
  '1184x864': '4:3',
  '768x1344': '9:16',
  '1344x768': '16:9',
};
type ImageControls = { resolution: string; scale: string };
const oneK = (scale: string): ImageControls => ({ resolution: '1K', scale });
const gptSizes = {
  '1024x1024': oneK('1:1'),
  '1536x1152': oneK('4:3'),
  '1152x1536': oneK('3:4'),
  '1792x1024': oneK('16:9'),
  '1024x1792': oneK('9:16'),
};
const verifiedPixelSizes: Record<string, Record<string, ImageControls>> = {
  'gemini_2.5_flash_image_preview': Object.fromEntries(
    Object.entries(bananaSizes).map(([size, scale]) => [size, oneK(scale)]),
  ),
  gemini_3_pro_image_preview: {
    '1024x1024': oneK('1:1'),
    '1200x896': oneK('4:3'),
    '896x1200': oneK('3:4'),
    '1376x768': oneK('16:9'),
    '768x1376': oneK('9:16'),
    '4096x4096': { resolution: '4K', scale: '1:1' },
  },
  gpt_image_2: gptSizes,
  'gpt_image_2.5_sunburst': gptSizes,
};

/** 修改已解析的图片参数；未知尺寸和互相冲突的尺寸/比例在上传及付费前拒绝。 */
export function applyImageSize(
  input: Record<string, unknown>,
  modelVersion: string,
): ImageSizeRequirement | undefined {
  if (input.size === undefined) return;
  const size = text(input.size).trim();
  const tier = size.toUpperCase();
  const pixelControls = verifiedPixelSizes[modelVersion]?.[size];
  const resolution = ['1K', '2K', '4K'].includes(tier) ? tier : pixelControls?.resolution;
  const scale = pixelControls?.scale;
  if (!resolution)
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      'This image size has no verified native mapping for the selected Studio model. Use a verified size or resolution.',
    );
  if (
    (input.resolution !== undefined && input.resolution !== resolution) ||
    (scale && input.scale !== undefined && input.scale !== scale)
  )
    throw new TripoError('INVALID_INPUT', 'Image size conflicts with resolution or aspect_ratio/scale.');
  input.resolution = resolution;
  if (scale) input.scale = scale;
  delete input.size;
  if (pixelControls) {
    const [width, height] = size.split('x').map(Number) as [number, number];
    return { width, height };
  }
}
