/** 本地模型转换及离线渲染使用独立 Blender 子进程；没有网页凭证，也不执行输入中的脚本。 */
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readModelInput } from '../../studio/files.ts';
import { object, TripoError } from '../../studio/contracts/errors.ts';
import { decodedModel } from './gltf.ts';
import { selectExportParts } from './export-parts.ts';
import { localProcess } from './subprocess.ts';
import { applyModelMetadata } from './model-metadata.ts';
import { prepareRender, finishRender } from './preview-render.ts';
import { environmentValue } from '../core/environment.ts';

/** 在解码、选部件或Blender导入之前读取原件声明；导入丢图不能成为允许空编码的依据。 */
function hasNoSourceTextures(bytes: Buffer, format: string): boolean {
  const json = object(
    JSON.parse(
      format === 'glb' ? bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)) : bytes.toString('utf8'),
    ),
  );
  return [json.images, json.textures].every(
    (value) => value === undefined || (Array.isArray(value) && value.length === 0),
  );
}

export async function processModelResult(
  input: { model_path: string; blender?: string },
  roots: string[],
  options: Record<string, unknown>,
): Promise<{ bytes: Buffer; metadata?: Record<string, unknown> }> {
  const model = await readModelInput(input.model_path, roots);
  if (!['glb', 'gltf'].includes(model.format))
    throw new TripoError('INPUT_FORMAT', 'Local processing requires a self-contained GLB/GLTF.');
  const sourceWithoutImagesOrTextures = hasNoSourceTextures(model.bytes, model.format);
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-model-'));
  try {
    const edited = options.source_metadata
      ? { bytes: await applyModelMetadata(model.bytes, model.format, options.source_metadata), format: 'glb' }
      : model;
    const parts = options.action === 'convert' ? (options.part_names as string[] | undefined) : undefined;
    const preview = options.action === 'snapshot' || options.action === 'video';
    const prepared = preview
      ? await prepareRender(edited.bytes, edited.format, options, roots, directory)
      : undefined;
    const source = path.join(directory, 'source.' + (parts || prepared ? 'glb' : edited.format));
    const config = path.join(directory, 'config.json');
    await writeFile(
      source,
      parts
        ? await selectExportParts(edited.bytes, edited.format, parts)
        : (prepared?.bytes ?? (await decodedModel(edited.bytes, edited.format))),
      { mode: 0o600 },
    );
    await writeFile(
      config,
      JSON.stringify({
        ...options,
        ...prepared?.config,
        source,
        directory,
        source_without_images_or_textures: sourceWithoutImagesOrTextures,
      }),
      { mode: 0o600 },
    );
    await runBlender(input.blender, config);
    const previewMetadata = prepared ? await finishRender(directory, options, prepared.summary) : undefined;
    if (options.action === 'video') await encodeVideo(directory, options);
    const bytes = await readFile(path.join(directory, 'output.' + String(options.output_format)));
    const metadata =
      options.action === 'brush_snapshot'
        ? (JSON.parse(await readFile(path.join(directory, 'camera.json'), 'utf8')) as Record<string, unknown>)
        : previewMetadata;
    return { bytes, metadata: metadata ? { ...metadata, model_sha256: model.sha256 } : undefined };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function processModel(
  input: { model_path: string; blender?: string },
  roots: string[],
  options: Record<string, unknown>,
): Promise<Buffer> {
  return (await processModelResult(input, roots, options)).bytes;
}

/** 子进程错误不回显素材内容或环境凭据。 */
async function runBlender(executable: string | undefined, config: string): Promise<void> {
  try {
    await localProcess(
      executable || environmentValue('BLENDER') || 'blender',
      [
        '--background',
        '--factory-startup',
        '--disable-autoexec',
        '--python-exit-code',
        '1',
        '--python',
        fileURLToPath(new URL('./model-worker.py', import.meta.url)),
        '--',
        config,
      ],
      20 * 60 * 1000,
      4 * 1024 * 1024,
    );
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    throw new TripoError(
      missing ? 'LOCAL_DEPENDENCY_MISSING' : 'LOCAL_MODEL_FAILED',
      missing
        ? 'Install Blender 4.5+ and set AI_MODELING_BLENDER or --blender to its executable.'
        : 'Blender could not process this model.',
      'read',
    );
  }
}
async function encodeVideo(directory: string, options: Record<string, unknown>): Promise<void> {
  try {
    await localProcess(
      typeof options.ffmpeg === 'string' ? options.ffmpeg : environmentValue('FFMPEG') || 'ffmpeg',
      [
        '-nostdin',
        '-v',
        'error',
        '-n',
        '-framerate',
        String(options.fps),
        '-i',
        path.join(directory, 'frame-%04d.png'),
        ...(typeof options.overlay_path === 'string'
          ? [
              '-i',
              options.overlay_path,
              '-filter_complex',
              `[0:v][1:v]overlay=0:0:enable='gte(t,${Math.min(2.5, Number(options.duration) * 0.4)})'`,
            ]
          : []),
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        path.join(directory, 'output.mp4'),
      ],
      120000,
      1024 * 1024,
    );
  } catch {
    throw new TripoError(
      'LOCAL_VIDEO_FAILED',
      'FFmpeg with libx264 is required; set AI_MODELING_FFMPEG or --ffmpeg.',
    );
  }
}
