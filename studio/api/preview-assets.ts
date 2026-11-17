/** 视口 HDR 是网页公开静态资源；请求不携带账号头，不创建任务或调用 API 钱包。 */
import { networkFetch, type Fetcher } from './client.ts';
import { TripoError } from '../contracts/errors.ts';

export const environmentPresets = ['beach', 'desert', 'forest', 'interior', 'night', 'studio'] as const;
export const maximumHDRBytes = 32 * 1024 * 1024;

export function validateHDR(bytes: Buffer): void {
  const header = bytes.toString('ascii', 0, Math.min(bytes.length, 8192));
  const size = /(?:^|\n)-Y (\d+) \+X (\d+)(?:\r?\n)/.exec(header);
  if (
    !/^#\?(?:RADIANCE|RGBE)\r?\n/.test(header) ||
    !header.includes('FORMAT=32-bit_rle_rgbe') ||
    !size ||
    Number(size[1]) < 1 ||
    Number(size[2]) < 1 ||
    Number(size[1]) * Number(size[2]) > 32 * 1024 * 1024 ||
    bytes.length > maximumHDRBytes
  )
    throw new TripoError(
      'INPUT_FORMAT',
      'Expected a Radiance RGBE HDR environment of at most 32 MiB / 32 megapixels.',
    );
}

export async function fetchEnvironment(preset: string, fetcher: Fetcher = networkFetch): Promise<Buffer> {
  if (!environmentPresets.includes(preset as (typeof environmentPresets)[number]))
    throw new TripoError('INVALID_INPUT', 'Unknown Studio HDR preset.');
  let url = `https://tripo-webapp-assets.tripo3d.ai/studio-prod/images/workspace/view-control/hdr/${preset}.hdr`;
  for (let i = 0; i <= 3; i++) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'https:' ||
      parsed.port ||
      parsed.username ||
      parsed.password ||
      !['studio.tripo3d.ai', 'tripo-webapp-assets.tripo3d.ai'].includes(parsed.hostname)
    )
      throw new TripoError('DOWNLOAD_HOST_DENIED', 'HDR redirect is outside Studio asset hosts.');
    const response = await fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(60000) });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const next = response.headers.get('location');
      if (!next) break;
      url = new URL(next, url).href;
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new TripoError('DOWNLOAD_FAILED', 'Studio HDR download failed.', 'read', {
        http_status: response.status,
      });
    }
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.length;
        if (size > maximumHDRBytes) throw new TripoError('ARTIFACT_TOO_LARGE', 'HDR exceeds 32 MiB.');
        chunks.push(item.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const bytes = Buffer.concat(chunks);
    validateHDR(bytes);
    return bytes;
  }
  throw new TripoError('DOWNLOAD_REDIRECT', 'Too many HDR redirects.');
}
