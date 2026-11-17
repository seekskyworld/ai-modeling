/** 本地产物与下载采用同样的不覆盖、临时文件和路径边界规则。 */
import { writeFile, link, unlink, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { outputTarget } from '../../studio/files.ts';
import { resolveDestination } from '../artifacts/destination.ts';
import { TripoError } from '../../studio/contracts/errors.ts';

export async function localTarget(root: string, destination: string, extension: string): Promise<string> {
  const resolved = await resolveDestination(root, destination);
  const target = await outputTarget(resolved.root, resolved.relative);
  if (path.extname(target).toLowerCase() !== '.' + extension)
    throw new TripoError('OUTPUT_EXTENSION', `Use a .${extension} destination.`);
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (existing) throw new TripoError('OUTPUT_EXISTS', 'Destination already exists.');
  return target;
}
export async function publishLocal(
  target: string,
  bytes: Buffer,
  format: string,
  beforePublish?: () => void,
): Promise<Record<string, unknown>> {
  if (!bytes.length || bytes.length > 300 * 1024 * 1024)
    throw new TripoError('ARTIFACT_TOO_LARGE', 'Local output must be between 1 byte and 300 MiB.');
  const parent = await realpath(path.dirname(target));
  const temporary = path.join(parent, `.ai-modeling-${randomUUID()}.part`);
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    if ((await realpath(path.dirname(target))) !== parent)
      throw new TripoError('OUTPUT_PATH_DENIED', 'Output directory changed.');
    beforePublish?.();
    await link(temporary, target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') throw new TripoError('OUTPUT_EXISTS', 'Destination already exists.');
      throw error;
    });
    beforePublish?.();
    return {
      local_path: target,
      bytes: bytes.length,
      format,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
