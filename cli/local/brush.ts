/** Magic Brush 的本地投影、笔刷选择和 UV 烘焙；提交仍由独立 retexture/retexture-apply 命令负责。 */
import { z } from 'zod';
import sharp from 'sharp';
import path from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import type { Config } from '../core/config.ts';
import type { LocalSpec } from './operations.ts';
import { readInput } from '../../studio/files.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import { loadGLB } from './gltf.ts';
import { bakePart } from './brush-raster.ts';
import { brushParts, brushPixels, brushTexture } from './brush-model.ts';
import { localTarget, publishLocal } from './files.ts';
import { processModelResult } from './blender.ts';
const cameraMatrix = z.array(z.number().finite()).length(16);
const snapshotSchema = z
  .object({
    model_path: z.string().min(1),
    destination_path: z.string().min(1),
    blender: z.string().min(1).optional(),
    size: z.number().int().min(128).max(4096).default(1024),
    azimuth: z.number().min(-360).max(360).default(20),
    elevation: z.number().min(-89).max(89).default(12),
    fov: z.number().min(10).max(100).default(50),
  })
  .strict();
const bakeSchema = z
  .object({
    model_path: z.string().min(1),
    model_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    destination_path: z
      .string()
      .min(1)
      .describe('Output JSON manifest; sibling .assets directory contains part textures and preview GLB.'),
    image_path: z.string().min(1).optional(),
    color: z
      .string()
      .regex(/^#[a-fA-F0-9]{6}$/)
      .optional(),
    camera_matrix: cameraMatrix,
    fov: z.number().min(10).max(100).default(50),
    part_names: z.array(z.string().min(1)).min(1).max(200).optional(),
    opacity: z.number().min(0).max(1).default(1),
    strokes: z
      .array(
        z
          .object({
            x: z.number().min(0).max(1),
            y: z.number().min(0).max(1),
            radius: z.number().positive().max(2),
            opacity: z.number().min(0).max(1).default(1),
            erase: z.boolean().default(false),
          })
          .strict(),
      )
      .max(10000)
      .default([])
      .describe(
        'Legacy screen-space selection, origin top-left; empty selects all front-facing surfaces. Use brush-paint for the webpage world-space brush and hardness.',
      ),
  })
  .strict()
  .refine((x) => Boolean(x.image_path) !== Boolean(x.color), 'Choose image_path or color.');
async function bake(config: Config, value: unknown): Promise<unknown> {
  const x = bakeSchema.parse(value),
    target = await localTarget(config.outputDir, x.destination_path, 'json');
  const { io, document, sha256 } = await loadGLB(x.model_path, config.inputRoots);
  if (x.model_sha256 && x.model_sha256 !== sha256)
    throw new TripoError('INPUT_CHANGED', 'Camera snapshot belongs to a different model file.');
  const parts = brushParts(document);
  if (x.part_names?.some((name) => !parts.some((p) => p.name === name)))
    throw new TripoError('INVALID_INPUT', 'Unknown part name; use brush-parts.');
  const image = x.image_path
    ? await brushPixels((await readInput(x.image_path, config.inputRoots)).bytes)
    : undefined;
  const directory = target.slice(0, -5) + '.assets';
  await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST')
      throw new TripoError('OUTPUT_EXISTS', 'Brush output directory already exists.');
    throw error;
  });
  try {
    const images = [];
    for (const [index, part] of parts.entries()) {
      if (x.part_names && !x.part_names.includes(part.name)) continue;
      const material = part.primitive.getMaterial();
      const base = await brushTexture(part);
      const result = bakePart(part.node, part.primitive, base, image, x);
      const bytes = await sharp(result.data, { raw: { width: base.width, height: base.height, channels: 4 } })
        .png()
        .toBuffer();
      const file = path.join(directory, `part-${index}.webp`);
      await publishLocal(file, await sharp(bytes).webp({ lossless: true }).toBuffer(), 'webp');
      const replacement = document.createTexture().setImage(bytes).setMimeType('image/png');
      part.primitive.setMaterial(material!.clone().setBaseColorTexture(replacement));
      images.push({
        part_name: part.name,
        image_path: file,
        changed_pixels: result.changed_pixels,
        width: base.width,
        height: base.height,
      });
    }
    if (!images.some((row) => row.changed_pixels > 0))
      throw new TripoError(
        'BRUSH_EMPTY_SELECTION',
        'No front-facing textured surface was selected; verify camera and strokes.',
      );
    const preview = await publishLocal(
      path.join(directory, 'preview.glb'),
      Buffer.from(await io.writeBinary(document)),
      'glb',
    );
    const result = {
      model_sha256: sha256,
      camera_matrix: x.camera_matrix,
      fov: x.fov,
      image_map: images,
      preview,
      remote_applied: false,
    };
    const manifest = await publishLocal(target, Buffer.from(JSON.stringify(result, null, 2)), 'json');
    return { ...result, manifest };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
export const brushOperations: LocalSpec[] = [
  {
    name: 'brush_snapshot',
    description: 'render a perspective Magic Brush input image and its column-major Studio camera matrix',
    schema: snapshotSchema,
    run: async (config, input) => {
      const x = snapshotSchema.parse(input),
        target = await localTarget(config.outputDir, x.destination_path, 'png');
      const result = await processModelResult(x, config.inputRoots, {
        ...x,
        action: 'brush_snapshot',
        output_format: 'png',
      });
      return {
        ...(await publishLocal(target, result.bytes, 'png')),
        ...result.metadata,
        renderer: 'Blender',
        remote_applied: false,
      };
    },
  },
  {
    name: 'brush_parts',
    description: 'list model part names and texture sizes for Magic Brush selection',
    schema: z.object({ model_path: z.string().min(1) }).strict(),
    readOnly: true,
    run: async (config, input) => {
      const { document, sha256 } = await loadGLB(
        (input as { model_path: string }).model_path,
        config.inputRoots,
      );
      return {
        model_sha256: sha256,
        parts: brushParts(document).map((p) => ({
          name: p.name,
          texture_size: p.primitive.getMaterial()?.getBaseColorTexture()?.getSize(),
          vertices: p.primitive.getAttribute('POSITION')?.getCount(),
        })),
      };
    },
  },
  {
    name: 'brush_bake',
    description:
      'project an image or color through a camera with legacy screen-space selection; use brush-paint for world-space brush strength and hardness',
    schema: bakeSchema,
    run: bake,
  },
];
