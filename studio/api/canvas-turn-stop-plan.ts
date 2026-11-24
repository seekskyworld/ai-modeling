/** Discover exact turn-owned runs before composing CancelTurn and StopRun; never submit either here. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { StudioClient } from './client.ts';
import { CanvasClient, bindCanvasAccount } from './canvas-client.ts';
import { canvasStateFingerprint } from './canvas-state.ts';
import { id } from '../contracts/primitives.ts';
import { object, text, sanitize, TripoError } from '../contracts/errors.ts';

export const turnStopPlanSchema = z
  .object({
    canvasId: id,
    turnId: id,
    expectedRevision: z.string().regex(/^\d+$/).optional(),
    maxMessages: z.number().int().min(1).max(2000).default(500),
    maxRuns: z.number().int().min(1).max(500).default(100),
  })
  .strict();
type Input = z.infer<typeof turnStopPlanSchema>;
type RecordValue = Record<string, unknown>;
const nodeLimit = 1000;
const activeTurns = new Set(['queued', 'running', 'waiting_for_user']);
const terminalTurns = new Set(['done', 'failed', 'cancelled', 'canceled']);
const activeRuns = new Set([
  'queued',
  'running',
  'cancelling',
  'stopping',
  'waiting_review',
  'awaiting_choice',
  'awaiting_input',
]);
const terminalRuns = new Set([
  'done',
  'succeeded',
  'failed',
  'cancelled',
  'canceled',
  'stopped',
  'aborted',
  'skipped',
]);
const status = (value: unknown) =>
  text(value)
    .replace(/^(?:TURN_STATUS|RUN_STATUS|RUN_STEP_STATUS|NODE_STATUS)_/, '')
    .toLowerCase();
const call = (client: CanvasClient, service: string, method: string, body: RecordValue) =>
  client.call(`/tripo.canvas.api.agent.${service}Service/${method}`, body).then(object);
function changed(message: string): never {
  throw new TripoError('CONTRACT_CHANGED', message);
}
function validId(value: unknown): value is string {
  return id.safeParse(value).success;
}
function paginationReasons(value: RecordValue, count: number, scope: string, reasons: string[]) {
  const containers = [value, object(value.pagination), object(value.pageInfo)];
  for (const item of containers) {
    for (const key of ['hasMore', 'has_more', 'haveMore', 'have_more', 'truncated'])
      if (item[key] !== undefined && item[key] !== false) reasons.push(`${scope}_pagination_unresolved`);
    for (const key of [
      'nextPageToken',
      'next_page_token',
      'nextCursor',
      'next_cursor',
      'nextPage',
      'next_page',
    ])
      if (item[key] !== undefined && item[key] !== null && item[key] !== '')
        reasons.push(`${scope}_pagination_unresolved`);
    if (item.complete === false) reasons.push(`${scope}_pagination_unresolved`);
    if (item.total !== undefined && (!Number.isSafeInteger(item.total) || Number(item.total) !== count))
      reasons.push(`${scope}_total_unresolved`);
  }
}
function collection(value: RecordValue, field: string, limit: number, scope: string, reasons: string[]) {
  const raw = value[field];
  if (!Array.isArray(raw)) {
    reasons.push(`${scope}_unavailable`);
    return [];
  }
  if (raw.length >= limit) reasons.push(`${scope}_limit_reached`);
  paginationReasons(value, raw.length, scope, reasons);
  return raw.slice(0, limit).map(object);
}
function uniqueRecords(records: RecordValue[], key: string, scope: string) {
  const ids = records.map((record) => record[key]);
  if (ids.some((value) => !validId(value)) || new Set(ids).size !== ids.length)
    changed(`${scope} identities are missing or duplicated.`);
}
function messageShape(message: RecordValue) {
  return {
    id: message.messageId,
    turn: message.turnId,
    role: message.role,
    card: message.cardType,
    card_json: message.cardJson,
  };
}
function messages(value: RecordValue, input: Input, scope: string, reasons: string[]) {
  const result = collection(value, 'messages', input.maxMessages, scope, reasons);
  uniqueRecords(result, 'messageId', scope);
  if (result.some((message) => !validId(message.turnId))) changed('A message has no exact turn identity.');
  return result;
}
function planNodes(messages: RecordValue[], reasons: string[]): string[] {
  const ids = new Set<string>();
  let visited = 0;
  for (const message of messages) {
    const raw = text(message.cardJson);
    if (!raw && message.cardType !== 'CARD_TYPE_PLAN_STEPS') continue;
    let card: RecordValue;
    try {
      if (raw.length > 100000) throw new Error('bounded');
      card = object(JSON.parse(raw));
    } catch {
      reasons.push('message_card_unreadable');
      continue;
    }
    if (message.cardType !== 'CARD_TYPE_PLAN_STEPS' && card.type !== 'plan_steps') continue;
    if (!['MESSAGE_ROLE_AGENT', 'assistant'].includes(text(message.role))) {
      reasons.push('plan_card_not_assistant');
      continue;
    }
    const groups = object(card.data).groups;
    if (!Array.isArray(groups)) {
      reasons.push('plan_groups_unavailable');
      continue;
    }
    for (const group of groups) {
      const steps = object(group).steps;
      if (!Array.isArray(steps)) {
        reasons.push('plan_steps_unavailable');
        continue;
      }
      for (const step of steps) {
        if (++visited > nodeLimit) {
          reasons.push('plan_nodes_limit_reached');
          return [...ids];
        }
        const nodes = object(step).nodeIds;
        if (
          !Array.isArray(nodes) ||
          nodes.some((node) => !validId(node)) ||
          new Set(nodes).size !== nodes.length
        ) {
          reasons.push('plan_node_references_unresolved');
          continue;
        }
        visited += nodes.length;
        if (visited > nodeLimit) {
          reasons.push('plan_nodes_limit_reached');
          return [...ids];
        }
        for (const node of nodes) ids.add(node as string);
      }
    }
  }
  return [...ids].sort();
}
function runCandidates(nodeRuns: RecordValue[], runs: RecordValue[], input: Input, reasons: string[]) {
  const candidates = new Set<string>();
  for (const run of [...nodeRuns, ...runs]) {
    if (validId(run.runId)) candidates.add(run.runId);
    else if (run.runId !== '' && run.runId !== undefined) reasons.push('current_run_identity_unavailable');
    else if (activeRuns.has(status(run.status))) reasons.push('active_run_identity_unavailable');
  }
  if (candidates.size >= input.maxRuns) reasons.push('run_candidates_limit_reached');
  return [...candidates].sort().slice(0, input.maxRuns);
}
async function snapshot(client: CanvasClient, input: Input, expectedSession?: string) {
  const reasons: string[] = [];
  const detail = await call(client, 'Turn', 'GetTurnDetail', { turnId: input.turnId });
  const turn = object(detail.turn);
  if (
    turn.turnId !== input.turnId ||
    !validId(turn.sessionId) ||
    (expectedSession && turn.sessionId !== expectedSession)
  )
    changed('The exact turn or its session identity changed.');
  const turnMessages = messages(detail, input, 'turn_messages', reasons);
  if (turnMessages.some((message) => message.turnId !== input.turnId))
    changed('Turn detail contains another turn’s messages.');
  const sessionDetail = await call(client, 'Session', 'GetSession', { sessionId: turn.sessionId });
  const session = object(sessionDetail.session);
  if (session.sessionId !== turn.sessionId || session.canvasId !== input.canvasId)
    changed('The selected turn session belongs to a different Canvas.');
  const sessionMessages = messages(sessionDetail, input, 'session_messages', reasons).filter(
    (message) => message.turnId === input.turnId,
  );
  if (
    canvasStateFingerprint(turnMessages.map(messageShape)) !==
    canvasStateFingerprint(sessionMessages.map(messageShape))
  )
    reasons.push('turn_session_messages_disagree');
  const graph = await call(client, 'Canvas', 'GetCanvas', { canvasId: input.canvasId });
  const canvas = object(graph.canvas);
  if (
    canvas.canvasId !== input.canvasId ||
    !validId(canvas.projectId) ||
    !/^\d+$/.test(text(canvas.revision))
  )
    changed('The saved Canvas identity or revision is unavailable.');
  if (input.expectedRevision !== undefined && input.expectedRevision !== canvas.revision)
    reasons.push('expected_revision_changed');
  const nodes = collection(graph, 'nodes', nodeLimit, 'canvas_nodes', reasons);
  const nodeRuns = collection(graph, 'nodeRuns', nodeLimit, 'canvas_node_runs', reasons);
  uniqueRecords(nodes, 'id', 'Canvas node');
  uniqueRecords(nodeRuns, 'nodeId', 'Current node run');
  if (nodeRuns.some((run) => !nodes.some((node) => node.id === run.nodeId)))
    reasons.push('current_run_node_unavailable');
  const listed = await call(client, 'Run', 'ListCanvasRuns', { canvasId: input.canvasId });
  const runs = collection(listed, 'runs', input.maxRuns, 'listed_runs', reasons);
  uniqueRecords(runs, 'runId', 'Listed run');
  const planNodeIds = planNodes(turnMessages, reasons);
  const candidates = runCandidates(nodeRuns, runs, input, reasons);
  return {
    reasons,
    turn,
    session,
    canvas,
    nodes,
    nodeRuns,
    runs,
    planNodeIds,
    candidates,
    messageCount: turnMessages.length,
    binding: canvasStateFingerprint({
      turn,
      session: { id: session.sessionId, canvas: session.canvasId, status: session.status },
      messages: turnMessages.map(messageShape),
      canvas,
      nodes: nodes.map((node) => ({ id: node.id, type: node.type })),
      nodeRuns: nodeRuns.map((run) => ({
        node: run.nodeId,
        run: run.runId,
        status: run.status,
        step: run.currentStepId,
      })),
      runs: runs.map((run) => ({
        run: run.runId,
        canvas: run.canvasId,
        turn: run.turnId,
        status: run.status,
        nodes: run.nodeIds,
      })),
    }),
  };
}
type Snapshot = Awaited<ReturnType<typeof snapshot>>;
function runIdentity(run: RecordValue, runId: string, input: Input) {
  if (run.runId !== runId || run.canvasId !== input.canvasId || typeof run.turnId !== 'string')
    changed('A discovered run has a conflicting run, Canvas or turn identity.');
  if (
    !Array.isArray(run.nodeIds) ||
    run.nodeIds.some((node) => !validId(node)) ||
    new Set(run.nodeIds).size !== run.nodeIds.length
  )
    changed('A discovered run has ambiguous node identities.');
}
function ownedRun(run: RecordValue, initial: Snapshot, reasons: string[]) {
  const nodeIds = run.nodeIds as string[];
  if (!nodeIds.length) reasons.push('owned_run_nodes_unavailable');
  const current = initial.nodeRuns.filter((row) => row.runId === run.runId);
  if (current.some((row) => !nodeIds.includes(String(row.nodeId))))
    changed('A current node is not part of its reported run.');
  const steps = Array.isArray(run.steps) ? run.steps.map(object) : [];
  if (!Array.isArray(run.steps)) reasons.push('owned_run_steps_unavailable');
  uniqueRecords(steps, 'stepId', 'Run step');
  if (steps.some((step) => !nodeIds.includes(String(step.nodeId))))
    changed('A run step belongs to another node.');
  for (const row of current) {
    if (
      text(row.currentStepId) &&
      !steps.some((step) => step.stepId === row.currentStepId && step.nodeId === row.nodeId)
    )
      reasons.push('current_run_step_unresolved');
  }
  const phase = status(run.status);
  if (!activeRuns.has(phase) && !terminalRuns.has(phase)) reasons.push('owned_run_state_unknown');
  return {
    run_id: String(run.runId),
    status: phase,
    node_ids: nodeIds,
    active: activeRuns.has(phase),
    terminal: terminalRuns.has(phase),
    current_node_ids: current.map((row) => String(row.nodeId)),
    already_stopping: ['cancelling', 'stopping'].includes(phase),
  };
}
async function readRuns(client: CanvasClient, input: Input, initial: Snapshot, reasons: string[]) {
  const owned: ReturnType<typeof ownedRun>[] = [];
  const unresolved: { run_id: string; code: string }[] = [];
  let excluded = 0;
  let unbound = 0;
  for (let offset = 0; offset < initial.candidates.length; offset += 4) {
    const batch = initial.candidates.slice(offset, offset + 4);
    const results = await Promise.allSettled(batch.map((runId) => call(client, 'Run', 'GetRun', { runId })));
    for (let index = 0; index < results.length; index++) {
      const result = results[index]!,
        runId = batch[index]!;
      if (result.status === 'rejected') {
        const error = result.reason;
        if (error instanceof TripoError && ['ACCOUNT_MISMATCH', 'AUTH_REQUIRED'].includes(error.code))
          throw error;
        unresolved.push({
          run_id: runId,
          code: error instanceof TripoError ? error.code : 'RUN_READ_FAILED',
        });
        continue;
      }
      const run = object(result.value.run);
      runIdentity(run, runId, input);
      if (run.turnId !== input.turnId) {
        if (run.turnId === '') unbound++;
        else excluded++;
        continue;
      }
      owned.push(ownedRun(run, initial, reasons));
    }
  }
  if (unresolved.length) reasons.push('run_reads_incomplete');
  const covered = new Set(owned.flatMap((run) => run.node_ids));
  if (initial.planNodeIds.some((node) => !covered.has(node))) reasons.push('plan_node_run_unresolved');
  return { owned, unresolved, excluded, unbound };
}
function actions(input: Input, current: Snapshot, runs: ReturnType<typeof ownedRun>[], ready: boolean) {
  const turnStatus = status(current.turn.status);
  const cancelled = ['cancelled', 'canceled'].includes(turnStatus);
  const active = runs.filter((run) => run.active);
  const reread = {
    tool: 'ai_modeling_canvas_turn_stop_plan',
    parameters: { ...input, expectedRevision: undefined },
  };
  const candidates = cancelled ? active.filter((run) => ['queued', 'running'].includes(run.status)) : [];
  return [
    {
      stage: 'cancel_turn',
      status: !ready ? 'blocked' : activeTurns.has(turnStatus) ? 'ready' : 'not_needed',
      actions:
        ready && activeTurns.has(turnStatus)
          ? [{ tool: 'ai_modeling_canvas_turn_cancel', parameters: { turnId: input.turnId } }]
          : [],
    },
    {
      stage: 'refresh_after_cancel',
      status: cancelled ? 'observed_cancelled' : 'required_before_run_stop',
      actions: [reread],
    },
    {
      stage: 'stop_runs',
      status: !ready
        ? 'blocked'
        : !cancelled
          ? active.length
            ? 'requires_cancelled_turn'
            : 'not_needed'
          : candidates.length
            ? 'ready'
            : active.length
              ? 'awaiting_run_state'
              : 'not_needed',
      actions: ready
        ? candidates.map((run) => ({
            tool: 'ai_modeling_canvas_run_stop',
            parameters: { runId: run.run_id },
          }))
        : [],
    },
    { stage: 'verify_again', status: 'required', actions: [reread] },
  ];
}
export async function resolveCanvasTurnStopPlan(studio: StudioClient, requested: unknown): Promise<unknown> {
  const input = turnStopPlanSchema.parse(requested);
  studio = bindCanvasAccount(studio);
  const client = new CanvasClient(studio);
  const initial = await snapshot(client, input);
  const reasons = [...initial.reasons];
  const discovery = await readRuns(client, input, initial, reasons);
  const latest = await snapshot(client, input, String(initial.turn.sessionId));
  reasons.push(...latest.reasons);
  if (latest.binding !== initial.binding) reasons.push('discovery_changed_during_read');
  const turnStatus = status(latest.turn.status);
  if (!activeTurns.has(turnStatus) && !terminalTurns.has(turnStatus)) reasons.push('turn_state_unknown');
  if (latest.session.status !== 'SESSION_STATUS_ACTIVE') reasons.push('session_not_active');
  studio.credentials.load();
  const ready = reasons.length === 0;
  const active = discovery.owned.filter((run) => run.active);
  return sanitize({
    canvas_id: input.canvasId,
    session_id: latest.turn.sessionId,
    turn_id: input.turnId,
    turn_status: latest.turn.status,
    source_revision: latest.canvas.revision,
    ready,
    incomplete: !ready,
    reasons: [...new Set(reasons)],
    plan_node_ids: latest.planNodeIds,
    owned_runs: discovery.owned,
    unresolved_runs: discovery.unresolved,
    active_owned_run_count: active.length,
    terminal_turn_with_active_runs: terminalTurns.has(turnStatus) && active.length > 0,
    stages: actions(input, latest, discovery.owned, ready),
    coverage: {
      scope: 'returned_current_canvas_and_run_snapshots',
      observed_complete: ready,
      history_complete: null,
      messages_observed: latest.messageCount,
      listed_runs_observed: latest.runs.length,
      current_node_runs_observed: latest.nodeRuns.length,
      candidate_runs_read: initial.candidates.length,
      excluded_other_turn_runs: discovery.excluded,
      excluded_unbound_runs: discovery.unbound,
      max_messages: input.maxMessages,
      max_runs: input.maxRuns,
      max_nodes: nodeLimit,
    },
    snapshot_binding: createHash('sha256').update(initial.binding).digest('hex'),
    concurrency_policy:
      'This is not an atomic stop or an exhaustive historical inventory. A new run can appear after these reads. After CancelTurn, re-read this plan and verify each exact run again before StopRun; re-read after stopping. Never infer that no future run can appear.',
    unknown_write_policy:
      'This plan does not reconcile or replay any prior write. Preserve an unknown CancelTurn or StopRun receipt and inspect its original identities without automatic resubmission.',
    outcome_policy:
      'Turn cancellation, run cancellation, natural completion and failure are separate outcomes. A terminal turn or no currently observed active runs does not prove that a stop request took effect.',
    execution_started: false,
    remote_saved: false,
    read_only: true,
  });
}
