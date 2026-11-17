/** 显式本机连接器：不发现日常浏览器目录，不允许重定向到远端调试端口。 */
import type { ConnectOverCDPTransport } from 'playwright-core';
import { object, TripoError } from '../contracts/errors.ts';

export function loopbackCdpEndpoint(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new TripoError('INVALID_INPUT', 'A local CDP endpoint is required.', 'not_submitted');
  }
  if (
    !['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TripoError('INVALID_INPUT', 'A local CDP endpoint is required.', 'not_submitted');
  }
  // localhost 不经过可变 DNS 解析；IPv6-only 调试端口可显式使用 [::1]。
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url;
}

async function websocketEndpoint(input: string, signal: AbortSignal): Promise<URL> {
  const endpoint = loopbackCdpEndpoint(input);
  if (endpoint.protocol === 'ws:' || endpoint.protocol === 'wss:') return endpoint;
  const discovery = new URL('/json/version', endpoint);
  const response = await fetch(discovery, { signal, redirect: 'error' });
  if (!response.ok) throw new Error('Local CDP discovery failed.');
  const body = await response.text();
  if (body.length > 65536) throw new Error('Local CDP discovery was invalid.');
  const discovered = object(JSON.parse(body)).webSocketDebuggerUrl;
  if (typeof discovered !== 'string') throw new Error('Local CDP discovery was invalid.');
  const socket = loopbackCdpEndpoint(discovered);
  if (socket.protocol !== 'ws:' && socket.protocol !== 'wss:')
    throw new Error('Local CDP discovery was invalid.');
  return socket;
}

/** 公开 Playwright transport 允许只断开连接，根本不调用既有浏览器的 close 方法。 */
export async function connectLocalCdpTransport(
  input: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<ConnectOverCDPTransport> {
  const scope = AbortSignal.any([signal, AbortSignal.timeout(Math.min(timeoutMs, 30000))]);
  scope.throwIfAborted();
  const endpoint = await websocketEndpoint(input, scope);
  scope.throwIfAborted();
  const socket = new WebSocket(endpoint);
  const transport: ConnectOverCDPTransport = {
    send: (message) => {
      // 防止库版本变化时把断开操作误变成终止用户浏览器的协议命令。
      if (object(message).method === 'Browser.close')
        throw new TripoError('BROWSER_LOGIN_FAILED', 'Cannot close an attached browser.', 'not_submitted');
      socket.send(JSON.stringify(message));
    },
    close: () => socket.close(),
  };
  const abort = () => socket.close();
  const detach = () => {
    scope.removeEventListener('abort', abort);
    signal.removeEventListener('abort', abort);
  };
  socket.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(String(event.data));
      if (typeof message !== 'object' || message === null || Array.isArray(message)) throw new Error();
      transport.onmessage?.(message);
    } catch {
      transport.close();
    }
  });
  socket.addEventListener('close', () => {
    detach();
    transport.onclose?.('Local browser connection closed.');
  });
  // error 事件可能包含端点细节；不向日志或调用方转发原事件。
  socket.addEventListener('error', () => {
    detach();
    transport.onclose?.('Local browser connection failed.');
  });
  scope.addEventListener('abort', abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        socket.removeEventListener('open', opened);
        socket.removeEventListener('error', failed);
        socket.removeEventListener('close', failed);
        scope.removeEventListener('abort', cancelled);
      };
      const opened = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(new Error('Local CDP connection failed.'));
      };
      const cancelled = () => {
        cleanup();
        reject(new Error('Local CDP connection cancelled.'));
      };
      socket.addEventListener('open', opened, { once: true });
      socket.addEventListener('error', failed, { once: true });
      socket.addEventListener('close', failed, { once: true });
      scope.addEventListener('abort', cancelled, { once: true });
      if (scope.aborted) cancelled();
    });
    // 30 秒限制只约束连接建立；登录中的验证码等仍受外层总期限约束。
    scope.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    return transport;
  } catch {
    transport.close();
    detach();
    throw new TripoError('BROWSER_LOGIN_FAILED', 'Cannot connect to the local browser.', 'not_submitted');
  }
}
