/** 网页 Lab → nodeAssetId → Studio 精确版本的只读链；不提交 SaveNodeAssetsToStudio 或导入。 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { StudioClient } from './client.ts';
import { CanvasClient } from './canvas-client.ts';
import { stableCanvasResource } from './canvas-state.ts';
import { taskUrlMatches } from './canvas-result-identity.ts';
import { array, object, text, TripoError } from '../contracts/errors.ts';
import type { Artifact, Job } from '../contracts/types.ts';
import type { LabModelSourceResolution, LabModelSourceTarget } from '../contracts/lab-model-source.ts';

const fail = (message: string): never => {
  throw new TripoError('LAB_MODEL_SOURCE_UNVERIFIED', message, 'read');
};
const stable = (url: unknown): string => stableCanvasResource(text(url));
const sha = (value: string): string => createHash('sha256').update(value).digest('hex');

function originalArtifact(job: Job, artifact: Artifact, value: unknown): Record<string, unknown> {
  const lab = object(value),
    models = array(lab.artifacts)
      .map(object)
      .filter((a) => a.kind === 'model'),
    result = object(models[0]),
    inputs = array(lab.inputs)
      .map(object)
      .map((a) => a.assetId);
  if (
    lab.jobId !== job.remote_ids.task_id ||
    lab.status !== 'completed' ||
    lab.prompt !== job.input.prompt ||
    !isDeepStrictEqual(inputs, job.input.asset_ids) ||
    models.length !== 1 ||
    result?.artifactId !== artifact.artifact_id ||
    !text(result.nodeAssetId) ||
    result.studioState !== 'STUDIO_ASSET_STATE_READY' ||
    Number(result.byteSize) !== artifact.bytes
  )
    fail('The original Lab job does not bind one ready saved model to its verified artifact.');
  return {
    artifactId: result.artifactId,
    nodeAssetId: result.nodeAssetId,
    downloadUrl: stable(result.downloadUrl),
    byteSize: result.byteSize,
  };
}

/** 同一 tripo-data 对象在 Lab S3 与 Canvas CDN 有不同域名，路径和业务查询仍须精确相同。 */
function storageObject(value: unknown, artifactId: string): string {
  let url: URL;
  try {
    url = new URL(stable(value));
  } catch {
    return fail('The Lab model has no valid storage object.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !/^tripo-data(?:\.s3[.-][a-z0-9-]+\.amazonaws\.com|\.[a-z0-9-]+\.data\.tripo3d\.com)$/.test(
      url.hostname,
    ) ||
    !url.pathname.startsWith(`/canvas/lab/${artifactId}/`)
  )
    fail('The node model does not identify the original Lab storage object.');
  // 实际 Lab 的 S3 预签名 GET 带固定操作标记，CDN 同对象不带它；只消去这个已核实值。
  if (url.hostname.includes('.s3.') && url.searchParams.get('x-id') === 'GetObject')
    url.searchParams.delete('x-id');
  return url.pathname + url.search;
}

function nodeAsset(job: Job, artifact: Record<string, unknown>, value: unknown): void {
  const nodes = array(object(value).nodes).map(object),
    matches = array(nodes[0]?.assets)
      .map(object)
      .filter((a) => a.assetId === artifact.nodeAssetId),
    asset = object(matches[0]);
  if (
    nodes.length !== 1 ||
    nodes[0]?.nodeId !== job.input.node_id ||
    matches.length !== 1 ||
    asset?.nodeId !== job.input.node_id ||
    asset.source !== 'ASSET_SOURCE_STUDIO' ||
    asset.kind !== 'ASSET_KIND_MODEL' ||
    asset.studioState !== 'STUDIO_ASSET_STATE_READY' ||
    storageObject(asset.url, text(artifact.artifactId)) !==
      storageObject(artifact.downloadUrl, text(artifact.artifactId))
  )
    fail('The original Lab node does not own the mapped ready Canvas model asset.');
}

function target(job: Job, artifact: Record<string, unknown>, value: unknown): LabModelSourceResolution {
  const response = object(value),
    detail = object(response.detail),
    url = text(detail.model_url),
    metadata = object(detail.metadata);
  if (
    response.assetId !== artifact.nodeAssetId ||
    response.provider !== 'studio' ||
    !text(detail.id) ||
    !text(detail.operator_id) ||
    detail.is_owner !== true ||
    detail.status !== 'success' ||
    detail.type !== 'upload' ||
    typeof detail.is_pbr !== 'boolean' ||
    !taskUrlMatches(url, text(detail.operator_id)) ||
    !detail.metadata ||
    Array.isArray(detail.metadata)
  )
    fail('The saved Lab asset has no owned completed Studio upload representation.');
  return {
    url,
    target: {
      lab_job_id: text(job.remote_ids.task_id),
      node_id: text(job.input.node_id),
      artifact_id: text(artifact.artifactId),
      node_asset_id: text(artifact.nodeAssetId),
      project_id: text(detail.id),
      operator_id: text(detail.operator_id),
      resource_identity: sha(stable(url)),
      metadata: structuredClone(metadata),
      is_pbr: detail.is_pbr === true,
    },
  };
}

function exactProject(value: unknown, expected: LabModelSourceResolution): void {
  const project = object(value),
    operator = object(project.operator),
    t = expected.target;
  if (
    project.id !== t.project_id ||
    (project.is_owner !== true && operator.is_owner !== true) ||
    operator.operator_id !== t.operator_id ||
    operator.type !== 'upload' ||
    operator.status !== 'success' ||
    project.running_operator ||
    stable(project.model_url) !== stable(expected.url) ||
    stable(operator.model_url) !== stable(expected.url) ||
    operator.is_pbr !== t.is_pbr ||
    !isDeepStrictEqual(operator.metadata, t.metadata)
  )
    fail('The exact Studio project version differs from the Lab asset detail.');
}

/** artifact.bytes 必须来自已验证原件证明，调用者不能以网页规范化产物补写原 Lab 交付。 */
export async function resolveLabModelSource(
  studio: StudioClient,
  job: Job,
  artifact: Artifact,
): Promise<LabModelSourceResolution> {
  if (
    job.operation !== 'canvas_lab' ||
    job.state !== 'succeeded' ||
    !job.account_ref ||
    !text(job.input.node_id) ||
    !text(job.remote_ids.task_id) ||
    artifact.kind !== 'model' ||
    artifact.format !== 'glb' ||
    !artifact.bytes
  )
    fail('Only an exact verified Lab GLB can resolve a Studio representation.');
  const bound = studio.forAccount(job.account_ref),
    client = new CanvasClient(bound);
  const readLab = () =>
    client.call('/tripo.canvas.api.agent.LabService/GetLabJob', { jobId: job.remote_ids.task_id });
  const readNodes = () =>
    client.call('/tripo.canvas.api.agent.NodeService/ListNodesAssets', { nodeIds: [job.input.node_id] });
  const first = originalArtifact(job, artifact, await readLab());
  nodeAsset(job, first, await readNodes());
  const readAsset = () =>
    client.call('/tripo.canvas.api.agent.NodeService/GetNodeAssetDetail', { assetId: first.nodeAssetId });
  const resolved = target(job, first, await readAsset());
  exactProject(
    await bound.request(
      'GET',
      `/v2/studio/project/detail/v3/${encodeURIComponent(resolved.target.project_id)}?operator_id=${encodeURIComponent(resolved.target.operator_id)}`,
    ),
    resolved,
  );
  const last = originalArtifact(job, artifact, await readLab());
  nodeAsset(job, last, await readNodes());
  const current = target(job, last, await readAsset());
  bound.credentials.load();
  if (!isDeepStrictEqual(first, last) || !isDeepStrictEqual(resolved.target, current.target))
    fail('The Lab artifact or Studio representation changed during source resolution.');
  return resolved;
}

/** 准备期间下载结束后再次核模型版本/metadata，防止把变化后的来源与旧字节一起冻结。 */
export async function assertLabModelTargetCurrent(
  studio: StudioClient,
  account: string,
  expected: LabModelSourceTarget,
): Promise<void> {
  const bound = studio.forAccount(account),
    detail = object(
      await new CanvasClient(bound).call('/tripo.canvas.api.agent.NodeService/GetNodeAssetDetail', {
        assetId: expected.node_asset_id,
      }),
    ),
    raw = object(detail.detail);
  if (
    detail.assetId !== expected.node_asset_id ||
    detail.provider !== 'studio' ||
    raw.id !== expected.project_id ||
    raw.operator_id !== expected.operator_id ||
    raw.is_owner !== true ||
    raw.status !== 'success' ||
    raw.type !== 'upload' ||
    raw.is_pbr !== expected.is_pbr ||
    !isDeepStrictEqual(raw.metadata, expected.metadata) ||
    sha(stable(raw.model_url)) !== expected.resource_identity
  )
    fail('The saved Studio representation changed before its source proof was frozen.');
  bound.credentials.load();
}
