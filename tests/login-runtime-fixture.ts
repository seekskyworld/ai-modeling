/** 仅子进程测试加载：所有会话均为固定假值，网络/真实浏览器/用户凭据完全不参与。 */
import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from '../cli/core/config.ts';
import type { LoginRuntime } from '../cli/auth/types.ts';
import type { Session } from '../studio/auth/credentials.ts';
export const fakeLoginSession: Session = {
  cookie: 'not-real-test-cookie-01234567890123456789',
  deviceId: 'test-device',
  accountRef: 'a'.repeat(24),
  importedAt: '2026-11-16T00:00:00Z',
};
export function defaultLoginRuntime(config: Config): LoginRuntime {
  const file = path.join(config.dataDir, 'fixture-credentials-' + config.credentialProfile + '.json');
  const load = (): Session | undefined =>
    existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
  const save = (session: Session) => writeFileSync(file, JSON.stringify(session), { mode: 0o600 });
  return {
    store: {
      load,
      save,
      saveIfUnchanged(expected, next) {
        if (!isDeepStrictEqual(load(), expected)) return false;
        save(next);
        return true;
      },
      clear() {
        if (existsSync(file)) unlinkSync(file);
      },
    },
    verify: async () => ({
      session: { ...fakeLoginSession },
      result: { authenticated: true, account_ref: fakeLoginSession.accountRef, balance: 10 },
    }),
    browser: async (options) => {
      appendFileSync(
        path.join(config.dataDir, 'fixture-browser-events.jsonl'),
        JSON.stringify({
          pid: process.pid,
          debug: process.env.DEBUG !== undefined,
          debug_file: process.env.DEBUG_FILE !== undefined,
          pwdebug: process.env.PWDEBUG !== undefined,
          arguments_contain_cookie: process.argv.some((value) => value.includes(fakeLoginSession.cookie!)),
        }) + '\n',
        { mode: 0o600 },
      );
      options.onWaiting?.();
      if (process.env.AI_MODELING_TEST_LOGIN_MODE === 'accept') {
        await delay(80);
        await options.accept({ ...fakeLoginSession }, options.signal);
        return;
      }
      if (!options.signal.aborted)
        await new Promise<void>((resolve) =>
          options.signal.addEventListener('abort', () => resolve(), { once: true }),
        );
    },
  };
}
