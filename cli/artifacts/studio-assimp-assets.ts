/** 定制网页引擎仅从已观察的官方地址或调用方目录读取；不将许可未确认的产物随包分发。 */
import { networkFetch, type Fetcher } from '../../studio/api/client.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import { runtimeCache, runtimeSource } from '../runtime/cache.ts';
import {
  studioAssimpFiles,
  studioAssimpUrl,
  runtimeKinds,
  verifyRuntime,
  type RuntimeKind,
  type StudioAssimpAssets,
} from '../runtime/manifest.ts';
export { studioAssimpFiles, studioAssimpHash, type StudioAssimpAssets } from '../runtime/manifest.ts';

async function fetchRuntime(kind: RuntimeKind, fetcher: Fetcher): Promise<Buffer> {
  const file = studioAssimpFiles[kind];
  const response = await fetcher(studioAssimpUrl(kind), {
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok || !response.body)
    throw new TripoError(
      'FRONTEND_RUNTIME_DOWNLOAD',
      'Cannot download the pinned Studio frontend runtime.',
      'read',
      { http_status: response.status },
    );
  const reader = response.body.getReader(),
    chunks: Buffer[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > file.bytes)
        throw new TripoError('FRONTEND_RUNTIME_INTEGRITY', 'Runtime download exceeds its pinned size.');
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return verifyRuntime(Buffer.concat(chunks), kind);
}
export async function loadStudioAssimpAssets(
  options: { dataDir: string; runtimeDir?: string; inputRoots?: string[] },
  fetcher: Fetcher = networkFetch,
): Promise<StudioAssimpAssets> {
  const directory = options.runtimeDir
    ? runtimeSource(options.runtimeDir, options.inputRoots)
    : runtimeCache(options.dataDir, true)!;
  const output = {} as StudioAssimpAssets;
  for (const kind of runtimeKinds) {
    const file = studioAssimpFiles[kind],
      cached = directory.read(kind);
    if (cached) {
      output[kind] = cached;
      continue;
    }
    if (options.runtimeDir)
      throw new TripoError(
        'FRONTEND_RUNTIME_MISSING',
        `The supplied runtime directory must contain ${file.name}.`,
      );
    const downloaded = await fetchRuntime(kind, fetcher).catch((error: unknown) => {
      if (error instanceof TripoError) throw error;
      throw new TripoError(
        'FRONTEND_RUNTIME_DOWNLOAD',
        'Pinned runtime transfer failed; no export was submitted.',
      );
    });
    directory.publish(kind, downloaded);
    // 并发下载只接纳最终文件与固定摘要相同的胜出者，不覆盖或信任未核缓存。
    output[kind] = directory.read(kind)!;
  }
  return output;
}
