/** 精确绑定画布、会话、turn 与卡片；答案准备期间换图/换卡/换账号必须停止。 */
import { createHash } from 'node:crypto';
import type { StudioClient } from './client.ts';
import { CanvasClient, bindCanvasAccount } from './canvas-client.ts';
import { canvasStateFingerprint } from './canvas-state.ts';
import { canvasAssetBinding, isAvailableCanvasOutput } from './canvas-turn-assets.ts';
import { array, object, sanitize, text, TripoError } from '../contracts/errors.ts';
import {
  answerPlanSchema,
  prepareAnswer,
  readAnswerCard,
  type AnswerInput,
  type PreparedAnswer,
} from './canvas-answer.ts';
export { answerPlanSchema } from './canvas-answer.ts';
const call = (client: CanvasClient, service: string, method: string, body: Record<string, unknown>) =>
  client.call(`/tripo.canvas.api.agent.${service}Service/${method}`, body).then(object);

function turnContext(value: Record<string, unknown>, input: AnswerInput) {
  const turn = object(value.turn);
  if (turn.turnId !== input.turnId || !text(turn.sessionId) || !Array.isArray(value.messages))
    throw new TripoError('CONTRACT_CHANGED', 'Answer turn identity or messages are unavailable.');
  const messages = value.messages.map(object),
    matches = messages.filter((message) => message.messageId === input.cardMessageId);
  if (
    matches.length !== 1 ||
    matches[0]!.turnId !== input.turnId ||
    !['MESSAGE_ROLE_AGENT', 'assistant'].includes(text(matches[0]!.role))
  )
    throw new TripoError('CONTRACT_CHANGED', 'The exact card does not belong to this assistant turn.');
  const message = matches[0]!,
    card = readAnswerCard(message);
  if (!card)
    throw new TripoError(
      'UNSUPPORTED_CARD',
      'This message is not a verified selection or confirmation card.',
    );
  const reasons: string[] = [];
  if (turn.status !== 'TURN_STATUS_WAITING_FOR_USER') reasons.push('turn_not_waiting_for_user');
  if (
    ['MESSAGE_STATUS_PENDING', 'MESSAGE_STATUS_STREAMING', 'MESSAGE_STATUS_FAILED'].includes(
      text(message.status),
    )
  )
    reasons.push('card_not_ready');
  const after = messages.slice(messages.indexOf(message) + 1).some((entry) => {
    if (entry.turnId !== input.turnId || !['MESSAGE_ROLE_AGENT', 'assistant'].includes(text(entry.role)))
      return false;
    const next = readAnswerCard(entry);
    return next && !next.answered && !next.expired;
  });
  if (after) reasons.push('newer_unanswered_card_exists');
  return { turn, message, card, reasons };
}
function sessionContext(value: Record<string, unknown>, sessionId: string, input: AnswerInput) {
  const session = object(value.session);
  if (session.sessionId !== sessionId || session.canvasId !== input.canvasId)
    throw new TripoError('CONTRACT_CHANGED', 'The turn session belongs to another Canvas.');
  return session;
}
function graphContext(value: Record<string, unknown>, input: AnswerInput) {
  const canvas = object(value.canvas);
  if (
    canvas.canvasId !== input.canvasId ||
    !text(canvas.projectId) ||
    !/^\d+$/.test(text(canvas.revision)) ||
    !Array.isArray(value.nodes)
  )
    throw new TripoError('CONTRACT_CHANGED', 'Answer Canvas identity or nodes are unavailable.');
  const nodes = value.nodes.map(object);
  if (nodes.some((node) => !text(node.id)) || new Set(nodes.map((node) => node.id)).size !== nodes.length)
    throw new TripoError('CONTRACT_CHANGED', 'Answer Canvas node identities are missing or duplicated.');
  return { canvas, nodes };
}
function snapshot(
  turn: ReturnType<typeof turnContext>,
  session: Record<string, unknown>,
  graph: ReturnType<typeof graphContext>,
  references: PreparedAnswer['references'],
) {
  const ids = new Set(references.map((ref) => ref.nodeId).filter(Boolean));
  return canvasStateFingerprint({
    turn: [turn.turn.turnId, turn.turn.sessionId, turn.turn.status, turn.turn.requestId],
    card: turn.message,
    reasons: turn.reasons,
    session: [session.sessionId, session.canvasId, session.status, session.activeTurnId],
    canvas: [graph.canvas.canvasId, graph.canvas.projectId, graph.canvas.revision],
    nodes: graph.nodes
      .filter((node) => ids.has(text(node.id)))
      .map((node) => ({
        id: node.id,
        type: node.type,
        params: node.params,
        inputMount: array(node.inputMount).map((entry) => object(entry).assetId),
      })),
  });
}

async function verifyUnscopedReference(
  client: CanvasClient,
  graph: ReturnType<typeof graphContext>,
  assetId: string,
): Promise<string> {
  const nodes = graph.nodes.filter((node) =>
    [...array(node.inputMount), ...array(node.nodeAssets)].some((value) => object(value).assetId === assetId),
  );
  if (nodes.length > 1)
    throw new TripoError('CONTRACT_CHANGED', 'The card asset has ambiguous Canvas node ownership.');
  if (nodes.length === 1) return verifyReferences(client, graph, [{ nodeId: text(nodes[0]!.id), assetId }]);
  // GetNodeAssetDetail 是模型详情入口；图片选项不能用该接口或 5442 推断凭据/资产状态。
  const result = await call(client, 'Asset', 'BatchGetInputAssets', {
    projectId: graph.canvas.projectId,
    assetIds: [assetId],
  });
  const matches = array(result.assets)
    .map(object)
    .filter((asset) => asset.assetId === assetId);
  if (matches.length !== 1 || matches[0]!.status !== 'INPUT_ASSET_STATUS_READY')
    throw new TripoError(
      'INPUT_NOT_READY',
      'The card asset cannot be bound to a saved Canvas node or a READY input in this project.',
    );
  return canvasStateFingerprint(canvasAssetBinding(matches[0]!));
}

async function verifyReferences(
  client: CanvasClient,
  graph: ReturnType<typeof graphContext>,
  references: PreparedAnswer['references'],
) {
  const bindings: unknown[] = [];
  for (const ref of references) {
    const node = ref.nodeId ? graph.nodes.find((entry) => entry.id === ref.nodeId) : undefined;
    if (ref.nodeId && !node)
      throw new TripoError('CANVAS_CHANGED', 'The selected card node is no longer in this Canvas.');
    if (!ref.assetId) continue;
    if (node?.type === 'NODE_TYPE_UPLOAD_CARD') {
      if (!array(node.inputMount).some((entry) => object(entry).assetId === ref.assetId))
        throw new TripoError('CANVAS_CHANGED', 'The card upload was replaced on its original node.');
      const result = await call(client, 'Asset', 'BatchGetInputAssets', {
        projectId: graph.canvas.projectId,
        assetIds: [ref.assetId],
      });
      const matches = array(result.assets)
        .map(object)
        .filter((entry) => entry.assetId === ref.assetId);
      if (matches.length !== 1 || matches[0]!.status !== 'INPUT_ASSET_STATUS_READY')
        throw new TripoError(
          'INPUT_NOT_READY',
          'The selected card input is not ready in this Canvas project.',
        );
      bindings.push([ref.nodeId, ref.assetId, canvasAssetBinding(matches[0]!)]);
    } else if (ref.nodeId) {
      const result = await call(client, 'Node', 'ListNodesAssets', { nodeIds: [ref.nodeId] });
      const nodes = array(result.nodes)
        .map(object)
        .filter((entry) => entry.nodeId === ref.nodeId);
      const matches =
        nodes.length === 1
          ? array(nodes[0]!.assets)
              .map(object)
              .filter((entry) => entry.nodeId === ref.nodeId && entry.assetId === ref.assetId)
          : [];
      if (matches.length !== 1 || !isAvailableCanvasOutput(matches[0]!))
        throw new TripoError(
          'INPUT_NOT_READY',
          'The selected card asset is unavailable on its original node.',
        );
      bindings.push([ref.nodeId, ref.assetId, canvasAssetBinding(matches[0]!)]);
    } else {
      bindings.push([ref.assetId, await verifyUnscopedReference(client, graph, ref.assetId)]);
    }
  }
  return JSON.stringify(bindings);
}

export async function resolveCanvasAnswerPlan(studio: StudioClient, requested: unknown): Promise<unknown> {
  const input = answerPlanSchema.parse(requested);
  studio = bindCanvasAccount(studio);
  const account = studio.credentials.load()!.accountRef,
    client = new CanvasClient(studio);
  const readTurn = () =>
    call(client, 'Turn', 'GetTurnDetail', { turnId: input.turnId }).then((value) =>
      turnContext(value, input),
    );
  const initial = await readTurn(),
    sessionId = text(initial.turn.sessionId);
  const readSession = () =>
    call(client, 'Session', 'GetSession', { sessionId }).then((value) =>
      sessionContext(value, sessionId, input),
    );
  const readGraph = () =>
    call(client, 'Canvas', 'GetCanvas', { canvasId: input.canvasId }).then((value) =>
      graphContext(value, input),
    );
  const session = await readSession(),
    graph = await readGraph(),
    plan = prepareAnswer(initial.card, input);
  const reasons = [...initial.reasons, ...plan.reasons];
  if (session.status !== 'SESSION_STATUS_ACTIVE') reasons.push('session_not_active');
  if (text(session.activeTurnId) && session.activeTurnId !== input.turnId)
    reasons.push('another_turn_is_active');
  const references = await verifyReferences(client, graph, plan.references);
  const identity = snapshot(initial, session, graph, plan.references);
  const latestSession = await readSession(),
    latestGraph = await readGraph();
  const latestReferences = await verifyReferences(client, latestGraph, plan.references),
    latest = await readTurn();
  if (
    identity !== snapshot(latest, latestSession, latestGraph, plan.references) ||
    references !== latestReferences
  )
    throw new TripoError(
      'CANVAS_CHANGED',
      'The turn, card or selected node assets changed while preparing the answer.',
    );
  studio.credentials.load();
  return sanitize({
    canvas_id: input.canvasId,
    session_id: sessionId,
    turn_id: input.turnId,
    card_message_id: input.cardMessageId,
    source_revision: graph.canvas.revision,
    branch: plan.branch,
    ready: reasons.length === 0,
    reasons: [...new Set(reasons)],
    card: initial.card,
    answer_binding: createHash('sha256')
      .update(JSON.stringify([account, identity, references, plan.parameters]))
      .digest('hex'),
    parameters: reasons.length ? null : plan.parameters,
    requires_accept_variable_cost: true,
    answer_effect:
      'Any answer, including Skip, may continue paid creation. Skip is not cancellation; use canvas turn-cancel to cancel a turn.',
    quote: { known: false, variable: true },
    request_key_policy:
      'Use a new stable local request_id for this answer; the original turn requestId is not reused.',
    preparation_scope:
      'Read snapshot only; the card may change before a later explicit ContinueTurn submission.',
    remote_saved: false,
    execution_started: false,
  });
}
