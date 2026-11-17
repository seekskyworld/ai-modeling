/** 网页已有素材直接落盘，共用路径/格式/哈希验证；不把远端签名 URL 放入 CLI 或 MCP 输出。 */
import { existingArtifact, existingArtifactSchema } from '../../studio/api/existing-artifact.ts';
import type { StudioClient, Fetcher } from '../../studio/api/client.ts';
import { resolveDestination } from './destination.ts';
import { download } from './download.ts';
import { outputTarget, validateGlb } from '../../studio/files.ts';
import { lstat } from 'node:fs/promises';
import { array, object, TripoError } from '../../studio/contracts/errors.ts';
import type { TaskService } from '../core/service.ts';
import { modelIO } from '../local/gltf.ts';

/** 已由本CLI保存的UV候选优先通过任务恢复；网页已有候选仍走原生context只读接口。 */
export async function downloadAccountArtifact(
  client: StudioClient,
  service: TaskService,
  input: unknown,
): Promise<Record<string, unknown>> {
  const x = existingArtifactSchema.parse(input);
  if (x.kind === 'uv_layout') {
    const job = service.jobs.uvCandidate(service.accountRef(), x.id, x.current_operator_id!, x.operator_id!);
    if (job?.artifacts.some((a) => a.artifact_id === 'uv-layout'))
      return {
        kind: x.kind,
        source_id: x.id,
        operator_id: x.operator_id,
        ...(await service.download(job.job_id, 'uv-layout', x.destination_path)),
      };
  }
  return await downloadExistingArtifact(client, service.config.outputDir, x);
}
export async function downloadExistingArtifact(
  client: StudioClient,
  outputRoot: string,
  input: unknown,
  fetcher?: Fetcher,
): Promise<Record<string, unknown>> {
  const x = existingArtifactSchema.parse(input);
  const destination = await resolveDestination(outputRoot, x.destination_path);
  const target = await outputTarget(destination.root, destination.relative);
  const exists = await lstat(target).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return false;
    },
  );
  if (exists) throw new TripoError('OUTPUT_EXISTS', 'Destination already exists; choose a new path.');
  const source = await existingArtifact(client, x);
  const saved = await download(
    source.url,
    destination.root,
    destination.relative,
    source.format,
    fetcher,
    false,
    {
      contentHint: source.content_hint,
      ...(x.kind === 'motion' ? { validateBytes: validateMotionContent } : {}),
    },
  );
  return {
    kind: x.kind,
    source_id: source.source_id,
    ...(source.operator_id ? { operator_id: source.operator_id } : {}),
    ...(source.project_id ? { project_id: source.project_id } : {}),
    ...(source.canvas_id ? { canvas_id: source.canvas_id } : {}),
    ...(source.template_id ? { template_id: source.template_id } : {}),
    ...(source.node_id ? { node_id: source.node_id } : {}),
    ...(source.job_id ? { job_id: source.job_id } : {}),
    ...(source.representation ? { representation: source.representation } : {}),
    ...(source.input_metadata_scope ? { input_metadata_scope: source.input_metadata_scope } : {}),
    ...saved,
  };
}

/** retarget URL 仍须核实物含动作轨道；静态主骨架不能因 GLB 格式正确而冒充动作下载成功。 */
async function validateMotionContent(bytes: Buffer, format: string): Promise<void> {
  if (format !== 'glb')
    throw new TripoError('INVALID_ARTIFACT', 'Applied motion requires a verified animated GLB.');
  const model = validateGlb(bytes, true);
  const hasClip = array(model.animations)
    .map(object)
    .some((clip) => array(clip.channels).length > 0 && array(clip.samplers).length > 0);
  if (!hasClip)
    throw new TripoError('INVALID_ARTIFACT', 'The selected motion file has no animation channels.');
  try {
    const animations = (await (await modelIO()).readBinary(bytes)).getRoot().listAnimations();
    if (
      !animations.length ||
      animations.some(
        (clip) =>
          !clip.listChannels().length ||
          clip.listChannels().some((channel) => {
            const sampler = channel.getSampler();
            return (
              !channel.getTargetNode() ||
              !channel.getTargetPath() ||
              !sampler?.getInput()?.getCount() ||
              !sampler.getOutput()?.getCount()
            );
          }),
      )
    )
      throw new Error('Missing decoded animation tracks');
  } catch {
    throw new TripoError('INVALID_ARTIFACT', 'The selected motion file has no complete decoded animation.');
  }
}
