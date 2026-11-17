/** Canvas 执行纳入本地持久任务；保存图版本与逐节点价格依据，稳定 job UUID 用作服务端幂等键。 */
import { CanvasClient } from './canvas-client.ts';
import { canvasNodeQuote, canvasAction } from './canvas-pricing.ts';
import type { StudioClient } from './client.ts';
import { array, object, text, TripoError } from '../contracts/errors.ts';
import type { Job, RemoteStatus } from '../contracts/types.ts';
import type { ArtifactLinks } from '../auth/artifact-links.ts';
import { canvasArtifacts, readCanvasRun } from './canvas-artifacts.ts';
import { canvasInputIssues } from './canvas-graph.ts';
import { canvasSaveSchema } from './canvas.ts';
import { extractionContext } from './canvas-extraction-memory.ts';
const method = (name: string) => `/tripo.canvas.api.agent.RunService/${name}`;

/** GetCanvas 的 Lab 简略素材没有 kind/role；执行前只补读本次目标的 Lab 入边，不阻塞无关分支。 */
async function hydrateLabInputs(
  studio: StudioClient,
  nodes: Record<string, unknown>[],
  edges: unknown[],
  selectedIds: string[],
): Promise<void> {
  const byId = new Map(nodes.map((node) => [text(node.id), node]));
  const selected = new Set(selectedIds);
  const ids = [
    ...new Set(
      edges
        .map(object)
        .filter((edge) => selected.has(text(object(edge.target).nodeId)))
        .map((edge) => text(object(edge.source).nodeId))
        .filter((id) => byId.get(id)?.type === 'NODE_TYPE_AI_3D_LAB'),
    ),
  ];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const nodeIds = ids.slice(offset, offset + 100);
    const response = object(
      await new CanvasClient(studio).call('/tripo.canvas.api.agent.NodeService/ListNodesAssets', { nodeIds }),
    );
    const returned = array(response.nodes).map(object);
    for (const nodeId of nodeIds) {
      const record = returned.find((node) => node.nodeId === nodeId);
      if (!record)
        throw new TripoError(
          'INPUT_NOT_READY',
          'Read the current Lab outputs before running its downstream nodes.',
        );
      const assets = array(record.assets).map(object);
      if (assets.some((asset) => asset.nodeId !== nodeId))
        throw new TripoError('CONTRACT_CHANGED', 'Lab output belongs to a different source node.');
      byId.get(nodeId)!.nodeAssets = assets;
    }
  }
}

export async function prepareCanvasRun(
  studio: StudioClient,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = object(
    await new CanvasClient(studio).call('/tripo.canvas.api.agent.CanvasService/GetCanvas', {
      canvasId: input.canvas_id,
    }),
  );
  if (String(object(result.canvas).revision) !== input.revision)
    throw new TripoError('CANVAS_CHANGED', 'Read the current Canvas revision before running.');
  const nodes = array(result.nodes).map(object);
  await hydrateLabInputs(studio, nodes, array(result.edges), array(input.node_ids).map(text));
  const graph = canvasSaveSchema.parse({
    canvasId: input.canvas_id,
    clientId: 'preflight',
    revision: input.revision,
    nodes,
    edges: array(result.edges),
  });
  const issues = canvasInputIssues(graph.nodes, graph.edges, array(input.node_ids).map(text));
  if (issues.length) throw new TripoError('INVALID_INPUT', issues.join(' '));
  const selected = array(input.node_ids).map((id) => {
    const node = nodes.find((n) => n.id === id);
    if (!node) throw new TripoError('INVALID_INPUT', 'Selected Canvas node does not exist.');
    return node;
  });
  return {
    ...input,
    _canvas_quotes: selected.map((node) => ({
      ...canvasNodeQuote(node, input),
      ...(node.type === 'NODE_TYPE_SEMANTIC_SPLIT'
        ? { extraction_context: extractionContext(result, text(node.id)) }
        : {}),
    })),
    _canvas_action: canvasAction(selected, input),
  };
}
export async function submitCanvasRun(
  studio: StudioClient,
  job: Job,
): Promise<{ remote_ids: { task_id: string } }> {
  // 在 POST 前复核图版本；该检查不能代替上游的原子版本控制。
  const prepared = await prepareCanvasRun(studio, job.input);
  const latest = array(prepared._canvas_quotes).map(object);
  for (const quote of array(job.input._canvas_quotes).map(object))
    if (
      quote.extraction_context &&
      latest.find((value) => value.node_id === quote.node_id)?.extraction_context !== quote.extraction_context
    )
      throw new TripoError(
        'CANVAS_CHANGED',
        'Extraction inputs changed after preparation; read the Canvas again.',
      );
  const result = object(
    await new CanvasClient(studio).call(
      method('CreateRun'),
      {
        canvasId: job.input.canvas_id,
        nodeIds: job.input.node_ids,
        idempotencyKey: job.job_id,
        includeCompleted: true,
        mode: 'MODE_CONTROL',
        origin: 'RUN_ORIGIN_CANVAS',
        // 普通节点的网页请求没有 action；该字段只用于提取节点的阶段动作，通用生成传入会被 1000 拒绝。
        ...(job.input._canvas_action ? { action: job.input._canvas_action } : {}),
        ...(job.input.parts ? { parts: job.input.parts } : {}),
      },
      true,
    ),
  );
  const runId = text(result.runId) || text(object(result.run).runId);
  if (!runId)
    throw new TripoError('CONTRACT_CHANGED', 'Canvas run receipt has no ID; do not resubmit.', 'unknown');
  return { remote_ids: { task_id: runId } };
}
export async function canvasRunStatus(
  studio: StudioClient,
  job: Job,
  links: ArtifactLinks,
): Promise<RemoteStatus> {
  const run = await readCanvasRun(studio, job);
  const status = text(run.status)
    .replace(/^RUN_STATUS_/, '')
    .toLowerCase();
  if (['failed', 'cancelled', 'stopped', 'aborted'].includes(status))
    return {
      state: 'failed',
      progress: 0,
      artifacts: await canvasArtifacts(studio, job, run, links, true),
      error: { code: 'REMOTE_TASK_FAILED', remote_status: status },
    };
  if (['done', 'succeeded', 'success'].includes(status))
    return { state: 'succeeded', progress: 100, artifacts: await canvasArtifacts(studio, job, run, links) };
  if (['waiting_review', 'awaiting_choice', 'awaiting_input'].includes(status))
    return { state: 'waiting_input', progress: 0, artifacts: [] };
  if (
    [
      'queued',
      'running',
      'pending',
      'cancelling',
      'stopping',
      'waiting_review',
      'awaiting_choice',
      'awaiting_input',
    ].includes(status)
  )
    return { state: 'running', progress: 0, artifacts: [] };
  throw new TripoError('CONTRACT_CHANGED', 'Unknown Canvas run state.');
}
