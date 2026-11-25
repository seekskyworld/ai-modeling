/** Cross-check the history returned by Studio without claiming an undocumented server retention limit. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { StudioClient } from './client.ts';
import { CanvasClient, bindCanvasAccount } from './canvas-client.ts';
import { canvasStateFingerprint } from './canvas-state.ts';
import { object, sanitize, text, TripoError } from '../contracts/errors.ts';
import { id } from '../contracts/primitives.ts';

export const canvasHistorySchema = z
  .object({
    canvasId: id,
    sessionId: id,
    maxTurns: z.number().int().min(1).max(100).default(50),
    maxMessages: z.number().int().min(1).max(10000).default(2000),
  })
  .strict();
type Input = z.infer<typeof canvasHistorySchema>;
type RecordValue = Record<string, unknown>;
const knownTurnStatuses = [
  'TURN_STATUS_QUEUED',
  'TURN_STATUS_RUNNING',
  'TURN_STATUS_WAITING_FOR_USER',
  'TURN_STATUS_DONE',
  'TURN_STATUS_FAILED',
  'TURN_STATUS_CANCELLED',
];
interface TurnDetail {
  turn: RecordValue;
  messages: RecordValue[];
}
interface Snapshot {
  session: RecordValue;
  messages: RecordValue[];
  turns: RecordValue[];
  discovered: string[];
  details: TurnDetail[];
  incomplete: string[];
}
const call = (client: CanvasClient, service: string, action: string, body: RecordValue) =>
  client.call(`/tripo.canvas.api.agent.${service}Service/${action}`, body).then(object);
function changed(message: string): never {
  throw new TripoError('CONTRACT_CHANGED', message);
}
function collection(value: RecordValue, key: string): RecordValue[] {
  if (!Array.isArray(value[key])) changed(`Session history ${key} are unavailable.`);
  return value[key].map(object);
}
function uniqueIdentity(rows: RecordValue[], key: string, label: string) {
  if (rows.some((row) => !id.safeParse(row[key]).success))
    changed(`Session history ${label} identity is missing or malformed.`);
  if (new Set(rows.map((row) => row[key])).size !== rows.length)
    changed(`Session history ${label} identities are duplicated.`);
}
function messages(value: RecordValue, turnId?: string): RecordValue[] {
  const result = collection(value, 'messages');
  uniqueIdentity(result, 'messageId', 'message');
  if (result.some((row) => !id.safeParse(row.turnId).success || (turnId && row.turnId !== turnId)))
    changed('Session history contains a message with a missing or foreign turn identity.');
  return result;
}
function advertisesMore(value: RecordValue, count: number): boolean {
  const cursor = ['nextPageToken', 'next_page_token', 'nextCursor', 'next_cursor'],
    flags = ['hasMore', 'has_more', 'haveMore', 'have_more', 'hasNext', 'has_next'],
    totals = ['total', 'totalCount', 'total_count'];
  return (
    cursor.some((key) => typeof value[key] === 'string' && text(value[key]).length > 0) ||
    flags.some((key) => value[key] === true) ||
    totals.some((key) => typeof value[key] === 'number' && Number(value[key]) > count)
  );
}
function pagination(value: RecordValue, count: number, scope: string, incomplete: string[]) {
  if (advertisesMore(value, count) || advertisesMore(object(value.pagination), count))
    incomplete.push(`${scope}_pagination_unresolved`);
}
async function readDiscovery(client: CanvasClient, input: Input): Promise<Snapshot> {
  const value = await call(client, 'Session', 'GetSession', { sessionId: input.sessionId }),
    session = object(value.session);
  if (session.sessionId !== input.sessionId || session.canvasId !== input.canvasId)
    changed('Session history does not belong to the requested session and Canvas.');
  const entries = messages(value),
    listed = await call(client, 'Session', 'ListTurns', {
      sessionId: input.sessionId,
      statuses: knownTurnStatuses,
    }),
    turns = collection(listed, 'turns'),
    incomplete: string[] = [];
  uniqueIdentity(turns, 'turnId', 'turn');
  if (turns.some((turn) => turn.sessionId !== input.sessionId))
    changed('Session history lists a turn from a different session.');
  if (turns.some((turn) => !text(turn.status))) changed('Listed turn status is unavailable.');
  if (
    session.activeTurnId !== undefined &&
    session.activeTurnId !== null &&
    session.activeTurnId !== '' &&
    !id.safeParse(session.activeTurnId).success
  )
    changed('Session active turn identity is malformed.');
  const active = text(session.activeTurnId);
  const discovered = [
    ...new Set([
      ...turns.map((turn) => text(turn.turnId)),
      ...entries.map((row) => text(row.turnId)),
      ...(active ? [active] : []),
    ]),
  ].sort();
  if (discovered.length > input.maxTurns) incomplete.push('turn_limit_exceeded');
  if (entries.length > input.maxMessages) incomplete.push('message_limit_exceeded');
  pagination(value, entries.length, 'session_messages', incomplete);
  pagination(listed, turns.length, 'listed_turns', incomplete);
  return { session, messages: entries, turns, discovered, details: [], incomplete };
}
async function readSnapshot(client: CanvasClient, input: Input): Promise<Snapshot> {
  const snapshot = await readDiscovery(client, input);
  if (snapshot.incomplete.length) return snapshot;
  let observed = 0;
  for (let offset = 0; offset < snapshot.discovered.length; offset += 4) {
    const batch = await Promise.all(
      snapshot.discovered.slice(offset, offset + 4).map(async (turnId) => {
        const value = await call(client, 'Turn', 'GetTurnDetail', { turnId }),
          turn = object(value.turn);
        if (turn.turnId !== turnId || turn.sessionId !== input.sessionId)
          changed('Session history detail belongs to another turn or session.');
        if (!text(turn.status)) changed('Turn detail status is unavailable.');
        const entries = messages(value, turnId);
        pagination(value, entries.length, `turn:${turnId}`, snapshot.incomplete);
        return { turn, messages: entries };
      }),
    );
    snapshot.details.push(...batch);
    observed += batch.reduce((sum, detail) => sum + detail.messages.length, 0);
    if (observed > input.maxMessages) snapshot.incomplete.push('detail_message_limit_exceeded');
    if (snapshot.incomplete.length) break;
  }
  snapshot.incomplete.sort();
  return snapshot;
}
function compareTurn(snapshot: Snapshot, detail: TurnDetail) {
  const turnId = text(detail.turn.turnId),
    session = snapshot.messages.filter((message) => message.turnId === turnId),
    sessionMap = new Map(session.map((message) => [text(message.messageId), message])),
    detailMap = new Map(detail.messages.map((message) => [text(message.messageId), message])),
    missing = [...detailMap.keys()].filter((key) => !sessionMap.has(key)),
    extra = [...sessionMap.keys()].filter((key) => !detailMap.has(key)),
    differing = [...detailMap.keys()].filter((key) => {
      const message = sessionMap.get(key);
      return message && canvasStateFingerprint(message) !== canvasStateFingerprint(detailMap.get(key));
    }),
    order = canvasStateFingerprint([...sessionMap.keys()]) === canvasStateFingerprint([...detailMap.keys()]),
    listed = snapshot.turns.find((turn) => turn.turnId === turnId),
    statusMatches = listed ? listed.status === detail.turn.status : null;
  return {
    turn_id: turnId,
    status: detail.turn.status,
    listed: Boolean(listed),
    listed_status_matches: statusMatches,
    session_message_count: session.length,
    detail_message_count: detail.messages.length,
    missing_from_session: missing,
    missing_from_turn_detail: extra,
    differing_message_ids: differing,
    message_order_matches: order,
    consistent:
      Boolean(listed) &&
      statusMatches === true &&
      !missing.length &&
      !extra.length &&
      !differing.length &&
      order,
  };
}
function cardInventory(entries: RecordValue[]) {
  const counts = new Map<string, number>();
  for (const message of entries) {
    const type = text(message.cardType);
    if (type) counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, count]) => ({ type, count }));
}

/** No writes, cursors or fabricated history are introduced when one endpoint omits returned messages. */
export async function inspectCanvasSessionHistory(
  studio: StudioClient,
  requested: unknown,
): Promise<unknown> {
  const input = canvasHistorySchema.parse(requested);
  studio = bindCanvasAccount(studio);
  const client = new CanvasClient(studio),
    initial = await readSnapshot(client, input),
    latest = await readSnapshot(client, input),
    fingerprint = canvasStateFingerprint(initial);
  if (fingerprint !== canvasStateFingerprint(latest))
    throw new TripoError(
      'CANVAS_CHANGED',
      'The session, turn inventory or messages changed during history inspection. Read the current history again.',
    );
  studio.credentials.load();
  const comparisons = initial.details.map((detail) => compareTurn(initial, detail)),
    incomplete = initial.incomplete.length > 0,
    allMessages = initial.details.flatMap((detail) => detail.messages);
  uniqueIdentity(allMessages, 'messageId', 'cross-turn message');
  return sanitize({
    canvas_id: input.canvasId,
    session_id: input.sessionId,
    snapshot_stable: true,
    observed_history_consistent: incomplete ? null : comparisons.every((turn) => turn.consistent),
    history_complete: null,
    incomplete,
    incomplete_reasons: initial.incomplete,
    counts: {
      session_messages: initial.messages.length,
      listed_turns: initial.turns.length,
      discovered_turns: initial.discovered.length,
      inspected_turns: initial.details.length,
      detail_messages: allMessages.length,
    },
    limits: { max_turns: input.maxTurns, max_messages: input.maxMessages },
    listed_statuses: knownTurnStatuses,
    turns: comparisons,
    session_card_types: cardInventory(initial.messages),
    snapshot_sha256: createHash('sha256').update(fingerprint).digest('hex'),
    verification_scope:
      'Two matching read snapshots and cross-endpoint agreement for returned message identities, content, per-turn order and turn status. No documented pagination or total-history contract proves that Studio returned all historical turns or messages. The session and its history may change after this inspection.',
    read_messages: { tool: 'ai_modeling_canvas_session_get', parameters: { sessionId: input.sessionId } },
    remote_saved: false,
    execution_started: false,
  });
}
