/** 登录状态只含短时流程信息；浏览器候选和凭据快照仅通过进程内/父子IPC传递。 */
import type { Config } from '../core/config.ts';
import type { CredentialStore, Session } from '../../studio/auth/credentials.ts';
import { TripoError } from '../../studio/contracts/errors.ts';

export const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
export const loginStates = [
  'checking',
  'waiting_for_login',
  'verifying',
  'authenticated',
  'cancelled',
  'expired',
  'failed',
] as const;
export type LoginPhase = (typeof loginStates)[number];
export interface LoginStatus {
  /** Flow snapshots do not recheck the saved credential or the remote session. */
  scope: 'login_flow' | 'verified_session';
  credential_store_check: 'not_checked' | 'verified';
  studio_session_check: 'not_checked' | 'verified';
  login_id?: string;
  profile: string;
  status: LoginPhase;
  authenticated: boolean;
  login_required: boolean;
  login_url?: string;
  started_at: string;
  expires_at: string;
  account_ref?: string;
  renewable?: boolean;
  session_expires_at?: string;
  balance?: number;
  wait_timeout?: boolean;
  error?: { code: string; message: string };
}
export interface LoginOptions {
  config?: Config;
  wait?: boolean;
  open?: boolean;
  force?: boolean;
  timeoutMs?: number;
  expectedAccountRef?: string;
  signal?: AbortSignal;
  onStatus?: (status: LoginStatus) => void;
  executablePath?: string;
  cdpEndpoint?: string;
}
export interface BrowserLoginOptions {
  signal: AbortSignal;
  timeoutMs: number;
  onWaiting?: () => void;
  accept: (candidate: Session, signal?: AbortSignal) => Promise<boolean>;
  executablePath?: string;
  cdpEndpoint?: string;
  initialSession?: Session;
}
export interface VerifiedLogin {
  session: Session;
  result: Record<string, unknown>;
}
export interface LoginRuntime {
  store: CredentialStore;
  browser: (options: BrowserLoginOptions) => Promise<void>;
  verify: (candidate: string | Session) => Promise<VerifiedLogin>;
  launch?: (start: BrokerStart) => Promise<void>;
}
export interface BrokerStart {
  config: Config;
  loginId: string;
  expected?: Session;
  expectedAccountRef?: string;
  open: boolean;
  executablePath?: string;
  cdpEndpoint?: string;
}
/** 私有磁盘状态中的随机IPC能力不是Studio凭据，不通过公共状态暴露。 */
export interface LoginState {
  version: 1;
  profile: string;
  login_id: string;
  status: LoginPhase;
  started_at: string;
  expires_at: string;
  pid: number;
  port?: number;
  nonce: string;
  control: string;
  account_ref?: string;
  renewable?: boolean;
  session_expires_at?: string;
  balance?: number;
  error?: { code: string; message: string };
}
export function activeLogin(status: LoginPhase): boolean {
  return ['checking', 'waiting_for_login', 'verifying'].includes(status);
}
export function loginTimeout(value = LOGIN_TIMEOUT_MS): number {
  if (!Number.isFinite(value) || value <= 0)
    throw new TripoError('INVALID_INPUT', 'Login timeout must be positive.');
  return Math.max(1, Math.min(Math.floor(value), LOGIN_TIMEOUT_MS));
}
