/** 仅处理原网页导出的 GLB；本地失败可重下原任务，不再提交/扣费。 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { download } from './download.ts';
import { localTarget, publishLocal } from '../local/files.ts';
import { processModel } from '../local/blender.ts';
import { transformedExportFormat } from '../../studio/contracts/export-options.ts';
import { detectFormat } from '../../studio/files.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import { createHash } from 'node:crypto';
import type { Artifact } from '../../studio/contracts/types.ts';
import { LOCAL_EXPORT_PROCESSING } from './local-export-delivery.ts';

export async function downloadTransformedExport(
  url: string,
  root: string,
  relative: string,
  input: Record<string, unknown>,
  assertOutput?: (
    metadata: Pick<Artifact, 'format' | 'sha256' | 'bytes' | 'processing' | 'source_sha256'>,
  ) => void,
): Promise<Record<string, unknown>> {
  const format = transformedExportFormat(input);
  const target = await localTarget(root, path.resolve(root, relative), format);
  const temp = await mkdtemp(path.join(tmpdir(), 'ai-modeling-export-'));
  try {
    const source = await download(url, temp, 'source.glb', 'glb');
    const bytes = await processModel({ model_path: source.local_path }, [temp], {
      ...input,
      action: 'convert',
      output_format: format,
    });
    if (detectFormat(bytes, true) !== format)
      throw new TripoError('INVALID_ARTIFACT', 'Local export conversion returned an unexpected format.');
    const metadata = {
      format,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      processing: LOCAL_EXPORT_PROCESSING,
      source_sha256: source.sha256,
    };
    assertOutput?.(metadata);
    return {
      ...(await publishLocal(target, bytes, format, () => assertOutput?.(metadata))),
      processing: LOCAL_EXPORT_PROCESSING,
      source_sha256: source.sha256,
    };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
