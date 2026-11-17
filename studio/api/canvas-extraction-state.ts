/** 网页元素拆分的状态准备：保留自动/手动清单，检测结果失效时不沿用旧部件。 */
import { array, object, text } from '../contracts/errors.ts';

type Params = Record<string, unknown>;
export const isManualExtraction = (params: Params): boolean =>
  ['manual', 'user_defined'].includes(text(params.split_mode));

/** 网页按 Unicode 字符截断历史结果；调用方显式输入另由 schema 严格校验。 */
export function extractionTitles(value: unknown): string[] {
  const result: string[] = [];
  for (const item of array(value)) {
    if (typeof item !== 'string' && typeof item !== 'number') continue;
    const title = Array.from(String(item).trim()).slice(0, 200).join('');
    if (title && !result.includes(title)) result.push(title);
    if (result.length === 12) break;
  }
  return result;
}
const editable = (value: unknown): string[] => array(value).map(String).slice(0, 12);
export function extractionFacts(assets: unknown[]): string[] {
  for (const asset of assets) {
    if (object(asset).role !== 'ASSET_ROLE_CURRENT') continue;
    try {
      const facts = object(JSON.parse(text(object(asset).factsJson)));
      const titles = extractionTitles(array(facts.candidates).map((value) => object(value).title));
      if (titles.length) return titles;
    } catch {
      // 非检测资产或旧结果没有 JSON facts，不把它当作可生成的部件列表。
    }
  }
  return [];
}
export function extractionPrompt(params: Params, assets: unknown[]): string {
  if (text(params.prompt).trim()) return text(params.prompt).trim();
  for (const asset of assets.map(object)) {
    if (asset.role !== 'ASSET_ROLE_CURRENT') continue;
    try {
      const prompt = text(object(JSON.parse(text(asset.factsJson))).prompt).trim();
      if (prompt) return prompt;
    } catch {
      // 普通图片资产不一定携带提示词。
    }
  }
  return '';
}
export function extractionState(params: Params, extraction: Params, assets: unknown[] = []) {
  const manual = isManualExtraction(params);
  const stale = extraction.detectionStale === true || params.detect_list_stale === true;
  let titles: string[];
  if (!manual && stale) titles = [];
  else if (Array.isArray(params.candidate_titles) && (!manual || params.candidate_titles.length > 0))
    titles = editable(params.candidate_titles);
  else if (manual) titles = Array.isArray(params.manual_titles) ? editable(params.manual_titles) : ['', ''];
  else
    titles = array(extraction.detectedParts).length
      ? editable(extraction.detectedParts)
      : extractionFacts(assets);
  return {
    mode: manual ? 'manual' : 'auto',
    stale,
    editable_titles: titles,
    parts: extractionTitles(titles),
    current_batch_id: text(extraction.currentBatchId),
  };
}

/** 对应网页模式/数量变更；旧 granularity 是另一套枚举，不能拿官方粒度替代。 */
export function changeExtractionField(
  original: Params,
  field: 'split_mode' | 'amount',
  value: unknown,
  detectedParts: string[] = [],
  detectionVisible = true,
): Params {
  const params = { ...original, [field]: value };
  delete params.granularity;
  delete params.detect_list_stale;
  if (field === 'split_mode' && value === 'manual')
    return manualMode(original, params, detectedParts, detectionVisible);
  if (field === 'split_mode' && value === 'auto') autoMode(original, params);
  if (field === 'amount') {
    params.split_mode = 'auto';
    setAmount(params, value);
    delete params.auto_titles;
  }
  const restoreAuto = field === 'split_mode' && value === 'auto' && Array.isArray(original.auto_titles);
  if ((field === 'amount' || (field === 'split_mode' && value !== 'manual')) && !restoreAuto)
    delete params.candidate_titles;
  return params;
}

function manualMode(original: Params, params: Params, detected: string[], visible: boolean): Params {
  if (!isManualExtraction(original)) {
    if (Array.isArray(original.candidate_titles)) params.auto_titles = editable(original.candidate_titles);
    else if (visible && detected.length) params.auto_titles = editable(detected);
    else delete params.auto_titles;
  }
  const previous = Array.isArray(original.manual_titles) ? editable(original.manual_titles) : null;
  const candidates = editable(original.candidate_titles);
  const titles = previous ?? (candidates.length ? candidates : detected.length ? detected : ['', '']);
  params.candidate_titles = titles.slice(0, 12);
  params.manual_titles = titles.slice(0, 12);
  delete params.amount;
  return params;
}
function setAmount(params: Params, value: unknown): void {
  const amount = Number(value);
  if (Number.isInteger(amount) && amount >= 1 && amount <= 12) params.amount = amount;
  else delete params.amount;
}
function autoMode(original: Params, params: Params): void {
  if (isManualExtraction(original) && Array.isArray(original.candidate_titles))
    params.manual_titles = editable(original.candidate_titles);
  setAmount(params, params.amount);
  if (Array.isArray(original.auto_titles)) params.candidate_titles = editable(original.auto_titles);
}

export function changeExtractionParts(params: Params, parts: string[]): Params {
  return {
    ...params,
    candidate_titles: [...parts],
    ...(isManualExtraction(params) ? { manual_titles: [...parts] } : {}),
  };
}
