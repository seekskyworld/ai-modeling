/** 历史消息的服务端附件身份及跨阶段失败；不从正文占位或数组长度猜测原素材。 */
import { array, object, text, TripoError } from '../contracts/errors.ts';
import { canvasTurnCapabilitiesSchema } from '../contracts/canvas-agent.ts';
import { id } from '../contracts/primitives.ts';
import type { TurnAttachment } from './canvas-turn-compose.ts';

function changed(message: string): never {
  throw new TripoError('CONTRACT_CHANGED', message);
}

function sourceReference(refs: Record<string, unknown>[], assetId: string, index: number) {
  const matches = refs.filter((ref) => ref.assetId === assetId || ref.inputAssetId === assetId);
  if (!matches.length) return undefined;
  if (
    matches.some(
      (ref) =>
        !text(ref.assetId).trim() ||
        (ref.order !== undefined && (!Number.isSafeInteger(ref.order) || Number(ref.order) < 0)),
    )
  )
    changed('Historical attachment source identity or order is malformed.');
  // order 只能用于服务明确给出的关联；没有 inputAssetId/assetId 匹配时不能按数组位置猜测。
  const candidates = matches.filter((ref) => ref.order === undefined || ref.order === index),
    identities = new Set(candidates.map((ref) => JSON.stringify([ref.assetId, ref.nodeId ?? ''])));
  if (identities.size !== 1)
    changed('Historical attachment has ambiguous source nodes or inconsistent source order.');
  const source = candidates[0]!;
  if (source.assetId !== assetId && !text(source.nodeId).trim())
    changed('A historical input alias has no exact original node identity.');
  return source;
}

function historicalCardData(message: Record<string, unknown>) {
  let raw: Record<string, unknown> = {};
  if (text(message.cardJson)) {
    try {
      raw = object(JSON.parse(text(message.cardJson)));
    } catch {
      changed('Historical user attachment references are malformed.');
    }
  }
  return raw;
}

/**
 * 网页 gc 只从用户消息 cardJson.capabilities 恢复；未知能力不能静默丢弃后当普通消息重试。
 * Holy 特殊 composer 引用不进入 content/attachments/turnRefs：CreateTurn 另发 nodeId，
 * 持久用户消息已证实另以 cardJson.targetNodeId 回显目标；缺字段仍不能证明原请求是新建。
 */
export function historicalCapabilities(message: Record<string, unknown>) {
  const raw = historicalCardData(message);
  if (raw.capabilities === undefined) return undefined;
  const parsed = canvasTurnCapabilitiesSchema.safeParse(raw.capabilities);
  if (!parsed.success) changed('Historical user message capabilities are unsupported or malformed.');
  return parsed.data;
}

/** 只恢复已证实的持久目标字段；同页临时字段、普通素材 refs 和当前唯一 Holy 节点不能代替它。 */
export function historicalHolyMollyTarget(message: Record<string, unknown>) {
  const raw = historicalCardData(message);
  if (raw.targetNodeId === undefined) return undefined;
  const target = id.safeParse(raw.targetNodeId);
  if (!target.success) changed('Historical HolyMolly target identity is malformed.');
  if (!historicalCapabilities(message)?.includes('holy_molly'))
    changed('Historical target identity has no verified HolyMolly capability.');
  return target.data;
}

export function historicalAttachments(message: Record<string, unknown>): TurnAttachment[] {
  const raw = historicalCardData(message);
  // 服务对没有普通素材引用的目标修改回显 turnRefs:null；它不包含可推断的目标或附件关系。
  if (raw.turnRefs !== undefined && raw.turnRefs !== null && !Array.isArray(raw.turnRefs))
    changed('Historical user attachment references are not an array.');
  const refs = array(raw.turnRefs).map(object);
  return array(message.attachments).map((value, index) => {
    const asset = object(value),
      inputId = text(asset.assetId),
      source = sourceReference(refs, inputId, index),
      assetId = source ? text(source.assetId) : inputId,
      nodeId = text(source?.nodeId) || text(asset.nodeId),
      filename = text(source?.filename) || text(asset.name) || text(asset.filename),
      kind = text(source?.kind) || text(asset.type) || text(asset.mime) || text(asset.kind);
    if (!assetId) changed('Historical attachment identity is missing.');
    if (source?.nodeId && asset.nodeId && source.nodeId !== asset.nodeId)
      changed('Historical attachment node conflicts with its explicit source reference.');
    return {
      assetId,
      ...(nodeId ? { nodeId } : {}),
      ...(filename ? { filename } : {}),
      ...(kind ? { kind } : {}),
    };
  });
}

/** 网页 ko 保留已有 classified，除非后续有新的 classified；普通解释和 legacy 不会清除它。 */
export function historicalFailure(messages: Record<string, unknown>[]) {
  let failure: { protocol: 'classified' | 'legacy'; code: string; retryable?: boolean } | undefined;
  for (const message of messages) {
    const code = text(message.failCode).trim();
    if (!code) continue;
    const classified =
      ['FAIL_CATEGORY_CREATIVE', 'FAIL_CATEGORY_SYSTEM'].includes(text(message.failCategory)) &&
      typeof message.retryable === 'boolean';
    if (!classified && failure?.protocol === 'classified') continue;
    failure = classified
      ? { protocol: 'classified', code, retryable: message.retryable as boolean }
      : { protocol: 'legacy', code };
  }
  return failure;
}
