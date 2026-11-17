/** watch只延后查询原任务，绝不调用提交；服务端等待时间优先且受总等待期限约束。 */
import { object } from '../../studio/contracts/errors.ts';

export interface PollTiming {
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}

export function pollingDelay(error: unknown, consecutiveFailures: number): number {
  const fallback = Math.min(30000, 2000 * 2 ** Math.min(4, Math.max(0, consecutiveFailures - 1)));
  const retryAfter = object(error).retry_after_ms;
  return typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0
    ? Math.max(fallback, retryAfter)
    : fallback;
}
