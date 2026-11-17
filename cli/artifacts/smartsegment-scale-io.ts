/** 仅读取原生GLB；下载临时文件不会成为用户交付或新的网页输入。 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Artifact, Job } from '../../studio/contracts/types.ts';
import type { Gateway } from '../../studio/api/gateway.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import { download } from './download.ts';
import { verifiedArtifactBytes } from './recover-download.ts';

export async function scaleUrlBytes(url: string, dataDir: string): Promise<Buffer> {
  const root = path.join(dataDir, 'smartsegment-scale-checks');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(root, 'source-'));
  try {
    const file = await download(url, directory, 'model.glb', 'glb');
    return await readFile(file.local_path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
export async function nativeScaleBytes(
  job: Job,
  artifact: Artifact,
  gateway: Gateway,
  dataDir: string,
): Promise<Buffer> {
  const bytes =
    (await verifiedArtifactBytes(artifact)) ??
    (await scaleUrlBytes(await gateway.artifactUrl(job, artifact), dataDir));
  // 缓存缺失只允许恢复同一原件；签名网址刷新不能重新定义已冻结的源模型。
  if (
    (artifact.sha256 !== undefined && artifact.sha256 !== createHash('sha256').update(bytes).digest('hex')) ||
    (artifact.bytes !== undefined && artifact.bytes !== bytes.length)
  )
    throw new TripoError(
      'NATIVE_OUTPUT_CONTENT_CHANGED',
      'Recovered native bytes differ from the original artifact receipt.',
      'read',
    );
  return bytes;
}
