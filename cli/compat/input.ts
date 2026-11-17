/** 无显式输入时只接受有效管道任务；非交互环境绝不把空输入解释成最近资产。 */
import { object, text, TripoError } from '../../studio/contracts/errors.ts';
export function pipedTask(raw: string): string {
  const trimmed = raw.trim();
  if (/^(?:task_[A-Za-z0-9_-]+|[a-f\d]{8}-[a-f\d-]{27})$/i.test(trimmed)) return trimmed;
  let values: unknown[];
  try {
    values = [JSON.parse(trimmed)];
  } catch {
    try {
      values = trimmed
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
    } catch {
      throw new TripoError('INVALID_INPUT', 'Pipe task JSON, NDJSON or a bare task ID.');
    }
  }
  let id = '';
  for (const record of values) id = taskFromRecord(object(record)) || id;
  if (!id) throw new TripoError('INVALID_INPUT', 'Piped JSON contains no task_id.');
  return id;
}
/** 任意一条上游失败都阻断后续提交，不能用较早的成功记录掩盖最终错误。 */
function taskFromRecord(value: Record<string, unknown>): string {
  const body = Object.keys(object(value.result)).length ? object(value.result) : value;
  const error = { ...object(body.studio_error), ...object(body.error) };
  if (body.error || ['failed', 'outcome_unknown', 'requires_login'].includes(text(body.status)))
    throw new TripoError(
      text(error.code) || text(body.code) || 'UPSTREAM_TASK_FAILED',
      'Upstream command failed; no downstream work was submitted.',
      'not_submitted',
      { upstream_exit_code: typeof value.exit_code === 'number' ? value.exit_code : undefined },
    );
  return text(body.task_id) || text(body.job_id);
}
export async function processingInput(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  if (process.stdin.isTTY) return '@last';
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += String(chunk);
    if (raw.length > 131072) throw new TripoError('INVALID_INPUT', 'Piped input exceeds 128 KiB.');
  }
  return pipedTask(raw);
}
