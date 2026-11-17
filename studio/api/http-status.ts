/** HTTP状态先于正文格式；这里只分类，不重放任何已经收到响应的请求。 */
import { TripoError } from '../contracts/errors.ts';

const maximumRetryAfterMs = 24 * 60 * 60 * 1000;

export function retryAfterMilliseconds(value: string | null, now = Date.now()): number | undefined {
  if (!value) return;
  const source = value.trim();
  if (/^\d+$/.test(source)) {
    const seconds = Number(source);
    if (Number.isFinite(seconds)) return Math.min(maximumRetryAfterMs, seconds * 1000);
    return;
  }
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(source)) return;
  const date = Date.parse(source);
  if (Number.isFinite(date)) return Math.min(maximumRetryAfterMs, Math.max(0, date - now));
}

export async function rejectTransientHttpStatus(
  response: Response,
  certainty: TripoError['certainty'],
): Promise<void> {
  if (response.status !== 429 && response.status < 500) return;
  const retryAfter = retryAfterMilliseconds(response.headers.get('retry-after'));
  await response.body?.cancel().catch(() => undefined);
  throw new TripoError(
    response.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR',
    response.status === 429
      ? 'Studio rate limit reached.'
      : 'Studio server failed without confirming the outcome.',
    certainty,
    {
      http_status: response.status,
      ...(retryAfter !== undefined ? { retry_after_ms: retryAfter } : {}),
    },
  );
}
