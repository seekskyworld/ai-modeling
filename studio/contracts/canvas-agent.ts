/** 创作代理与 Lab 的费用由所选工具动态产生；调用方必须明确接受此计费方式，不能伪造固定报价。 */
import { z } from 'zod';
import { id } from './primitives.ts';
import { canvasTurnCharacterCount } from './canvas-turn-text.ts';
export const canvasNodeOperations = new Set(['canvas_node_stop', 'canvas_node_retry']);
export const variableCanvasOperations = new Set([
  'canvas_turn',
  'canvas_continue',
  'canvas_lab',
  'canvas_node_retry',
]);
export const creativeCanvasOperations = new Set([...variableCanvasOperations, ...canvasNodeOperations]);
const consent = {
  accept_variable_cost: z
    .literal(true)
    .describe('Accept Studio variable billing; no estimate or hard spending limit is available.'),
};
const ids = z.array(id).max(100);
const nodeExecutionTarget = {
  canvas_id: id,
  node_id: id,
  revision: z.string().regex(/^\d+$/).describe('Current saved Canvas revision as a decimal string.'),
  expected_run_id: id.describe(
    'Exact run currently attached to this saved HolyMolly node. These guards are checked before sending; the upstream node RPC has no atomic revision/run condition.',
  ),
};
export const canvasTurnCapabilitiesSchema = z
  .array(z.literal('holy_molly'))
  .max(1)
  .describe(
    'Explicit Studio Agent capabilities. Only holy_molly is mapped from the observed webpage protocol; omit for ordinary chat. Not inferred from attachments or target nodes.',
  );
const attachmentRef = z
  .object({
    asset_id: id,
    filename: z.string().trim().min(1).optional(),
    kind: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Asset kind or MIME type; values longer than 32 code units use Studio image/model/file normalization.',
      ),
    node_id: id.optional().describe('Source node in the session canvas; omit for uploaded attachments.'),
  })
  .strict();
const attachmentRebinding = z.object({ node_id: id, from_asset_id: id, to_asset_id: id }).strict();
export const canvasAgentSchemas = {
  canvas_node_stop: z.object(nodeExecutionTarget).strict(),
  canvas_node_retry: z.object({ ...consent, ...nodeExecutionTarget }).strict(),
  canvas_turn: z
    .object({
      ...consent,
      session_id: id,
      // 网页普通消息和 Lab 共用 co(document) 的 200000 Unicode 码点限制；附件节点不计入文字。
      text: z
        .string()
        .trim()
        .max(500000)
        .describe(
          'Message text. Empty text requires explicit holy_molly capability, an existing HolyMolly node_id and no ordinary asset attachments.',
        ),
      mode: z.enum(['control', 'auto']).default('control'),
      capabilities: canvasTurnCapabilitiesSchema.optional(),
      node_id: id.optional(),
      attachment_ids: ids.default([]),
      refs: z
        .array(attachmentRef)
        .max(100)
        .optional()
        .describe(
          'Ordered attachment references preserving names, kinds and source nodes. Derives attachment_ids when omitted; if supplied, attachment_ids must match refs in the same order.',
        ),
      attachment_rebindings: z
        .array(attachmentRebinding)
        .min(1)
        .max(100)
        .optional()
        .describe(
          'Local-only saved-copy mappings returned by turn-plan. Each old marker must map to a current refs node_id + asset_id; used only for character counting and never sent to CreateTurn.',
        ),
    })
    .strict()
    .refine(
      (x) =>
        Boolean(x.text) ||
        (x.capabilities?.includes('holy_molly') === true &&
          Boolean(x.node_id) &&
          !x.attachment_ids.length &&
          !x.refs?.length &&
          !x.attachment_rebindings?.length),
      'Empty text requires an explicit HolyMolly target and capability without asset attachments.',
    )
    .refine(
      (x) =>
        !x.refs?.length ||
        !x.attachment_ids.length ||
        (x.attachment_ids.length === x.refs.length &&
          x.refs.every((ref, index) => ref.asset_id === x.attachment_ids[index])),
      'attachment_ids must match refs asset_id values in the same order.',
    )
    .refine((x) => {
      const seen = new Set<string>();
      return (x.attachment_rebindings ?? []).every((mapping) => {
        const key = JSON.stringify([mapping.node_id, mapping.from_asset_id]);
        if (
          mapping.from_asset_id === mapping.to_asset_id ||
          seen.has(key) ||
          !x.refs?.some((ref) => ref.node_id === mapping.node_id && ref.asset_id === mapping.to_asset_id)
        )
          return false;
        seen.add(key);
        return true;
      });
    }, 'attachment_rebindings must be unique saved-copy mappings to current refs node_id + asset_id.')
    .refine(
      (x) =>
        canvasTurnCharacterCount(x.text, [
          ...(x.refs?.length ? x.refs.map((ref) => ref.asset_id) : x.attachment_ids),
          ...(x.attachment_rebindings ?? []).map((mapping) => mapping.from_asset_id),
        ]) <= 200000,
      'Canvas message exceeds 200000 Unicode code points excluding known attachment markers.',
    ),
  canvas_continue: z
    .object({
      ...consent,
      turn_id: id,
      request_id: id
        .optional()
        .describe(
          'Optional stable idempotency key for this answer (CLI --remote-request-id). Defaults to the persisted local job UUID. Do not reuse the original turn.requestId.',
        ),
      selected_option_ids: ids.default([]),
      confirmed_parts: z
        .array(z.string().trim().min(1).max(200))
        .min(1)
        .max(12)
        // 当前 Zod 的 max 已按 Unicode 码点计数，与网页一致；trim 后重复名称仍须额外拒绝。
        .refine((parts) => new Set(parts).size === parts.length, 'Confirmed part names must be unique.')
        .optional(),
      other_text: z
        .string()
        .max(16000)
        .optional()
        .describe(
          'Answer a single-question Other/input option; select its option ID (usually __other__) too.',
        ),
      other_texts: z.record(z.string().min(1), z.string().max(16000)).optional(),
      text: z
        .string()
        .max(16000)
        .optional()
        .describe(
          'Extra composer text; the remote agent may ignore this. Use other_text/other_texts for free-text selection answers.',
        ),
      attachment_ids: ids.optional(),
    })
    .strict(),
  canvas_lab: z
    .object({
      ...consent,
      node_id: id,
      // 网页 BoYY6--q.xe 先 trim 后提交；current/history 由 co(document) 按 Unicode 码点限 200000。
      // 400000 仅是 UTF-16 的外层内存边界，不能把 emoji 当两个用户字符提前拒绝。
      prompt: z
        .string()
        .trim()
        .min(1)
        .max(400000)
        .refine((value) => [...value].length <= 200000, 'Lab prompt exceeds 200000 Unicode code points.'),
      asset_ids: ids
        .optional()
        .describe('Explicit input asset IDs. A graph edge alone does not attach a model to the Lab request.'),
    })
    .strict(),
};
