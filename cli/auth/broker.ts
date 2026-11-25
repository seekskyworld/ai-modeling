/** 短时受控登录：互斥状态+原凭据CAS共同约束迟到候选，退出/取消不会被旧窗口覆盖。 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import type { Session } from '../../studio/auth/credentials.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import { readState, writeState, withLoginLock, loginStatus, safeLoginError } from './state.ts';
import {
  activeLogin,
  type BrokerStart,
  type LoginRuntime,
  type LoginState,
  type LoginPhase,
} from './types.ts';
import { loginPage } from './page.ts';

export function sameLoginAccount(expected: string | undefined, session: Session): void {
  if (!session.accountRef || (expected && session.accountRef !== expected))
    throw new TripoError(
      'ACCOUNT_MISMATCH',
      'The login account differs from the original account.',
      'not_submitted',
    );
}
export function saveLogin(runtime: LoginRuntime, expected: Session | undefined, next: Session): void {
  if (!runtime.store.saveIfUnchanged)
    throw new TripoError('CREDENTIAL_STORE_UNAVAILABLE', 'Atomic credential saving is required.');
  if (!runtime.store.saveIfUnchanged(expected, next))
    throw new TripoError(
      'SESSION_CHANGED',
      'The saved session changed; the newer session was preserved.',
      'not_submitted',
    );
}
export async function withLoginSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  // work可能已经开始；即使信号先到，也要观察其迟到拒绝，不能产生未处理异常。
  void work.catch(() => undefined);
  const interruption = (): TripoError =>
    signal.reason instanceof TripoError
      ? signal.reason
      : new TripoError(
          signal.reason?.name === 'TimeoutError' ? 'LOGIN_TIMEOUT' : 'LOGIN_CANCELLED',
          signal.reason?.name === 'TimeoutError' ? 'Login verification timed out.' : 'Login was cancelled.',
        );
  if (signal.aborted) throw interruption();
  return await new Promise((resolve, reject) => {
    const abort = () => reject(interruption());
    signal.addEventListener('abort', abort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort))
      .catch(() => undefined);
  });
}
export async function startLoginBroker(
  start: BrokerStart,
  runtime: LoginRuntime,
): Promise<{
  closed: Promise<void>;
  close: () => Promise<void>;
}> {
  const { config } = start,
    controller = new AbortController();
  const initial = await readState(config);
  if (!initial || initial.login_id !== start.loginId || !activeLogin(initial.status))
    throw new TripoError('SESSION_CHANGED', 'The active login changed before startup.');
  let state = initial,
    running = false,
    closing = false;
  const writes = new Set<Promise<unknown>>();
  let browserWork: Promise<void> | undefined;
  const tracked = <T>(work: Promise<T>): Promise<T> => {
    writes.add(work);
    void work.then(
      () => writes.delete(work),
      () => writes.delete(work),
    );
    return work;
  };
  let complete!: () => void;
  const closed = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const current = async (): Promise<LoginState> => {
    const saved = await readState(config);
    if (!saved || saved.login_id !== start.loginId || !activeLogin(saved.status) || controller.signal.aborted)
      throw new TripoError('SESSION_CHANGED', 'The active login changed.');
    if (Date.parse(saved.expires_at) <= Date.now()) throw new TripoError('LOGIN_EXPIRED', 'Login expired.');
    if (!isDeepStrictEqual(runtime.store.load(), start.expected))
      throw new TripoError('SESSION_CHANGED', 'The stored session changed.');
    return saved;
  };
  const update = async (phase: LoginPhase, error?: unknown): Promise<void> => {
    if (closing) return;
    await tracked(
      withLoginLock(config, async () => {
        const saved = await readState(config);
        if (closing || !saved || saved.login_id !== start.loginId || !activeLogin(saved.status)) return;
        state = { ...saved, status: phase, ...(error ? { error: safeLoginError(error) } : {}) };
        await writeState(config, state);
      }),
    );
  };
  const close = async (): Promise<void> => {
    if (closing) return await closed;
    closing = true;
    controller.abort();
    clearInterval(monitor);
    clearTimeout(deadline);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.allSettled([...writes]);
    if (browserWork) {
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          browserWork,
          new Promise<void>((resolve) => {
            cleanupTimer = setTimeout(resolve, 2000);
          }),
        ]);
      } finally {
        clearTimeout(cleanupTimer);
      }
    }
    complete();
  };
  const finish = async (phase: LoginPhase, error?: unknown): Promise<void> => {
    await update(phase, error);
    controller.abort();
    const remaining = Math.max(0, Date.parse(state.expires_at) - Date.now());
    setTimeout(() => void close(), Math.min(700, remaining)).unref();
  };
  const accept = async (candidate: Session, browserSignal?: AbortSignal): Promise<boolean> => {
    const acceptingSignal = browserSignal
      ? AbortSignal.any([browserSignal, controller.signal])
      : controller.signal;
    try {
      await tracked(
        withLoginLock(config, async () => {
          state = { ...(await current()), status: 'verifying' };
          await writeState(config, state);
        }),
      );
      if (acceptingSignal.aborted)
        throw new TripoError('LOGIN_CANCELLED', 'Login browser closed or was cancelled.');
      const verified = await withLoginSignal(runtime.verify(candidate), acceptingSignal);
      await tracked(
        withLoginLock(config, async () => {
          const saved = await current();
          if (acceptingSignal.aborted)
            throw new TripoError('LOGIN_CANCELLED', 'Login browser closed or was cancelled.');
          sameLoginAccount(start.expectedAccountRef ?? start.expected?.accountRef, verified.session);
          saveLogin(runtime, start.expected, verified.session);
          state = {
            ...saved,
            status: 'authenticated',
            account_ref: verified.session.accountRef,
            renewable: Boolean(verified.session.cookie),
            session_expires_at: verified.session.expiresAt,
            ...(typeof verified.result.balance === 'number' ? { balance: verified.result.balance } : {}),
          };
          delete state.error;
          await writeState(config, state);
        }),
      );
      setTimeout(() => void close(), 700).unref();
      return true;
    } catch (error) {
      if (error instanceof TripoError && error.code === 'AUTH_REQUIRED' && !controller.signal.aborted) {
        await update('waiting_for_login');
        return false;
      }
      await finish(failurePhase(error), error);
      throw error;
    }
  };
  const launch = (): void => {
    if (running || closing || !activeLogin(state.status)) return;
    running = true;
    browserWork = runtime
      .browser({
        signal: controller.signal,
        timeoutMs: Math.max(1, Date.parse(state.expires_at) - Date.now()),
        executablePath: start.executablePath,
        cdpEndpoint: start.cdpEndpoint,
        initialSession: start.expected,
        onWaiting: () => {
          void update('waiting_for_login').catch(() => finish('failed'));
        },
        accept,
      })
      .then(async () => {
        if (activeLogin(state.status))
          await finish('failed', new TripoError('LOGIN_BROWSER_CLOSED', 'Login browser closed.'));
      })
      .catch(async (error) => {
        if (activeLogin(state.status)) await finish(failurePhase(error), error);
      });
  };
  let origin = '';
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${state.nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'`,
    );
    if (req.headers.host !== new URL(origin).host) {
      res.writeHead(403).end();
      return;
    }
    const endpoint = req.url ?? '';
    if (req.method === 'GET' && endpoint === `/${state.nonce}`) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(loginPage(state.nonce));
      return;
    }
    if (req.method === 'GET' && endpoint === `/${state.nonce}/status`) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(loginStatus(state)));
      return;
    }
    if (req.method === 'POST' && endpoint === `/${state.nonce}/start` && req.headers.origin === origin) {
      launch();
      res.writeHead(303, { Location: `/${state.nonce}` }).end();
      return;
    }
    if (
      req.method !== 'POST' ||
      endpoint !== '/control' ||
      req.headers['x-ai-modeling-login'] !== state.control ||
      (req.headers.origin !== undefined && req.headers.origin !== origin)
    ) {
      res.writeHead(403).end();
      return;
    }
    const body = await controlBody(req);
    if (body.login_id !== start.loginId) {
      res.writeHead(403).end();
      return;
    }
    if (body.action === 'cancel')
      await finish('cancelled', new TripoError('LOGIN_CANCELLED', 'Login cancelled.'));
    else if (body.action === 'start') launch();
    else if (body.action !== 'status') {
      res.writeHead(400).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(loginStatus(state)));
  };
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new TripoError('LOGIN_BROKER_UNAVAILABLE', 'Login coordinator cannot listen.');
  origin = `http://127.0.0.1:${address.port}`;
  await withLoginLock(config, async () => {
    state = { ...(await current()), pid: process.pid, port: address.port, status: 'waiting_for_login' };
    await writeState(config, state);
  }).catch((error) => {
    server.closeAllConnections();
    server.close();
    throw error;
  });
  const deadline = setTimeout(
    () => {
      void finish('expired', new TripoError('LOGIN_EXPIRED', 'Login expired.'));
    },
    Math.max(1, Date.parse(state.expires_at) - Date.now()),
  );
  let monitoring = false;
  const monitor = setInterval(() => {
    // Native Windows permission checks may outlast a poll interval. Keep at most one
    // revocation read in flight so synchronous ACL work cannot accumulate behind it.
    if (closing || monitoring) return;
    monitoring = true;
    void readState(config)
      .then(async (saved) => {
        if (closing) return;
        if (!saved || saved.login_id !== start.loginId) {
          await close();
          return;
        }
        if (!activeLogin(saved.status) && activeLogin(state.status)) {
          state = saved;
          await close();
        }
      })
      .catch(() => close())
      .finally(() => {
        monitoring = false;
      });
  }, 250);
  monitor.unref();
  if (start.open) launch();
  return { closed, close };
}
function failurePhase(error: unknown): LoginPhase {
  const code = safeLoginError(error).code;
  if (['LOGIN_TIMEOUT', 'LOGIN_EXPIRED'].includes(code)) return 'expired';
  return code === 'LOGIN_CANCELLED' ? 'cancelled' : 'failed';
}
async function controlBody(req: IncomingMessage): Promise<{ login_id?: string; action?: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024) throw Error('Oversized control request');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
