/** 网页 Lab 的“复用说明”和“再次运行”准备分支；只读快照，不替调用方提交或接受浮动费用。 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { id } from '../contracts/primitives.ts';
import { array, object, sanitize, text, TripoError } from '../contracts/errors.ts';
import { canvasAgentSchemas } from '../contracts/canvas-agent.ts';
import { StudioClient } from './client.ts';
import { CanvasClient, bindCanvasAccount } from './canvas-client.ts';
import { hydrateLabUpstream, labNodeRun, selectLabUpstream, type LabInput } from './canvas-lab-inputs.ts';

export const labPlanSchema = z
  .object({
    canvasId: id,
    nodeId: id,
    revision: z.string().regex(/^\d+$/).optional(),
    mode: z.enum(['reuse_instructions', 'run_again']),
    jobId: id
      .optional()
      .describe('The exact previous Lab job for run_again; never the latest job implicitly.'),
    historyLimit: z.number().int().min(1).max(100).optional(),
    previousInputBinding: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional()
      .describe('A prior reuse_instructions input_binding; when supplied, unchanged inputs are not ready.'),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.mode === 'run_again' && !input.jobId)
      context.addIssue({ code: 'custom', path: ['jobId'], message: 'run_again requires an exact jobId.' });
    if (input.mode !== 'run_again' && input.jobId)
      context.addIssue({ code: 'custom', path: ['jobId'], message: 'jobId is only used by run_again.' });
    if (input.mode !== 'reuse_instructions' && input.previousInputBinding)
      context.addIssue({
        code: 'custom',
        path: ['previousInputBinding'],
        message: 'previousInputBinding is only used by reuse_instructions.',
      });
  });

const call = (client: CanvasClient, service: string, method: string, input: Record<string, unknown>) =>
  client.call(`/tripo.canvas.api.agent.${service}Service/${method}`, input).then(object);
const active = (value: unknown) => ['queued', 'running', 'cancelling'].includes(text(value));
const terminal = (value: unknown) => ['completed', 'failed', 'cancelled'].includes(text(value));

function context(graph: Record<string, unknown>, canvasId: string, nodeId: string) {
  const canvas = object(graph.canvas);
  if (
    canvas.canvasId !== canvasId ||
    !text(canvas.projectId) ||
    !/^\d+$/.test(text(canvas.revision)) ||
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.edges)
  )
    throw new TripoError('CONTRACT_CHANGED', 'Lab plan canvas identity or graph is incomplete.');
  const nodes = graph.nodes.map(object);
  if (nodes.some((node) => !text(node.id)) || new Set(nodes.map((node) => node.id)).size !== nodes.length)
    throw new TripoError('CONTRACT_CHANGED', 'Lab plan canvas has missing or duplicate node identities.');
  const target = nodes.find((node) => node.id === nodeId);
  if (target?.type !== 'NODE_TYPE_AI_3D_LAB')
    throw new TripoError('INVALID_INPUT', 'Select an existing Lab node in this Canvas.');
  const edges = graph.edges.map(object).filter((edge) => object(edge.target).nodeId === nodeId);
  const upstreamIds = [...new Set(edges.map((edge) => text(object(edge.source).nodeId)))];
  const related = nodes.filter((node) => node.id === nodeId || upstreamIds.includes(text(node.id)));
  return { canvas, nodes, edges, upstreamIds, related };
}

function graphIdentity(value: ReturnType<typeof context>) {
  // 签名、缩略图和 ETA 不改变输入意图；同 revision 下的换挂载/参数/连线仍须检测。
  return JSON.stringify({
    canvas: [value.canvas.canvasId, value.canvas.projectId, value.canvas.revision],
    edges: value.edges.map((edge) => ({ source: edge.source, target: edge.target })),
    nodes: value.related
      .slice()
      .sort((a, b) => text(a.id).localeCompare(text(b.id)))
      .map((node) => ({
        id: node.id,
        type: node.type,
        params: node.params ?? {},
        mounts: array(node.inputMount).map((asset) => object(asset).assetId),
      })),
  });
}

async function upstream(
  client: CanvasClient,
  graph: Record<string, unknown>,
  scope: ReturnType<typeof context>,
) {
  const byId = new Map(scope.nodes.map((node) => [text(node.id), node]));
  const missing = scope.upstreamIds
    .filter((nodeId) => !byId.has(nodeId))
    .map((node_id) => ({ node_id, reason: 'source_node_missing' }));
  const nodes = scope.upstreamIds.flatMap((nodeId) =>
    byId.has(nodeId) ? [structuredClone(byId.get(nodeId)!)] : [],
  );
  missing.push(...(await hydrateLabUpstream(client, nodes, text(scope.canvas.projectId))));
  const inputs = nodes.flatMap((node) => {
    const selected = selectLabUpstream(node, labNodeRun(graph, text(node.id)));
    if (!selected.length || selected.some((asset) => !asset.asset_id))
      missing.push({ node_id: text(node.id), reason: 'upstream_output_unavailable' });
    return selected.filter((asset) => asset.asset_id);
  });
  return { inputs, missing };
}

function inputIdentity(inputs: LabInput[]) {
  return JSON.stringify(inputs.map((asset) => [asset.asset_id, asset.version ?? null]));
}
function uniqueInputs(inputs: LabInput[]) {
  const seen = new Set<string>();
  return inputs.filter((asset) => !seen.has(asset.asset_id) && (seen.add(asset.asset_id), true));
}
function savedInstructions(value: Record<string, unknown>, nodeId: string) {
  const state = object(value.taskInstructions),
    saved = object(state.saved);
  if (saved.nodeId && saved.nodeId !== nodeId)
    throw new TripoError('CONTRACT_CHANGED', 'Saved Lab instructions belong to another node.');
  return { state, saved };
}

type PlanInput = z.infer<typeof labPlanSchema>;
interface Plan {
  prompt: string;
  inputs: LabInput[];
  source: Record<string, unknown>;
  reasons: string[];
  current?: Awaited<ReturnType<typeof upstream>>;
  instructions?: ReturnType<typeof savedInstructions>;
}

async function history(client: CanvasClient, input: PlanInput) {
  const listing = await call(client, 'Lab', 'ListLabJobs', {
    nodeId: input.nodeId,
    ...(input.historyLimit === undefined ? {} : { limit: input.historyLimit }),
  });
  if (!Array.isArray(listing.jobs))
    throw new TripoError(
      'CONTRACT_CHANGED',
      'Lab history is unavailable; an empty history was not confirmed.',
    );
  return [...listing.jobs.map(object), ...(listing.activeJob ? [object(listing.activeJob)] : [])];
}

async function instructionPlan(
  client: CanvasClient,
  input: PlanInput,
  graph: Record<string, unknown>,
  scope: ReturnType<typeof context>,
  accountRef: string,
): Promise<Plan> {
  const reasons: string[] = [];
  const instructions = savedInstructions(
    await call(client, 'Lab', 'GetLabTaskInstructions', { nodeId: input.nodeId }),
    input.nodeId,
  );
  const { state, saved } = instructions,
    prompt = text(saved.instructions).trim();
  if (!prompt) reasons.push('saved_instructions_empty');
  if (!saved.nodeId || !/^\d+$/.test(text(saved.version)))
    reasons.push('saved_instructions_identity_missing');
  if (state.saving === true || text(state.saveStatus).endsWith('SAVING')) reasons.push('instructions_saving');
  if (text(state.saveStatus).endsWith('FAILED')) reasons.push('instructions_save_failed');
  const current = await upstream(client, graph, scope),
    inputs = uniqueInputs(current.inputs);
  if (current.missing.length) reasons.push('upstream_input_unavailable');
  if (!inputs.length) reasons.push('upstream_inputs_empty');
  // 网页复用说明不执行历史去重；全部当前上游输入参与新任务，顺序保持网页连接/slot 顺序。
  const binding = createHash('sha256')
    .update(JSON.stringify([accountRef, input.canvasId, input.nodeId, inputIdentity(current.inputs)]))
    .digest('hex');
  const source = {
    instructions_version: saved.version ?? null,
    input_binding: binding,
    upstream_changed: input.previousInputBinding ? binding !== input.previousInputBinding : null,
    input_change_observation: input.previousInputBinding ? 'caller_baseline' : 'no_local_baseline',
  };
  if (input.previousInputBinding === binding) reasons.push('upstream_inputs_unchanged');
  return { prompt, inputs, source, reasons, current, instructions };
}

async function historyPlan(
  client: CanvasClient,
  input: PlanInput,
  jobs: Record<string, unknown>[],
): Promise<Plan> {
  if (!jobs.some((job) => job.jobId === input.jobId))
    return { prompt: '', inputs: [], source: {}, reasons: ['source_job_not_in_returned_node_history'] };
  const historical = await call(client, 'Lab', 'GetLabJob', { jobId: input.jobId });
  if (historical.jobId !== input.jobId || (historical.nodeId && historical.nodeId !== input.nodeId))
    throw new TripoError('CONTRACT_CHANGED', 'Historical Lab job identity mismatch.');
  const reasons: string[] = [],
    prompt = text(historical.prompt).trim();
  if (!terminal(historical.status)) reasons.push('source_job_not_terminal');
  if (!prompt) reasons.push('source_prompt_empty');
  if (!Array.isArray(historical.inputs)) reasons.push('source_inputs_unavailable');
  const original = array(historical.inputs).map(object);
  if (original.some((asset) => !text(asset.assetId).trim())) reasons.push('source_input_identity_missing');
  const inputs = uniqueInputs(
    original.map((asset) => ({
      asset_id: text(asset.assetId).trim(),
      kind: text(asset.kind),
      name: text(asset.filename) || text(asset.assetId),
    })),
  );
  return {
    prompt,
    inputs,
    reasons,
    source: { source_job_id: input.jobId, source_status: historical.status },
  };
}

async function verifySnapshot(
  client: CanvasClient,
  input: PlanInput,
  scope: ReturnType<typeof context>,
  plan: Plan,
) {
  const latest = await call(client, 'Canvas', 'GetCanvas', { canvasId: input.canvasId }),
    latestScope = context(latest, input.canvasId, input.nodeId);
  if (graphIdentity(latestScope) !== graphIdentity(scope))
    throw new TripoError('CANVAS_CHANGED', 'Lab graph or upstream binding changed while preparing the plan.');
  if (plan.current) {
    const reread = await upstream(client, latest, latestScope);
    if (
      inputIdentity(reread.inputs) !== inputIdentity(plan.current.inputs) ||
      JSON.stringify(reread.missing) !== JSON.stringify(plan.current.missing)
    )
      throw new TripoError('CANVAS_CHANGED', 'Selected Lab input assets changed while preparing the plan.');
  }
  if (plan.instructions) {
    const reread = savedInstructions(
      await call(client, 'Lab', 'GetLabTaskInstructions', { nodeId: input.nodeId }),
      input.nodeId,
    );
    if (JSON.stringify(reread) !== JSON.stringify(plan.instructions))
      throw new TripoError('CANVAS_CHANGED', 'Saved Lab instructions changed while preparing the plan.');
  }
}

export async function resolveCanvasLabPlan(studio: StudioClient, requested: unknown): Promise<unknown> {
  const input = labPlanSchema.parse(requested);
  studio = bindCanvasAccount(studio);
  const signal = AbortSignal.timeout(20000);
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
  const graph = await call(client, 'Canvas', 'GetCanvas', { canvasId: input.canvasId }),
    scope = context(graph, input.canvasId, input.nodeId),
    revision = text(scope.canvas.revision);
  if (input.revision !== undefined && input.revision !== revision)
    throw new TripoError('CANVAS_CHANGED', 'Read the current Canvas before preparing a Lab operation.');
  const jobs = await history(client, input);
  const plan =
    input.mode === 'reuse_instructions'
      ? await instructionPlan(client, input, graph, scope, studio.credentials.load()!.accountRef!)
      : await historyPlan(client, input, jobs);
  const { prompt, inputs, source, reasons } = plan;
  if (jobs.some((job) => active(job.status))) reasons.unshift('lab_job_active');
  const parameters = { node_id: input.nodeId, prompt, asset_ids: inputs.map((asset) => asset.asset_id) };
  if (
    prompt &&
    !canvasAgentSchemas.canvas_lab.safeParse({ ...parameters, accept_variable_cost: true }).success
  )
    reasons.push('prepared_parameters_outside_current_cli_contract');
  await verifySnapshot(client, input, scope, plan);
  studio.credentials.load();
  return sanitize({
    canvas_id: input.canvasId,
    node_id: input.nodeId,
    source_revision: revision,
    mode: input.mode,
    ...source,
    ready: reasons.length === 0,
    reasons,
    inputs,
    missing_inputs: plan.current?.missing ?? [],
    parameters: reasons.length ? null : parameters,
    history_scope: 'returned_jobs_only',
    history_query_limit: input.historyLimit ?? null,
    requires_accept_variable_cost: true,
    quote: { known: false, variable: true },
    validation_scope: 'read_snapshot_only',
    remote_saved: false,
    execution_started: false,
  });
}
