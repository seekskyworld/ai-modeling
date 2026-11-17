/** 仅调用方已核实的只读链允许重读；传输重试共享原signal、正文和凭据，不处理HTTP/解码错误。 */
import { setTimeout as delay } from 'node:timers/promises';
import type { CredentialStore, Session } from '../auth/credentials.ts';
import { object, TripoError } from '../contracts/errors.ts';
import type { Fetcher } from './client.ts';

const transportCodes = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** fetch的参数/重定向/业务异常也可能reject；只识别明确的传输错误码。 */
function retryableTransportFailure(error: unknown, depth = 0): boolean {
  if (depth > 5 || error instanceof TripoError) return false;
  const details = object(error);
  if (typeof details.status === 'number' || typeof details.statusCode === 'number') return false;
  if (error instanceof AggregateError)
    return (
      error.errors.length > 0 && error.errors.every((item) => retryableTransportFailure(item, depth + 1))
    );
  if (typeof details.code === 'string') return transportCodes.has(details.code);
  return details.cause !== undefined && retryableTransportFailure(details.cause, depth + 1);
}

/** 退避不刷新登录；原读取不能被换成另一账号、另一份凭据或设备的请求。 */
export function assertRetrySession(
  store: CredentialStore,
  original: Session | undefined,
  certainty: 'read' | 'not_submitted' = 'read',
): void {
  const current = store.load();
  if (current?.accountRef !== original?.accountRef)
    throw new TripoError('ACCOUNT_MISMATCH', 'The Studio account changed before the request.', certainty);
  if (
    current?.cookie !== original?.cookie ||
    current?.bearer !== original?.bearer ||
    current?.deviceId !== original?.deviceId
  )
    throw new TripoError('SESSION_CHANGED', 'The Studio session changed before the request.', certainty);
}

interface TransportOptions {
  readRetry: boolean;
  timeoutMs: number;
  /** 多段只读链共用第一次建立的时限；重定向不得重新获得完整下载预算。 */
  budget?: { signal: AbortSignal; deadline: number };
  beforeRetry: () => void;
  failure: () => TripoError;
}
export async function fetchReadTransport(
  fetcher: Fetcher,
  url: string,
  init: RequestInit,
  options: TransportOptions,
): Promise<Response> {
  const deadline = options.budget?.deadline ?? performance.now() + options.timeoutMs,
    signal = options.budget?.signal ?? AbortSignal.timeout(options.timeoutMs),
    attempts = options.readRetry ? 3 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) {
      options.beforeRetry();
    }
    if (signal.aborted || performance.now() >= deadline) throw options.failure();
    try {
      return await fetcher(url, { ...init, signal });
    } catch (error) {
      const backoff = 150 * (attempt + 1);
      if (
        !retryableTransportFailure(error) ||
        attempt + 1 === attempts ||
        signal.aborted ||
        performance.now() + backoff >= deadline
      )
        throw options.failure();
      await delay(backoff, undefined, { signal }).catch(() => {
        throw options.failure();
      });
      if (signal.aborted || performance.now() >= deadline) throw options.failure();
    }
  }
  throw options.failure();
}
