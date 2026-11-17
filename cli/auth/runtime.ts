/** 默认实现连接私有JSON凭据及Studio适配器，测试可直接注入完全隔离的替代实现。 */
import { JsonStore } from '../../studio/auth/credentials.ts';
import { verifyCredential } from '../../studio/auth/import.ts';
import { runBrowserLogin } from '../../studio/auth/browser-login.ts';
import type { Config } from '../core/config.ts';
import type { LoginRuntime } from './types.ts';

export function defaultLoginRuntime(config: Config): LoginRuntime {
  return {
    store: new JsonStore(config.credentialProfile),
    verify: verifyCredential,
    browser: runBrowserLogin,
  };
}
