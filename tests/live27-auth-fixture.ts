/** 登录接续的子进程替身仅存在于测试，真实 CLI/MCP 仍负责解析和输出。 */
import { appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers.ts';
import { TripoError } from '../studio/contracts/errors.ts';
import type { LoginOptions, LoginStatus } from '../cli/auth/types.ts';

export function record(kind: string, values: Record<string, unknown> = {}): void {
  appendFileSync(process.env.LIVE27_TRACE!, JSON.stringify({ kind, ...values }) + '\n');
}
export const loginId = '22222222-2222-4222-8222-222222222222';
function loginComplete(): boolean {
  return (
    process.env.LIVE27_CASE === 'resume' &&
    existsSync(path.join(process.env.AI_MODELING_DATA_DIR!, 'login-complete'))
  );
}
export function pending(): LoginStatus {
  return {
    scope: 'login_flow',
    credential_store_check: 'not_checked',
    studio_session_check: 'not_checked',
    login_id: loginId,
    profile: 'live27-isolated',
    status: 'waiting_for_login',
    authenticated: false,
    login_required: true,
    login_url: 'http://127.0.0.1:1/controlled-local-login',
    started_at: '2026-11-16T00:00:00Z',
    expires_at: '2026-11-16T00:15:00Z',
  };
}
export async function ensureLogin(options: LoginOptions = {}): Promise<LoginStatus> {
  record('ensure-login', { wait: options.wait, open: options.open, expected: options.expectedAccountRef });
  const status = pending();
  options.onStatus?.(status);
  // CliBridge 必须丢弃 stderr，stdout 只保留 CLI 的一个 JSON 文档。
  process.stderr.write('controlled login diagnostic\n');
  return status;
}
export async function beginLogin(options: LoginOptions = {}): Promise<LoginStatus> {
  record('begin-login', { open: options.open, wait: options.wait });
  return pending();
}
export async function readLogin(id?: string): Promise<LoginStatus> {
  record('read-login', { login_id: id });
  if (loginComplete())
    return { ...pending(), status: 'authenticated', authenticated: true, login_required: false };
  return pending();
}
export async function waitLogin(id: string, options: LoginOptions = {}): Promise<LoginStatus> {
  record('wait-login', { login_id: id, timeoutMs: options.timeoutMs });
  return { ...pending(), wait_timeout: true };
}
export async function cancelLogin(id?: string): Promise<LoginStatus> {
  record('cancel-login', { login_id: id });
  return { ...pending(), status: 'cancelled' };
}
export async function logoutLogin(): Promise<{ signed_out_locally: true }> {
  record('logout-login');
  return { signed_out_locally: true };
}
export async function createApplication() {
  record('create-application');
  const f = await fixture(process.env.AI_MODELING_DATA_DIR);
  if (process.env.LIVE27_CASE !== 'late_auth' && process.env.LIVE27_CASE !== 'hold' && !loginComplete())
    f.service.credentials.clear();
  const submit = f.gateway.submit.bind(f.gateway);
  f.gateway.submit = async (job) => {
    record('business-submit');
    if (loginComplete()) return await submit(job);
    throw new Error('Unexpected business submit');
  };
  const quote = f.service.pricing.quote.bind(f.service.pricing);
  f.service.pricing.quote = async (operation, input) => {
    record('business-quote');
    if (loginComplete()) return await quote(operation, input);
    throw new TripoError('AUTH_REQUIRED', 'Controlled late authentication boundary.', 'not_submitted', {
      login: pending(),
      resume: { checkpoint: 'before_request', replay_submitted_writes: false },
    });
  };
  f.gateway.account = async () => {
    record('business-account');
    if (process.env.LIVE27_CASE === 'hold') await new Promise(() => setInterval(() => {}, 1000));
    return { authenticated: true, balance: 100 };
  };
  return {
    service: f.service,
    studio: {
      assets: async () => ({ assets: [] }),
      client: {
        request: async () => {
          throw new Error('Unexpected Studio read');
        },
      },
    },
    close: () => f.jobs.close(),
  };
}
