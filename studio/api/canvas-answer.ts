/** 网页选择/确认卡片的纯准备逻辑；只生成 ContinueTurn 参数，不发送答案。 */
import { z } from 'zod';
import { id } from '../contracts/primitives.ts';
import { array, object, text, TripoError } from '../contracts/errors.ts';

const answer = z
  .string()
  .trim()
  .refine((value) => [...value].length <= 500, 'Card answers allow 500 Unicode code points.');
export const answerPlanSchema = z
  .object({
    canvasId: id,
    turnId: id,
    cardMessageId: id,
    action: z.enum(['continue', 'skip']).default('continue'),
    selectedOptionIds: z
      .array(id)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, 'Option IDs must be unique.')
      .optional()
      .describe('Actual option IDs from the card, such as q1:__other__; do not use question IDs here.'),
    otherText: answer.optional().describe('Free text for a single selection or confirmation card.'),
    otherTexts: z
      .record(id, answer)
      .optional()
      .describe(
        'For grouped questions, map question IDs to text, for example {"q1":"a red panda"}; keys are not option IDs such as q1:__other__.',
      ),
    confirmedParts: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .refine((value) => [...value].length <= 200, 'Part names allow 200 Unicode code points.'),
      )
      .min(1)
      .max(12)
      .refine((parts) => new Set(parts).size === parts.length, 'Part names must be unique.')
      .optional(),
  })
  .strict();
export type AnswerInput = z.infer<typeof answerPlanSchema>;
interface Option {
  id: string;
  label: string;
  input: boolean;
  selected: boolean;
  nodeId?: string;
  assetId?: string;
  thumbnail: boolean;
}
interface Question {
  id: string;
  prompt: string;
  min: number;
  max: number;
  skippable: boolean;
  options: Option[];
}
export interface AnswerCard {
  messageId: string;
  prompt: string;
  intent: string;
  confirm: boolean;
  skippable: boolean;
  min: number;
  max: number;
  options: Option[];
  questions: Question[];
  parts?: string[];
  confirmNodeId?: string;
  answered: boolean;
  expired: boolean;
}
const selectionTypes = new Set(['select', 'selection', 'user_select', 'request_user_select']);
const confirmTypes = new Set(['confirm', 'confirmation', 'auto_confirm', 'auto_confirmation']);
const skip = (value: Record<string, unknown>) =>
  value.skip === true ||
  text(value.id ?? value.optionId) === '__skip__' ||
  text(value.id ?? value.optionId).endsWith(':__skip__');
function malformed(message: string): never {
  throw new TripoError('CONTRACT_CHANGED', message);
}
function limits(value: Record<string, unknown>) {
  const min = Number(value.min ?? value.minSelect ?? 1),
    max = Number(value.max ?? value.maxSelect ?? 1);
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min || max > 100)
    malformed('Card selection limits are invalid.');
  return { min, max };
}
function options(value: unknown, nodes?: Set<string>): Option[] {
  if (!Array.isArray(value)) malformed('Card options are unavailable.');
  const result = value.map((item) => {
    const option = object(item),
      optionId = text(option.id ?? option.optionId);
    if (!optionId.trim()) malformed('Card option identity is unavailable.');
    const nodeId =
      text(option.nodeId) ||
      (nodes?.has(optionId) && !option.input && !skip(option) && optionId !== '__other__' ? optionId : '');
    return {
      id: optionId,
      label: text(option.label ?? option.title),
      input: Boolean(option.input),
      selected: option.selected === true,
      ...(nodeId ? { nodeId } : {}),
      ...(text(option.assetId) ? { assetId: text(option.assetId) } : {}),
      thumbnail: Boolean(option.thumbnailUrl ?? option.thumbnail),
    };
  });
  if (new Set(result.map((option) => option.id)).size !== result.length)
    malformed('Card option identities are duplicated.');
  return result;
}

function readQuestions(value: unknown): Question[] {
  const questions = array(value).map((value): Question => {
    const question = object(value),
      questionId = text(question.id),
      prompt = text(question.prompt ?? question.title);
    if (!questionId || !prompt) malformed('Card question identity or prompt is unavailable.');
    const original = array(question.options).map(object),
      values = options(original.filter((option) => !skip(option)));
    if (!values.length) malformed('Card question has no options.');
    return {
      id: questionId,
      prompt,
      ...limits(question),
      skippable: question.skippable === true || original.some(skip),
      options: values,
    };
  });
  if (new Set(questions.map((question) => question.id)).size !== questions.length)
    malformed('Card question identities are duplicated.');
  return questions;
}
function cardOptions(raw: Record<string, unknown>, confirm: boolean, questions: Question[]) {
  const data = object(raw.data);
  const nodeIds =
    data.field === 'canvas_node' && Array.isArray(data.values)
      ? new Set(data.values.map(text).filter(Boolean))
      : undefined;
  const values = confirm
    ? []
    : questions.length
      ? questions.flatMap((question) => question.options)
      : options(raw.options, nodeIds);
  if (new Set(values.map((option) => option.id)).size !== values.length)
    malformed('Card options cannot be uniquely assigned to questions.');
  return values;
}
function cardParts(data: Record<string, unknown>): string[] | undefined {
  if (
    data.parts !== undefined &&
    (!Array.isArray(data.parts) || data.parts.some((part) => typeof part !== 'string'))
  )
    malformed('Card part names are incomplete.');
  return Array.isArray(data.parts) ? data.parts.map(text) : undefined;
}
function verifyCardIdentity(raw: Record<string, unknown>, message: Record<string, unknown>) {
  if (
    !text(message.messageId) ||
    (raw.messageId !== undefined && raw.messageId !== message.messageId) ||
    (raw.turnId !== undefined && raw.turnId !== message.turnId)
  )
    malformed('Card JSON identity conflicts with its message.');
}
/** Dv96avMB.Co 的已确认选择/确认形状；未知卡型不猜成可提交的卡片。 */
export function readAnswerCard(message: Record<string, unknown>): AnswerCard | null {
  let raw: Record<string, unknown>;
  try {
    raw = object(JSON.parse(text(message.cardJson)));
  } catch {
    return null;
  }
  const type = text(raw.type).toLowerCase(),
    cardType = text(message.cardType)
      .replace(/^CARD_TYPE_/, '')
      .toLowerCase();
  const confirm = confirmTypes.has(type) || confirmTypes.has(cardType);
  if (!confirm && !selectionTypes.has(type) && !selectionTypes.has(cardType)) return null;
  verifyCardIdentity(raw, message);
  const data = object(raw.data),
    questions = confirm ? [] : readQuestions(raw.questions),
    values = cardOptions(raw, confirm, questions),
    parts = cardParts(data);
  return {
    messageId: text(message.messageId),
    prompt: text(raw.prompt ?? raw.question ?? raw.title),
    intent: text(raw.intent),
    confirm,
    skippable:
      raw.skippable === true ||
      array(raw.options).some((value) => {
        const option = object(value);
        return (option.id ?? option.optionId) === '__skip__';
      }),
    ...(confirm || questions.length ? { min: 0, max: 0 } : limits(raw)),
    options: values,
    questions,
    ...(parts === undefined ? {} : { parts }),
    ...(confirm && text(data.confirmNodeId) ? { confirmNodeId: text(data.confirmNodeId) } : {}),
    answered: Array.isArray(raw.selected_option_ids ?? raw.selectedOptionIds),
    expired: raw.expired === true,
  };
}
const inputOption = (option: Option) => option.input || option.id === '__other__';
const validParts = (parts: string[]) =>
  parts.length >= 1 &&
  parts.length <= 12 &&
  parts.every((part) => part.length > 0 && [...part].length <= 200) &&
  new Set(parts).size === parts.length;
export interface PreparedAnswer {
  parameters: Record<string, unknown>;
  reasons: string[];
  references: { nodeId?: string; assetId?: string }[];
  branch: string;
}

interface AnswerPreparation {
  card: AnswerCard;
  input: AnswerInput;
  params: Record<string, unknown>;
  reasons: string[];
  selected: string[];
  parts?: string[];
}
function defaultSelected(card: AnswerCard, input: AnswerInput): string[] {
  if (input.selectedOptionIds) return input.selectedOptionIds;
  if (card.confirm || card.questions.length) return [];
  return card.options
    .filter((option) => option.selected && !inputOption(option) && option.id !== '__skip__')
    .map((option) => option.id)
    .slice(0, card.max);
}
function prepareParts(state: AnswerPreparation) {
  const { card, input, reasons } = state;
  if (input.confirmedParts && card.parts === undefined) reasons.push('card_has_no_parts');
  if (card.parts === undefined) return;
  const parts = input.confirmedParts ?? card.parts.map((part) => part.trim()).filter(Boolean);
  if (!validParts(parts)) reasons.push('invalid_confirmed_parts');
  else state.parts = parts;
  // 网页只在单卡 Skip 与 confirmation 发送部件名；不把它扩展到其他卡型。
  const sendsParts = !card.questions.length && (input.action === 'skip' || card.confirm);
  if (input.confirmedParts && (!sendsParts || card.intent === 'retry'))
    reasons.push('confirmed_parts_not_sent_by_branch');
}
function prepareRetry(state: AnswerPreparation) {
  const { input, reasons } = state;
  if (
    input.action !== 'continue' ||
    input.selectedOptionIds?.length ||
    input.otherText ||
    Object.keys(input.otherTexts ?? {}).length ||
    input.confirmedParts
  )
    reasons.push('retry_card_accepts_continue_only');
  state.selected = [];
  return 'retry';
}
function questionAnswer(state: AnswerPreparation, question: Question) {
  const optionIds = new Set(question.options.map((option) => option.id)),
    ids = state.selected.filter((value) => optionIds.has(value)),
    chosen = question.options.filter((option) => ids.includes(option.id)),
    other = text(state.input.otherTexts?.[question.id]);
  // 原网页 Un 校验 input/__other__，It 发送 input/:__other__；两者不能合并成一个判断。
  const requiresText = chosen.some(inputOption),
    sendsText = chosen.some((option) => option.input || option.id.endsWith(':__other__')),
    valid = ids.length >= question.min && ids.length <= question.max && (!requiresText || Boolean(other));
  return { ids, other, sendsText, valid, skipId: `${question.id}:__skip__` };
}
function prepareQuestion(state: AnswerPreparation, question: Question, texts: Record<string, string>) {
  const { ids, other, sendsText, valid, skipId } = questionAnswer(state, question),
    { reasons } = state,
    wantsSkip = state.selected.includes(skipId);
  if (wantsSkip && ids.length) reasons.push(`mixed_skip_and_selection:${question.id}`);
  if (other && !sendsText) reasons.push(`other_text_requires_input_option:${question.id}`);
  // 网页 Skip 保留有效且非空的回答；空题由 question:__skip__ 表达。
  if (wantsSkip || (state.input.action === 'skip' && (!ids.length || !valid))) {
    if (!question.skippable) reasons.push(`question_not_skippable:${question.id}`);
    return [skipId];
  }
  if (!valid) reasons.push(`invalid_question_answer:${question.id}`);
  if (sendsText && other) texts[question.id] = other;
  return ids;
}
function validateQuestionInput(state: AnswerPreparation) {
  const { card, input, selected, reasons } = state;
  if (input.otherText) reasons.push('questions_require_other_texts');
  const known = new Set(
    card.questions.flatMap((question) => [
      ...question.options.map((option) => option.id),
      `${question.id}:__skip__`,
    ]),
  );
  if (selected.some((value) => !known.has(value))) reasons.push('unknown_option_id');
  if (
    Object.keys(input.otherTexts ?? {}).some((key) => !card.questions.some((question) => question.id === key))
  )
    reasons.push('unknown_question_id');
}
function prepareQuestions(state: AnswerPreparation) {
  validateQuestionInput(state);
  const texts: Record<string, string> = {},
    chosen = state.card.questions.flatMap((question) => prepareQuestion(state, question, texts));
  if (state.input.action === 'skip') state.selected = chosen;
  state.params.selected_option_ids = state.selected;
  if (Object.keys(texts).length) state.params.other_texts = texts;
  return state.input.action === 'skip' ? 'questions_skip' : 'questions';
}
function prepareSkip(state: AnswerPreparation) {
  const { card, input, params, reasons } = state;
  if (!card.skippable) reasons.push('card_not_skippable');
  if (input.otherText || Object.keys(input.otherTexts ?? {}).length)
    reasons.push('skip_does_not_send_other_text');
  params.selected_option_ids = ['__skip__'];
  if (state.parts) params.confirmed_parts = state.parts;
  state.selected = [];
  return card.parts ? 'parts_skip' : 'skip';
}
function prepareConfirmation(state: AnswerPreparation) {
  const { card, input, params, reasons } = state;
  if (state.selected.length) reasons.push('confirmation_does_not_select_options');
  if (Object.keys(input.otherTexts ?? {}).length) reasons.push('single_card_requires_other_text');
  if (state.parts) params.confirmed_parts = state.parts;
  if (input.otherText) {
    params.selected_option_ids = ['__other__'];
    params.other_text = input.otherText;
  }
  state.selected = [];
  return card.parts ? 'parts_confirmation' : input.otherText ? 'confirmation_other' : 'confirmation';
}
function prepareSelection(state: AnswerPreparation) {
  const { card, input, params, reasons } = state;
  if (Object.keys(input.otherTexts ?? {}).length) reasons.push('single_card_requires_other_text');
  if (state.selected.some((value) => !card.options.some((option) => option.id === value)))
    reasons.push('unknown_option_id');
  if (state.selected.includes('__skip__')) reasons.push('use_skip_action');
  if (card.parts === undefined && (state.selected.length < card.min || state.selected.length > card.max))
    reasons.push('selection_count_out_of_range');
  const other = state.selected.some((value) =>
    card.options.some((option) => option.id === value && inputOption(option)),
  );
  if (other && !input.otherText) reasons.push('other_text_required');
  if (!other && input.otherText) reasons.push('other_text_requires_input_option');
  if (other && card.options.some((option) => option.nodeId || option.assetId || option.thumbnail))
    state.selected = state.selected.filter((value) =>
      card.options.some((option) => option.id === value && inputOption(option)),
    );
  params.selected_option_ids = state.selected;
  if (other && input.otherText) params.other_text = input.otherText;
  return other ? 'selection_other' : 'selection';
}
function prepareBranch(state: AnswerPreparation) {
  if (state.card.intent === 'retry') return prepareRetry(state);
  if (state.card.questions.length) return prepareQuestions(state);
  if (state.input.action === 'skip') return prepareSkip(state);
  if (state.card.confirm) return prepareConfirmation(state);
  return prepareSelection(state);
}
/** BoYY6--q.Ft/It/Lt 的发送分支：单题与多题 Other、部分跳过、确认部件保持不同语义。 */
export function prepareAnswer(card: AnswerCard, input: AnswerInput): PreparedAnswer {
  const state: AnswerPreparation = {
    card,
    input,
    params: { turn_id: input.turnId, selected_option_ids: [] },
    reasons: [],
    selected: defaultSelected(card, input),
  };
  if (card.answered) state.reasons.push('card_already_answered');
  if (card.expired) state.reasons.push('card_expired');
  prepareParts(state);
  const branch = prepareBranch(state);
  const references = card.options
    .filter((option) => state.selected.includes(option.id))
    .filter((option) => option.nodeId || option.assetId)
    .map(({ nodeId, assetId }) => ({ nodeId, assetId }));
  if (card.confirmNodeId) references.push({ nodeId: card.confirmNodeId, assetId: undefined });
  return { parameters: state.params, reasons: [...new Set(state.reasons)], references, branch };
}
