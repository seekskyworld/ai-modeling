/** 网页扩展沿用 CLI 的参数风格；嵌套对象用 JSON，保留 --input 给已有脚本。 */
import type { Command } from 'commander';
import { z } from 'zod';
import { object, text, TripoError } from '../../studio/contracts/errors.ts';
// 请求去重的 --request-id 属于 CLI，ContinueTurn 的 request_id 属于网页选择，不能共用同一选项。
const optionKey = (key: string): string => (key === 'request_id' ? 'remote_request_id' : key);
export function resourceOptions(command: Command, schema: z.ZodType): void {
  const json = z.toJSONSchema(schema);
  for (const [key, raw] of Object.entries(object(json.properties))) {
    const value = object(raw);
    const flag = optionKey(key)
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .replaceAll('_', '-')
      .toLowerCase();
    if (command.options.some((option) => option.long === `--${flag}`)) continue;
    const hint =
      text(value.description) || `${key}${value.enum ? ` (${(value.enum as unknown[]).join('|')})` : ''}`;
    if (value.type === 'boolean')
      command.option(`--${flag} [boolean]`, hint, (v) => {
        if (!['true', 'false'].includes(v))
          throw new TripoError('INVALID_INPUT', `${flag} must be true or false.`);
        return v === 'true';
      });
    else
      command.option(`--${flag} <value>`, hint, (v) => {
        if (['number', 'integer'].includes(text(value.type))) return Number(v);
        if (['object', 'array'].includes(text(value.type)) || value.anyOf || value.oneOf) {
          // 联合类型中的明确字符串选项仍按普通 CLI 枚举输入，例如 --amount auto。
          const variants = Array.isArray(value.anyOf) ? value.anyOf : value.oneOf;
          if (
            Array.isArray(variants) &&
            variants.some((entry) => {
              const choice = object(entry);
              return (
                choice.type === 'string' &&
                (choice.const === v || (Array.isArray(choice.enum) && choice.enum.includes(v)))
              );
            })
          )
            return v;
          try {
            return JSON.parse(v);
          } catch {
            throw new TripoError('INVALID_INPUT', `${flag} expects JSON.`);
          }
        }
        return v;
      });
  }
}
export function resourceInput(flags: Record<string, unknown>, schema: z.ZodType): Record<string, unknown> {
  const input = object(JSON.parse(text(flags.input) || '{}'));
  const props = object(z.toJSONSchema(schema).properties);
  for (const key of Object.keys(props)) {
    const flag = optionKey(key).replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    if (flags[flag] !== undefined) {
      if (key in input)
        throw new TripoError('INVALID_INPUT', `${key} was provided in both --input and a named option.`);
      input[key] = flags[flag];
    }
  }
  return input;
}
