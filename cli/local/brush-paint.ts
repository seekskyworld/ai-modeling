/** 将网页笔刷的颜色/图片、填桶、恢复原贴图和撤销历史封装为可重放的独立 CLI 操作。 */
import { z } from 'zod';
import path from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import sharp from 'sharp';
import { readBoundedFile, readInput } from '../../studio/files.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import type { Config } from '../core/config.ts';
import type { LocalSpec } from './operations.ts';
import { loadGLB } from './gltf.ts';
import { brushParts, brushPixels, brushTexture, type BrushPart } from './brush-model.ts';
import { surfaceMask, paintSurface } from './brush-surface.ts';
import { bakePart, type Pixels } from './brush-raster.ts';
import { localTarget, publishLocal } from './files.ts';

export const brushPoint = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const color = z.string().regex(/^#[a-fA-F0-9]{6}$/);
const names = z.array(z.string().min(1)).min(1).max(256).optional();
const resource = z.union([
  z.object({ color }).strict(),
  z
    .object({
      image_path: z.string().min(1),
      image_sha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      camera_matrix: z.array(z.number().finite()).length(16),
      fov: z.number().min(10).max(100).default(50),
    })
    .strict(),
]);
const stroke = {
  points: z
    .array(brushPoint)
    .min(1)
    .max(1000)
    .describe('World-space surface samples in pointer order; repeated samples accumulate strength.'),
  size: z
    .number()
    .positive()
    .max(10000)
    .describe('World-space brush size; webpage slider value / 1000 on the same model transform.'),
  strength: z.number().min(0).max(1).default(0.2),
  hardness: z
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe('0 is fully feathered, 1 is hard; webpage hardness percentage / 100.'),
  part_names: names,
};
const command = z.discriminatedUnion('action', [
  z.object({ action: z.literal('stroke'), ...stroke, resource }).strict(),
  z.object({ action: z.literal('erase'), ...stroke }).strict(),
  z.object({ action: z.literal('fill'), color, part_names: names }).strict(),
]);
const action = z.union([command, z.object({ action: z.enum(['undo', 'redo', 'reset']) }).strict()]);
type PaintCommand = z.infer<typeof command>;
const historySchema = z
  .object({
    format: z.literal('ai-modeling-brush-v1'),
    model_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    history: z
      .object({ commands: z.array(command).max(128), cursor: z.number().int().min(0).max(128) })
      .strict(),
  })
  .refine((x) => x.history.cursor <= x.history.commands.length, 'History cursor exceeds commands.');
const schema = z
  .object({
    model_path: z.string().min(1).describe('Exact original textured GLB used by this edit history.'),
    history_path: z
      .string()
      .min(1)
      .optional()
      .describe('Prior brush-paint manifest; source and image hashes are checked before replay.'),
    destination_path: z
      .string()
      .min(1)
      .describe('New JSON manifest; sibling .assets directory holds textures and preview GLB.'),
    actions: z.array(action).min(1).max(128),
  })
  .strict();

async function history(config: Config, x: z.infer<typeof schema>, sha256: string) {
  const state = x.history_path
    ? historySchema.parse(
        JSON.parse(
          (await readBoundedFile(x.history_path, config.inputRoots, 4 * 1024 * 1024)).bytes.toString('utf8'),
        ),
      )
    : {
        format: 'ai-modeling-brush-v1' as const,
        model_sha256: sha256,
        history: { commands: [] as PaintCommand[], cursor: 0 },
      };
  if (state.model_sha256 !== sha256)
    throw new TripoError('INPUT_CHANGED', 'Brush history requires the exact original model.');
  const h = state.history;
  for (const edit of x.actions) {
    if (edit.action === 'undo') h.cursor = Math.max(0, h.cursor - 1);
    else if (edit.action === 'redo') h.cursor = Math.min(h.commands.length, h.cursor + 1);
    else if (edit.action === 'reset') {
      h.commands = [];
      h.cursor = 0;
    } else if (edit.action === 'stroke' || edit.action === 'erase' || edit.action === 'fill') {
      h.commands = [...h.commands.slice(0, h.cursor), edit];
      h.cursor++;
    }
  }
  if (h.commands.length > 128)
    throw new TripoError(
      'BRUSH_HISTORY_LIMIT',
      'At most 128 paint actions can be retained per original model.',
    );
  return state;
}
async function images(config: Config, commands: PaintCommand[]): Promise<Map<string, Pixels>> {
  const result = new Map<string, Pixels>();
  let decodedBytes = 0;
  for (const edit of commands) {
    if (edit.action !== 'stroke' || !('image_path' in edit.resource)) continue;
    const source = edit.resource,
      input = await readInput(source.image_path, config.inputRoots);
    if (source.image_sha256 && source.image_sha256 !== input.sha256)
      throw new TripoError('INPUT_CHANGED', 'A brush projection image changed after it was recorded.');
    source.image_sha256 = input.sha256;
    if (!result.has(input.sha256)) {
      const pixels = await brushPixels(input.bytes);
      decodedBytes += pixels.data.length;
      if (decodedBytes > 256 * 1024 * 1024)
        throw new TripoError(
          'BRUSH_IMAGE_LIMIT',
          'Projected images exceed the 256 MiB decoded-image budget.',
        );
      result.set(input.sha256, pixels);
    }
  }
  return result;
}
function apply(
  part: BrushPart,
  original: Pixels,
  current: Pixels,
  edit: PaintCommand,
  imageCache: Map<string, Pixels>,
): Pixels {
  if (edit.part_names && !edit.part_names.includes(part.name)) return current;
  if (edit.action === 'fill')
    return paintSurface(
      part,
      current,
      edit.color,
      new Uint8Array(part.primitive.getAttribute('POSITION')!.getCount()).fill(255),
    );
  const mask = surfaceMask(part, edit);
  if (!mask.some((value) => value > 0)) return current;
  if (edit.action === 'erase') return paintSurface(part, current, original, mask);
  if ('color' in edit.resource) return paintSurface(part, current, edit.resource.color, mask);
  const source = edit.resource;
  const projected = bakePart(part.node, part.primitive, original, imageCache.get(source.image_sha256!)!, {
    camera_matrix: source.camera_matrix,
    fov: source.fov,
    strokes: [],
    opacity: 1,
  });
  return paintSurface(part, current, { ...original, data: projected.data }, mask);
}
function changedPixels(before: Buffer, after: Buffer): number {
  let count = 0;
  for (let i = 0; i < before.length; i += 4)
    if ([0, 1, 2, 3].some((c) => before[i + c] !== after[i + c])) count++;
  return count;
}
async function paint(config: Config, value: unknown) {
  const x = schema.parse(value),
    target = await localTarget(config.outputDir, x.destination_path, 'json');
  const loaded = await loadGLB(x.model_path, config.inputRoots),
    parts = brushParts(loaded.document);
  const state = await history(config, x, loaded.sha256),
    cache = await images(config, state.history.commands);
  for (const edit of state.history.commands)
    if (edit.part_names?.some((name) => !parts.some((part) => part.name === name)))
      throw new TripoError('INVALID_INPUT', 'Unknown part name; use brush-parts.');
  const directory = target.slice(0, -5) + '.assets';
  await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST')
      throw new TripoError('OUTPUT_EXISTS', 'Brush output directory already exists.');
    throw error;
  });
  try {
    const imageMap = [];
    for (const [index, part] of parts.entries()) {
      const original = await brushTexture(part);
      if (
        part.primitive.getMode() !== 4 ||
        !part.primitive.getAttribute('POSITION') ||
        !part.primitive.getAttribute('TEXCOORD_0')
      )
        throw new TripoError('BRUSH_GEOMETRY', 'Use textured UV0 triangles.');
      let current = original;
      for (const edit of state.history.commands.slice(0, state.history.cursor))
        current = apply(part, original, current, edit, cache);
      const raw = { width: current.width, height: current.height, channels: 4 as const };
      const png = await sharp(current.data, { raw }).png().toBuffer();
      const imagePath = path.join(directory, `part-${index}.webp`);
      await publishLocal(imagePath, await sharp(png).webp({ lossless: true }).toBuffer(), 'webp');
      const texture = loaded.document.createTexture().setImage(png).setMimeType('image/png');
      part.primitive.setMaterial(part.primitive.getMaterial()!.clone().setBaseColorTexture(texture));
      imageMap.push({
        part_name: part.name,
        image_path: imagePath,
        width: current.width,
        height: current.height,
        changed_pixels: changedPixels(original.data, current.data),
      });
    }
    const preview = await publishLocal(
      path.join(directory, 'preview.glb'),
      Buffer.from(await loaded.io.writeBinary(loaded.document)),
      'glb',
    );
    const result = {
      ...state,
      image_map: imageMap,
      preview,
      remote_applied: false,
      processing: 'local equivalent of Studio browser Magic Brush; save separately with retexture-apply',
      pose: 'Base mesh positions and stored node matrices, as in the webpage brush; animation is not sampled.',
      pixel_equivalent: false,
    };
    const manifest = await publishLocal(target, Buffer.from(JSON.stringify(result, null, 2)), 'json');
    return { ...result, manifest };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
export const brushPaintOperations: LocalSpec[] = [
  {
    name: 'brush_paint',
    description:
      'paint colors or projected images with world-space brush strength/hardness, fill parts, erase to source, and undo/redo; bake textures for retexture-apply',
    schema,
    run: paint,
  },
];
