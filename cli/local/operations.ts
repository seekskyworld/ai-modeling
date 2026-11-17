/** 浏览器本地操作的 CLI 实现：裁剪、模型转换、截图、分享图和 MP4；不消耗生成额度。 */
import { z } from 'zod';
import sharp, { type OverlayOptions } from 'sharp';
import QRCode from 'qrcode';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Config } from '../core/config.ts';
import { readInput, detectFormat } from '../../studio/files.ts';
import { object, TripoError } from '../../studio/contracts/errors.ts';
import { shareTemplates } from '../../studio/contracts/share-templates.ts';
import { localExportFields, supportsExportTexture } from '../../studio/contracts/export-options.ts';
import { download } from '../artifacts/download.ts';
import { localTarget, publishLocal } from './files.ts';
import { processModel, processModelResult } from './blender.ts';
import {
  previewFields as camera,
  validPreviewOptions,
  previewConstraint,
  validStillPreview,
  validImagePreview,
} from './preview-options.ts';
import { inspectPreviewModel } from './preview-model.ts';
import { canvasEditOperations } from './canvas-edit.ts';
import { dccOperations } from './dcc.ts';
import { brushOperations } from './brush.ts';
import { brushPaintOperations } from './brush-paint.ts';
import { brushPickOperations } from './brush-pick.ts';
import { segmentationOperations } from './segmentation.ts';
import { uvOperations } from './uv.ts';
import { localMetadataSchema, metadataOperations } from './model-metadata.ts';

const destination = { destination_path: z.string().min(1) };
const modelInput = { model_path: z.string().min(1), blender: z.string().min(1).optional() };
const cropSchema = z
  .object({
    image_path: z.string().min(1),
    ...destination,
    left: z.number().int().min(0),
    top: z.number().int().min(0),
    width: z.number().int().positive().max(32768),
    height: z.number().int().positive().max(32768),
    aspect_ratio: z
      .number()
      .positive()
      .finite()
      .optional()
      .describe('Optional crop ratio constraint (width / height); one source pixel of rounding is allowed.'),
    output_width: z
      .number()
      .int()
      .positive()
      .max(8192)
      .optional()
      .describe('Resize the cropped area to this width, matching the browser fixed-output crop.'),
    output_height: z.number().int().positive().max(8192).optional(),
  })
  .strict()
  .refine(
    (x) => (x.output_width !== undefined) === (x.output_height !== undefined),
    'Provide output_width and output_height together.',
  )
  .refine(
    (x) => !x.aspect_ratio || Math.abs(x.width - x.height * x.aspect_ratio) <= Math.max(1, x.aspect_ratio),
    'Crop dimensions do not match aspect_ratio.',
  );
const convertSchema = z
  .object({
    ...modelInput,
    ...destination,
    format: z.enum(['glb', 'fbx', 'obj', 'stl', 'usdz', '3mf']),
    source_metadata: localMetadataSchema
      .optional()
      .describe(
        'Apply Studio metadata to the original GLB before conversion; do not use an already edited export.',
      ),
    ...localExportFields,
    scale_factor: z.number().positive().optional(),
    pivot_to_center_bottom: z.boolean().optional(),
    flatten_bottom: z.boolean().optional(),
    flatten_bottom_threshold: z.number().positive().optional(),
  })
  .strict()
  .refine(supportsExportTexture, 'texture_format supports OBJ/FBX, GLB PNG/JPEG/WEBP, and USDZ PNG only.');
const previewSchema = z.object({ ...modelInput, ...destination, ...camera }).strict();
const snapshotSchema = previewSchema
  .refine(validPreviewOptions, previewConstraint)
  .refine(validStillPreview, 'Environment auto-rotation and animation speed require video.');
const videoSchema = previewSchema
  .extend({
    template: z.enum(['showcase-dark', 'showcase-sweep']).default('showcase-dark'),
    project_id: z.uuid().optional().describe('Optional project QR; does not change visibility.'),
    duration: z.number().min(1).max(30).default(7),
    fps: z.number().int().min(1).max(60).default(24),
    camera_motion: z.enum(['turntable', 'fixed']).default('turntable'),
    ffmpeg: z.string().min(1).optional(),
  })
  .refine((x) => x.size % 2 === 0 && x.size <= 1920, 'MP4 size must be even and at most 1920.')
  .refine(validPreviewOptions, previewConstraint);
const shareSchema = z
  .object({
    ...destination,
    ...camera,
    model_path: z.string().min(1).optional(),
    image_path: z.string().min(1).optional(),
    blender: z.string().min(1).optional(),
    template: z
      .enum(['retro-window', 'modern-game', 'blister', 'pixel-game', 'classic-game', 'germany'])
      .default('retro-window'),
    project_id: z.uuid().describe('Model project ID used in the share QR. Visibility is not changed.'),
  })
  .strict()
  .refine((x) => Boolean(x.image_path) !== Boolean(x.model_path), 'Choose image_path or model_path.')
  .refine(validPreviewOptions, previewConstraint)
  .refine(validStillPreview, 'Environment auto-rotation and animation speed require video.')
  .refine(validImagePreview, 'Model preview options require model_path, not image_path.');

export interface LocalSpec {
  name: string;
  group?: 'canvas';
  description: string;
  schema: z.ZodType;
  readOnly?: boolean;
  run: (config: Config, input: unknown) => Promise<unknown>;
}

async function crop(config: Config, input: unknown): Promise<unknown> {
  const x = cropSchema.parse(input);
  const target = await localTarget(config.outputDir, x.destination_path, 'png');
  const original = await readInput(x.image_path, config.inputRoots);
  const oriented = await sharp(original.bytes).rotate().png().toBuffer();
  const metadata = await sharp(oriented).metadata();
  if (x.left + x.width > metadata.width || x.top + x.height > metadata.height)
    throw new TripoError('INVALID_INPUT', 'Crop rectangle is outside the oriented image.');
  const cropped = sharp(oriented).extract({ left: x.left, top: x.top, width: x.width, height: x.height });
  // 网页 cropper 的 getResult().canvas 在输出宽高指定时 drawImage 缩放；不新增上传或生成请求。
  if (x.output_width && x.output_height) cropped.resize(x.output_width, x.output_height, { fit: 'fill' });
  const bytes = await cropped.png().toBuffer();
  return {
    ...(await publishLocal(target, bytes, 'png')),
    width: x.output_width ?? x.width,
    height: x.output_height ?? x.height,
    crop: { left: x.left, top: x.top, width: x.width, height: x.height },
  };
}
async function convert(config: Config, input: unknown): Promise<unknown> {
  const x = convertSchema.parse(input);
  const extension = x.format === 'obj' ? 'zip' : x.format;
  const target = await localTarget(config.outputDir, x.destination_path, extension);
  const bytes = await processModel(x, config.inputRoots, {
    ...x,
    action: 'convert',
    format: x.format,
    output_format: extension,
  });
  const actual = detectFormat(bytes, true);
  if (actual !== extension && !(actual === 'zip' && ['usdz', '3mf'].includes(extension)))
    throw new TripoError('INVALID_ARTIFACT', 'Local model conversion returned an unexpected format.');
  return {
    ...(await publishLocal(target, bytes, extension)),
    renderer: 'Blender',
    ...(x.format === 'obj' ? { packaging: 'zip', includes: 'OBJ, MTL and referenced textures' } : {}),
    ...(['obj', 'stl', '3mf'].includes(x.format) ? { animation_preserved: false } : {}),
  };
}
async function snapshot(config: Config, input: unknown): Promise<unknown> {
  const x = snapshotSchema.parse(input);
  const target = await localTarget(config.outputDir, x.destination_path, 'png');
  const { bytes, metadata } = await processModelResult(x, config.inputRoots, {
    ...x,
    action: 'snapshot',
    output_format: 'png',
  });
  if (detectFormat(bytes) !== 'png') throw new TripoError('INVALID_ARTIFACT', 'Expected a PNG render.');
  return {
    ...(await publishLocal(target, bytes, 'png')),
    renderer: 'Blender',
    width: x.size,
    height: x.size,
    preview: metadata,
    view_settings: {
      shading: x.shading,
      wireframe: x.wireframe,
      pbr: x.pbr,
      metalness: x.metalness,
      roughness: x.roughness,
    },
  };
}
async function video(config: Config, input: unknown): Promise<unknown> {
  const x = videoSchema.parse(input);
  const target = await localTarget(config.outputDir, x.destination_path, 'mp4');
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-video-branding-'));
  let bytes: Buffer, metadata: Record<string, unknown> | undefined;
  try {
    const overlay = await videoOverlay(directory, x.size, x.template, x.project_id);
    ({ bytes, metadata } = await processModelResult(x, config.inputRoots, {
      ...x,
      action: 'video',
      output_format: 'mp4',
      overlay_path: overlay,
    }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  if (bytes.toString('ascii', 4, 8) !== 'ftyp')
    throw new TripoError('INVALID_ARTIFACT', 'Expected an MP4 video.');
  return {
    ...(await publishLocal(target, bytes, 'mp4')),
    renderer: 'Blender',
    duration: x.duration,
    fps: x.fps,
    template: x.template,
    preview: metadata,
    visibility_changed: false,
  };
}
/** 分享水印与二维码均在本地合成，不调用社交发布或奖励接口。 */
async function videoOverlay(
  directory: string,
  size: number,
  template: string,
  project?: string,
): Promise<string> {
  const saved = await download(
    'https://studio.tripo3d.ai/images/share/video-credit.webp',
    directory,
    'credit.webp',
    'webp',
  );
  const width = Math.round(size * 0.6);
  const credit = await sharp(await readFile(saved.local_path))
    .resize({ width })
    .png()
    .toBuffer();
  const meta = await sharp(credit).metadata();
  const layers: OverlayOptions[] = [
    { input: credit, left: Math.round(size * 0.05), top: size - meta.height - Math.round(size * 0.03) },
  ];
  if (project) {
    const url = `https://studio.tripo3d.ai/3d-model/${project}`;
    // qrcode 在 width 小于模块数时会退回 256px；按最小模块数取整，避免小视频被裁切。
    const minimum = QRCode.create(url).modules.size + 2;
    const sweep = template === 'showcase-sweep',
      qrSize = Math.max(minimum, Math.round(size * (sweep ? 0.18 : 0.15)));
    const qr = await QRCode.toBuffer(url, {
      width: qrSize,
      margin: 1,
      color: { dark: '#FFFFFFFF', light: '#00000000' },
    });
    layers.push({
      input: qr,
      left: Math.min(size - qrSize - 2, Math.round(size * (sweep ? 0.75 : 0.78))),
      top: Math.min(size - qrSize - 2, Math.round(size * (sweep ? 0.75 : 0.07))),
    });
  }
  const target = path.join(directory, 'overlay.png');
  await writeFile(
    target,
    await sharp({ create: { width: size, height: size, channels: 4, background: '#00000000' } })
      .composite(layers)
      .png()
      .toBuffer(),
    { mode: 0o600 },
  );
  return target;
}
async function share(config: Config, input: unknown): Promise<unknown> {
  const x = shareSchema.parse(input);
  const target = await localTarget(config.outputDir, x.destination_path, 'png');
  const template = shareTemplates.find((t) => t.id === x.template)!;
  const url = `https://studio.tripo3d.ai/3d-model/${x.project_id}`;
  const minimum = QRCode.create(url, { errorCorrectionLevel: 'H' }).modules.size + 4;
  if (Math.round((x.size * template.qr[2]) / 100) < minimum)
    throw new TripoError(
      'INVALID_INPUT',
      'Share image size is too small for this template QR; use 512 or larger.',
    );
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-share-'));
  const asset = async (name: string, logo = false): Promise<Buffer> => {
    const url = 'https://studio.tripo3d.ai/' + (logo ? name : 'images/share/templates/' + name);
    const saved = await download(url, directory, name, logo ? 'png' : 'webp');
    return await readFile(saved.local_path);
  };
  try {
    const background = await asset(template.background);
    const rendered = x.model_path
      ? await processModelResult({ model_path: x.model_path, blender: x.blender }, config.inputRoots, {
          ...x,
          action: 'snapshot',
          output_format: 'png',
        })
      : undefined;
    const render = rendered?.bytes ?? (await readInput(x.image_path!, config.inputRoots)).bytes;
    const px = (percent: number): number => Math.round((x.size * percent) / 100);
    const [left, top, width] = template.model;
    const layers: OverlayOptions[] = [
      {
        input: await sharp(render)
          .resize(px(width), px(width), { fit: 'contain', background: '#00000000' })
          .png()
          .toBuffer(),
        left: px(left),
        top: px(top),
      },
    ];
    if ('sticker' in template)
      layers.push({
        input: await sharp(await asset(template.sticker))
          .resize(x.size, x.size)
          .toBuffer(),
        left: 0,
        top: 0,
      });
    const [ql, qt, qw] = template.qr;
    const qr = await QRCode.toBuffer(url, {
      width: px(qw),
      margin: 2,
      errorCorrectionLevel: 'H',
      color: { dark: '#000000FF', light: 'qrBackground' in template ? template.qrBackground : '#00000000' },
    });
    if ('qrBox' in template)
      layers.push({
        input: await sharp(await asset(template.qrBox))
          .resize(px(qw), px(qw))
          .toBuffer(),
        left: px(ql),
        top: px(qt),
      });
    layers.push({ input: qr, left: px(ql), top: px(qt) });
    if ('logo' in template) {
      const size = Math.round(px(qw) * 0.2);
      layers.push({
        input: await sharp(await asset('logo-48x48.png', true))
          .resize(size, size)
          .toBuffer(),
        left: px(ql) + Math.round((px(qw) - size) / 2),
        top: px(qt) + Math.round((px(qw) - size) / 2),
      });
    }
    const bytes = await sharp(background).resize(x.size, x.size).composite(layers).png().toBuffer();
    return {
      ...(await publishLocal(target, bytes, 'png')),
      template: x.template,
      preview: rendered?.metadata,
      visibility_changed: false,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
export const localOperations: LocalSpec[] = [
  ...canvasEditOperations,
  ...dccOperations,
  ...brushOperations,
  ...brushPaintOperations,
  ...brushPickOperations,
  ...segmentationOperations,
  ...uvOperations,
  ...metadataOperations,
  {
    name: 'image_crop',
    description: 'crop an image locally with an optional aspect ratio and fixed output size, saving PNG',
    schema: cropSchema,
    run: crop,
  },
  {
    name: 'local_convert',
    description: 'convert a self-contained GLB locally with Blender; no Studio request or credits',
    schema: convertSchema,
    run: convert,
  },
  {
    name: 'model_inspect',
    description: 'inspect embedded animation names, durations, mesh parts and skeletons for local previews',
    schema: z.object({ model_path: z.string().min(1) }).strict(),
    readOnly: true,
    run: async (config, input) =>
      await inspectPreviewModel(object(input).model_path as string, config.inputRoots),
  },
  {
    name: 'snapshot',
    description: 'render a model PNG with viewport modes, HDR, part expansion and an optional animation pose',
    schema: snapshotSchema,
    run: snapshot,
  },
  {
    name: 'showcase_video',
    description: 'render Showcase Dark or Showcase Sweep MP4 locally with Blender and FFmpeg',
    schema: videoSchema,
    run: video,
  },
  {
    name: 'share_image',
    description: 'compose one of the six Studio share-image templates with a model preview and QR',
    schema: shareSchema,
    run: share,
  },
  {
    name: 'share_templates',
    description: 'list supported Studio share-image templates and local video capabilities',
    schema: z.object({}).strict(),
    readOnly: true,
    run: async () => ({
      source_date: '2026-11-12',
      images: shareTemplates,
      video: { kind: 'turntable', renderer: 'Blender', pixel_equivalent: false },
    }),
  },
];
export async function runLocal(config: Config, spec: LocalSpec, input: unknown): Promise<unknown> {
  return await spec.run(config, object(spec.schema.parse(input)));
}
