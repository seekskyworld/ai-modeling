/** 登录窗口只是候选来源；只有调用方验证且原子接受后才报告完成。 */
import { parseCredential, type Session } from './credentials.ts';
import { TripoError } from '../contracts/errors.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { playwrightLoginRuntime } from './browser-login-runtime.ts';
import {
  boundedCleanup,
  studioSessionUrls,
  type BrowserLoginCookie,
  type BrowserLoginOptions,
  type BrowserLoginRuntime,
  type BrowserLoginWindow,
} from './browser-login-types.ts';
export type { BrowserLoginOptions } from './browser-login-types.ts';

const failureMessages: Record<string, string> = {
  LOGIN_CANCELLED: 'Studio browser login was cancelled.',
  LOGIN_TIMEOUT: 'Studio browser login timed out.',
  BROWSER_NOT_FOUND:
    'Install Chrome or Edge, or choose an explicit browser executable or local CDP endpoint.',
  INVALID_INPUT: 'Browser login options are invalid.',
  AUTH_REQUIRED: 'Studio has not accepted the login session.',
  ACCOUNT_MISMATCH: 'The browser login belongs to a different account.',
  SESSION_CHANGED: 'The saved Studio session changed during login.',
  CREDENTIAL_STORE_UNAVAILABLE:
    'Unlock the OS credential store and allow ai-modeling (Node.js) access when prompted, then retry the original command.',
  CREDENTIAL_STORE_BUSY: 'Another process is updating the Studio session.',
  NETWORK_ERROR: 'Studio login verification could not reach the service.',
};

/** 第三方异常可能含 CDP 地址、Cookie 或页面内容，只保留稳定分类。 */
function loginError(error: unknown): TripoError {
  const code =
    error instanceof TripoError && /^[A-Z][A-Z_]{0,63}$/.test(error.code)
      ? error.code
      : 'BROWSER_LOGIN_FAILED';
  return new TripoError(
    code,
    failureMessages[code] ?? 'Studio browser login could not be completed.',
    'not_submitted',
  );
}

function applicableCookie(cookie: BrowserLoginCookie): boolean {
  if (cookie.name !== 'ory_kratos_session' || !cookie.secure) return false;
  if (cookie.expires > 0 && cookie.expires <= Date.now() / 1000) return false;
  const domain = cookie.domain.replace(/^\./, '').toLowerCase();
  if (!domain || !cookie.path.startsWith('/')) return false;
  return studioSessionUrls.some((url) => {
    const target = new URL(url);
    const domainMatches = target.hostname === domain || target.hostname.endsWith(`.${domain}`);
    const pathMatches =
      target.pathname === cookie.path ||
      target.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`);
    return domainMatches && pathMatches && (domain === 'tripo3d.ai' || domain.endsWith('.tripo3d.ai'));
  });
}

function cookieCandidate(cookie: BrowserLoginCookie, initialSession?: Session): Session | undefined {
  if (!applicableCookie(cookie)) return;
  try {
    const candidate = parseCredential(JSON.stringify({ cookie: cookie.value }));
    if (initialSession?.deviceId) candidate.deviceId = initialSession.deviceId;
    return candidate;
  } catch {
    return;
  }
}

function loginLifecycle(signal: AbortSignal, timeoutMs: number) {
  const controller = new AbortController();
  const stop = (code: string) =>
    controller.abort(new TripoError(code, failureMessages[code]!, 'not_submitted'));
  const cancel = () => stop('LOGIN_CANCELLED');
  const timer = setTimeout(() => stop('LOGIN_TIMEOUT'), timeoutMs);
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const interrupted = new Promise<never>((_resolve, reject) => {
    if (controller.signal.aborted) reject(controller.signal.reason);
    else controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
  });
  // 启动前就取消时也必须立即安装拒绝处理，不能产生未处理的 Promise rejection。
  void interrupted.catch(() => undefined);
  return {
    signal: controller.signal,
    stop,
    wait: <T>(work: Promise<T>): Promise<T> => Promise.race([work, interrupted]),
    check: () => controller.signal.throwIfAborted(),
    finish: () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
    },
  };
}

async function inspectCandidates(
  window: BrowserLoginWindow,
  options: BrowserLoginOptions,
  lifecycle: ReturnType<typeof loginLifecycle>,
  attempts: Map<string, number>,
): Promise<boolean> {
  const cookies = await lifecycle.wait(window.cookies());
  for (const cookie of cookies) {
    lifecycle.check();
    const candidate = cookieCandidate(cookie, options.initialSession);
    if (!candidate || Date.now() - (attempts.get(cookie.value) ?? 0) < 2000) continue;
    // Cookie 可能先于服务端完成认证；限速复验同一候选，不能忙循环请求 whoami。
    if (attempts.size >= 32 && !attempts.has(cookie.value)) attempts.delete(attempts.keys().next().value!);
    attempts.set(cookie.value, Date.now());
    const accepted = await lifecycle.wait(options.accept(candidate, lifecycle.signal));
    lifecycle.check();
    if (accepted) return true;
  }
  return false;
}

export async function runBrowserLogin(
  options: BrowserLoginOptions,
  runtime: BrowserLoginRuntime = playwrightLoginRuntime,
): Promise<void> {
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > 15 * 60 * 1000 ||
    (options.executablePath && options.cdpEndpoint)
  ) {
    throw loginError(new TripoError('INVALID_INPUT', 'Invalid browser login options.'));
  }
  const lifecycle = loginLifecycle(options.signal, options.timeoutMs);
  let window: BrowserLoginWindow | undefined;
  let removeClosed: (() => void) | undefined;
  const attempts = new Map<string, number>();
  try {
    lifecycle.check();
    const opening = runtime.open({ ...options, signal: lifecycle.signal });
    // 连接或启动刚好晚于取消返回时，仍回收刚取得的自有资源。
    void opening.then(
      (late) => {
        if (lifecycle.signal.aborted && window !== late)
          void boundedCleanup(Promise.resolve().then(() => late.close()));
      },
      () => undefined,
    );
    window = await lifecycle.wait(opening);
    removeClosed = window.onClosed(() => lifecycle.stop('LOGIN_CANCELLED'));
    if (window.isClosed()) lifecycle.stop('LOGIN_CANCELLED');
    lifecycle.check();
    options.onWaiting?.();
    await lifecycle.wait(window.navigate(Math.min(options.timeoutMs, 30000)));
    while (true) {
      lifecycle.check();
      if (await inspectCandidates(window, options, lifecycle, attempts)) return;
      await lifecycle.wait(delay(250, undefined, { signal: lifecycle.signal }));
    }
  } catch (error) {
    throw loginError(error);
  } finally {
    removeClosed?.();
    lifecycle.finish();
    attempts.clear();
    if (window) await boundedCleanup(Promise.resolve().then(() => window!.close()));
  }
}
