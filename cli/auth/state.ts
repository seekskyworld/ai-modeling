/** 每个profile独立短时状态和互斥锁；原始Cookie/Token/浏览器端点/业务命令不落盘。 */
import { constants } from 'node:fs';
import { lstat, open, writeFile, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import type { Config } from '../core/config.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import { privateAuthDirectory } from '../../studio/auth/control-directory.ts';
import {
  protectPrivateWindowsPath,
  verifyPrivateWindowsPath,
} from '../../studio/auth/windows-permissions.ts';
import { loginStates, type LoginState, type LoginStatus } from './types.ts';

export async function loginStateFile(config: Config): Promise<string> {
  // 凭据身份只按OS用户/profile划分；不同dataDir也必须共享撤销，避免空会话ABA覆盖。
  const directory = privateAuthDirectory('login-sessions');
  const key = createHash('sha256').update(config.credentialProfile).digest('hex');
  return path.join(directory, key + '.json');
}
function valid(state: LoginState, config: Config): boolean {
  return (
    state.version === 1 &&
    state.profile === config.credentialProfile &&
    /^[a-f0-9-]{36}$/.test(state.login_id) &&
    loginStates.includes(state.status) &&
    Number.isSafeInteger(state.pid) &&
    state.pid > 0 &&
    /^[a-f0-9]{64}$/.test(state.nonce) &&
    /^[a-f0-9]{64}$/.test(state.control) &&
    Number.isFinite(Date.parse(state.started_at)) &&
    Number.isFinite(Date.parse(state.expires_at)) &&
    (state.port === undefined || (Number.isInteger(state.port) && state.port > 0 && state.port <= 65535))
  );
}
export async function readState(config: Config): Promise<LoginState | undefined> {
  const file = await loginStateFile(config);
  let handle;
  try {
    const initial = await lstat(file);
    if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1)
      throw new TripoError('LOGIN_STATE_INVALID', 'Login state must be a private regular file.');
    // Older versions created login-control metadata with inherited Windows permissions.
    // Narrow this owned control file before reading it; credential records and import files remain read-only checks.
    if (process.platform === 'win32') protectPrivateWindowsPath(file, 'file');
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.dev !== initial.dev ||
      info.ino !== initial.ino ||
      info.size > 16384 ||
      (process.platform !== 'win32' && info.mode & 0o077) ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new TripoError('LOGIN_STATE_INVALID', 'Login state must be a private regular file.');
    const state = JSON.parse(await handle.readFile('utf8')) as LoginState;
    if (process.platform === 'win32') verifyPrivateWindowsPath(file, 'file');
    if (!valid(state, config)) throw new Error('Invalid login state');
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    if (error instanceof TripoError) throw error;
    throw new TripoError('LOGIN_STATE_INVALID', 'Cannot read the private login state.');
  } finally {
    await handle?.close();
  }
}
/** 仅在profile互斥锁内调用；临时文件原子替换，避免观察到半写状态。 */
export async function writeState(config: Config, state: LoginState): Promise<void> {
  const file = await loginStateFile(config),
    temporary = file + '.' + randomUUID() + '.part';
  try {
    await writeFile(temporary, JSON.stringify(state) + '\n', { mode: 0o600, flag: 'wx' });
    if (process.platform === 'win32') protectPrivateWindowsPath(temporary, 'file');
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
// Windows ACL checks are synchronous and individually bounded at 10 seconds. A login commit
// can perform several checks while the event-loop heartbeat is paused. Keep the lease beyond
// that bounded critical section so another process cannot steal it and undo a completed logout.
export const loginLockStaleMs = 180000;
export async function withLoginLock<T>(config: Config, action: () => Promise<T>): Promise<T> {
  const file = await loginStateFile(config);
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(file, {
      realpath: false,
      stale: loginLockStaleMs,
      update: 2000,
      retries: { retries: 40, minTimeout: 20, maxTimeout: 100 },
    });
  } catch {
    throw new TripoError(
      'CREDENTIAL_STORE_BUSY',
      'Authentication for this profile is being updated by another process. Retry the original action.',
      'not_submitted',
    );
  }
  try {
    return await action();
  } finally {
    await release();
  }
}
export function loginStatus(state: LoginState): LoginStatus {
  return {
    scope: 'login_flow',
    credential_store_check: 'not_checked',
    studio_session_check: 'not_checked',
    login_id: state.login_id,
    profile: state.profile,
    status: state.status,
    authenticated: state.status === 'authenticated',
    login_required: state.status !== 'authenticated',
    ...(state.port ? { login_url: `http://127.0.0.1:${state.port}/${state.nonce}` } : {}),
    started_at: state.started_at,
    expires_at: state.expires_at,
    ...(state.account_ref ? { account_ref: state.account_ref } : {}),
    ...(typeof state.renewable === 'boolean' ? { renewable: state.renewable } : {}),
    ...(state.session_expires_at ? { session_expires_at: state.session_expires_at } : {}),
    ...(typeof state.balance === 'number' && Number.isFinite(state.balance)
      ? { balance: state.balance }
      : {}),
    ...(state.error ? { error: safeLoginError(state.error) } : {}),
  };
}
export function safeLoginError(error: unknown): { code: string; message: string } {
  const code =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[A-Z_]{2,64}$/.test(error.code)
      ? error.code
      : 'LOGIN_FAILED';
  const messages: Record<string, string> = {
    LOGIN_CANCELLED: 'Login was cancelled.',
    LOGIN_EXPIRED: 'The login flow expired.',
    LOGIN_BROKER_UNAVAILABLE: 'The login coordinator stopped; start a new login flow.',
    ACCOUNT_MISMATCH: 'The login account differs from the original account.',
    SESSION_CHANGED: 'The saved session or active login changed; the newer session was preserved.',
    CREDENTIAL_STORE_UNAVAILABLE:
      "Cannot access private JSON credentials. Check the current OS user's .ai-modeling-auth directory and file permissions, then retry the original command.",
    CREDENTIAL_STORE_INVALID:
      'The private JSON credential file is invalid. Restore a valid private file or sign in again after resolving the storage error.',
    CREDENTIAL_STORE_BUSY:
      'Another process is updating the private JSON credentials. Retry the original command.',
    AUTH_DIRECTORY_INVALID:
      'Authentication storage must be a private directory owned by the current OS user.',
  };
  return {
    code,
    message: messages[code] ?? 'Login could not finish; check the reported error code and retry.',
  };
}
