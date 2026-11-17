/** Usage reports retain missing tasks and unknown costs; totals never turn absent evidence into zero. */
import { errorResult, object, text, TripoError } from '../../studio/contracts/errors.ts';
import { transactionHistory } from '../../studio/api/transaction-history.ts';
import { resolveJob, taskResult, type Application } from './runtime.ts';

interface UsageEntry {
  task_id: string;
  type: string;
  credits_consumed: number | null;
  created_at: string | null;
}
interface UsageError {
  task_id: string;
  error: Record<string, unknown>;
}
const amount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
function report(
  usage: UsageEntry[],
  total: number,
  missed: string[],
  errors: UsageError[],
  namespace: string,
) {
  const unknown = usage.filter((entry) => entry.credits_consumed === null).map((entry) => entry.task_id);
  const sum = usage.reduce((total, row) => total + (row.credits_consumed ?? 0), 0);
  const known = !unknown.length && !missed.length && !errors.length && Number.isFinite(sum);
  const truncated = total > usage.length;
  return {
    total_entries: total,
    returned_entries: usage.length,
    truncated,
    total_credits: known ? sum : null,
    usage,
    missed,
    errors,
    unknown,
    complete: known && !truncated,
    task_id_namespace: namespace,
  };
}
async function selectedUsage(app: Application, references: string[]) {
  const missed: string[] = [],
    errors: UsageError[] = [];
  const selected = new Map<string, string>();
  for (const reference of new Set(references)) {
    try {
      selected.set(resolveJob(app, reference).job_id, reference);
    } catch (error) {
      if (error instanceof TripoError && error.code === 'JOB_NOT_FOUND') missed.push(reference);
      else errors.push({ task_id: reference, error: errorResult(error) });
    }
  }
  const total = selected.size + missed.length + errors.length;
  const ids = [...selected.keys()];
  const results = await Promise.allSettled(ids.map(async (id) => taskResult(await app.service.get(id))));
  const usage: UsageEntry[] = [];
  results.forEach((result, index) => {
    const id = ids[index]!;
    if (result.status === 'fulfilled') {
      const task = result.value;
      usage.push({
        task_id: id,
        type: text(task.type) || 'unknown',
        credits_consumed: amount(task.credits_consumed),
        created_at: text(task.created_at) || null,
      });
      if (task.poll_error) errors.push({ task_id: id, error: object(task.poll_error) });
    } else if (result.reason instanceof TripoError && result.reason.code === 'JOB_NOT_FOUND')
      missed.push(selected.get(id)!);
    else errors.push({ task_id: id, error: errorResult(result.reason) });
  });
  const result = report(usage, total, missed, errors, 'local_job');
  return { ...result, truncated: false };
}
export async function usageReport(app: Application, input: Record<string, unknown>) {
  if (Array.isArray(input.task_ids)) return selectedUsage(app, input.task_ids.map(text));
  const history = await transactionHistory(app.studio.client.forAccount(app.service.accountRef()));
  const grouped = new Map<string, UsageEntry>();
  const errors: UsageError[] = [];
  for (const row of history) {
    if (row.txn_type !== 'charge' || row.direction !== 'sub') continue;
    const id = text(row.operator_id);
    if (!id) {
      errors.push({
        task_id: '',
        error: { code: 'BILLING_ID_MISSING', message: 'A charge has no operator identity.' },
      });
      continue;
    }
    const credits = row.status === 'fulfilled' ? amount(row.amount) : null;
    const previous = grouped.get(id);
    grouped.set(id, {
      task_id: id,
      type: text(row.operator_type) || text(row.task_type) || 'studio_transaction',
      credits_consumed: previous
        ? previous.credits_consumed === null || credits === null
          ? null
          : amount(previous.credits_consumed + credits)
        : credits,
      created_at: (previous?.created_at ?? text(row.created_at)) || text(row.create_time) || null,
    });
  }
  const limit = Number(input.limit ?? 50);
  return report([...grouped.values()].slice(0, limit), grouped.size, [], errors, 'studio_operator');
}
