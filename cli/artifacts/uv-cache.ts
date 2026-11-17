/** 网页应用 UV 后原候选 context 返回 2043；应用前保存原布局字节，避免成功任务再也无法下载。 */
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../core/config.ts';
import type { JobStore } from '../storage/jobs.ts';
import type { Gateway } from '../../studio/api/gateway.ts';
import type { Fetcher } from '../../studio/api/client.ts';
import type { Job } from '../../studio/contracts/types.ts';
import { download } from './download.ts';
import { verifiedArtifactBytes } from './recover-download.ts';

/** 仅缓存已成功的精确 UV 候选；失败留在应用前，下一次只恢复下载，不重新生成。 */
export async function preserveUvLayout(
  job: Job,
  config: Config,
  jobs: JobStore,
  gateway: Gateway,
  fetcher?: Fetcher,
): Promise<void> {
  const layout = job.artifacts.find((a) => a.artifact_id === 'uv-layout');
  if (job.state !== 'succeeded' || !layout || (await verifiedArtifactBytes(layout))) return;
  const root = path.join(config.dataDir, 'artifact-cache');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(root, 'uv-'));
  const saved = await download(
    await gateway.artifactUrl(job, layout),
    directory,
    `uv-layout.${layout.format}`,
    layout.format,
    fetcher,
  );
  jobs.saveArtifact(job.job_id, { ...layout, ...saved });
}
