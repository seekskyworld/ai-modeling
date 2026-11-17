/** 网页 composer 的附件占位与字数准备；文本和附件顺序不能分别排序或按素材 ID 去重。 */
import { z } from 'zod';
import { id } from '../contracts/primitives.ts';

export const turnAttachmentSchema = z
  .object({
    assetId: id,
    nodeId: id.optional(),
    filename: z.string().trim().min(1).max(1000).optional(),
    kind: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type TurnAttachment = z.infer<typeof turnAttachmentSchema>;
const copiedNode = z
  .object({
    id,
    type: id,
    nodeAssets: z.array(z.record(z.string(), z.json())).max(100),
  })
  .strict();
export const turnPlanSchema = z
  .object({
    canvasId: id,
    sessionId: id,
    action: z.enum(['new', 'retry']).default('new'),
    agentMode: z.enum(['control', 'auto']).default('control'),
    text: z.string().max(500000).optional(),
    attachments: z.array(turnAttachmentSchema).max(100).optional(),
    sourceTurnId: id.optional(),
    sourceMessageId: id
      .optional()
      .describe('Exact historical USER message ID for retry, not an assistant card ID.'),
    expectedRevision: z.string().regex(/^\d+$/).optional(),
    copiedNodes: z
      .array(copiedNode)
      .max(100)
      .optional()
      .describe(
        'Pre-save copied nodes from an already completed canvas save. Requires its expectedRevision; resolves old output IDs without saving again.',
      ),
  })
  .strict()
  .superRefine((value, context) => {
    const issue = (message: string) => context.addIssue({ code: 'custom', message });
    if (value.action === 'retry') {
      if (!value.sourceTurnId || !value.sourceMessageId)
        issue('Retry requires sourceTurnId and sourceMessageId.');
      if (value.text !== undefined || value.attachments !== undefined)
        issue('Retry reads historical content and attachments; caller overrides are not accepted.');
    } else if (value.sourceTurnId || value.sourceMessageId)
      issue('Historical source IDs require action=retry.');
    if (value.copiedNodes?.length && !value.expectedRevision)
      issue('Copied nodes require the saved expectedRevision.');
  });
export type TurnPlanInput = z.infer<typeof turnPlanSchema>;
interface Segment {
  text?: string;
  attachment?: TurnAttachment;
}
/** 对应 BoYY6--q.mo/ho：匹配已有占位，重复同 ID 依次匹配原引用，未出现的附件按原序追加。 */
function composerSegments(text: string, attachments: TurnAttachment[]): Segment[] {
  const segments: Segment[] = [],
    byId = new Map<string, { index: number; attachment: TurnAttachment }[]>(),
    used = new Set<number>(),
    occurrences = new Map<string, number>();
  attachments.forEach((attachment, index) => {
    const group = byId.get(attachment.assetId) ?? [];
    group.push({ index, attachment });
    byId.set(attachment.assetId, group);
  });
  const addText = (value: string) => {
    if (!value) return;
    const previous = segments.at(-1);
    if (previous?.text !== undefined) previous.text += value;
    else segments.push({ text: value });
  };
  let offset = 0;
  for (const match of text.matchAll(/\[Attachment: ([^\]]+)\]/g)) {
    const assetId = match[1]!,
      group = byId.get(assetId);
    if (!group?.length) continue;
    const occurrence = occurrences.get(assetId) ?? 0,
      selected = group[occurrence] ?? group[0]!;
    addText(text.slice(offset, match.index));
    segments.push({ attachment: selected.attachment });
    used.add(selected.index);
    occurrences.set(assetId, occurrence + 1);
    offset = match.index + match[0].length;
  }
  addText(text.slice(offset));
  attachments.forEach((attachment, index) => {
    if (used.has(index)) return;
    const previous = segments.at(-1);
    if (previous && (previous.attachment || !/\s$/.test(previous.text ?? ''))) addText(' ');
    segments.push({ attachment });
  });
  return segments;
}
export function normalizeAttachmentKind(kind: string): string {
  kind = kind.trim();
  if (kind.length <= 32) return kind;
  if (kind.startsWith('image/')) return 'image';
  if (kind.startsWith('model/')) return 'model';
  return 'file';
}
export function composeCanvasTurn(text: string, attachments: TurnAttachment[], action: 'new' | 'retry') {
  const segments = composerSegments(text, attachments),
    documentText = segments.map((segment) => segment.text ?? '').join(''),
    ordered = segments.flatMap((segment) => (segment.attachment ? [segment.attachment] : [])),
    content = segments
      .map((segment) => segment.text ?? `[Attachment: ${segment.attachment!.assetId}]`)
      .join('')
      .trim(),
    characterCount = [...documentText].length,
    reasons: string[] = [];
  if (!content) reasons.push('empty_message');
  if (characterCount > 200000) reasons.push('text_limit_exceeded');
  if (action === 'new' && ordered.length > 30) reasons.push('new_message_attachment_limit_exceeded');
  // 网页历史重试直接保留 e.content/e.attachments，仅用 ho 重建文档计算文字长度。
  const values =
    action === 'retry'
      ? attachments
      : ordered.map((attachment) => ({
          ...attachment,
          filename: attachment.filename ?? attachment.assetId,
          kind: attachment.kind ?? 'application/octet-stream',
        }));
  if (values.length > 100) reasons.push('raw_turn_attachment_limit_exceeded');
  return {
    text: action === 'retry' ? text : content,
    attachments: values,
    characterCount,
    attachmentCount: ordered.length,
    reasons,
  };
}
export function turnReferences(attachments: TurnAttachment[]) {
  return attachments.map((attachment) => ({
    asset_id: attachment.assetId,
    ...(attachment.nodeId ? { node_id: attachment.nodeId } : {}),
    ...(attachment.filename ? { filename: attachment.filename.trim() } : {}),
    ...(attachment.kind ? { kind: normalizeAttachmentKind(attachment.kind) } : {}),
  }));
}
