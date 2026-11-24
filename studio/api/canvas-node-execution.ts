/** HolyMolly node Stop/Retry use exact saved identities and one durable request; never replay an unknown write. */
import { CanvasClient, bindCanvasAccount } from './canvas-client.ts';
import type { StudioClient } from './client.ts';
import { array, object, text, TripoError } from '../contracts/errors.ts';
import { id } from '../contracts/primitives.ts';
import type { Job, RemoteIds } from '../contracts/types.ts';

export type CanvasNodeExecutionAction = 'stop' | 'retry';
type RecordValue = Record<string, unknown>;
type ExecutionJob = Pick<Job, 'job_id' | 'account_ref' | 'input'>;
interface Context {
  action: CanvasNodeExecutionAction;
  source_turn_id: string;
  session_id: string;
}
const method = (service: string, action: string) => `/tripo.canvas.api.agent.${service}Service/${action}`;
const activePhases = new Set(['analysing', 'building', 'gate', 'testing', 'queued', 'waiting']);
const terminalStates = new Set(['succeeded', 'failed', 'stopped', 'cancelled', 'canceled', 'done']);
const activeStates = new Set(['queued', 'running', 'awaiting_choice', 'awaiting_input', 'waiting_review']);
const state = (value: unknown) =>
  text(value)
    .replace(/^(?:RUN_STATUS|NODE_STATUS)_/, '')
    .toLowerCase();

function requireInput(input: RecordValue, action?: CanvasNodeExecutionAction): void {
  for (const key of ['canvas_id', 'node_id', 'expected_run_id'])
    if (!id.safeParse(input[key]).success)
      throw new TripoError(
        'INVALID_INPUT',
        `${key} must identify the exact saved execution.`,
        'not_submitted',
      );
  if (typeof input.revision !== 'string' || !/^\d+$/.test(input.revision))
    throw new TripoError('INVALID_INPUT', 'The saved Canvas revision is required.', 'not_submitted');
  if (action !== undefined && !['stop', 'retry'].includes(action))
    throw new TripoError('INVALID_INPUT', 'Unsupported node execution action.', 'not_submitted');
  if (action === 'retry' && input.accept_variable_cost !== true)
    throw new TripoError(
      'VARIABLE_COST_NOT_ACCEPTED',
      'Node retry can create a new billed execution; explicitly accept variable cost.',
      'not_submitted',
    );
}
function changed(message: string): never {
  throw new TripoError('CONTRACT_CHANGED', message);
}
async function call(client: CanvasClient, service: string, action: string, input: RecordValue) {
  return object(await client.call(method(service, action), input));
}
async function savedTarget(client: CanvasClient, input: RecordValue) {
  const result = await call(client, 'Canvas', 'GetCanvas', { canvasId: input.canvas_id });
  const canvas = object(result.canvas);
  if (canvas.canvasId !== input.canvas_id || !Array.isArray(result.nodes) || !Array.isArray(result.nodeRuns))
    changed('The saved Canvas or node execution identity is unavailable.');
  if (text(canvas.revision) !== input.revision)
    throw new TripoError('CANVAS_CHANGED', 'The saved Canvas revision changed; inspect its current state.');
  const nodes = result.nodes.map(object).filter((node) => node.id === input.node_id);
  const runs = result.nodeRuns.map(object).filter((run) => run.nodeId === input.node_id);
  if (nodes.length !== 1 || runs.length !== 1)
    changed('The selected node or its current execution is missing or ambiguous.');
  if (nodes[0]!.type !== 'NODE_TYPE_HOLY_MOLLY')
    throw new TripoError(
      'UNSUPPORTED_OPERATION',
      'Node Stop/Retry is mapped only for saved HolyMolly nodes.',
    );
  if (runs[0]!.runId !== input.expected_run_id)
    throw new TripoError(
      'CANVAS_CHANGED',
      'The node now refers to a different run; no newer run was selected.',
    );
  return { node: nodes[0]!, nodeRun: runs[0]! };
}
function requireEligible(
  target: Awaited<ReturnType<typeof savedTarget>>,
  run: RecordValue,
  action: CanvasNodeExecutionAction,
) {
  const params = object(target.node.params);
  const statuses = [state(target.nodeRun.status), state(run.status)];
  if (action === 'stop') {
    if (!activePhases.has(text(params.hm_phase)) || !statuses.every((value) => activeStates.has(value)))
      throw new TripoError(
        'NODE_EXECUTION_NOT_STOPPABLE',
        'Stop requires an observed active HolyMolly phase and recognized nonterminal node/run states.',
      );
  } else if (params.retryable !== true || !statuses.every((value) => terminalStates.has(value)))
    throw new TripoError(
      'NODE_EXECUTION_NOT_RETRYABLE',
      'Retry requires retryable=true and terminal states for the exact previous node execution and run.',
    );
}
async function ownedSourceRun(client: CanvasClient, input: RecordValue) {
  const run = object((await call(client, 'Run', 'GetRun', { runId: input.expected_run_id })).run);
  const nodeIds = array(run.nodeIds);
  if (
    run.runId !== input.expected_run_id ||
    run.canvasId !== input.canvas_id ||
    !id.safeParse(run.turnId).success ||
    !nodeIds.length ||
    nodeIds.some((nodeId) => !id.safeParse(nodeId).success) ||
    new Set(nodeIds).size !== nodeIds.length ||
    !nodeIds.includes(input.node_id)
  )
    changed('The source run does not match the exact Canvas, node and turn identities.');
  const turn = object((await call(client, 'Turn', 'GetTurnDetail', { turnId: run.turnId })).turn);
  if (turn.turnId !== run.turnId || !id.safeParse(turn.sessionId).success)
    changed('The source run turn identity is unavailable.');
  const session = object(
    (await call(client, 'Session', 'GetSession', { sessionId: turn.sessionId })).session,
  );
  if (session.sessionId !== turn.sessionId || session.canvasId !== input.canvas_id)
    changed('The source run session does not belong to the requested Canvas.');
  return { run, turnId: text(run.turnId), sessionId: text(turn.sessionId) };
}
function storedContext(input: RecordValue): Context {
  const context = object(input._node_execution);
  if (
    !['stop', 'retry'].includes(text(context.action)) ||
    !id.safeParse(context.source_turn_id).success ||
    !id.safeParse(context.session_id).success
  )
    changed('The durable node execution preparation is missing; do not infer it from the latest run.');
  return context as unknown as Context;
}
function requireContext(expected: Context, actual: Context) {
  if (
    expected.action !== actual.action ||
    expected.source_turn_id !== actual.source_turn_id ||
    expected.session_id !== actual.session_id
  )
    changed('The source turn or session no longer matches this prepared node action.');
}
function beforeWrite(error: unknown): never {
  if (error instanceof TripoError)
    throw new TripoError(error.code, error.message, 'not_submitted', error.details);
  throw new TripoError(
    'NODE_EXECUTION_PRECHECK_FAILED',
    'Node execution preflight did not complete.',
    'not_submitted',
  );
}

/** Read-only preparation; the hidden context is frozen by the normal persistent task service. */
export async function prepareCanvasNodeExecution(
  studio: StudioClient,
  input: RecordValue,
  action: CanvasNodeExecutionAction,
): Promise<RecordValue> {
  try {
    requireInput(input, action);
    studio = bindCanvasAccount(studio);
    const client = new CanvasClient(studio);
    const target = await savedTarget(client, input);
    const source = await ownedSourceRun(client, input);
    requireEligible(target, source.run, action);
    // This narrows a read/write race; the actual RPC accepts neither revision nor runId.
    const finalTarget = await savedTarget(client, input);
    requireEligible(finalTarget, source.run, action);
    studio.credentials.load();
    return {
      ...input,
      _node_execution: { action, source_turn_id: source.turnId, session_id: source.sessionId },
    };
  } catch (error) {
    beforeWrite(error);
  }
}

/** Called only after the durable job has claimed submission. An unknown job is never sent again. */
export async function submitCanvasNodeExecution(
  studio: StudioClient,
  job: ExecutionJob,
  action: CanvasNodeExecutionAction,
  assertClaimed: () => void,
): Promise<{ remote_ids: RemoteIds & { task_id: string } }> {
  const verifyClaim = () => {
    try {
      if (typeof assertClaimed !== 'function')
        throw new TripoError('SUBMISSION_NOT_CLAIMED', 'A durable submission claim checker is required.');
      assertClaimed();
    } catch (error) {
      beforeWrite(error);
    }
  };
  let client: CanvasClient;
  try {
    verifyClaim();
    if (!id.safeParse(job.job_id).success)
      throw new TripoError('SUBMISSION_NOT_CLAIMED', 'Node execution requires the original durable job ID.');
    studio = studio.forAccount(job.account_ref);
    const expected = storedContext(job.input);
    const prepared = await prepareCanvasNodeExecution(studio, job.input, action);
    requireContext(expected, storedContext(prepared));
    client = new CanvasClient(studio);
  } catch (error) {
    beforeWrite(error);
  }
  const result = object(
    await client.call(
      method('Node', action === 'stop' ? 'StopNodeExecution' : 'RetryNodeExecution'),
      { nodeId: job.input.node_id, requestId: job.job_id },
      true,
      verifyClaim,
    ),
  );
  // The observed Stop RPC acknowledges the original run, not a newly created turn.
  // Never fall back to a turn when a conflicting run receipt is present.
  if (action === 'stop' && Object.hasOwn(result, 'runId')) {
    if (
      result.runId !== job.input.expected_run_id ||
      result.status !== 'accepted' ||
      Object.hasOwn(result, 'turnId')
    )
      throw new TripoError(
        'CONTRACT_CHANGED',
        'Node stop receipt does not unambiguously acknowledge the exact original run; inspect without resubmitting.',
        'unknown',
      );
    return {
      remote_ids: { task_id: text(result.runId), node_execution_receipt: 'accepted_run' },
    };
  }
  if (!id.safeParse(result.turnId).success)
    throw new TripoError(
      'CONTRACT_CHANGED',
      'Node execution receipt has no exact turnId; inspect the original request, node and run without resubmitting.',
      'unknown',
    );
  if (action === 'stop') {
    if (
      result.turnId === job.input.expected_run_id ||
      (result.status !== undefined && result.status !== 'accepted')
    )
      throw new TripoError(
        'CONTRACT_CHANGED',
        'Node stop turn receipt has an ambiguous identity or unrecognized acknowledgment; inspect without resubmitting.',
        'unknown',
      );
    return { remote_ids: { task_id: text(result.turnId), node_execution_receipt: 'turn' } };
  }
  return { remote_ids: { task_id: text(result.turnId) } };
}

/** Inspect the original run even after the node is removed or replaced; this never resolves an unknown receipt. */
export async function readSourceRun(studio: StudioClient, job: ExecutionJob): Promise<RecordValue> {
  requireInput(job.input);
  const expected = storedContext(job.input);
  studio = studio.forAccount(job.account_ref);
  const source = await ownedSourceRun(new CanvasClient(studio), job.input);
  requireContext(expected, {
    action: expected.action,
    source_turn_id: source.turnId,
    session_id: source.sessionId,
  });
  studio.credentials.load();
  return source.run;
}
