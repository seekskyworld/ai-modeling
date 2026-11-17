/** 网页 listDismissed 的 CLI 持久对应；状态存储由 CLI 注入，Studio 不依赖本地目录或数据库。 */
import { createHash } from 'node:crypto';
import { array, object, text } from '../contracts/errors.ts';
import { extractionFacts } from './canvas-extraction-state.ts';
import type { ExtractionPlanInput } from './canvas-extraction-plan.ts';

export interface DetectionEpoch {
  assetIds: string[];
  runId: string;
  stepId: string;
  revision: string;
}
export interface ExtractionScope {
  account: string;
  canvasId: string;
  nodeId: string;
}
export interface DetectionReceipt extends ExtractionScope {
  runId: string;
  revision: string;
  context: string;
}
export interface ExtractionMemory {
  transact<T>(scope: ExtractionScope, run: (epochs: Record<string, DetectionEpoch>) => T): Promise<T>;
  isDetection(receipt: DetectionReceipt): boolean;
}

function stable(value: unknown): unknown {
  if (typeof value === 'string' && /^https?:\/\//.test(value)) {
    try {
      const url = new URL(value);
      return url.origin + url.pathname;
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)]),
    );
  return value;
}
function hash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
}
function sourceIdentity(graph: Record<string, unknown>, nodeId: string): unknown {
  const edges = array(graph.edges).map(object),
    ids = new Set([nodeId]);
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
  const assets = (value: unknown) =>
    array(value)
      .map(object)
      .sort((a, b) => text(a.assetId).localeCompare(text(b.assetId)));
  return {
    project: object(graph.canvas).projectId,
    nodes: array(graph.nodes)
      .map(object)
      .filter((node) => ids.has(text(node.id)))
      .map((node) => ({
        id: node.id,
        type: node.type,
        inputMount: assets(node.inputMount),
        ...(node.id !== nodeId ? { params: node.params, nodeAssets: assets(node.nodeAssets) } : {}),
      }))
      .sort((a, b) => text(a.id).localeCompare(text(b.id))),
    edges: edges
      .filter((edge) => ids.has(text(object(edge.target).nodeId)))
      .sort((a, b) => text(a.id).localeCompare(text(b.id))),
  };
}
function context(source: unknown, params: Record<string, unknown>): string {
  const value = { ...params };
  delete value.detect_list_stale;
  return hash({ source, params: value });
}
/** 与提交前快照共同固定源素材/变换、入边和全部参数；URL 临时签名不属于输入身份。 */
export function extractionContext(graph: Record<string, unknown>, nodeId: string): string {
  const node = array(graph.nodes)
    .map(object)
    .find((value) => value.id === nodeId);
  return context(sourceIdentity(graph, nodeId), object(node?.params));
}
function currentEpoch(graph: Record<string, unknown>, assets: unknown[], nodeId: string): DetectionEpoch {
  const run =
    array(graph.nodeRuns)
      .map(object)
      .find((value) => value.nodeId === nodeId) ?? {};
  return {
    assetIds: assets
      .map(object)
      .filter((asset) => asset.role === 'ASSET_ROLE_CURRENT' && extractionFacts([asset]).length > 0)
      .map((asset) => text(asset.assetId))
      .filter(Boolean)
      .sort(),
    runId: text(run.runId),
    stepId: text(run.currentStepId),
    revision: text(object(graph.canvas).revision),
  };
}
function freshDetection(
  memory: ExtractionMemory,
  scope: ExtractionScope,
  graph: Record<string, unknown>,
  node: Record<string, unknown>,
  epoch: DetectionEpoch,
  previous: DetectionEpoch,
  key: string,
): boolean {
  const run =
    array(graph.nodeRuns)
      .map(object)
      .find((value) => value.nodeId === scope.nodeId) ?? {};
  return (
    object(node.extraction).detectionStale !== true &&
    run.status === 'NODE_STATUS_DONE' &&
    Boolean(epoch.runId && epoch.stepId) &&
    epoch.runId !== previous.runId &&
    epoch.stepId !== previous.stepId &&
    epoch.assetIds.length > 0 &&
    epoch.assetIds.every((id) => !previous.assetIds.includes(id)) &&
    epoch.assetIds.includes(text(run.selectedAssetId)) &&
    memory.isDetection({ ...scope, runId: epoch.runId, revision: epoch.revision, context: key })
  );
}

export async function withExtractionMemory(
  memory: ExtractionMemory | undefined,
  account: string,
  graph: Record<string, unknown>,
  assets: unknown[],
  input: ExtractionPlanInput,
  build: (accepted?: string[]) => Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const node = array(graph.nodes)
    .map(object)
    .find((value) => value.id === input.nodeId)!;
  if (!memory || node.type !== 'NODE_TYPE_SEMANTIC_SPLIT') return build();
  const scope = { account, canvasId: input.canvasId, nodeId: input.nodeId };
  return await memory.transact(scope, (epochs) => {
    const source = sourceIdentity(graph, input.nodeId),
      original = object(node.params);
    const key = context(source, original),
      current = currentEpoch(graph, assets, input.nodeId);
    const previous = epochs[key];
    const invalidating = input.amount !== undefined || input.action === 'detect';
    const accepted =
      original.detect_list_stale === true &&
      !invalidating &&
      previous &&
      freshDetection(memory, scope, graph, node, current, previous, key)
        ? extractionFacts(assets)
        : undefined;
    const plan = build(accepted);
    const params = object(
      array(plan.actions)
        .map(object)
        .find((action) => action.node_id === input.nodeId)?.params,
    );
    const target = Object.keys(params).length ? params : original;
    if (target.detect_list_stale === true) {
      // 未保存的计划只登记目标指纹；读取其它参数/来源时不会套用，也不会覆盖并发的不同意图。
      epochs[context(source, target)] = invalidating ? current : (previous ?? current);
    }
    return { ...plan, detection_memory: { persistent: true, fresh_detection_verified: Boolean(accepted) } };
  });
}
