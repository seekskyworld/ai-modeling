/** 画布创作任务使用与普通生成相同的持久状态；本地幂等不冒充不带幂等键的 Turn 接口保证。 */
import { CanvasClient } from './canvas-client.ts';
import { readSourceRun, submitCanvasNodeExecution } from './canvas-node-execution.ts';
import { canvasNodeOperations } from '../contracts/canvas-agent.ts';
import { verifyTurnAttachments } from './canvas-turn-assets.ts';
import type { TurnAttachment } from './canvas-turn-compose.ts';
import type { StudioClient } from './client.ts';
import type { ArtifactLinks } from '../auth/artifact-links.ts';
import type { Job, RemoteIds, RemoteStatus, Artifact, ObservedCost } from '../contracts/types.ts';
import { array, object, text, TripoError } from '../contracts/errors.ts';
const method = (service: string, action: string) => `/tripo.canvas.api.agent.${service}Service/${action}`;

/** 网页按附件顺序保留同素材在不同节点的引用；不能按 assetId 去重而丢失来源。 */
function attachmentRefs(input: Record<string, unknown>): Record<string, unknown>[] {
  return array(input.refs).map((value) => {
    const ref = object(value);
    const kind = text(ref.kind).trim();
    return {
      assetId: ref.asset_id,
      ...(ref.filename ? { filename: ref.filename } : {}),
      ...(kind
        ? {
            kind:
              kind.length <= 32
                ? kind
                : kind.startsWith('image/')
                  ? 'image'
                  : kind.startsWith('model/')
                    ? 'model'
                    : 'file',
          }
        : {}),
      ...(ref.node_id ? { nodeId: ref.node_id } : {}),
    };
  });
}

function checkEmptyGameReference(input: Record<string, unknown>, target?: Record<string, unknown>): void {
  if (text(input.text).trim()) return;
  if (
    !array(input.capabilities).includes('holy_molly') ||
    !text(input.node_id) ||
    array(input.refs).length ||
    array(input.attachment_ids).length ||
    target?.type !== 'NODE_TYPE_HOLY_MOLLY'
  )
    throw new TripoError(
      'INVALID_INPUT',
      'An empty message requires an explicit HolyMolly capability and the exact saved HolyMolly target, without ordinary attachments.',
      'not_submitted',
    );
}

/** 新提交复用 composer 的准确来源守卫；独立上传仍须在当前项目 READY。 */
async function checkReferenceNodes(
  canvas: CanvasClient,
  input: Record<string, unknown>,
  refs: Record<string, unknown>[],
): Promise<void> {
  const attachments: TurnAttachment[] = refs.length
    ? refs.map((ref) => ({
        assetId: text(ref.assetId),
        ...(ref.nodeId ? { nodeId: text(ref.nodeId) } : {}),
      }))
    : array(input.attachment_ids).map((assetId) => ({ assetId: text(assetId) }));
  const nodeId = text(input.node_id),
    sessionId = input.session_id;
  if (!attachments.length && !nodeId) return;
  const detail = object(await canvas.call(method('Session', 'GetSession'), { sessionId }));
  const session = object(detail.session);
  const canvasId = text(session.canvasId);
  if (session.sessionId !== sessionId || !canvasId)
    throw new TripoError('CONTRACT_CHANGED', 'Attachment session identity is unavailable.', 'not_submitted');
  const graph = object(await canvas.call(method('Canvas', 'GetCanvas'), { canvasId }));
  if (object(graph.canvas).canvasId !== canvasId || !Array.isArray(graph.nodes))
    throw new TripoError('CONTRACT_CHANGED', 'Attachment canvas identity mismatch.', 'not_submitted');
  const nodes = graph.nodes.map(object);
  if (nodeId && nodes.filter((node) => node.id === nodeId).length !== 1)
    throw new TripoError(
      'CANVAS_CHANGED',
      'The target node is missing or ambiguous in the session Canvas. Read the Canvas and update node_id.',
      'not_submitted',
    );
  checkEmptyGameReference(
    input,
    nodes.find((node) => node.id === nodeId),
  );
  try {
    await verifyTurnAttachments(canvas, { canvas: object(graph.canvas), nodes }, attachments);
  } catch (error) {
    // 此处只有读取；不能把新消息的预检失败报告成可能已提交。
    if (error instanceof TripoError)
      throw new TripoError(error.code, error.message, 'not_submitted', error.details);
    throw error;
  }
}

async function checkContinuation(canvas: CanvasClient, input: Record<string, unknown>): Promise<void> {
  // 网页为每次答案生成新的幂等键；复制创建 Turn 的 requestId 会静默复用原请求。
  const detail = object(await canvas.call(method('Turn', 'GetTurnDetail'), { turnId: input.turn_id })),
    turn = object(detail.turn);
  if (turn.turnId !== input.turn_id)
    throw new TripoError('CONTRACT_CHANGED', 'Continuation target identity mismatch.', 'not_submitted');
  if (turn.status !== 'TURN_STATUS_WAITING_FOR_USER')
    throw new TripoError(
      'TURN_NOT_WAITING',
      'This turn is not waiting for a user answer. Read its current result before continuing.',
      'not_submitted',
    );
  if (input.request_id && input.request_id === turn.requestId)
    throw new TripoError(
      'INVALID_INPUT',
      'Do not reuse turn.requestId for an answer; omit the remote request ID to use the persisted job UUID.',
      'not_submitted',
    );
}

async function submitNodeTask(client: StudioClient, job: Job, beforeSubmit?: () => void) {
  if (!beforeSubmit)
    throw new TripoError(
      'SUBMISSION_NOT_CLAIMED',
      'A durable node submission guard is required.',
      'not_submitted',
    );
  return await submitCanvasNodeExecution(
    client,
    job,
    job.operation === 'canvas_node_stop' ? 'stop' : 'retry',
    beforeSubmit,
  );
}

export async function submitCreativeTask(
  client: StudioClient,
  job: Job,
  beforeSubmit?: () => void,
): Promise<{ remote_ids: RemoteIds & { task_id: string } }> {
  const canvas = new CanvasClient(client);
  const x = job.input;
  if (canvasNodeOperations.has(job.operation)) return await submitNodeTask(client, job, beforeSubmit);
  if (job.operation === 'canvas_lab') {
    const result = object(
      await canvas.call(
        method('Lab', 'CreateLabJob'),
        {
          nodeId: x.node_id,
          prompt: x.prompt,
          idempotencyKey: job.job_id,
          ...(x.asset_ids ? { assetIds: x.asset_ids } : {}),
        },
        true,
        beforeSubmit,
      ),
    );
    if (!text(result.jobId))
      throw new TripoError('CONTRACT_CHANGED', 'Lab receipt has no job ID.', 'unknown');
    return { remote_ids: { task_id: text(result.jobId) } };
  }
  if (job.operation === 'canvas_continue') {
    await checkContinuation(canvas, x);
    await canvas.call(
      method('Turn', 'ContinueTurn'),
      {
        turnId: x.turn_id,
        requestId: x.request_id ?? job.job_id,
        selectedOptionIds: x.selected_option_ids,
        ...(x.confirmed_parts ? { confirmedParts: x.confirmed_parts } : {}),
        ...(x.other_text !== undefined ? { otherText: x.other_text } : {}),
        ...(x.other_texts ? { otherTexts: x.other_texts } : {}),
        ...(x.text !== undefined ? { text: x.text } : {}),
        ...(x.attachment_ids ? { attachmentIds: x.attachment_ids } : {}),
      },
      true,
      beforeSubmit,
    );
    return { remote_ids: { task_id: text(x.turn_id) } };
  }
  const refs = attachmentRefs(x);
  await checkReferenceNodes(canvas, x, refs);
  const result = object(
    await canvas.call(
      method('Session', 'CreateTurn'),
      {
        sessionId: x.session_id,
        text: x.text,
        mode: x.mode === 'auto' ? 'MODE_AUTO' : 'MODE_CONTROL',
        nodeId: x.node_id ?? '',
        ...(array(x.capabilities).length ? { capabilities: x.capabilities } : {}),
        attachmentIds: refs.length ? refs.map((ref) => ref.assetId) : x.attachment_ids,
        ...(refs.length ? { refs } : {}),
      },
      true,
      beforeSubmit,
    ),
  );
  const id = text(result.id) || text(result.turnId);
  if (!id)
    throw new TripoError(
      'CONTRACT_CHANGED',
      'Turn receipt has no ID; reconcile before any further submission.',
      'unknown',
    );
  return { remote_ids: { task_id: id } };
}
function nodeStopUsesRun(job: Job): boolean {
  const kind = job.remote_ids.node_execution_receipt;
  if (kind === 'accepted_run') {
    if (!text(job.input.expected_run_id) || job.remote_ids.task_id !== job.input.expected_run_id)
      throw new TripoError('CONTRACT_CHANGED', 'Node stop receipt does not identify its original run.');
    return true;
  }
  // Existing untagged receipts follow the old turn contract and must still pass its identity checks.
  if (
    (kind !== undefined && kind !== 'turn') ||
    !text(job.remote_ids.task_id) ||
    job.remote_ids.task_id === job.input.expected_run_id
  )
    throw new TripoError('CONTRACT_CHANGED', 'Node stop receipt identity is missing or ambiguous.');
  return false;
}
async function verifyNodeReceiptTurn(
  client: StudioClient,
  job: Job,
  detail: Record<string, unknown>,
): Promise<void> {
  const sessionId = text(object(job.input._node_execution).session_id);
  if (!sessionId || detail.sessionId !== sessionId)
    throw new TripoError('CONTRACT_CHANGED', 'Node execution receipt belongs to a different session.');
  const session = object(
    object(await new CanvasClient(client).call(method('Session', 'GetSession'), { sessionId })).session,
  );
  if (session.sessionId !== sessionId || session.canvasId !== job.input.canvas_id)
    throw new TripoError('CONTRACT_CHANGED', 'Node execution receipt belongs to a different Canvas.');
}
export async function creativeDetail(client: StudioClient, job: Job): Promise<Record<string, unknown>> {
  if (job.operation === 'canvas_node_stop' && nodeStopUsesRun(job)) return await readSourceRun(client, job);
  const lab = job.operation === 'canvas_lab';
  if (job.operation === 'canvas_continue' && job.remote_ids.task_id !== job.input.turn_id)
    throw new TripoError('CONTRACT_CHANGED', 'Continuation receipt does not match its original turn.');
  const result = object(
    await new CanvasClient(client).call(
      method(lab ? 'Lab' : 'Turn', lab ? 'GetLabJob' : 'GetTurnDetail'),
      lab ? { jobId: job.remote_ids.task_id } : { turnId: job.remote_ids.task_id },
    ),
  );
  const detail = lab ? result : Object.keys(object(result.turn)).length ? object(result.turn) : result;
  const id = lab ? detail.jobId : (detail.id ?? detail.turnId);
  if (id !== job.remote_ids.task_id)
    throw new TripoError('CONTRACT_CHANGED', 'Creative task identity mismatch.');
  if (
    job.operation === 'canvas_turn' &&
    (!text(job.input.session_id) || detail.sessionId !== job.input.session_id)
  )
    throw new TripoError('CONTRACT_CHANGED', 'Turn belongs to a different session.');
  if (canvasNodeOperations.has(job.operation)) await verifyNodeReceiptTurn(client, job, detail);
  return detail;
}
async function nodeStopStatus(client: StudioClient, job: Job): Promise<RemoteStatus> {
  const run = await readSourceRun(client, job);
  const observedRun = {
    original_run_status: text(run.status),
    ...(text(run.stopRequestedTime) ? { stop_requested_time: text(run.stopRequestedTime) } : {}),
  };
  const graph = object(
    await new CanvasClient(client).call(method('Canvas', 'GetCanvas'), { canvasId: job.input.canvas_id }),
  );
  if (object(graph.canvas).canvasId !== job.input.canvas_id || !Array.isArray(graph.nodeRuns))
    throw new TripoError('CONTRACT_CHANGED', 'The original node execution status is unavailable.');
  const nodes = graph.nodeRuns.map(object).filter((node) => node.nodeId === job.input.node_id);
  if (nodes.length > 1) throw new TripoError('CONTRACT_CHANGED', 'The node execution status is ambiguous.');
  if (nodes.length !== 1 || nodes[0]!.runId !== job.input.expected_run_id)
    return {
      state: 'failed',
      progress: 0,
      artifacts: [],
      error: {
        code: 'STOP_STATE_UNAVAILABLE',
        message:
          'The original node execution was replaced or removed. Its stop outcome cannot be confirmed from another run; preserve the original receipt.',
        ...observedRun,
      },
    };
  const status = text(nodes[0]!.status)
    .replace(/^(?:RUN_STATUS|NODE_STATUS)_/, '')
    .toLowerCase();
  if (['cancelled', 'canceled', 'stopped', 'aborted'].includes(status))
    return { state: 'succeeded', progress: 100, artifacts: [] };
  if (['done', 'succeeded', 'success', 'completed', 'failed'].includes(status))
    return {
      state: 'failed',
      progress: 0,
      artifacts: [],
      error: {
        code: 'STOP_NOT_CONFIRMED',
        remote_status: status,
        node_status: text(nodes[0]!.status),
        ...observedRun,
        message:
          'The original node execution ended without a stopped state. Completion or failure does not prove this stop request took effect.',
      },
    };
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
  throw new TripoError('CONTRACT_CHANGED', 'Unknown original node execution status.');
}
export async function creativeStatus(
  client: StudioClient,
  job: Job,
  links: ArtifactLinks,
): Promise<RemoteStatus> {
  if (job.operation === 'canvas_node_stop') {
    if (!nodeStopUsesRun(job)) await creativeDetail(client, job);
    return await nodeStopStatus(client, job);
  }
  const detail = await creativeDetail(client, job);
  const status = text(detail.status)
    .replace(/^TURN_STATUS_/, '')
    .toLowerCase();
  if (['failed', 'cancelled'].includes(status))
    return {
      state: 'failed',
      progress: 0,
      artifacts: [],
      error: { code: 'REMOTE_TASK_FAILED', remote_status: status },
    };
  if (status === 'waiting_for_user') return { state: 'waiting_input', progress: 0, artifacts: [] };
  if (['queued', 'running'].includes(status)) return { state: 'running', progress: 0, artifacts: [] };
  if (!['completed', 'done'].includes(status))
    throw new TripoError('CONTRACT_CHANGED', 'Unknown creative task status.');
  return { state: 'succeeded', progress: 100, artifacts: labArtifacts(job, detail, links) };
}
function labArtifacts(job: Job, detail: Record<string, unknown>, links: ArtifactLinks): Artifact[] {
  if (job.operation !== 'canvas_lab') return [];
  const artifacts: Artifact[] = [];
  for (const item of array(detail.artifacts).map(object)) {
    const url = text(item.downloadUrl);
    const id = text(item.artifactId);
    if (!url || !id) continue;
    let format: string;
    try {
      format = new URL(url).pathname.split('.').at(-1)?.toLowerCase() ?? '';
    } catch {
      continue;
    }
    if (!['png', 'jpg', 'jpeg', 'webp', 'glb', 'fbx', 'obj', 'stl', 'usdz', '3mf', 'zip'].includes(format))
      continue;
    const kind = ['png', 'jpg', 'jpeg', 'webp'].includes(format) ? 'image' : 'model';
    links.set(`${job.job_id}:${id}`, url);
    artifacts.push({
      artifact_id: id,
      kind,
      format: format === 'jpg' ? 'jpeg' : format,
      index: artifacts.length,
    });
  }
  return artifacts;
}
export async function creativeArtifactUrl(
  client: StudioClient,
  job: Job,
  artifact: Artifact,
  links: ArtifactLinks,
): Promise<string> {
  // Lab 下载链接可过期，按原 jobId/artifactId 只读刷新，不触发另一次创作。
  const detail = await creativeDetail(client, job);
  const artifacts = labArtifacts(job, detail, links);
  const url =
    artifacts.some((x) => x.artifact_id === artifact.artifact_id) &&
    links.get(`${job.job_id}:${artifact.artifact_id}`);
  if (!url) throw new TripoError('ARTIFACT_NOT_READY', 'Original Lab artifact is unavailable.');
  return url;
}
export async function creativeCost(client: StudioClient, job: Job): Promise<ObservedCost | undefined> {
  if (job.operation !== 'canvas_lab') return undefined;
  const detail = await creativeDetail(client, job);
  const value = object(detail.billing).chargedCredits;
  if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    return undefined;
  return {
    credits: Number(value),
    source: 'studio_lab',
    status: 'fulfilled',
    observed_at: new Date().toISOString(),
  };
}
