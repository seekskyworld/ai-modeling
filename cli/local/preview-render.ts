/** 本地预览的输入快照和骨架叠加；不把运行时下载的网页 HDR 打包分发。 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { readBoundedFile } from '../../studio/files.ts';
import { fetchEnvironment, maximumHDRBytes, validateHDR } from '../../studio/api/preview-assets.ts';
import { preparePreviewModel } from './preview-model.ts';
import { previewMaterialModel, type PreviewMaterial } from './preview-material.ts';

export async function prepareRender(
  bytes: Buffer,
  format: string,
  options: Record<string, unknown>,
  roots: string[],
  directory: string,
) {
  const prepared = await preparePreviewModel(
    previewMaterialModel(bytes, format, options as PreviewMaterial),
    format,
    options,
  );
  let hdr: Buffer | undefined;
  if (typeof options.environment_path === 'string')
    hdr = (await readBoundedFile(options.environment_path, roots, maximumHDRBytes)).bytes;
  else if (typeof options.environment === 'string') hdr = await fetchEnvironment(options.environment);
  let hdrPath: string | undefined, hdrHash: string | undefined;
  if (hdr) {
    validateHDR(hdr);
    hdrPath = path.join(directory, 'environment.hdr');
    await writeFile(hdrPath, hdr, { mode: 0o600 });
    hdrHash = createHash('sha256').update(hdr).digest('hex');
  }
  return {
    bytes: prepared.bytes,
    config: { selected_animation: prepared.animation, hdr_path: hdrPath },
    summary: {
      animation: prepared.animation ?? null,
      environment_sha256: hdrHash,
      source_meshes: prepared.info.meshes.length,
    },
  };
}

interface FrameEvidence {
  animation_time: number | null;
  pose_sha256: string;
  joints: number;
  bounds: number[][];
  skeleton_lines: number[][][];
}
/** 骨架投影独立合成，等价于网页深度无关的辅助线；不改变模型或其材质透明度。 */
export async function finishRender(
  directory: string,
  options: Record<string, unknown>,
  summary: Record<string, unknown>,
) {
  const report = JSON.parse(await readFile(path.join(directory, 'preview.json'), 'utf8')) as {
    frames: FrameEvidence[];
    fit_bounds: number[][];
  };
  if (options.skeleton) {
    const size = Number(options.size);
    for (const [index, frame] of report.frames.entries()) {
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><g stroke="#67e8f9" stroke-width="${Math.max(1, size / 512)}" fill="none">` +
        frame.skeleton_lines
          .map(([a, b]) => `<path d="M${a![0]! * size},${a![1]! * size}L${b![0]! * size},${b![1]! * size}"/>`)
          .join('') +
        '</g></svg>';
      const target = path.join(
        directory,
        options.action === 'video' ? `frame-${String(index + 1).padStart(4, '0')}.png` : 'output.png',
      );
      const bytes = await sharp(await readFile(target))
        .composite([{ input: Buffer.from(svg) }])
        .png()
        .toBuffer();
      await writeFile(target, bytes, { mode: 0o600 });
    }
  }
  const indices = [...new Set([0, Math.floor(report.frames.length / 2), report.frames.length - 1])];
  return {
    ...summary,
    pixel_equivalent: false,
    display_mode: options.display_mode ?? 'material',
    environment: options.environment ?? (options.environment_path ? 'file' : 'local-area-lights'),
    environment_intensity: options.environment_intensity,
    environment_rotation: options.environment_rotation,
    environment_auto_rotate: options.environment_auto_rotate,
    projection: options.projection,
    zoom: options.zoom ?? 1,
    pan: { x: options.pan_x ?? 0, y: options.pan_y ?? 0 },
    skeleton: options.skeleton ?? false,
    explode: options.explode ?? 0,
    grid: options.grid ?? false,
    camera_motion: options.camera_motion ?? 'fixed',
    frames: report.frames.length,
    fit_bounds: report.fit_bounds,
    distinct_poses: new Set(report.frames.map((f) => f.pose_sha256)).size,
    samples: indices.map((index) => {
      const { skeleton_lines, ...frame } = report.frames[index]!;
      return { frame: index, ...frame, skeleton_segments: skeleton_lines.length };
    }),
  };
}
