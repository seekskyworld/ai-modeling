/** Parse the script-facing CLI before any application, account or database is opened. */
import { TripoError } from '../studio/contracts/errors.ts';

/** Top-level dispatch grammar outside the Commander command tree. */
export const structuredEntryPointNames = ['auth', 'call', 'tools', 'guides', 'serve'] as const;

export interface StructuredRequest {
  command: 'call' | 'tools';
  name?: string;
  toolset: 'default' | 'full' | 'studio';
  profile?: string;
  source?: 'inline' | 'stdin';
  json?: string;
  help: boolean;
}
/** Preserve the conventional global profile prefix without changing Commander commands. */
export function structuredRoute(args: string[]): string[] {
  let index = 0;
  while (args[index]?.startsWith('--profile=')) index++;
  while (args[index] === '--profile' && args[index + 1] && !args[index + 1]!.startsWith('-')) index += 2;
  return index > 0 && ['call', 'tools'].includes(args[index] ?? '')
    ? [args[index]!, ...args.slice(0, index), ...args.slice(index + 1)]
    : args;
}
const invalid = (message: string): never => {
  throw new TripoError('INVALID_INPUT', message, 'not_submitted');
};
function setInput(result: StructuredRequest, source: 'stdin' | 'inline', json?: string): void {
  if (result.command !== 'call' || result.source) return invalid('Choose exactly one input source for call.');
  result.source = source;
  result.json = json;
}
function setValue(result: StructuredRequest, flag: string, value: string): void {
  if (flag === '--toolset') {
    if (!['default', 'full', 'studio'].includes(value))
      return invalid('toolset must be default, full or studio.');
    result.toolset = value as StructuredRequest['toolset'];
  } else if (flag === '--profile') result.profile = value;
  else setInput(result, 'inline', value);
}
export function parseStructuredArgs(args: string[]): StructuredRequest {
  if (args[0] !== 'call' && args[0] !== 'tools') return invalid('Expected call or tools.');
  const result: StructuredRequest = { command: args[0], toolset: 'studio', help: false };
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index++) {
    const token = args[index]!;
    if (!token.startsWith('-')) {
      if (result.command !== 'call' || result.name) return invalid('Unexpected positional argument.');
      result.name = token;
      continue;
    }
    const split = token.indexOf('=');
    const flag = split < 0 ? token : token.slice(0, split);
    if (!['--input', '--input-stdin', '--toolset', '--profile', '--help', '-h'].includes(flag))
      return invalid(`Unknown option: ${flag}`);
    if (seen.has(flag)) return invalid(`Duplicate option: ${flag}`);
    seen.add(flag);
    if (['--help', '-h', '--input-stdin'].includes(flag)) {
      if (split >= 0) return invalid(`${flag} does not accept a value.`);
      if (flag !== '--input-stdin') {
        result.help = true;
        continue;
      }
      setInput(result, 'stdin');
      continue;
    }
    const value = split < 0 ? args[++index] : token.slice(split + 1);
    if (!value || value.startsWith('--')) return invalid(`Missing value for ${flag}.`);
    setValue(result, flag, value);
  }
  if (result.command === 'call' && !result.name && !result.help) return invalid('call requires a tool name.');
  return result;
}
export async function structuredInput(
  request: StructuredRequest,
  readStdin: () => Promise<string>,
): Promise<unknown> {
  if (!request.source) return {};
  const raw = request.source === 'stdin' ? await readStdin() : request.json!;
  if (Buffer.byteLength(raw) > 1048576) return invalid('Command input exceeds 1 MiB.');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return invalid('Tool input must be valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid('Tool input must be a JSON object.');
  return value;
}
