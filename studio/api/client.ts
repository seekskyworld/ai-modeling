/** 统一 Studio 请求与失败语义；付费提交只发一次，未知回执不能转为可重试失败。 */
import { EnvHttpProxyAgent, fetch as proxyFetch } from 'undici';
import { object, TripoError } from '../contracts/errors.ts';
import { type CredentialStore, type Session } from '../auth/credentials.ts';
import { refreshSessionToken } from '../auth/session-token.ts';
import { assertRetrySession, fetchReadTransport } from './read-transport.ts';
import { rejectTransientHttpStatus } from './http-status.ts';

export interface RequestOptions {
  paid?: boolean;
  public?: boolean;
  timeoutMs?: number;
  /** session 刷新也有 await；调用者的同步身份义务必须在真实 fetch 前执行。 */
  beforeSend?: () => void;
  /** whoami 续期内部禁用交互，防止旧刷新在登录 CAS 后继续保存。 */
  authentication?: false;
}
export interface AuthenticationContext {
  error: TripoError;
  expectedAccountRef?: string;
  phase: 'before_request' | 'read_rejected';
}
export type AuthenticationHandler = (context: AuthenticationContext) => Promise<void>;
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
const dispatcher = new EnvHttpProxyAgent();
export const networkFetch: Fetcher = async (url, init) =>
  (await proxyFetch(url, { ...init, dispatcher } as Parameters<typeof proxyFetch>[1])) as unknown as Response;

/** 仅识别已经在线确认的参数拒绝格式；代理错误和服务器故障不能被当成安全重提依据。 */
function plainValidationRejection(status: number, body: string): boolean {
  return (
    status === 400 &&
    [
      /^error: value "[^\r\n]*" is not defined in options "\[[^\r\n]*\]"\s*$/,
      /^type mismatch for field "[a-zA-Z_][a-zA-Z0-9_.]*"\s*$/,
      /^invalid modelVersion: [a-zA-Z0-9_.-]+\s*$/,
    ].some((pattern) => pattern.test(body))
  );
}

export class StudioClient {
  readonly origin: string;
  readonly credentials: CredentialStore;
  readonly fetcher: Fetcher;
  readonly authentication?: AuthenticationHandler;
  private expectedAccountRef?: string;
  constructor(
    credentials: CredentialStore,
    fetcher: Fetcher = networkFetch,
    origin = 'https://api.tripo3d.ai',
    authentication?: AuthenticationHandler,
  ) {
    this.credentials = credentials;
    this.fetcher = fetcher;
    this.origin = origin;
    this.authentication = authentication;
  }
  /** 每次读取或刷新都核对任务账号，防止多进程换账号时将后续请求发到另一身份。 */
  forAccount(expected: string): StudioClient {
    const original = this.credentials;
    let observedSession = false;
    const checked = (): ReturnType<CredentialStore['load']> => {
      const session = original.load();
      if (!session)
        throw new TripoError(
          observedSession ? 'ACCOUNT_MISMATCH' : 'AUTH_REQUIRED',
          "Restore this job's Studio session.",
          'not_submitted',
        );
      if (session.accountRef !== expected)
        throw new TripoError(
          'ACCOUNT_MISMATCH',
          'The saved session no longer matches this job.',
          'not_submitted',
        );
      observedSession = true;
      return session;
    };
    const bound = new StudioClient(
      {
        load: checked,
        save: (session) => {
          checked();
          original.save(session);
        },
        ...(original.saveIfUnchanged
          ? {
              saveIfUnchanged: (expected: Session | undefined, session: Session) => {
                checked();
                return original.saveIfUnchanged!(expected, session);
              },
            }
          : {}),
        clear: () => {
          checked();
          original.clear();
        },
      },
      this.fetcher,
      this.origin,
      this.authentication,
    );
    bound.expectedAccountRef = expected;
    return bound;
  }
  /** 普通 REST 仍兼容仅 Cookie 会话；微服务必须取得有效 JWT。 */
  async session(requireBearer = false): Promise<Session | undefined> {
    let expected: string | undefined;
    try {
      return await this.refresh(requireBearer, (session) => {
        expected = session?.accountRef;
      });
    } catch (error) {
      await this.recoverAuthentication(error, 'before_request', expected);
      return await this.refresh(requireBearer);
    }
  }
  private async refresh(
    requireBearer: boolean,
    observe?: (session: Session | undefined) => void,
  ): Promise<Session | undefined> {
    return await refreshSessionToken(
      this.credentials,
      () =>
        this.request('GET', '/v2/studio/studio/whoami?tokenizeAs=default_jwt', undefined, {
          authentication: false,
        }),
      requireBearer,
      observe,
    );
  }
  /** 供已核实的微服务只读边界共用；调用方必须限制一次，不能用于重放写操作。 */
  async recoverAuthentication(
    error: unknown,
    phase: AuthenticationContext['phase'],
    expected?: string,
  ): Promise<void> {
    if (!(error instanceof TripoError) || error.code !== 'AUTH_REQUIRED' || !this.authentication) throw error;
    if (expected && this.credentials.load()?.accountRef !== expected)
      throw new TripoError(
        'ACCOUNT_MISMATCH',
        'The Studio account changed while this request was pending.',
        'not_submitted',
      );
    await this.authentication({ error, phase, expectedAccountRef: this.expectedAccountRef ?? expected });
    const current = this.credentials.load();
    if (!current) throw error;
    if (expected && current.accountRef !== expected)
      throw new TripoError(
        'ACCOUNT_MISMATCH',
        'The login belongs to a different Studio account.',
        'not_submitted',
      );
  }
  async request(
    method: 'GET' | 'POST' | 'DELETE',
    route: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<unknown> {
    if (!route.startsWith('/v2/studio/') || route.includes('..') || route.includes('\\'))
      throw new TripoError('INVALID_ROUTE', 'Unsupported Studio route.');
    let session: Session | undefined;
    let expected: string | undefined;
    const prepare = async (): Promise<Session | undefined> => {
      const saved = this.credentials.load();
      expected ??= saved?.accountRef;
      if (expected && saved?.accountRef !== expected)
        throw new TripoError(
          'ACCOUNT_MISMATCH',
          'The Studio account changed while preparing this request.',
          'not_submitted',
        );
      if (!options.public && !saved)
        throw new TripoError('AUTH_REQUIRED', 'Sign in with ai-modeling auth login.', 'not_submitted');
      const prepared = saved?.bearer && !route.includes('/whoami') ? await this.refresh(false) : saved;
      if (expected && prepared?.accountRef !== expected)
        throw new TripoError(
          'ACCOUNT_MISMATCH',
          'The Studio account changed while refreshing this request.',
          'not_submitted',
        );
      return prepared;
    };
    try {
      session = await prepare();
    } catch (error) {
      if (options.authentication === false) throw error;
      await this.recoverAuthentication(error, 'before_request', expected);
      session = await prepare();
    }
    try {
      return await this.requestWithSession(method, route, body, options, session);
    } catch (error) {
      // 只读请求可在同账号登录后重读一次；收费和普通写请求绝不在响应后重放。
      const read =
        !options.paid &&
        (method === 'GET' || (method === 'POST' && route === '/v2/studio/operation/download_with_name'));
      if (!read || options.authentication === false) throw error;
      await this.recoverAuthentication(error, 'read_rejected', session?.accountRef);
      return await this.requestWithSession(method, route, body, options, await prepare());
    }
  }
  private async requestWithSession(
    method: 'GET' | 'POST' | 'DELETE',
    route: string,
    body: unknown,
    options: RequestOptions,
    session: Session | undefined,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      origin: 'https://studio.tripo3d.ai',
      referer: 'https://studio.tripo3d.ai/',
      'content-type': 'application/json',
    };
    if (session) {
      if (session.cookie) headers.cookie = `ory_kratos_session=${session.cookie}`;
      if (session.bearer && !route.includes('/whoami')) headers.authorization = `Bearer ${session.bearer}`;
      headers['x-tripo-device-id'] = session.deviceId;
      headers['x-tripo-region'] = 'global';
      headers['x-tripo-start'] = performance.now().toString();
    }
    return await this.send(method, route, headers, body, options, session ? { ...session } : undefined);
  }
  /** GET及唯一已核实的下载链接查询POST可重读；不按名称/Get前缀推断其它POST安全。 */
  private async fetchResponse(
    route: string,
    init: RequestInit,
    options: RequestOptions,
    session: Session | undefined,
  ): Promise<Response> {
    options.beforeSend?.();
    const readRetry =
      !options.paid &&
      (init.method === 'GET' ||
        (init.method === 'POST' && route === '/v2/studio/operation/download_with_name'));
    return await fetchReadTransport(this.fetcher, this.origin + route, init, {
      readRetry,
      timeoutMs: options.timeoutMs ?? 60000,
      beforeRetry: () => assertRetrySession(this.credentials, session),
      failure: () =>
        new TripoError(
          'NETWORK_ERROR',
          'Studio request failed without a confirmed response.',
          options.paid ? 'unknown' : 'read',
        ),
    });
  }
  private async send(
    method: string,
    route: string,
    headers: Record<string, string>,
    body: unknown,
    options: RequestOptions,
    session: Session | undefined,
  ): Promise<unknown> {
    const certainty = options.paid ? 'unknown' : 'read';
    const response = await this.fetchResponse(
      route,
      {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
      },
      options,
      session,
    );
    // HTTP 401 本身已确认未认证；登录网关可能返回空/HTML正文，不依赖JSON格式判断。
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      throw new TripoError(
        'AUTH_REQUIRED',
        'Studio rejected the session; sign in again.',
        options.paid ? 'not_submitted' : 'read',
      );
    }
    await rejectTransientHttpStatus(response, certainty);
    let data: Record<string, unknown>;
    let raw = '';
    try {
      raw = await response.text();
      data = object(JSON.parse(raw));
    } catch {
      if (response.status === 403)
        throw new TripoError('HTTP_ERROR', 'Studio returned HTTP 403.', certainty, { http_status: 403 });
      // 生图接口的枚举校验返回纯文本 400；明确未受理，不能误留为结果未知。
      // 只识别实测的校验格式，代理 HTML、其他 400 和 5xx 继续保守处理；不回显可能含输入的正文。
      if (plainValidationRejection(response.status, raw))
        throw new TripoError(
          'STUDIO_REJECTED',
          'Studio rejected an unsupported parameter value before submission.',
          'not_submitted',
          { http_status: response.status },
        );
      throw new TripoError('CONTRACT_CHANGED', 'Studio returned an unreadable response.', certainty, {
        http_status: response.status,
      });
    }
    // 403/429/5xx 等HTTP失败不能被正文中的认证码改写成登录动作。
    if (response.ok && data.code === 1002)
      throw new TripoError(
        'AUTH_REQUIRED',
        'Studio rejected the session; sign in again.',
        options.paid ? 'not_submitted' : 'read',
      );
    if (data.code !== undefined && data.code !== 0) {
      const code =
        data.code === 2010
          ? 'INSUFFICIENT_CREDITS'
          : data.code === 6102
            ? 'PLAN_REQUIRED'
            : 'STUDIO_REJECTED';
      throw new TripoError(code, 'Studio declined the operation.', 'not_submitted', {
        remote_code: data.code,
        http_status: response.status,
      });
    }
    if (!response.ok)
      throw new TripoError('HTTP_ERROR', `Studio returned HTTP ${response.status}.`, certainty);
    return data.code === 0 ? data.data : data;
  }
}
