/** 网页 Lab 输入准备的独立只读工具；不自动保存图或创建任务。 */
import { z } from 'zod';
import { id } from '../contracts/primitives.ts';
import { array, object, text, sanitize, TripoError } from '../contracts/errors.ts';
import { StudioClient } from './client.ts';
import { CanvasClient, bindCanvasAccount } from './canvas-client.ts';
import { hasUnavailableCanvasOutputStatus } from './canvas-turn-assets.ts';

export const labInputsSchema = z
  .object({
    canvasId: id,
    nodeId: id,
    revision: z.string().regex(/^\d+$/).optional(),
    assetIds: z
      .array(id)
      .max(100)
      .default([])
      .describe(
        'Explicit attachments appended after new upstream assets; these are not removed by history deduplication.',
      ),
    historyLimit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(
        'Optional bound for the Lab history query; omitted uses the same service default as the webpage.',
      ),
  })
  .strict();
export interface LabInput {
  asset_id: string;
  kind: string;
  name: string;
  version?: unknown;
}
export interface MissingInput {
  node_id: string;
  reason: string;
}
const call = (client: CanvasClient, service: string, method: string, input: Record<string, unknown>) =>
  client.call(`/tripo.canvas.api.agent.${service}Service/${method}`, input).then(object);
const modelNodes = new Set([
  'GENERATE_HD_MODEL',
  'GENERATE_SM_MODEL',
  'RETOPOLOGY',
  'SMART_UV',
  'PBR',
  'RIGGING',
  'SEGMENTATION',
  'TEXTURE',
]);
const imageNodes = new Set(['GENERATE_IMAGE', 'ASSET', 'MULTIVIEW_RESULT', 'SPLIT_RESULT', 'REVIEW']);
const multipleNodes = new Set(['MULTIVIEW', 'IMAGE_SPLIT', 'SEMANTIC_SPLIT']);

function input(asset: Record<string, unknown>, kind: string): LabInput {
  return {
    asset_id: text(asset.assetId).trim(),
    kind,
    name: text(asset.filename).trim() || text(asset.assetId),
    ...(asset.version === undefined ? {} : { version: asset.version }),
  };
}
function matchesKind(asset: Record<string, unknown>, kind: string) {
  return (
    !asset.kind ||
    asset.kind === 'ASSET_KIND_UNSPECIFIED' ||
    asset.kind === `ASSET_KIND_${kind.toUpperCase()}`
  );
}

function animatedInput(node: Record<string, unknown>, nodeRun: unknown, current: Record<string, unknown>[]) {
  const status = text(object(nodeRun).status)
    .replace(/^(RUN_STATUS_|NODE_STATUS_|RUN_STEP_STATUS_)/, '')
    .toLowerCase();
  if (object(node.params).animation_applied !== true || !['succeeded', 'done', 'success'].includes(status))
    return [];
  const models = current.filter((asset) => matchesKind(asset, 'model'));
  const asset = models.find((asset) => asset.kind === 'ASSET_KIND_MODEL') ?? models[0];
  return asset ? [input(asset, 'model')] : [];
}

/** GetCanvas 的真实 nodeRuns 是按 nodeId 标识的数组；旧的离线图还可能使用字典。 */
export function labNodeRun(graph: Record<string, unknown>, nodeId: string): unknown {
  return Array.isArray(graph.nodeRuns)
    ? graph.nodeRuns.map(object).find((run) => run.nodeId === nodeId)
    : object(graph.nodeRuns)[nodeId];
}

function uploadInput(node: Record<string, unknown>): LabInput[] {
  const asset = object(array(node.inputMount)[0]);
  const declared = text(asset.kind).replace('ASSET_KIND_', '').toLowerCase();
  const kind = !declared || declared === 'unspecified' ? text(object(node.params).assetType) : declared;
  return ['image', 'model'].includes(kind) && text(asset.assetId) ? [input(asset, kind)] : [];
}

/** BbtNBreL.Ab/Db：多输出保留 slot 顺序，普通单图选 selected，模型优先明确 MODEL。 */
function selectedUpstream(node: Record<string, unknown>, nodeRun: unknown): LabInput[] {
  const type = text(node.type).replace('NODE_TYPE_', '');
  const assets = array(node.nodeAssets).map(object);
  const current = assets.filter((asset) => asset.role === 'ASSET_ROLE_CURRENT');
  const outputs = (current.length ? current : assets)
    .slice()
    .sort((a, b) => Number(a.slotIndex ?? 0) - Number(b.slotIndex ?? 0));
  if (type === 'UPLOAD_CARD') return uploadInput(node);
  if (type === 'ANIMATION') return animatedInput(node, nodeRun, current);
  if (type === 'AI_3D_LAB') {
    const studio = outputs.filter(
      (asset) => asset.role === 'ASSET_ROLE_CURRENT' && asset.source === 'ASSET_SOURCE_STUDIO',
    );
    const selected = studio.filter((asset) => asset.selected === true);
    return (selected.length ? selected : studio)
      .filter((asset) => ['ASSET_KIND_IMAGE', 'ASSET_KIND_MODEL'].includes(text(asset.kind)))
      .map((asset) => input(asset, asset.kind === 'ASSET_KIND_MODEL' ? 'model' : 'image'));
  }
  const kind = modelNodes.has(type)
    ? 'model'
    : imageNodes.has(type) || multipleNodes.has(type)
      ? 'image'
      : '';
  if (!kind) return [];
  const compatible = outputs.filter((asset) => matchesKind(asset, kind));
  if (multipleNodes.has(type)) return compatible.map((asset) => input(asset, kind));
  const selected =
    (kind === 'model' ? compatible.find((asset) => asset.kind === 'ASSET_KIND_MODEL') : undefined) ??
    compatible.find((asset) => asset.selected === true) ??
    compatible[0];
  return selected ? [input(selected, kind)] : [];
}

export function selectLabUpstream(node: Record<string, unknown>, nodeRun: unknown): LabInput[] {
  const selected = selectedUpstream(node, nodeRun),
    assets = array(node.nodeAssets).map(object);
  if (node.type === 'NODE_TYPE_UPLOAD_CARD') return selected;
  // 先按网页选当前/选中输出，再核明确失败或处理中；不能回退到另一个旧件冒充选中来源。
  // 未返回状态不等于失败，Lab 输入也不要求浏览器下载 URL。
  if (
    selected.some((input) =>
      assets.some((asset) => asset.assetId === input.asset_id && hasUnavailableCanvasOutputStatus(asset)),
    )
  )
    return [];
  return selected;
}

export async function hydrateLabUpstream(
  client: CanvasClient,
  nodes: Record<string, unknown>[],
  projectId: string,
) {
  const missing: MissingInput[] = [];
  const generated = nodes.filter((node) => node.type !== 'NODE_TYPE_UPLOAD_CARD');
  for (let offset = 0; offset < generated.length; offset += 100) {
    const batch = generated.slice(offset, offset + 100);
    const result = await call(client, 'Node', 'ListNodesAssets', { nodeIds: batch.map((node) => node.id) });
    for (const node of batch) {
      const found = array(result.nodes)
        .map(object)
        .filter((item) => item.nodeId === node.id);
      const assets = array(found[0]?.assets).map(object);
      if (
        found.length !== 1 ||
        assets.some((asset) => asset.nodeId !== node.id || !text(asset.assetId)) ||
        new Set(assets.map((asset) => asset.assetId)).size !== assets.length
      ) {
        missing.push({ node_id: text(node.id), reason: 'generated_asset_identity_unavailable' });
        node.nodeAssets = [];
      } else node.nodeAssets = array(found[0]!.assets);
    }
  }
  const uploads = nodes.filter((node) => node.type === 'NODE_TYPE_UPLOAD_CARD');
  const ids = [
    ...new Set(uploads.map((node) => text(object(array(node.inputMount)[0]).assetId)).filter(Boolean)),
  ];
  const ready = new Map<string, Record<string, unknown>>();
  for (let offset = 0; offset < ids.length; offset += 100) {
    const assetIds = ids.slice(offset, offset + 100);
    const result = await call(client, 'Asset', 'BatchGetInputAssets', {
      projectId,
      assetIds,
    });
    for (const assetId of assetIds) {
      const matches = array(result.assets)
        .map(object)
        .filter((asset) => asset.assetId === assetId);
      if (matches.length === 1 && matches[0]!.status === 'INPUT_ASSET_STATUS_READY')
        ready.set(assetId, matches[0]!);
    }
  }
  for (const node of uploads) {
    const assetId = text(object(array(node.inputMount)[0]).assetId);
    if (!assetId || !ready.has(assetId)) {
      missing.push({ node_id: text(node.id), reason: 'input_asset_not_ready_in_project' });
      node.inputMount = [];
    } else node.inputMount = [{ ...object(array(node.inputMount)[0]), ...ready.get(assetId) }];
  }
  return missing;
}

async function previousInputs(client: CanvasClient, nodeId: string, limit?: number) {
  const listing = await call(client, 'Lab', 'ListLabJobs', {
    nodeId,
    ...(limit === undefined ? {} : { limit }),
  });
  const jobs = [
    ...new Set(
      [...array(listing.jobs), ...(listing.activeJob ? [listing.activeJob] : [])]
        .map((job) => text(object(job).jobId))
        .filter(Boolean),
    ),
  ];
  if (jobs.length > 100)
    throw new TripoError('CONTRACT_CHANGED', 'Lab history exceeds the bounded input resolver.');
  const ids = new Set<string>();
  const unresolved: string[] = [];
  for (let offset = 0; offset < jobs.length; offset += 4) {
    const batch = jobs.slice(offset, offset + 4);
    const results = await Promise.allSettled(
      batch.map((jobId) => call(client, 'Lab', 'GetLabJob', { jobId })),
    );
    for (let index = 0; index < results.length; index++) {
      const result = results[index]!;
      if (
        result.status === 'rejected' ||
        result.value.jobId !== batch[index] ||
        (result.value.nodeId && result.value.nodeId !== nodeId) ||
        !Array.isArray(result.value.inputs)
      ) {
        unresolved.push(batch[index]!);
        continue;
      }
      for (const asset of result.value.inputs)
        if (text(object(asset).assetId)) ids.add(text(object(asset).assetId));
    }
  }
  // 网页只消费本次返回列表，当前契约没有可验证的全历史穷尽标记。
  // 即使每个 GetLabJob 都成功，也不能将“已观察记录完整”写成“全历史完整”。
  const truncated =
    ['hasMore', 'has_more'].some((key) => listing[key] === true) ||
    ['nextPageToken', 'next_page_token', 'nextCursor', 'next_cursor'].some((key) => !!listing[key]);
  return { ids, jobs, unresolved, truncated };
}

export async function resolveLabInputs(studio: StudioClient, requested: unknown) {
  const x = labInputsSchema.parse(requested);
  studio = bindCanvasAccount(studio);
  const signal = AbortSignal.timeout(15000);
  const client = new CanvasClient(
    new StudioClient(
      studio.credentials,
      (url, init) =>
        studio.fetcher(url, {
          ...init,
          signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal,
        }),
      studio.origin,
    ),
  );
  const graph = await call(client, 'Canvas', 'GetCanvas', { canvasId: x.canvasId });
  const info = object(graph.canvas);
  if (info.canvasId !== x.canvasId || !text(info.projectId))
    throw new TripoError('CONTRACT_CHANGED', 'Lab input canvas identity is unavailable.');
  if (x.revision !== undefined && String(info.revision) !== x.revision)
    throw new TripoError('CANVAS_CHANGED', 'Read the current Canvas before resolving Lab inputs.');
  const graphNodes = array(graph.nodes).map(object);
  if (
    graphNodes.some((node) => !text(node.id)) ||
    new Set(graphNodes.map((node) => node.id)).size !== graphNodes.length
  )
    throw new TripoError('CONTRACT_CHANGED', 'Lab input Canvas node identities are missing or duplicated.');
  const byId = new Map(graphNodes.map((node) => [text(node.id), node]));
  if (byId.get(x.nodeId)?.type !== 'NODE_TYPE_AI_3D_LAB')
    throw new TripoError('INVALID_INPUT', 'Select an existing Lab node in this Canvas.');
  const upstreamIds = [
    ...new Set(
      array(graph.edges)
        .map(object)
        .filter((edge) => object(edge.target).nodeId === x.nodeId)
        .map((edge) => text(object(edge.source).nodeId)),
    ),
  ];
  const missing: MissingInput[] = upstreamIds
    .filter((id) => !byId.has(id))
    .map((id) => ({ node_id: id, reason: 'source_node_missing' }));
  const nodes = upstreamIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  missing.push(...(await hydrateLabUpstream(client, nodes, text(info.projectId))));
  const upstream = nodes.flatMap((node) => {
    const selected = selectLabUpstream(node, labNodeRun(graph, text(node.id)));
    if (!selected.length || selected.some((asset) => !asset.asset_id))
      missing.push({ node_id: text(node.id), reason: 'upstream_output_unavailable' });
    return selected.filter((asset) => asset.asset_id);
  });
  const history = await previousInputs(client, x.nodeId, x.historyLimit);
  const seen = new Set<string>();
  const inputs = [
    ...upstream.filter((asset) => !history.ids.has(asset.asset_id)),
    ...x.assetIds.map((asset_id) => ({ asset_id, kind: '', name: asset_id })),
  ].filter((asset) => !seen.has(asset.asset_id) && (seen.add(asset.asset_id), true));
  return sanitize({
    canvas_id: x.canvasId,
    node_id: x.nodeId,
    revision: String(info.revision),
    inputs,
    asset_ids: inputs.map((asset) => asset.asset_id),
    upstream_asset_ids: [...new Set(upstream.map((asset) => asset.asset_id))],
    already_used_asset_ids: [
      ...new Set(upstream.filter((asset) => history.ids.has(asset.asset_id)).map((asset) => asset.asset_id)),
    ],
    missing: missing.length > 0 || history.unresolved.length > 0,
    missing_inputs: missing,
    history_jobs_observed: history.jobs.length,
    history_scope: 'returned_jobs_only',
    history_query_limit: x.historyLimit ?? null,
    observed_history_complete: history.unresolved.length === 0,
    history_complete: history.truncated || history.unresolved.length > 0 ? false : null,
    history_truncated: history.truncated ? true : null,
    unresolved_history_job_ids: history.unresolved,
    explicit_assets_validated: false,
    execution_started: false,
  });
}
