/** 显式粘贴入口也绑定本次流程；异步校验不允许跨logout或新登录覆盖会话。 */
import { randomBytes, randomUUID } from 'node:crypto';
import { configFromEnv } from '../core/config.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import type { Session } from '../../studio/auth/credentials.ts';
import { defaultLoginRuntime } from './runtime.ts';
import { activeLogin, loginTimeout, type LoginOptions, type LoginRuntime, type LoginState } from './types.ts';
import { withLoginLock, readState, writeState, safeLoginError } from './state.ts';
import { saveLogin, sameLoginAccount, withLoginSignal } from './broker.ts';

export async function manualLogin(
  options: LoginOptions = {},
  injected?: LoginRuntime,
): Promise<{
  accept: (input: string) => Promise<Record<string, unknown>>;
}> {
  if (options.signal?.aborted)
    throw new TripoError('LOGIN_CANCELLED', 'Manual login was cancelled before startup.');
  const config = options.config ?? configFromEnv(),
    runtime = injected ?? defaultLoginRuntime(config);
  const id = randomUUID();
  let expected: Session | undefined;
  const timeout = loginTimeout(options.timeoutMs),
    deadline = Date.now() + timeout;
  const state: LoginState = {
    version: 1,
    profile: config.credentialProfile,
    login_id: id,
    status: 'verifying',
    started_at: new Date().toISOString(),
    expires_at: new Date(deadline).toISOString(),
    pid: process.pid,
    nonce: randomBytes(32).toString('hex'),
    control: randomBytes(32).toString('hex'),
  };
  await withLoginLock(config, async () => {
    expected = structuredClone(runtime.store.load());
    await writeState(config, state);
  });
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)])
    : AbortSignal.timeout(timeout);
  return {
    accept: async (input) => {
      try {
        if (signal.aborted) throw new TripoError('LOGIN_EXPIRED', 'Manual login expired.');
        const verified = await withLoginSignal(runtime.verify(input), signal);
        // 手动导入沿用显式切换账号语义；业务恢复传expectedAccountRef时仍严格同号。
        sameLoginAccount(options.expectedAccountRef, verified.session);
        await withLoginLock(config, async () => {
          const current = await readState(config);
          if (!current || current.login_id !== id || !activeLogin(current.status) || signal.aborted)
            throw new TripoError('SESSION_CHANGED', 'The active login changed before manual import.');
          saveLogin(runtime, expected, verified.session);
          const saved: LoginState = {
            ...current,
            status: 'authenticated',
            account_ref: verified.session.accountRef,
            renewable: Boolean(verified.session.cookie),
            session_expires_at: verified.session.expiresAt,
          };
          delete saved.error;
          await writeState(config, saved);
        });
        return verified.result;
      } catch (error) {
        await withLoginLock(config, async () => {
          const current = await readState(config);
          if (current?.login_id === id && activeLogin(current.status)) {
            const expired = Date.now() >= deadline;
            await writeState(config, {
              ...current,
              status: expired
                ? 'expired'
                : error instanceof TripoError && ['INVALID_CREDENTIAL', 'AUTH_REQUIRED'].includes(error.code)
                  ? 'waiting_for_login'
                  : 'failed',
              error: safeLoginError(expired ? { code: 'LOGIN_EXPIRED' } : error),
            });
          }
        });
        throw error;
      }
    },
  };
}
