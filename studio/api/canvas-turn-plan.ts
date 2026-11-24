/** 新消息与失败历史消息重试的只读准备；保存/上传/费用接受/CreateTurn 始终由调用者独立执行。 */
import { createHash } from 'node:crypto';
import type { StudioClient } from './client.ts';
import { CanvasClient, bindCanvasAccount } from './canvas-client.ts';
import { readSavedAssetRebindings } from './canvas-rebind.ts';
import { verifyTurnAttachments, type TurnGraph } from './canvas-turn-assets.ts';
import { array, object, text, sanitize, TripoError } from '../contracts/errors.ts';
import { canvasAgentSchemas } from '../contracts/canvas-agent.ts';
import { canvasStateFingerprint } from './canvas-state.ts';
import {
  historicalAttachments,
  historicalCapabilities,
  historicalFailure,
  historicalHolyMollyTarget,
} from './canvas-turn-history.ts';
import {
  composeCanvasTurn,
  turnPlanSchema,
  turnReferences,
  type TurnAttachment,
  type TurnPlanInput,
} from './canvas-turn-compose.ts';
export { turnPlanSchema } from './canvas-turn-compose.ts';
const call = (client: CanvasClient, service: string, action: string, body: Record<string, unknown>) =>
  client.call(`/tripo.canvas.api.agent.${service}Service/${action}`, body).then(object);
function changed(message: string): never {
  throw new TripoError('CONTRACT_CHANGED', message);
}
function graphContext(value: Record<string, unknown>, input: TurnPlanInput): TurnGraph {
  const canvas = object(value.canvas);
  if (
    canvas.canvasId !== input.canvasId ||
    !text(canvas.projectId) ||
    !/^\d+$/.test(text(canvas.revision)) ||
    !Array.isArray(value.nodes)
  )
    changed('Turn Canvas identity, revision or nodes are unavailable.');
  const nodes = value.nodes.map(object);
  if (nodes.some((node) => !text(node.id)) || new Set(nodes.map((node) => node.id)).size !== nodes.length)
    changed('Turn Canvas node identities are missing or duplicated.');
  if (input.nodeId && !nodes.some((node) => node.id === input.nodeId))
    throw new TripoError('CANVAS_CHANGED', 'The explicit message target is missing from the saved Canvas.');
  if (input.expectedRevision && canvas.revision !== input.expectedRevision)
    throw new TripoError(
      'CANVAS_CHANGED',
      'The saved Canvas revision no longer matches the requested preparation.',
    );
  return { canvas, nodes };
}
function sessionContext(value: Record<string, unknown>, input: TurnPlanInput) {
  const session = object(value.session);
  if (session.sessionId !== input.sessionId || session.canvasId !== input.canvasId)
    changed('The message session belongs to another Canvas.');
  return { session, messages: array(value.messages) };
}
function retryContext(value: Record<string, unknown>, input: TurnPlanInput) {
  const turn = object(value.turn);
  if (
    turn.turnId !== input.sourceTurnId ||
    turn.sessionId !== input.sessionId ||
    !Array.isArray(value.messages)
  )
    changed('Retry source turn does not match the selected session.');
  const messages = value.messages.map(object),
    matches = messages.filter((message) => message.messageId === input.sourceMessageId),
    reasons: string[] = [];
  if (
    matches.length !== 1 ||
    matches[0]!.turnId !== input.sourceTurnId ||
    !['MESSAGE_ROLE_USER', 'user'].includes(text(matches[0]!.role))
  )
    changed('Retry source must be the exact user message in the selected turn.');
  const message = matches[0]!,
    after = messages.slice(messages.indexOf(message) + 1),
    phases = after.filter(
      (entry) =>
        entry.turnId === input.sourceTurnId && ['MESSAGE_ROLE_AGENT', 'assistant'].includes(text(entry.role)),
    ),
    assistant = phases.at(-1),
    failure = historicalFailure(phases);
  if (turn.status !== 'TURN_STATUS_FAILED') reasons.push('retry_source_not_failed');
  if (
    !assistant ||
    after.some(
      (entry) =>
        entry.turnId === input.sourceTurnId && ['MESSAGE_ROLE_USER', 'user'].includes(text(entry.role)),
    )
  )
    reasons.push('retry_source_not_latest_user_message');
  if (failure?.protocol === 'classified' && failure.retryable === false)
    reasons.push('source_failure_not_retryable');
  if (!text(message.content).trim()) reasons.push('historical_content_empty');
  const capabilities = historicalCapabilities(message),
    nodeId = historicalHolyMollyTarget(message);
  // 缺失持久目标不能证明原请求是新建，不可把定向修改退化成无目标创作。
  if (capabilities?.includes('holy_molly') && !nodeId) reasons.push('retry_holy_molly_target_unknown');
  return {
    turn,
    message,
    assistant,
    failure,
    reasons,
    text: text(message.content),
    attachments: historicalAttachments(message),
    capabilities,
    nodeId,
  };
}
async function readState(client: CanvasClient, input: TurnPlanInput) {
  const session = sessionContext(
      await call(client, 'Session', 'GetSession', { sessionId: input.sessionId }),
      input,
    ),
    graph = graphContext(await call(client, 'Canvas', 'GetCanvas', { canvasId: input.canvasId }), input);
  let active: Record<string, unknown> | undefined;
  if (text(session.session.activeTurnId)) {
    const value = await call(client, 'Turn', 'GetTurnDetail', { turnId: session.session.activeTurnId });
    active = object(value.turn);
    if (active.turnId !== session.session.activeTurnId || active.sessionId !== input.sessionId)
      changed('The active turn no longer belongs to the selected session.');
  }
  const source =
    input.action === 'retry'
      ? retryContext(await call(client, 'Turn', 'GetTurnDetail', { turnId: input.sourceTurnId }), input)
      : undefined;
  if (source?.nodeId) {
    const target = graph.nodes.find((node) => node.id === source.nodeId);
    if (!target || target.type !== 'NODE_TYPE_HOLY_MOLLY')
      throw new TripoError(
        'CANVAS_CHANGED',
        'The historical HolyMolly target is missing or has another type in the saved Canvas.',
      );
  }
  return { session, graph, active, source };
}
async function savedRebindings(studio: StudioClient, input: TurnPlanInput, graph: TurnGraph) {
  if (!input.copiedNodes?.length)
    return { mappings: [], unresolved: [] } as {
      mappings: { node_id: string; from_asset_id: string; to_asset_id: string }[];
      unresolved: unknown[];
    };
  for (const copied of input.copiedNodes) {
    const node = graph.nodes.find((node) => node.id === copied.id);
    if (!node || node.type !== copied.type)
      throw new TripoError('CANVAS_CHANGED', 'A saved copied node changed identity.');
  }
  const readback = object(await readSavedAssetRebindings(studio, input.copiedNodes));
  return {
    mappings: array(readback.asset_rebindings).map((value) => {
      const mapping = object(value);
      return {
        node_id: text(mapping.node_id),
        from_asset_id: text(mapping.from_asset_id),
        to_asset_id: text(mapping.to_asset_id),
      };
    }),
    unresolved: array(readback.asset_rebinding_unresolved),
  };
}
function applyRebindings(
  attachments: TurnAttachment[],
  mappings: Awaited<ReturnType<typeof savedRebindings>>['mappings'],
) {
  return attachments.map((attachment) => {
    const matches = mappings.filter(
      (mapping) => mapping.node_id === attachment.nodeId && mapping.from_asset_id === attachment.assetId,
    );
    if (matches.length > 1) changed('A copied attachment has ambiguous saved mappings.');
    return matches.length ? { ...attachment, assetId: matches[0]!.to_asset_id } : attachment;
  });
}
function reasonsFor(state: Awaited<ReturnType<typeof readState>>) {
  const reasons = [...(state.source?.reasons ?? [])];
  if (state.session.session.status !== 'SESSION_STATUS_ACTIVE') reasons.push('session_not_active');
  if (state.active && ['TURN_STATUS_QUEUED', 'TURN_STATUS_RUNNING'].includes(text(state.active.status)))
    reasons.push('another_turn_is_running');
  return reasons;
}
function fingerprint(
  state: Awaited<ReturnType<typeof readState>>,
  attachments: TurnAttachment[],
  nodeId?: string,
) {
  const ids = new Set(attachments.map((attachment) => attachment.nodeId).filter(Boolean));
  if (nodeId) ids.add(nodeId);
  return canvasStateFingerprint({
    session: state.session,
    active: state.active,
    source: state.source,
    canvas: state.graph.canvas,
    nodes: state.graph.nodes.filter((node) => ids.has(text(node.id))),
  });
}
function sourceSummary(source: Awaited<ReturnType<typeof readState>>['source'], input: TurnPlanInput) {
  if (!source) return {};
  return {
    source_turn_id: input.sourceTurnId,
    source_message_id: input.sourceMessageId,
    ...(source.capabilities !== undefined ? { source_capabilities: source.capabilities } : {}),
    ...(source.nodeId ? { source_target_node_id: source.nodeId } : {}),
  };
}
function messageReasons(
  state: Awaited<ReturnType<typeof readState>>,
  input: TurnPlanInput,
  composed: ReturnType<typeof composeCanvasTurn>,
) {
  // 网页只允许明确引用已有 Holy 节点时省略正文；单选插件能力不能提交空消息。
  if (
    composed.text ||
    input.action !== 'new' ||
    !input.nodeId ||
    !input.capabilities?.includes('holy_molly') ||
    composed.attachments.length
  )
    return composed.reasons;
  if (state.graph.nodes.find((node) => node.id === input.nodeId)?.type !== 'NODE_TYPE_HOLY_MOLLY')
    return [...composed.reasons, 'empty_message_target_not_holy_molly'];
  return composed.reasons.filter((reason) => reason !== 'empty_message');
}
export async function resolveCanvasTurnPlan(studio: StudioClient, requested: unknown): Promise<unknown> {
  const input = turnPlanSchema.parse(requested);
  studio = bindCanvasAccount(studio);
  const account = studio.credentials.load()!.accountRef,
    client = new CanvasClient(studio),
    initial = await readState(client, input),
    content = initial.source?.text ?? input.text ?? '',
    attachments = initial.source?.attachments ?? input.attachments ?? [],
    capabilities = initial.source ? initial.source.capabilities : input.capabilities,
    nodeId = initial.source ? initial.source.nodeId : input.nodeId,
    composed = composeCanvasTurn(content, attachments, input.action),
    mappings = await savedRebindings(studio, input, initial.graph),
    selected = applyRebindings(composed.attachments, mappings.mappings),
    reasons = [...reasonsFor(initial), ...messageReasons(initial, input, composed)];
  if (mappings.unresolved.length) reasons.push('copied_assets_unresolved');
  // 仅携带本次选中且已经唯一读回的旧→新关系；正文快照仍保留网页保存前的标记。
  const attachmentRebindings = mappings.mappings.filter((mapping) =>
    composed.attachments.some(
      (attachment) => attachment.nodeId === mapping.node_id && attachment.assetId === mapping.from_asset_id,
    ),
  );
  const params = {
    session_id: input.sessionId,
    text: composed.text,
    mode: input.agentMode,
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(nodeId ? { node_id: nodeId } : {}),
    attachment_ids: selected.map((attachment) => attachment.assetId),
    refs: turnReferences(selected),
    ...(attachmentRebindings.length ? { attachment_rebindings: attachmentRebindings } : {}),
  };
  if (!canvasAgentSchemas.canvas_turn.safeParse({ ...params, accept_variable_cost: true }).success)
    reasons.push('prepared_parameters_exceed_raw_turn_contract');
  const bindings = mappings.unresolved.length
      ? 'unresolved'
      : await verifyTurnAttachments(client, initial.graph, selected),
    identity = fingerprint(initial, selected, nodeId),
    latest = await readState(client, input),
    latestMappings = await savedRebindings(studio, input, latest.graph),
    latestBindings = latestMappings.unresolved.length
      ? 'unresolved'
      : await verifyTurnAttachments(client, latest.graph, selected);
  if (
    identity !== fingerprint(latest, selected, nodeId) ||
    bindings !== latestBindings ||
    JSON.stringify(mappings) !== JSON.stringify(latestMappings)
  )
    throw new TripoError(
      'CANVAS_CHANGED',
      'The session, historical message, Canvas, target node or selected attachments changed while preparing the turn.',
    );
  studio.credentials.load();
  return sanitize({
    canvas_id: input.canvasId,
    session_id: input.sessionId,
    action: input.action,
    source_revision: initial.graph.canvas.revision,
    ...sourceSummary(initial.source, input),
    ready: reasons.length === 0,
    reasons: [...new Set(reasons)],
    parameters: reasons.length ? null : params,
    character_count: composed.characterCount,
    attachment_count: composed.attachmentCount,
    new_message_attachment_limit: 30,
    raw_attachment_limit: 100,
    asset_rebindings: mappings.mappings,
    asset_rebinding_unresolved: mappings.unresolved,
    input_binding: createHash('sha256')
      .update(JSON.stringify([account, identity, bindings, params, mappings]))
      .digest('hex'),
    requires_accept_variable_cost: true,
    quote: { known: false, variable: true },
    request_key_policy:
      'Use a new stable local request_id for an intentional new message or failed-message retry. Do not repeat an unknown prior submission.',
    preparation_scope:
      'Read snapshot of an already saved Canvas only. Upload and save independently first; later explicit CreateTurn is not an atomic consumption of this binding.',
    attachment_text_policy:
      'Known attachment markers preserve composer positions. Like the webpage, saved-copy rebinding updates refs/attachmentIds after the text snapshot; no latest-asset substitution.',
    remote_saved: false,
    execution_started: false,
  });
}
