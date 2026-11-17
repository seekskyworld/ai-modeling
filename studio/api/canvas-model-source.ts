/** 显式 quick_cap=false 的原分割模型只读绑定；不能把 run ID 当项目或按最新资产猜来源。 */
import type { StudioClient } from './client.ts';
import { CanvasClient } from './canvas-client.ts';
import { canvasStateFingerprint, stableCanvasResource } from './canvas-state.ts';
import { taskUrlMatches } from './canvas-result-identity.ts';
import { array, object, text, TripoError } from '../contracts/errors.ts';
import type { Job } from '../contracts/types.ts';
import {
  uncappedCanvasModelIntent,
  validUncappedCanvasModelSource,
  type UncappedCanvasModelSourceProof,
} from '../contracts/canvas-model-source.ts';

function mismatch(message: string): never {
  throw new TripoError('CANVAS_MODEL_SOURCE_UNVERIFIED', message, 'read');
}
function sameFile(left: unknown, right: unknown): boolean {
  try {
    const a = new URL(text(left)),
      b = new URL(text(right));
    return (
      a.protocol === 'https:' &&
      b.protocol === 'https:' &&
      stableCanvasResource(a.toString()) === stableCanvasResource(b.toString())
    );
  } catch {
    return false;
  }
}
type SourceIntent = NonNullable<ReturnType<typeof uncappedCanvasModelIntent>>;
function graphNode(
  graph: Record<string, unknown>,
  step: Record<string, unknown>,
  assetId: string,
): Record<string, unknown> {
  const nodes = array(graph.nodes)
      .map(object)
      .filter((node) => node.id === step.nodeId),
    node = nodes[0],
    assets = array(node?.nodeAssets).map(object);
  if (
    nodes.length !== 1 ||
    node?.type !== 'NODE_TYPE_SEGMENTATION' ||
    assets.length !== 1 ||
    assets[0]?.assetId !== assetId ||
    assets[0]?.studioState !== 'STUDIO_ASSET_STATE_READY' ||
    !taskUrlMatches(text(assets[0]?.url), text(step.taskId))
  )
    mismatch('The current Canvas graph does not identify this original completed model.');
  return node;
}
function graphIdentity(
  graph: Record<string, unknown>,
  job: Job,
  step: Record<string, unknown>,
  assetId: string,
): Record<string, unknown> {
  const node = graphNode(graph, step, assetId),
    runs = array(graph.nodeRuns)
      .map(object)
      .filter((run) => run.nodeId === step.nodeId),
    current = runs[0];
  if (
    object(graph.canvas).canvasId !== job.input.canvas_id ||
    runs.length !== 1 ||
    current?.runId !== job.remote_ids.task_id ||
    current?.currentStepId !== step.stepId ||
    current?.status !== 'NODE_STATUS_DONE' ||
    (text(current.selectedAssetId) && current.selectedAssetId !== assetId)
  )
    mismatch('The current Canvas node no longer identifies the original run and step.');
  return { canvas: graph.canvas, node, run: current };
}

function originalStep(run: Record<string, unknown>, job: Job, intent: SourceIntent): Record<string, unknown> {
  const steps = array(run.steps).map(object),
    step = steps[0],
    nodeIds = array(run.nodeIds);
  if (
    run.runId !== job.remote_ids.task_id ||
    run.canvasId !== job.input.canvas_id ||
    run.status !== 'RUN_STATUS_SUCCEEDED' ||
    nodeIds.length !== 1 ||
    nodeIds[0] !== intent.node_id ||
    steps.length !== 1 ||
    step?.nodeId !== intent.node_id ||
    !['RUN_STEP_STATUS_DONE', 'RUN_STEP_STATUS_SUCCEEDED'].includes(text(step.status)) ||
    !text(step.stepId) ||
    !text(step.taskId)
  )
    mismatch('The original Canvas run does not contain one completed segmentation step.');
  return step;
}
function currentAsset(
  listed: Record<string, unknown>,
  intent: SourceIntent,
  step: Record<string, unknown>,
  before: Record<string, unknown>,
): Record<string, unknown> {
  const nodeAssets = array(listed.nodes).map(object),
    assets = array(nodeAssets[0]?.assets)
      .map(object)
      .filter((asset) => asset.kind === 'ASSET_KIND_MODEL' && asset.role === 'ASSET_ROLE_CURRENT'),
    asset = assets[0];
  if (
    nodeAssets.length !== 1 ||
    nodeAssets[0]?.nodeId !== intent.node_id ||
    assets.length !== 1 ||
    asset?.nodeId !== intent.node_id ||
    asset.assetId !== intent.artifact_id ||
    asset.source !== 'ASSET_SOURCE_STUDIO' ||
    asset.studioState !== 'STUDIO_ASSET_STATE_READY' ||
    !taskUrlMatches(text(asset.url), text(step.taskId)) ||
    !sameFile(asset.url, array(object(before.node).nodeAssets).map(object)[0]?.url)
  )
    mismatch('There is no unique current ready Studio model for the frozen artifact.');
  return asset;
}
function assetIdentity(
  response: Record<string, unknown>,
  intent: SourceIntent,
  step: Record<string, unknown>,
  asset: Record<string, unknown>,
): { projectId: string; operatorId: string } {
  const detail = object(response.detail),
    projectId = text(detail.id),
    operatorId = text(detail.operator_id);
  if (
    response.assetId !== intent.artifact_id ||
    response.provider !== 'studio' ||
    !projectId ||
    operatorId !== step.taskId ||
    detail.is_owner !== true ||
    detail.status !== 'success' ||
    detail.type !== 'ai_segmentation' ||
    !sameFile(detail.model_url, asset.url)
  )
    mismatch('The asset is not the owned completed segmentation from the original task.');
  return { projectId, operatorId };
}
function assertProject(
  project: Record<string, unknown>,
  projectId: string,
  operatorId: string,
  step: Record<string, unknown>,
  asset: Record<string, unknown>,
): void {
  const operator = object(project.operator);
  if (
    project.id !== projectId ||
    (project.is_owner !== true && operator.is_owner !== true) ||
    operator.operator_id !== operatorId ||
    operator.status !== 'success' ||
    operator.type !== 'ai_segmentation' ||
    !taskUrlMatches(text(operator.model_url), text(step.taskId)) ||
    !sameFile(project.model_url, operator.model_url) ||
    !sameFile(operator.model_url, asset.url)
  )
    mismatch('The exact owned project and operation do not identify the original model file.');
}

export async function resolveUncappedCanvasModelSource(
  studio: StudioClient,
  job: Job,
): Promise<UncappedCanvasModelSourceProof> {
  const intent = uncappedCanvasModelIntent(job);
  if (!intent) mismatch('Only one explicitly uncapped frozen segmentation model can be resolved.');
  // 多次读取都绑定原任务账号；中途切换账号不能借新的 Canvas 会话跨身份读取。
  const bound = studio.forAccount(job.account_ref),
    client = new CanvasClient(bound),
    jobIdentity = canvasStateFingerprint({
      job_id: job.job_id,
      account_ref: job.account_ref,
      input_hash: job.input_hash,
      input: job.input,
      remote_ids: job.remote_ids,
      intent,
    });
  const run = object(
    object(
      await client.call('/tripo.canvas.api.agent.RunService/GetRun', {
        runId: job.remote_ids.task_id,
      }),
    ).run,
  );
  const step = originalStep(run, job, intent);
  const readGraph = async () =>
    object(
      await client.call('/tripo.canvas.api.agent.CanvasService/GetCanvas', {
        canvasId: job.input.canvas_id,
      }),
    );
  const before = graphIdentity(await readGraph(), job, step, intent.artifact_id);
  const listed = object(
    await client.call('/tripo.canvas.api.agent.NodeService/ListNodesAssets', {
      nodeIds: [intent.node_id],
    }),
  );
  const asset = currentAsset(listed, intent, step, before);
  const response = object(
    await client.call('/tripo.canvas.api.agent.NodeService/GetNodeAssetDetail', {
      assetId: intent.artifact_id,
    }),
  );
  const { projectId, operatorId } = assetIdentity(response, intent, step, asset);
  const project = object(
    await bound.request(
      'GET',
      `/v2/studio/project/detail/v3/${encodeURIComponent(projectId)}?operator_id=${encodeURIComponent(operatorId)}`,
    ),
  );
  assertProject(project, projectId, operatorId, step, asset);
  const after = graphIdentity(await readGraph(), job, step, intent.artifact_id);
  // 最后一次响应返回期间也可能切号；不等下一次请求才检查本次证明的账号。
  bound.credentials.load();
  if (canvasStateFingerprint(before) !== canvasStateFingerprint(after))
    mismatch('The Canvas node, result or revision changed while its source was being resolved.');
  if (
    jobIdentity !==
    canvasStateFingerprint({
      job_id: job.job_id,
      account_ref: job.account_ref,
      input_hash: job.input_hash,
      input: job.input,
      remote_ids: job.remote_ids,
      intent: uncappedCanvasModelIntent(job),
    })
  )
    mismatch('The frozen Canvas job changed during source resolution.');
  const proof: UncappedCanvasModelSourceProof = {
    version: 1,
    job_id: job.job_id,
    account_ref: job.account_ref,
    input_hash: job.input_hash,
    canvas_id: text(run.canvasId),
    run_id: text(run.runId),
    node_id: intent.node_id,
    step_id: text(step.stepId),
    task_id: text(step.taskId),
    artifact_id: intent.artifact_id,
    asset_id: intent.artifact_id,
    project_id: projectId,
    operator_id: operatorId,
    task_type: 'mesh_segmentation',
  };
  if (!validUncappedCanvasModelSource(job, proof)) mismatch('The source proof does not bind the frozen job.');
  return proof;
}
