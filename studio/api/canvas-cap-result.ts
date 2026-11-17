/** 网页 quick_cap 会在分割后建立独立 mesh_fill；只接受可唯一复核的完整运行血缘。 */
import type { StudioClient } from './client.ts';
import { CanvasClient } from './canvas-client.ts';
import { array, object, text, TripoError } from '../contracts/errors.ts';
import type { Artifact, CanvasResultBinding, Job } from '../contracts/types.ts';
import { canvasFinalId, validCanvasResult } from '../contracts/canvas-result.ts';
import { taskUrlMatches } from './canvas-result-identity.ts';
import { stableCanvasResource } from './canvas-state.ts';

function mismatch(message: string): never {
  throw new TripoError('CANVAS_FINAL_ARTIFACT_UNVERIFIED', message, 'read');
}
function sameFile(a: unknown, b: unknown): boolean {
  try {
    const x = new URL(text(a)),
      y = new URL(text(b));
    return (
      x.protocol === 'https:' &&
      y.protocol === 'https:' &&
      stableCanvasResource(x.toString()) === stableCanvasResource(y.toString())
    );
  } catch {
    return false;
  }
}
function currentRun(
  graph: Record<string, unknown>,
  run: Record<string, unknown>,
  step: Record<string, unknown>,
  assetId: string,
): void {
  const matches = array(graph.nodeRuns)
    .map(object)
    .filter((n) => n.nodeId === step.nodeId);
  const node = matches[0];
  if (
    object(graph.canvas).canvasId !== run.canvasId ||
    matches.length !== 1 ||
    node?.runId !== run.runId ||
    node?.currentStepId !== step.stepId ||
    node?.status !== 'NODE_STATUS_DONE' ||
    (text(node?.selectedAssetId) && node?.selectedAssetId !== assetId)
  )
    mismatch('The Canvas node no longer uniquely identifies this original run and step.');
}
async function exactOperator(
  studio: StudioClient,
  projectId: string,
  operatorId: string,
  type: string,
): Promise<Record<string, unknown>> {
  const project = object(
    await studio.request(
      'GET',
      `/v2/studio/project/detail/v3/${encodeURIComponent(projectId)}?operator_id=${encodeURIComponent(operatorId)}`,
    ),
  );
  const op = object(project.operator);
  if (
    project.id !== projectId ||
    op.operator_id !== operatorId ||
    op.type !== type ||
    op.status !== 'success' ||
    (project.is_owner !== true && op.is_owner !== true) ||
    !text(op.model_url) ||
    !sameFile(project.model_url, op.model_url)
  )
    mismatch('The exact Canvas result project or operation could not be verified.');
  return op;
}
export async function frozenCanvasCapUrl(
  studio: StudioClient,
  job: Job,
  artifact: Artifact,
): Promise<string> {
  if (!validCanvasResult(job, artifact)) mismatch('The frozen Canvas result identity is invalid.');
  const b = artifact.canvas_result!;
  const op = await exactOperator(studio, b.project_id, b.final_operator_id, 'mesh_fill');
  if (!taskUrlMatches(text(op.model_url), b.final_operator_id))
    mismatch('The final model URL belongs to another operation.');
  return text(op.model_url);
}

function uniqueCapAsset(
  step: Record<string, unknown>,
  assets: Record<string, unknown>[],
): Record<string, unknown> {
  // 两个真实节点 selectedAssetId 均为空；仅唯一 CURRENT/READY 模型允许走此分支，不能选“最新”。
  const candidates = assets.filter(
    (a) =>
      a.nodeId === step.nodeId &&
      a.kind === 'ASSET_KIND_MODEL' &&
      a.source === 'ASSET_SOURCE_STUDIO' &&
      a.role === 'ASSET_ROLE_CURRENT' &&
      a.studioState === 'STUDIO_ASSET_STATE_READY',
  );
  if (candidates.length !== 1) mismatch('No unique current ready model identifies this capped result.');
  const asset = candidates[0]!,
    assetId = text(asset.assetId);
  if (!assetId || !taskUrlMatches(text(asset.thumbnailUrl), text(step.taskId)))
    mismatch('The capped asset preview does not identify the original segmentation.');
  return asset;
}
async function capAssetDetail(
  client: CanvasClient,
  asset: Record<string, unknown>,
): Promise<{ projectId: string; finalId: string }> {
  const assetId = text(asset.assetId);
  const response = object(
    await client.call('/tripo.canvas.api.agent.NodeService/GetNodeAssetDetail', { assetId }),
  );
  const detail = object(response.detail),
    projectId = text(detail.id),
    finalId = text(detail.operator_id);
  if (
    response.assetId !== assetId ||
    response.provider !== 'studio' ||
    !projectId ||
    !finalId ||
    detail.is_owner !== true ||
    detail.status !== 'success' ||
    detail.type !== 'mesh_fill' ||
    !sameFile(detail.model_url, asset.url)
  )
    mismatch('The current Canvas asset is not its completed owned mesh_fill result.');
  return { projectId, finalId };
}
async function verifyCapHistory(
  studio: StudioClient,
  projectId: string,
  finalId: string,
  asset: Record<string, unknown>,
  step: Record<string, unknown>,
): Promise<{ segmentId: string; url: string }> {
  const readHistory = async () =>
    array(
      object(await studio.request('GET', `/v2/studio/project/history/${encodeURIComponent(projectId)}`))
        .history,
    ).map(object);
  const history = await readHistory();
  // 没有显式 parent 字段，因此首次绑定只接受网页自动创建的两步链；时间相近不作为证据。
  if (
    history.length !== 2 ||
    history[0]?.operator_id !== finalId ||
    history[0]?.type !== 'mesh_fill' ||
    history[1]?.type !== 'ai_segmentation'
  )
    mismatch('The Canvas result history is ambiguous or contains later editing operations.');
  const segmentId = text(history[1]?.operator_id);
  if (!segmentId || segmentId === finalId) mismatch('The segmentation history identity is invalid.');
  const source = await exactOperator(studio, projectId, segmentId, 'ai_segmentation');
  const final = await exactOperator(studio, projectId, finalId, 'mesh_fill');
  if (
    !taskUrlMatches(text(source.model_url), text(step.taskId)) ||
    !taskUrlMatches(text(source.segmentation_map_url), text(step.taskId)) ||
    !taskUrlMatches(text(final.model_url), finalId) ||
    !sameFile(final.model_url, asset.url)
  )
    mismatch('The segmentation and capped model do not form this original run’s exact result chain.');
  const after = await readHistory();
  if (
    after.length !== 2 ||
    after.some((op, i) => op.operator_id !== history[i]?.operator_id || op.type !== history[i]?.type)
  )
    mismatch('The result history changed while its identity was being verified.');
  return { segmentId, url: text(final.model_url) };
}

export async function canvasCapResult(
  studio: StudioClient,
  job: Job,
  run: Record<string, unknown>,
  step: Record<string, unknown>,
  assets: Record<string, unknown>[],
): Promise<{ artifact: Artifact; url: string }> {
  const saved = job.artifacts.filter((a) => a.canvas_result?.node_id === step.nodeId);
  if (saved.length) {
    const artifact = saved[0]!;
    if (
      saved.length !== 1 ||
      !validCanvasResult(job, artifact) ||
      artifact.canvas_result!.step_id !== step.stepId ||
      artifact.canvas_result!.task_id !== step.taskId
    )
      mismatch('The original Canvas step differs from the frozen final result.');
    return { artifact, url: await frozenCanvasCapUrl(studio, job, artifact) };
  }
  if (
    !text(step.stepId) ||
    !text(step.taskId) ||
    run.runId !== job.remote_ids.task_id ||
    run.canvasId !== job.input.canvas_id
  )
    mismatch('The completed Canvas run lacks an exact step identity.');
  const client = new CanvasClient(studio);
  const readGraph = async () =>
    object(
      await client.call('/tripo.canvas.api.agent.CanvasService/GetCanvas', { canvasId: job.input.canvas_id }),
    );
  const asset = uniqueCapAsset(step, assets),
    assetId = text(asset.assetId);
  currentRun(await readGraph(), run, step, assetId);
  const { projectId, finalId } = await capAssetDetail(client, asset);
  const { segmentId, url } = await verifyCapHistory(studio, projectId, finalId, asset, step);
  currentRun(await readGraph(), run, step, assetId);
  const binding: CanvasResultBinding = {
    version: 1,
    stage: 'segmentation_quick_cap',
    job_id: job.job_id,
    account_ref: job.account_ref,
    input_hash: job.input_hash,
    canvas_id: text(run.canvasId),
    run_id: text(run.runId),
    node_id: text(step.nodeId),
    step_id: text(step.stepId),
    task_id: text(step.taskId),
    asset_id: assetId,
    project_id: projectId,
    segment_operator_id: segmentId,
    final_operator_id: finalId,
  };
  const artifact: Artifact = {
    artifact_id: canvasFinalId(binding),
    kind: 'model',
    format: 'glb',
    index: 0,
    canvas_result: binding,
  };
  if (!validCanvasResult(job, artifact))
    mismatch('The final Canvas result does not match the frozen submission.');
  return { artifact, url };
}
