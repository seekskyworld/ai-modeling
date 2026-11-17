/** 下载不携带账号头；校验每次重定向，完成验证后以不覆盖的原子硬链接发布。 */
import { open, link, unlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { outputTarget } from '../../studio/files.ts';
import { networkFetch, type Fetcher } from '../../studio/api/client.ts';
import { fetchReadTransport } from '../../studio/api/read-transport.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import type { ArtifactContentHint } from '../../studio/contracts/artifact-source.ts';
import { downloadedContent } from './content-validation.ts';

export function allowedDownload(url: string): boolean {
  try {
    const value = new URL(url);
    const host = value.hostname.toLowerCase();
    return (
      value.protocol === 'https:' &&
      !value.username &&
      !value.password &&
      !value.port &&
      (host === 'tripo3d.ai' ||
        host.endsWith('.tripo3d.ai') ||
        host.endsWith('.data.tripo3d.com') ||
        /^tripo-[a-z0-9.-]+\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(host))
    );
  } catch {
    return false;
  }
}
async function fetchArtifact(url: string, fetcher: Fetcher): Promise<Response> {
  // 公共模型可超过60MiB；整条读取链共用10分钟时限，保留300MiB限制和每跳主机校验。
  const timeoutMs = 600000,
    budget = { signal: AbortSignal.timeout(timeoutMs), deadline: performance.now() + timeoutMs };
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!allowedDownload(url))
      throw new TripoError('DOWNLOAD_HOST_DENIED', 'Artifact URL is outside Tripo storage hosts.');
    // 仅收到Response前的确切GET连接错误可重试；不携带账号头，正文/校验/写盘均在重试之外。
    const response = await fetchReadTransport(
      fetcher,
      url,
      { method: 'GET', redirect: 'manual' },
      {
        readRetry: true,
        timeoutMs,
        budget,
        beforeRetry: () => undefined,
        failure: () =>
          new TripoError(
            'DOWNLOAD_FAILED',
            'Artifact request failed before receiving a response; retry the original download, do not regenerate.',
            'read',
          ),
      },
    );
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get('location');
      await response.body?.cancel();
      if (!next) break;
      url = new URL(next, url).toString();
      continue;
    }
    if (!response.ok || !response.body)
      throw new TripoError('DOWNLOAD_FAILED', 'Artifact download failed.', 'read', {
        http_status: response.status,
      });
    return response;
  }
  throw new TripoError('DOWNLOAD_REDIRECT', 'Too many artifact redirects.');
}
/** 私有图片缓存先收完原字节，之后在同步目录守卫内写入；不跨网络await持有可替换的写路径。 */
export async function downloadArtifactBytes(
  url: string,
  expected: string,
  fetcher: Fetcher = networkFetch,
): Promise<Buffer> {
  const response = await fetchArtifact(url, fetcher).catch((error: unknown) => {
    throw downloadError(error);
  });
  const reader = response.body!.getReader(),
    chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 300 * 1024 * 1024) throw new TripoError('ARTIFACT_TOO_LARGE', 'Artifact exceeds 300 MiB.');
      chunks.push(Buffer.from(value));
    }
    const declared = response.headers.get('content-length');
    if (declared && Number(declared) !== size && !response.headers.get('content-encoding'))
      throw new TripoError('INVALID_ARTIFACT', 'Artifact length does not match the response.');
    const bytes = Buffer.concat(chunks, size);
    downloadedContent(bytes, expected);
    return bytes;
  } catch (error) {
    throw downloadError(error);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
export async function download(
  url: string,
  root: string,
  relative: string,
  expected: string,
  fetcher: Fetcher = networkFetch,
  inferImageExtension = false,
  options: {
    contentHint?: ArtifactContentHint;
    validateBytes?: (bytes: Buffer, format: string) => Promise<void>;
    beforePublish?: () => void;
  } = {},
): Promise<{
  local_path: string;
  sha256: string;
  bytes: number;
  format: string;
  content_validation?: string;
}> {
  const initialTarget = await outputTarget(root, relative);
  const parent = await realpath(path.dirname(initialTarget));
  const temporary = path.join(parent, `.ai-modeling-${randomUUID()}.part`);
  const maximum = 300 * 1024 * 1024;
  const response = await fetchArtifact(url, fetcher).catch((error: unknown) => {
    throw downloadError(error);
  });
  const handle = await open(temporary, 'wx', 0o600);
  let size = 0;
  try {
    const reader = response.body!.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maximum) throw new TripoError('ARTIFACT_TOO_LARGE', 'Artifact exceeds 300 MiB.');
        await handle.writeFile(value);
      }
    } finally {
      // 读流失败后的取消也可能抛同一错误，清理不应盖掉原始失败。
      await reader.cancel().catch(() => undefined);
    }
    const declared = response.headers.get('content-length');
    if (declared && Number(declared) !== size && !response.headers.get('content-encoding'))
      throw new TripoError('INVALID_ARTIFACT', 'Artifact length does not match the response.');
    await handle.sync();
    await handle.close();
    const readHandle = await open(temporary, 'r');
    const bytes = await readHandle.readFile().finally(() => readHandle.close());
    const content = downloadedContent(bytes, expected, options.contentHint);
    const { format } = content;
    await options.validateBytes?.(bytes, format);
    const target = await artifactTarget(root, relative, expected, format, inferImageExtension);
    if ((await realpath(path.dirname(target))) !== parent)
      throw new TripoError('OUTPUT_PATH_DENIED', 'Output directory changed during download.');
    options.beforePublish?.();
    await link(temporary, target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST')
        throw new TripoError('OUTPUT_EXISTS', 'Destination already exists; choose a new path.');
      throw error;
    });
    options.beforePublish?.();
    return {
      local_path: target,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: size,
      format,
      ...('content_validation' in content ? { content_validation: content.content_validation } : {}),
    };
  } catch (error) {
    throw downloadError(error);
  } finally {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
  }
}
/** 兼容CLI自动命名按实物确定图片后缀，同次下载发布；显式目的路径仍严格检查。 */
async function artifactTarget(
  root: string,
  relative: string,
  expected: string,
  format: string,
  inferImageExtension: boolean,
): Promise<string> {
  const compatible =
    expected === 'image'
      ? ['png', 'jpeg', 'webp'].includes(format)
      : (expected === 'animation' && format === 'glb') ||
        format === expected ||
        (format === 'zip' && ['fbx', 'obj', 'usdz', '3mf'].includes(expected)) ||
        (expected === 'zip' && ['usdz', '3mf'].includes(format));
  if (!compatible)
    throw new TripoError(
      'ARTIFACT_FORMAT_MISMATCH',
      'Actual artifact format differs from the requested format.',
      'read',
      { expected, actual: format },
    );
  if (inferImageExtension && ['png', 'jpeg', 'webp'].includes(format))
    relative = relative.slice(0, relative.length - path.extname(relative).length) + '.' + format;
  const extension = path.extname(relative).toLowerCase();
  if (!['.' + format, ...(format === 'jpeg' ? ['.jpg'] : [])].includes(extension))
    throw new TripoError('OUTPUT_EXTENSION', `Use a .${format} destination for this artifact.`, 'read', {
      actual: format,
    });
  return await outputTarget(root, relative);
}
function downloadError(error: unknown): TripoError {
  if (error instanceof TripoError) return error;
  return new TripoError(
    'DOWNLOAD_FAILED',
    'Artifact transfer or local write failed; retry downloading the same task, do not regenerate.',
    'read',
    {
      cause: error instanceof Error ? error.name : 'unknown',
    },
  );
}
