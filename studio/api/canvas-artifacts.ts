/** 画布结果只按运行步骤与资产身份关联；临时链接进入凭据库，后续重生成不能偷换旧任务结果。 */
import { CanvasClient } from './canvas-client.ts';
import type { StudioClient } from './client.ts';
import type { ArtifactLinks } from '../auth/artifact-links.ts';
import type { Job, Artifact } from '../contracts/types.ts';
import { array, object, text, TripoError } from '../contracts/errors.ts';
import { assertCanvasArtifact, canvasCapNodes } from '../contracts/canvas-result.ts';
import { canvasCapResult, frozenCanvasCapUrl } from './canvas-cap-result.ts';
import {
  verifyRunNodes,
  internalAssetMatches,
  animationAssets,
  historicalModelAsset,
  taskUrlMatches,
} from './canvas-result-identity.ts';

export async function readCanvasRun(studio: StudioClient, job: Job): Promise<Record<string, unknown>> {
  const result = object(
    await new CanvasClient(studio).call('/tripo.canvas.api.agent.RunService/GetRun', {
      runId: job.remote_ids.task_id,
    }),
  );
  const run = object(result.run);
  if (run.runId !== job.remote_ids.task_id || run.canvasId !== job.input.canvas_id)
    throw new TripoError('CONTRACT_CHANGED', 'Canvas run identity mismatch.');
  await verifyRunNodes(new CanvasClient(studio), job, run);
  return run;
}
function formatOf(url: string, kind: Artifact['kind']): string {
  const ext = new URL(url).pathname.split('.').at(-1)?.toLowerCase();
  if (ext === 'jpg') return 'jpeg';
  return ext && ['png', 'jpeg', 'webp', 'glb', 'fbx', 'obj', 'stl', 'zip', 'usdz', '3mf'].includes(ext)
    ? ext
    : kind === 'image'
      ? 'image'
      : 'glb';
}
/** 优先核对产物路径中的 taskId，特殊节点另验原运行和结果身份，不按“最新图片”猜测。 */
export async function canvasArtifacts(
  studio: StudioClient,
  job: Job,
  run: Record<string, unknown>,
  links: ArtifactLinks,
  allowMissing = false,
): Promise<Artifact[]> {
  const steps = array(run.steps)
    .map(object)
    .filter((s) => ['RUN_STEP_STATUS_DONE', 'RUN_STEP_STATUS_SUCCEEDED'].includes(text(s.status)));
  const capped = new Set(canvasCapNodes(job));
  const artifacts = await restoreCappedArtifacts(studio, job, run, steps, links);
  const frozenNodes = new Set(artifacts.map((a) => a.canvas_result!.node_id));
  const nodeIds = [...new Set(steps.map((s) => text(s.nodeId)).filter((id) => id && !frozenNodes.has(id)))];
  if (!nodeIds.length) return artifacts;
  const result = object(
    await new CanvasClient(studio).call('/tripo.canvas.api.agent.NodeService/ListNodesAssets', { nodeIds }),
  );
  const client = new CanvasClient(studio);
  const graph = steps.some((s) => text(s.taskId).startsWith('internaltask-'))
    ? object(
        await client.call('/tripo.canvas.api.agent.CanvasService/GetCanvas', {
          canvasId: job.input.canvas_id,
        }),
      )
    : {};
  for (const node of array(result.nodes).map(object)) {
    const step = steps.find((s) => s.nodeId === node.nodeId);
    if (step && capped.has(text(step.nodeId))) {
      const final = await canvasCapResult(studio, job, run, step, array(node.assets).map(object));
      links.set(`${job.job_id}:${final.artifact.artifact_id}`, final.url);
      artifacts.push({ ...final.artifact, index: artifacts.length });
      continue;
    }
    for (const asset of array(node.assets).map(object)) {
      if (!step || asset.nodeId !== node.nodeId || !text(asset.url)) continue;
      let matching =
        taskUrlMatches(text(asset.url), text(step.taskId)) || internalAssetMatches(graph, run, step, asset)
          ? [asset]
          : await animationAssets(client, asset, text(step.taskId));
      if (!matching.length) matching = await historicalModelAsset(studio, asset, text(step.taskId));
      for (const matched of matching) addArtifact(artifacts, matched, job, links);
    }
  }
  if (!allowMissing && [...capped].some((id) => !artifacts.some((a) => a.canvas_result?.node_id === id)))
    throw new TripoError(
      'CANVAS_FINAL_ARTIFACT_UNVERIFIED',
      'The final capped Canvas model is not yet uniquely available.',
      'read',
    );
  if (!artifacts.length && !allowMissing && !['detect'].includes(text(job.input.action)))
    throw new TripoError(
      'ARTIFACT_NOT_READY',
      'Completed Canvas assets cannot yet be matched to the original run.',
    );
  return artifacts;
}
async function restoreCappedArtifacts(
  studio: StudioClient,
  job: Job,
  run: Record<string, unknown>,
  steps: Record<string, unknown>[],
  links: ArtifactLinks,
): Promise<Artifact[]> {
  const artifacts: Artifact[] = [],
    capped = new Set(canvasCapNodes(job));
  for (const step of steps) {
    if (
      !capped.has(text(step.nodeId)) ||
      !job.artifacts.some((a) => a.canvas_result?.node_id === step.nodeId)
    )
      continue;
    const result = await canvasCapResult(studio, job, run, step, []);
    links.set(`${job.job_id}:${result.artifact.artifact_id}`, result.url);
    artifacts.push(result.artifact);
  }
  return artifacts;
}
function addArtifact(
  artifacts: Artifact[],
  asset: Record<string, unknown>,
  job: Job,
  links: ArtifactLinks,
): void {
  const assetId = text(asset.assetId),
    url = text(asset.url);
  if (!assetId || !url || artifacts.some((a) => a.artifact_id === assetId)) return;
  const kind: Artifact['kind'] =
    asset.kind === 'ASSET_KIND_IMAGE'
      ? 'image'
      : asset.kind === 'ASSET_KIND_ANIMATION'
        ? 'animation'
        : 'model';
  links.set(`${job.job_id}:${assetId}`, url);
  artifacts.push({ artifact_id: assetId, kind, format: formatOf(url, kind), index: artifacts.length });
}
export async function canvasArtifactUrl(
  studio: StudioClient,
  job: Job,
  artifact: Artifact,
  links: ArtifactLinks,
): Promise<string> {
  assertCanvasArtifact(job, artifact);
  const cached = links.get(`${job.job_id}:${artifact.artifact_id}`);
  if (cached) return cached;
  if (artifact.canvas_result) {
    const url = await frozenCanvasCapUrl(studio, job, artifact);
    links.set(`${job.job_id}:${artifact.artifact_id}`, url);
    return url;
  }
  await canvasArtifacts(studio, job, await readCanvasRun(studio, job), links);
  const url = links.get(`${job.job_id}:${artifact.artifact_id}`);
  if (!url) throw new TripoError('ARTIFACT_NOT_READY', 'Original Canvas asset is unavailable.');
  return url;
}
