/** --then 的逗号既可分隔步骤也可分隔该步骤的参数，以已知步骤名消除歧义。 */
import { TripoError } from '../../studio/contracts/errors.ts';
const primary: Record<string, string | undefined> = {
  texture: 'texture_quality',
  convert: 'format',
  rig: 'rig_type',
  'rig-check': 'model',
  retarget: 'animation',
  segment: 'model',
  complete: 'completion_mode',
  decimate: 'face_limit',
  uv: undefined,
  edit: 'bbox',
  import: undefined,
  smartsegment: 'granularity',
};
export interface ChainStep {
  name: string;
  param: Record<string, unknown>;
}
function assign(step: ChainStep, raw: string): void {
  const equal = raw.indexOf('=');
  const key = equal < 0 ? primary[step.name] : raw.slice(0, equal).trim();
  const value = (equal < 0 ? raw : raw.slice(equal + 1)).trim();
  if (!key || !/^[a-z][a-z0-9_]*$/.test(key) || !value)
    throw new TripoError('INVALID_INPUT', 'Invalid processing-chain parameter.');
  let parsed: unknown = value;
  try {
    parsed = JSON.parse(value);
  } catch {
    /* 版本、格式和预设名称是未加引号的普通字符串。 */
  }
  step.param[key] = parsed;
}
export function parseChain(raw: string): ChainStep[] {
  const steps: ChainStep[] = [];
  if (!raw.trim()) return steps;
  for (const part of splitChain(raw, ',')) {
    const token = part.trim();
    const colon = token.indexOf(':');
    const rawName = (colon < 0 ? token : token.slice(0, colon)).trim().toLowerCase();
    const name =
      (
        { check: 'rig-check', rigcheck: 'rig-check', animate: 'retarget', lowpoly: 'decimate' } as Record<
          string,
          string
        >
      )[rawName] ?? rawName;
    if (Object.hasOwn(primary, name)) {
      const step = { name, param: {} };
      steps.push(step);
      if (colon >= 0) for (const argument of splitChain(token.slice(colon + 1), ';')) assign(step, argument);
    } else if (token.includes('=') && steps.length) assign(steps.at(-1)!, token);
    else throw new TripoError('INVALID_INPUT', `Unsupported chain step: ${name}.`);
  }
  return steps;
}
/** JSON 数组/对象与引号内部的逗号属于参数，不能截断多动作或边界框。 */
function splitChain(raw: string, separator: ',' | ';'): string[] {
  const parts: string[] = [];
  let start = 0,
    depth = 0,
    quoted = false,
    escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') quoted = !quoted;
    if (quoted) continue;
    if (char === '[' || char === '{') depth++;
    if (char === ']' || char === '}') {
      depth--;
      if (depth < 0) throw new TripoError('INVALID_INPUT', 'Unbalanced processing-chain argument.');
    }
    if (char === separator && depth === 0) {
      parts.push(raw.slice(start, i));
      start = i + 1;
    }
  }
  if (depth !== 0 || quoted) throw new TripoError('INVALID_INPUT', 'Unbalanced processing-chain argument.');
  parts.push(raw.slice(start));
  return parts.filter((part) => part.trim());
}
