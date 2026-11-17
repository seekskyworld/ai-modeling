/** CLI 的交互策略注入网页客户端；不重跑业务入口，也不把登录状态当成提交回执。 */
import type { Config } from '../core/config.ts';
import type { CredentialStore } from '../../studio/auth/credentials.ts';
import type { AuthenticationHandler } from '../../studio/api/client.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import { ensureLogin } from './coordinator.ts';

export function authenticationHandler(config: Config, credentials: CredentialStore): AuthenticationHandler {
  return async ({ error, expectedAccountRef, phase }) => {
    const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
    const expected = expectedAccountRef ?? credentials.load()?.accountRef;
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    if (interactive) process.once('SIGINT', cancel);
    let announced = false;
    try {
      const status = await ensureLogin({
        config,
        expectedAccountRef: expected,
        force: true,
        wait: interactive,
        open: interactive,
        signal: controller.signal,
        onStatus: (value) => {
          if (interactive && !announced && value.login_required) {
            announced = true;
            process.stderr.write('请在打开的 Tripo 页面完成登录，完成后命令将自动继续。\n');
            if (value.login_url) process.stderr.write(value.login_url + '\n');
          }
        },
      });
      if (status.authenticated) return;
      throw new TripoError(
        'AUTH_REQUIRED',
        'Complete browser login, then resume the original request or job.',
        error.certainty,
        {
          ...error.details,
          login: status,
          resume: { checkpoint: phase, replay_submitted_writes: false },
        },
      );
    } finally {
      process.removeListener('SIGINT', cancel);
    }
  };
}

/** 同步账号守卫执行前，仅补齐缺失会话；已有会话由真实请求按需续期/验证。 */
export async function prepareAuthentication(config: Config, credentials: CredentialStore): Promise<void> {
  if (credentials.load()?.accountRef) return;
  await authenticationHandler(
    config,
    credentials,
  )({
    error: new TripoError('AUTH_REQUIRED', 'Sign in to Studio before continuing.', 'not_submitted'),
    phase: 'before_request',
  });
}
