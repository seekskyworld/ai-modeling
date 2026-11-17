/** 只读准备网页拆分编辑和运行输入；保存图、报价及提交仍由已有独立命令完成。 */
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { id } from '../contracts/primitives.ts';
import { array, object, sanitize, text, TripoError } from '../contracts/errors.ts';
import { CanvasClient, bindCanvasAccount } from './canvas-client.ts';
import type { StudioClient } from './client.ts';
import { withExtractionMemory, type ExtractionMemory } from './canvas-extraction-memory.ts';
import {
  changeExtractionField,
  changeExtractionParts,
  extractionPrompt,
  extractionState,
  isManualExtraction,
} from './canvas-extraction-state.ts';

const title = z
  .string()
  .trim()
  .min(1)
  .refine((value) => Array.from(value).length <= 200);
export const extractionPlanSchema = z
  .object({
    canvasId: id,
    nodeId: id,
    revision: z.string().regex(/^\d+$/).optional(),
    action: z.enum(['inspect', 'detect', 'generate', 'regenerate', 'retry']).default('inspect'),
    splitMode: z.enum(['auto', 'manual']).optional(),
    amount: z.union([z.number().int().min(1).max(12), z.literal('auto')]).optional(),
    parts: z
      .array(title)
      .min(1)
      .max(12)
      .refine((values) => new Set(values).size === values.length)
      .optional(),
    prompt: z.string().trim().min(1).max(10000).optional(),
  })
  .strict()
  .refine(
    (value) => !(value.splitMode === 'manual' && value.amount !== undefined),
    'Manual mode has no amount.',
  )
  .refine(
    (value) => !(value.parts && ['detect', 'retry'].includes(value.action)),
    'Explicit parts apply to inspect/generate/regenerate; detect first, then edit the returned parts.',
  )
  .refine(
    (value) => !(value.parts && value.amount !== undefined),
    'Choose an automatic amount or explicit parts, not both.',
  );
export type ExtractionPlanInput = z.infer<typeof extractionPlanSchema>;
type Input = ExtractionPlanInput;
const busy = (value: unknown) => /(?:^|_)(?:queued|running|cancelling)$/i.test(text(value));

function targetNode(graph: Record<string, unknown>, input: Input): Record<string, unknown> {
  const nodes = array(graph.nodes).map(object);
  const node = nodes.find((item) => item.id === input.nodeId);
  if (!node || !['NODE_TYPE_SEMANTIC_SPLIT', 'NODE_TYPE_SPLIT_RESULT'].includes(text(node.type)))
    throw new TripoError('INVALID_INPUT', 'Select a SemanticSplit executor or one of its SplitResult nodes.');
  const child = node.type === 'NODE_TYPE_SPLIT_RESULT';
  if (child && (input.splitMode !== undefined || input.amount !== undefined || input.parts !== undefined))
    throw new TripoError('INVALID_INPUT', 'Edit the executor to change extraction mode, amount or parts.');
  if (!child && input.prompt !== undefined)
    throw new TripoError('INVALID_INPUT', 'Edit a SplitResult node to change its extraction prompt.');
  if (child && ['detect', 'retry'].includes(input.action))
    throw new TripoError('INVALID_INPUT', 'detect/retry applies to the extraction executor.');
  return node;
}
function preparedParams(node: Record<string, unknown>, assets: unknown[], input: Input, accepted?: string[]) {
  const original = object(node.params);
  const extraction = object(node.extraction);
  let params = { ...original };
  if (accepted) {
    delete params.detect_list_stale;
    params.candidate_titles = accepted;
  }
  const fresh = extraction.detectionStale !== true && params.detect_list_stale !== true;
  const detected = accepted ?? (fresh ? array(extraction.detectedParts).map(String) : []);
  if (input.splitMode !== undefined)
    params = changeExtractionField(params, 'split_mode', input.splitMode, detected, fresh);
  if (input.amount !== undefined)
    params = changeExtractionField(params, 'amount', input.amount, detected, fresh);
  if (input.parts !== undefined) params = changeExtractionParts(params, input.parts);
  if (input.prompt !== undefined) params.prompt = input.prompt;
  if (input.action === 'detect') {
    if (isManualExtraction(params))
      throw new TripoError('INVALID_INPUT', 'Manual extraction generates its explicit parts without Detect.');
    delete params.candidate_titles;
    delete params.auto_titles;
  }
  // 网页组件的 listDismissed 跨 CLI 进程必须持久化；使用网页已识别的字段，不能提前清除。
  if (
    input.amount !== undefined ||
    input.action === 'detect' ||
    (!accepted && original.detect_list_stale === true)
  )
    params.detect_list_stale = true;
  if (node.type === 'NODE_TYPE_SPLIT_RESULT' && !text(params.prompt).trim()) {
    const prompt = extractionPrompt(params, assets) || text(node.name).trim();
    if (prompt) params.prompt = prompt;
  }
  return params;
}
function runContext(graph: Record<string, unknown>, input: Input, batchId: string) {
  const nodes = array(graph.nodes).map(object);
  const child = nodes.find((node) => node.id === input.nodeId)?.type === 'NODE_TYPE_SPLIT_RESULT';
  const children = nodes.filter((item) => {
    if (item.type !== 'NODE_TYPE_SPLIT_RESULT') return false;
    if (batchId && item.batchId !== batchId) return false;
    return array(graph.edges).some((value) => {
      const edge = object(value);
      return object(edge.source).nodeId === input.nodeId && object(edge.target).nodeId === item.id;
    });
  });
  const ids = new Set([input.nodeId, ...children.map((item) => text(item.id))]);
  if (child)
    for (const value of array(graph.edges)) {
      const edge = object(value);
      const parent = nodes.find((item) => item.id === object(edge.source).nodeId);
      if (object(edge.target).nodeId === input.nodeId && parent?.type === 'NODE_TYPE_SEMANTIC_SPLIT')
        ids.add(text(parent.id));
    }
  return {
    child,
    children,
    ids,
    runs: array(graph.nodeRuns)
      .map(object)
      .filter((run) => ids.has(text(run.nodeId))),
  };
}
function runBlocked(input: Input, runs: Record<string, unknown>[], empty: boolean, stale: boolean) {
  if (runs.some((run) => busy(run.status))) return 'running';
  if (input.action === 'retry' && !runs.some((run) => /(?:^|_)failed$/i.test(text(run.status))))
    return 'no_failed_results';
  if (['generate', 'regenerate'].includes(input.action) && empty)
    return stale ? 'detection_stale' : 'empty_parts';
  return null;
}

/** 返回 graph-edit 可直接消费的 params 动作；有待保存动作时不返回过期 revision。 */
export function extractionPlan(
  graph: Record<string, unknown>,
  assets: unknown[],
  input: Input,
  acceptedDetection?: string[],
): Record<string, unknown> {
  const node = targetNode(graph, input);
  const original = object(node.params);
  const params = preparedParams(node, assets, input, acceptedDetection);
  const extraction = object(node.extraction);
  const state = extractionState(params, extraction, assets);
  // 数量调整会隐藏旧检测清单，直到保存后重新检测；不能回退到旧 extraction/facts。
  if (input.amount !== undefined) {
    state.stale = true;
    state.editable_titles = [];
    state.parts = [];
  }
  const { child, children, runs } = runContext(graph, input, state.current_batch_id);
  const blocked = runBlocked(
    input,
    runs,
    child ? !text(params.prompt).trim() : !state.parts.length,
    state.stale,
  );
  const actions = isDeepStrictEqual(original, params)
    ? []
    : [{ action: 'params', node_id: input.nodeId, params }];
  const run =
    input.action === 'inspect' || blocked
      ? null
      : {
          canvas_id: input.canvasId,
          ...(!actions.length ? { revision: text(object(graph.canvas).revision) } : {}),
          node_ids: [input.nodeId],
          action: child ? 'generate' : input.action,
          ...(!child && ['generate', 'regenerate'].includes(input.action) ? { parts: state.parts } : {}),
        };
  return {
    canvas_id: input.canvasId,
    node_id: input.nodeId,
    source_revision: text(object(graph.canvas).revision),
    node_type: node.type,
    state: child ? { prompt: text(params.prompt), kind: 'result' } : state,
    blocked,
    actions,
    run_parameters: run,
    run_requires_saved_revision: actions.length > 0,
    result_node_ids: children.map((item) => item.id),
    remote_saved: false,
    execution_started: false,
  };
}

/** GetCanvas 可重签素材 URL、变更 ETA 或返回不同顺序；防竞态比较固定身份和真正参与计划的状态。 */
function snapshot(graph: Record<string, unknown>, input: Input): unknown {
  const nodes = array(graph.nodes).map(object),
    edges = array(graph.edges).map(object);
  const node = nodes.find((item) => item.id === input.nodeId);
  const { ids } = runContext(graph, input, text(object(node?.extraction).currentBatchId));
  for (let changed = true; changed;) {
    changed = false;
    for (const edge of edges) {
      const from = text(object(edge.source).nodeId),
        to = text(object(edge.target).nodeId);
      if (ids.has(to) && !ids.has(from)) {
        ids.add(from);
        changed = true;
      }
    }
  }
  const canvas = object(graph.canvas);
  const pick = (value: Record<string, unknown>, keys: string[]) =>
    Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, stableValue(value[key])]));
  return {
    canvas: pick(canvas, ['canvasId', 'projectId', 'revision']),
    nodes: nodes
      .filter((item) => ids.has(text(item.id)))
      .map((item) => ({
        ...pick(item, ['id', 'type', 'pid', 'name', 'params', 'batchId', 'extraction']),
        inputMount: stableAssets(item.inputMount),
        nodeAssets: stableAssets(item.nodeAssets),
      }))
      .sort((a, b) => text(object(a).id).localeCompare(text(object(b).id))),
    edges: edges
      .filter((edge) => ids.has(text(object(edge.target).nodeId)))
      .sort((a, b) => text(a.id).localeCompare(text(b.id))),
    runs: array(graph.nodeRuns)
      .map(object)
      .filter((run) => ids.has(text(run.nodeId)))
      .map((run) => pick(run, ['nodeId', 'status', 'runId', 'selectedAssetId', 'currentStepId', 'failCode']))
      .sort((a, b) => text(a.nodeId).localeCompare(text(b.nodeId))),
  };
}
function stableValue(value: unknown): unknown {
  if (typeof value === 'string' && /^https?:\/\//.test(value)) {
    try {
      const url = new URL(value);
      return url.origin + url.pathname;
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stableValue(item)]));
  return value;
}
function stableAssets(value: unknown): unknown[] {
  return array(value)
    .map(object)
    .map((asset) => stableValue(asset) as Record<string, unknown>)
    .sort((a, b) => text(a.assetId).localeCompare(text(b.assetId)));
}

export async function resolveCanvasExtractionPlan(
  studio: StudioClient,
  value: unknown,
  memory?: ExtractionMemory,
): Promise<unknown> {
  const input = extractionPlanSchema.parse(value);
  studio = bindCanvasAccount(studio);
  const client = new CanvasClient(studio);
  const read = async () =>
    object(
      await client.call('/tripo.canvas.api.agent.CanvasService/GetCanvas', { canvasId: input.canvasId }),
    );
  const graph = await read();
  const canvas = object(graph.canvas);
  if (
    canvas.canvasId !== input.canvasId ||
    !/^\d+$/.test(text(canvas.revision)) ||
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.edges)
  )
    throw new TripoError('CONTRACT_CHANGED', 'Canvas extraction graph has no stable identity or revision.');
  if (input.revision !== undefined && input.revision !== canvas.revision)
    throw new TripoError('CANVAS_CHANGED', 'Read the current Canvas before preparing extraction.');
  // 在任何辅助查询前检查节点归属和输入；不会为了无效节点读取另一个节点的素材。
  extractionPlan(graph, [], input);
  const detail = object(
    await client.call('/tripo.canvas.api.agent.NodeService/ListNodesAssets', { nodeIds: [input.nodeId] }),
  );
  const row = array(detail.nodes)
    .map(object)
    .find((item) => item.nodeId === input.nodeId);
  if (!row) throw new TripoError('CONTRACT_CHANGED', 'Canvas returned no extraction asset record.');
  const assets = array(row.assets).map(object);
  if (assets.some((asset) => asset.nodeId !== input.nodeId))
    throw new TripoError('CONTRACT_CHANGED', 'Extraction asset belongs to another node.');
  const latest = await read();
  if (!isDeepStrictEqual(snapshot(graph, input), snapshot(latest, input)))
    throw new TripoError('CANVAS_CHANGED', 'Canvas changed while resolving extraction; read it again.');
  const account = studio.credentials.load()?.accountRef;
  if (!account) throw new TripoError('AUTH_REQUIRED', 'A verified Studio account is required for Canvas.');
  const plan = await withExtractionMemory(memory, account, graph, assets, input, (accepted) =>
    extractionPlan(graph, assets, input, accepted),
  );
  studio.credentials.load();
  return sanitize(plan);
}
