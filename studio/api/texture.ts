/** 按网页 Texture 面板分离内容/风格及所选部件，上传仍复用审核和文件指纹检查。 */
import { array, text } from '../contracts/errors.ts';
import { textureStyles } from '../contracts/texture.ts';
import type { ImageReference } from './upload.ts';
import type { Submission } from './operations.ts';
type Input = Record<string, unknown>;
type Reference = (input: Input, file?: string) => Promise<ImageReference>;

export async function textureSubmission(input: Input, reference: Reference): Promise<Submission> {
  const body: Input = { project_id: input.project_id, model_version: 'v3.0-20250812' };
  if (input.action !== 'pbr')
    body.texture_quality = input.texture_quality === 'ultra' ? 'extreme' : input.texture_quality;
  if (input.action === 'generate') {
    // 当前网页省略版本，由服务选择 v3.5；显式 v3.0 也被服务忽略，不能声称固定该引擎。
    delete body.model_version;
    Object.assign(body, {
      delight: input.delight,
      texture_alignment: input.texture_alignment,
      ...(input.texture_seed !== undefined ? { texture_seed: input.texture_seed } : {}),
      // 空数组会被当前 v3.5 服务视为“没有部件”并失败；省略时沿用网页的全模型选择。
      ...(array(input.part_names).length ? { part_names: input.part_names } : {}),
      ...(input.prompt ? { prompt_text: input.prompt } : {}),
    });
    if (input.image_path || input.image_asset) body.image = await reference(input);
    if (input.image_paths)
      body.images = await Promise.all(
        array(input.image_paths).map((f) => (f ? reference(input, text(f)) : null)),
      );
    if (input.image_assets)
      body.images = await Promise.all(
        array(input.image_assets).map((image_asset) => (image_asset ? reference({ image_asset }) : null)),
      );
    if (input.style_image_path || input.style_image_asset) {
      const style = await reference(
        { ...input, image_asset: input.style_image_asset },
        text(input.style_image_path) || undefined,
      );
      body.style_image = {
        bucket: style.bucket,
        key: style.key,
        image_audit_result: style.image_audit_result,
      };
    }
    // 国际 Studio 前端 Le().bucket 与四个风格资源的真实值；不接受调用方任意桶/对象键。
    if (input.style_preset)
      body.style_image = {
        bucket: 'tripo-data',
        key: textureStyles[input.style_preset as keyof typeof textureStyles],
      };
  }
  const endpoint =
    input.action === 'pbr'
      ? 'pbr_generate'
      : input.action === 'upscale'
        ? 'texture_upscaler'
        : 'texture_model';
  return { route: `/v2/studio/operation/${endpoint}`, body };
}
