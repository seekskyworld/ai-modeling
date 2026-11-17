/** Studio 网页微服务共用会话与解码；服务白名单阻止把凭据转发到任意方法。 */
import type { StudioClient } from './client.ts';
import { tokenClaims, type Session } from '../auth/credentials.ts';
import { object, text, TripoError } from '../contracts/errors.ts';
import { assertRetrySession, fetchReadTransport } from './read-transport.ts';
import { rejectTransientHttpStatus } from './http-status.ts';

// 这些方法在网页准备、状态和产物读取链中已核实；不按 Get/List 字样推断任意 RPC 安全。
const authenticationReads = new Set(
  [
    'CanvasService/GetCanvas',
    'LabService/GetLabJob',
    'RunService/GetRun',
    'AssetService/BatchGetInputAssets',
    'NodeService/ListNodesAssets',
    'NodeService/ListNodeBatches',
    'NodeService/GetNodeAssetDetail',
    'SessionService/GetSession',
    'TurnService/GetTurnDetail',
    'ToolService/ListTools',
  ].map((method) => '/tripo.canvas.api.agent.' + method),
);

export class WebMicroClient {
  private readonly studio: StudioClient;
  private readonly namespace: 'canvas' | 'community';
  constructor(studio: StudioClient, namespace: 'canvas' | 'community') {
    this.studio = studio;
    this.namespace = namespace;
  }
  /** 方法由内部目录选择；提交不自动重试，请求头和错误正文不进入调用结果。 */
  async call(method: string, body: unknown, write = false): Promise<unknown> {
    return await this.callOnce(method, body, write, true);
  }
  private async callOnce(
    method: string,
    body: unknown,
    write: boolean,
    allowLogin: boolean,
  ): Promise<unknown> {
    const allowed =
      this.namespace === 'canvas'
        ? /^\/tripo\.canvas\.api\.agent\.[A-Za-z]+Service\/[A-Za-z]+$/
        : /^\/tripo\.community\.api\.(content\.ContentService|search\.SearchService)\/(GetItem|ListItemsByUser|SearchItems|ListGalleryFeed|SearchMyCollectedItems)$/;
    if (!allowed.test(method))
      throw new TripoError('INVALID_ROUTE', 'Unsupported Studio microservice method.');
    const { headers, session } = await this.authentication(method);
    // 仅精确GetCanvas回读已核实可重放；write=false不意味着任意RPC都只读。
    const readRetry =
      this.namespace === 'canvas' && method === '/tripo.canvas.api.agent.CanvasService/GetCanvas' && !write;
    const response = await fetchReadTransport(
      this.studio.fetcher,
      'https://msapi.tripo3d.ai/ms/web/api',
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        redirect: 'error',
      },
      {
        readRetry,
        timeoutMs: 65000,
        beforeRetry: () => assertRetrySession(this.studio.credentials, session),
        failure: () =>
          new TripoError(
            'NETWORK_ERROR',
            'Studio microservice request has no confirmed response.',
            write ? 'unknown' : 'read',
          ),
      },
    );
    try {
      return await this.decode(response, write);
    } catch (error) {
      if (!allowLogin || write || !(this.namespace === 'community' || authenticationReads.has(method)))
        throw error;
      await this.studio.recoverAuthentication(error, 'read_rejected', session.accountRef);
      return await this.callOnce(method, body, write, false);
    }
  }
  /** SSE 与普通 RPC 使用同一会话，只允许已核实的两个订阅方法。 */
  async stream(method: string, body: unknown, signal: AbortSignal): Promise<Response> {
    return await this.streamOnce(method, body, signal, true);
  }
  private async streamOnce(
    method: string,
    body: unknown,
    signal: AbortSignal,
    allowLogin: boolean,
  ): Promise<Response> {
    if (
      this.namespace !== 'canvas' ||
      ![
        '/tripo.canvas.api.agent.CanvasService/SubscribeAgentEvents',
        '/tripo.canvas.api.agent.LabService/SubscribeLabEvents',
      ].includes(method)
    )
      throw new TripoError('INVALID_ROUTE', 'Unsupported event stream.');
    signal.throwIfAborted();
    const { headers, session } = await this.authentication(method);
    let response: Response;
    try {
      response = await this.studio.fetcher('https://msapi.tripo3d.ai/ms/web/sse', {
        method: 'POST',
        headers: { ...headers, accept: 'text/event-stream', 'x-timeout': '600000' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal,
      });
    } catch {
      if (signal.aborted) throw signal.reason;
      throw new TripoError('NETWORK_ERROR', 'Event stream connection failed.', 'read');
    }
    if (!response.ok) {
      try {
        await this.decode(response, false);
      } catch (error) {
        if (!allowLogin || signal.aborted) throw error;
        await this.studio.recoverAuthentication(error, 'read_rejected', session.accountRef);
        signal.throwIfAborted();
        return await this.streamOnce(method, body, signal, false);
      }
    }
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
      await response.body?.cancel();
      throw new TripoError('CONTRACT_CHANGED', 'Expected a Studio SSE response.', 'read');
    }
    return response;
  }
  private async authentication(
    method: string,
  ): Promise<{ headers: Record<string, string>; session: Session }> {
    let session: Session | undefined;
    try {
      session = this.studio.credentials.load();
    } catch (error) {
      await this.studio.recoverAuthentication(error, 'before_request');
      session = this.studio.credentials.load();
    }
    if (!session) session = await this.studio.session(true);
    if (!session?.accountRef) throw new TripoError('AUTH_REQUIRED', 'Sign in to Studio first.');
    const bound = this.studio.forAccount(session.accountRef);
    const refreshed = { ...(await bound.session(true))! };
    const bearer = refreshed.bearer!;
    assertRetrySession(bound.credentials, refreshed, 'not_submitted');
    return {
      session: { ...refreshed },
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-auth-token': bearer,
        'x-deviceid': refreshed.deviceId,
        'x-uid': text(tokenClaims(bearer).sub),
        'x-lang': 'en',
        'x-micro-method': method,
        'x-micro-service': method.split('/')[1]!.split('.').slice(0, -1).join('.'),
        'x-timeout': '60000',
        origin: 'https://studio.tripo3d.ai',
        referer: 'https://studio.tripo3d.ai/',
      },
    };
  }
  private async decode(response: Response, write: boolean): Promise<unknown> {
    const certainty = write ? 'unknown' : 'read';
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      throw new TripoError(
        'AUTH_REQUIRED',
        'Studio microservice rejected the Studio session.',
        'not_submitted',
      );
    }
    await rejectTransientHttpStatus(response, certainty);
    let result: Record<string, unknown>;
    try {
      result = object(await response.json());
    } catch {
      if (response.status === 403)
        throw new TripoError('STUDIO_REJECTED', 'Studio microservice denied access.', 'not_submitted', {
          http_status: 403,
        });
      throw new TripoError('CONTRACT_CHANGED', 'Unreadable Studio microservice response.', certainty);
    }
    const code = object(result.error).code;
    if (response.ok && code === 16)
      throw new TripoError(
        'AUTH_REQUIRED',
        'Studio microservice rejected the Studio session.',
        'not_submitted',
      );
    if (code || !response.ok)
      throw new TripoError(
        this.namespace === 'canvas' && code === 5411 ? 'CANVAS_CHANGED' : 'STUDIO_REJECTED',
        'Studio microservice declined the operation.',
        'not_submitted',
        { remote_code: code, http_status: response.status },
      );
    delete result.error;
    return result;
  }
}
