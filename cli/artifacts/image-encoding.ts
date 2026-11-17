/** 显式本地CLI交付编码扩展；网页图片下载保原字节，不能把通用Canvas编码函数当作其真实下载分支。 */
import sharp from '../runtime/sharp.ts';
import { detectFormat } from '../../studio/files.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import type { ImageOutputFormat } from '../core/image-output-policy.ts';

export async function encodeImageOutput(
  bytes: Buffer,
  target: ImageOutputFormat,
): Promise<{
  bytes: Buffer;
  source_format: 'png' | 'jpeg' | 'webp';
  width: number;
  height: number;
  processing: string;
}> {
  try {
    const source = detectFormat(bytes);
    if (!['png', 'jpeg', 'webp'].includes(source)) throw new Error('Source is not an image.');
    // 强制完整解码，拒绝只有有效文件头的截断图片；像素预算限制解码内存。
    const decoded = await sharp(bytes, { failOn: 'error', limitInputPixels: 40_000_000 })
      .rotate()
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height, channels } = decoded.info;
    if (source === target)
      return {
        bytes,
        source_format: source as 'png' | 'jpeg',
        width,
        height,
        processing: 'Verified original Studio image; requested format already satisfied',
      };
    const image = sharp(decoded.data, { raw: { width, height, channels } });
    const output =
      target === 'png'
        ? await image.png().toBuffer()
        : await image
            .flatten({ background: { r: 0, g: 0, b: 0 } })
            .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
            .toBuffer();
    if (detectFormat(output) !== target) throw new Error('Encoded image format mismatch.');
    return {
      bytes: output,
      source_format: source as 'png' | 'jpeg' | 'webp',
      width,
      height,
      processing: `Studio original image followed by optional local CLI ${target.toUpperCase()} delivery encoding`,
    };
  } catch (error) {
    if (error instanceof TripoError && error.code === 'IMAGE_RUNTIME_UNAVAILABLE') throw error;
    throw new TripoError(
      'IMAGE_OUTPUT_REQUIREMENT_FAILED',
      'The original Studio image could not be decoded or encoded in the requested output format. Retry this original task; do not regenerate.',
      'read',
    );
  }
}
