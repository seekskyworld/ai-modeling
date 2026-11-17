/** CLI/MCP共用有期限的单profile登录；等待只影响本次调用，不重放业务命令。 */
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { configFromEnv } from '../core/config.ts';
import { resolveLoginBrowserOptions } from './browser-options.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import type { Session } from '../../studio/auth/credentials.ts';
import { readState, writeState, withLoginLock, loginStatus, safeLoginError } from './state.ts';
import { contactBroker } from './transport.ts';
import { defaultLoginRuntime } from './runtime.ts';
import { launchLoginDaemon } from './daemon.ts';
import { sameLoginAccount, saveLogin, startLoginBroker, withLoginSignal } from './broker.ts';
import {
  activeLogin,
  loginTimeout,
  type LoginOptions,
  type LoginRuntime,
  type LoginState,
  type LoginStatus,
} from './types.ts';
export type { LoginOptions, LoginRuntime, LoginStatus } from './types.ts';

function assertAccount(options: LoginOptions, session: Session | undefined): void {
  if (options.expectedAccountRef && session?.accountRef && options.expectedAccountRef !== session.accountRef)
    throw new TripoError(
      'ACCOUNT_MISMATCH',
      'The saved session differs from the original task account.',
      'not_submitted',
    );
}
function assertStarted(options: LoginOptions): void {
  if (options.signal?.aborted)
    throw new TripoError('LOGIN_CANCELLED', 'Login was cancelled before startup.', 'not_submitted');
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
async function terminal(
  options: LoginOptions,
  id: string,
  phase: 'expired' | 'failed',
  code: string,
): Promise<LoginState> {
  const config = options.config ?? configFromEnv();
  return await withLoginLock(config, async () => {
    const state = await readState(config);
    if (!state || state.login_id !== id)
      throw new TripoError('LOGIN_NOT_FOUND', 'The login flow no longer exists.');
    if (!activeLogin(state.status)) return state;
    const next = { ...state, status: phase, error: safeLoginError({ code }) };
    await writeState(config, next);
    return next;
  });
}
export async function readLogin(loginId?: string, options: LoginOptions = {}): Promise<LoginStatus> {
  const config = options.config ?? configFromEnv();
  let state = await readState(config);
  if (!state || (loginId && state.login_id !== loginId))
    throw new TripoError(
      'LOGIN_NOT_FOUND',
      'No matching login flow exists for this profile.',
      'not_submitted',
    );
  if (activeLogin(state.status)) {
    if (Date.parse(state.expires_at) <= Date.now())
      state = await terminal(options, state.login_id, 'expired', 'LOGIN_EXPIRED');
    else if (!alive(state.pid))
      state = await terminal(options, state.login_id, 'failed', 'LOGIN_BROKER_UNAVAILABLE');
    else if (state.port) {
      try {
        await contactBroker(state, 'status');
      } catch {
        state = await terminal(options, state.login_id, 'failed', 'LOGIN_BROKER_UNAVAILABLE');
      }
    } else if (state.status === 'checking' && Date.now() - Date.parse(state.started_at) > 10000)
      state = await terminal(options, state.login_id, 'failed', 'LOGIN_BROKER_UNAVAILABLE');
  }
  const status = loginStatus(state);
  if (status.authenticated && options.expectedAccountRef && status.account_ref !== options.expectedAccountRef)
    throw new TripoError(
      'ACCOUNT_MISMATCH',
      'The completed login differs from the original task account.',
      'not_submitted',
    );
  return status;
}
async function ready(id: string, options: LoginOptions): Promise<LoginStatus> {
  const until = Date.now() + 11000;
  for (;;) {
    const status = await readLogin(id, options);
    if (status.login_url || status.status === 'verifying' || !activeLogin(status.status)) return status;
    if (Date.now() >= until)
      throw new TripoError('LOGIN_BROKER_UNAVAILABLE', 'Login coordinator did not publish its local URL.');
    await delay(30);
  }
}
/** begin始终返回短时流程；已有活跃流程共享，显式force不会偷换另一个等待者的登录。 */
export async function beginLogin(options: LoginOptions = {}, injected?: LoginRuntime): Promise<LoginStatus> {
  const browserOptions = resolveLoginBrowserOptions(options);
  assertStarted(options);
  const config = options.config ?? configFromEnv(),
    runtime = injected ?? defaultLoginRuntime(config);
  const timeout = loginTimeout(options.timeoutMs);
  // 先诊断旧进程，但不读取账号或修改任何任务库。
  await readLogin(undefined, { ...options, config }).catch((error) => {
    if (!(error instanceof TripoError) || error.code !== 'LOGIN_NOT_FOUND') throw error;
  });
  const selection = await withLoginLock(config, async () => {
    const previous = await readState(config);
    if (previous && activeLogin(previous.status)) return { state: previous, owner: false };
    const expected = structuredClone(runtime.store.load());
    assertAccount(options, expected);
    const state: LoginState = {
      version: 1,
      profile: config.credentialProfile,
      login_id: randomUUID(),
      status: 'checking',
      started_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + timeout).toISOString(),
      pid: process.pid,
      nonce: randomBytes(32).toString('hex'),
      control: randomBytes(32).toString('hex'),
    };
    await writeState(config, state);
    return { state, owner: true, expected };
  });
  if (selection.owner) {
    if (options.signal?.aborted) return await cancelLogin(selection.state.login_id, { ...options, config });
    const start = {
      config,
      loginId: selection.state.login_id,
      expected: selection.expected,
      expectedAccountRef: options.expectedAccountRef,
      open: options.open ?? true,
      ...browserOptions,
    };
    try {
      if (runtime.launch) await runtime.launch(start);
      else if (injected) await startLoginBroker(start, runtime);
      else await launchLoginDaemon(start);
    } catch (error) {
      const failed = await terminal(
        { ...options, config },
        selection.state.login_id,
        'failed',
        safeLoginError(error).code,
      );
      return loginStatus(failed);
    }
  } else if (options.open !== false && selection.state.port) {
    await contactBroker(selection.state, 'start');
  }
  const status = await ready(selection.state.login_id, { ...options, config });
  if (options.signal?.aborted && activeLogin(status.status))
    return await cancelLogin(status.login_id, { ...options, config });
  return status;
}
/** timeoutMs仅限此次等待；MCP的30秒轮询不取消或延长整个15分钟流程。 */
export async function waitLogin(loginId: string, options: LoginOptions = {}): Promise<LoginStatus> {
  const until = Date.now() + loginTimeout(options.timeoutMs);
  let previous = '';
  for (;;) {
    if (options.signal?.aborted) return await cancelLogin(loginId, options);
    const status = await readLogin(loginId, options),
      encoded = JSON.stringify(status);
    if (encoded !== previous) {
      options.onStatus?.(status);
      previous = encoded;
    }
    if (!activeLogin(status.status)) return status;
    if (Date.now() >= until) return { ...status, wait_timeout: true };
    await delay(Math.min(200, Math.max(1, until - Date.now())));
  }
}
export async function cancelLogin(loginId?: string, options: LoginOptions = {}): Promise<LoginStatus> {
  const config = options.config ?? configFromEnv();
  const state = await withLoginLock(config, async () => {
    const current = await readState(config);
    if (!current || (loginId && current.login_id !== loginId))
      throw new TripoError('LOGIN_NOT_FOUND', 'No matching login flow exists.');
    if (!activeLogin(current.status)) return current;
    const next: LoginState = {
      ...current,
      status: 'cancelled',
      error: safeLoginError({ code: 'LOGIN_CANCELLED' }),
    };
    await writeState(config, next);
    return next;
  });
  if (state.port) await contactBroker(state, 'cancel').catch(() => undefined);
  return loginStatus(state);
}
/** logout与candidate提交使用同一锁；先撤销流程再清凭据，阻断空会话的ABA覆盖。 */
export async function logoutLogin(
  options: LoginOptions = {},
  injected?: LoginRuntime,
): Promise<{ signed_out_locally: true }> {
  const config = options.config ?? configFromEnv(),
    runtime = injected ?? defaultLoginRuntime(config);
  const old = await withLoginLock(config, async () => {
    const state = await readState(config);
    if (state && (activeLogin(state.status) || state.status === 'authenticated'))
      await writeState(config, {
        ...state,
        status: 'cancelled',
        renewable: false,
        error: safeLoginError({ code: 'LOGIN_CANCELLED' }),
      });
    runtime.store.clear();
    return state;
  });
  if (old?.port) await contactBroker(old, 'cancel').catch(() => undefined);
  return { signed_out_locally: true };
}
export async function ensureLogin(options: LoginOptions = {}, injected?: LoginRuntime): Promise<LoginStatus> {
  resolveLoginBrowserOptions(options);
  assertStarted(options);
  const config = options.config ?? configFromEnv(),
    runtime = injected ?? defaultLoginRuntime(config);
  const expected = structuredClone(runtime.store.load());
  assertAccount(options, expected);
  if (expected && !options.force) {
    try {
      return await verifiedExisting(expected, { ...options, config }, runtime);
    } catch (error) {
      if (!(error instanceof TripoError) || error.code !== 'AUTH_REQUIRED') throw error;
    }
  }
  const interactive = Boolean(process.stdin.isTTY),
    wait = options.wait ?? interactive;
  const status = await beginLogin({ ...options, config, open: options.open ?? interactive }, injected);
  options.onStatus?.(status);
  if (!wait || !activeLogin(status.status) || !status.login_id) return status;
  return await waitLogin(status.login_id, { ...options, config });
}
async function verifiedExisting(
  expected: Session,
  options: LoginOptions,
  runtime: LoginRuntime,
): Promise<LoginStatus> {
  const config = options.config!,
    timeout = AbortSignal.timeout(loginTimeout(options.timeoutMs));
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const verified = await withLoginSignal(runtime.verify(expected), signal);
  sameLoginAccount(options.expectedAccountRef ?? expected.accountRef, verified.session);
  await withLoginLock(config, async () => {
    if (signal.aborted) throw new TripoError('LOGIN_CANCELLED', 'Login verification cancelled.');
    saveLogin(runtime, expected, verified.session);
  });
  const now = new Date().toISOString();
  return {
    scope: 'verified_session',
    credential_store_check: 'verified',
    studio_session_check: 'verified',
    profile: config.credentialProfile,
    status: 'authenticated',
    authenticated: true,
    login_required: false,
    started_at: now,
    expires_at: now,
    account_ref: verified.session.accountRef,
    renewable: Boolean(verified.session.cookie),
    session_expires_at: verified.session.expiresAt,
    ...(typeof verified.result.balance === 'number' ? { balance: verified.result.balance } : {}),
  };
}
