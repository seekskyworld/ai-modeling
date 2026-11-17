/** 远端链接过期时只恢复本任务已经验过的本地字节；不重新生成，也不把旧未加工导出冒充新结果。 */
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Artifact, Job } from '../../studio/contracts/types.ts';
import { errorResult, sanitize, TripoError } from '../../studio/contracts/errors.ts';
import { needsExportTransform } from '../../studio/contracts/export-options.ts';
import { detectFormat, outputTarget } from '../../studio/files.ts';
import { localTarget, publishLocal } from '../local/files.ts';

export async function verifiedArtifactBytes(artifact: Artifact): Promise<Buffer | undefined> {
  if (!artifact.local_path || !artifact.sha256 || !artifact.bytes) return;
  let handle;
  try {
    handle = await open(artifact.local_path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== artifact.bytes || stat.size > 300 * 1024 * 1024) return;
    const bytes = await handle.readFile();
    if (createHash('sha256').update(bytes).digest('hex') === artifact.sha256) return bytes;
  } catch (error) {
    if (!['ENOENT', 'ELOOP', 'EACCES'].includes(String((error as NodeJS.ErrnoException).code))) throw error;
  } finally {
    await handle?.close();
  }
}

export async function recoverDownload(
  job: Job,
  artifact: Artifact,
  destination: { root: string; relative: string },
  error: unknown,
  inferImageExtension = false,
  assertCurrent: () => void = () => undefined,
): Promise<Record<string, unknown>> {
  const downloadable =
    error instanceof TripoError &&
    (['DOWNLOAD_FAILED', 'NETWORK_ERROR', 'ARTIFACT_NOT_READY'].includes(error.code) ||
      (error.code === 'UPSTREAM_ERROR' && error.certainty === 'read') ||
      (error.code === 'STUDIO_REJECTED' && error.details.http_status === 404) ||
      (job.operation === 'uv_generate' &&
        error.code === 'STUDIO_REJECTED' &&
        error.details.remote_code === 2043));
  const processed =
    job.operation !== 'export' ||
    !needsExportTransform(job.input) ||
    Boolean(artifact.processing && artifact.source_sha256);
  const bytes = downloadable && processed ? await verifiedArtifactBytes(artifact) : undefined;
  assertCurrent();
  if (!bytes) throw error;
  const format = cachedFormat(artifact, bytes);
  const target = await recoveryTarget(
    destination,
    format,
    inferImageExtension,
    inferImageExtension ? artifact : undefined,
  );
  assertCurrent();
  return {
    ...(target.reused
      ? { local_path: target.path, bytes: bytes.length, sha256: artifact.sha256, format }
      : await publishLocal(target.path, bytes, format, assertCurrent)),
    ...(artifact.processing
      ? { processing: artifact.processing, source_sha256: artifact.source_sha256 }
      : {}),
    restored_from_cache: true,
    remote_download_error: sanitize(errorResult(error)),
  };
}

/** 历史记录可能只剩 image 占位；必须从已核摘要的字节恢复格式，不能按文件名猜测。 */
function cachedFormat(artifact: Artifact, bytes: Buffer): string {
  if (artifact.kind !== 'image' || artifact.format !== 'image') return artifact.format;
  const actual = detectFormat(bytes);
  if (!['png', 'jpeg', 'webp'].includes(actual))
    throw new TripoError('ARTIFACT_FORMAT_MISMATCH', 'The verified cache is not a supported image.', 'read');
  return actual;
}

async function recoveryTarget(
  destination: { root: string; relative: string },
  format: string,
  inferImageExtension: boolean,
  verifiedArtifact?: Artifact,
): Promise<{ path: string; reused: boolean }> {
  let relative = destination.relative;
  if (inferImageExtension && ['png', 'jpeg', 'webp'].includes(format))
    relative = relative.slice(0, relative.length - path.extname(relative).length) + '.' + format;
  // 与首次下载一致接受 JPEG 的两种合法后缀，恢复仍保留调用方指定的完整目标路径。
  const extension = format === 'jpeg' && path.extname(relative).toLowerCase() === '.jpg' ? 'jpg' : format;
  const target = await outputTarget(destination.root, relative);
  // 自动恢复到原目录可直接复用同一已验文件；显式路径及其他既有文件仍不允许覆盖。
  if (await sameVerifiedTarget(verifiedArtifact, target)) return { path: target, reused: true };
  return {
    path: await localTarget(destination.root, path.resolve(destination.root, relative), extension),
    reused: false,
  };
}

async function sameVerifiedTarget(artifact: Artifact | undefined, target: string): Promise<boolean> {
  if (!artifact?.local_path) return false;
  const original = await realpath(artifact.local_path).catch(() => undefined);
  // 规范路径相同还需重新以 O_NOFOLLOW 核验目标；符号链接、替换或损坏的文件不能复用。
  return original === target && Boolean(await verifiedArtifactBytes({ ...artifact, local_path: target }));
}
