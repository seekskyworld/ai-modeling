/** 可见浏览器登录、短时流程与显式粘贴备用入口；status仍保持旧账号查询语义。 */
import { configFromEnv } from './core/config.ts';
import { createApplication } from './core/application.ts';
import { KeyringStore } from '../studio/auth/credentials.ts';
import { startAuthBridge } from '../studio/auth/bridge.ts';
import { TripoError } from '../studio/contracts/errors.ts';
import {
  beginLogin,
  ensureLogin,
  readLogin,
  waitLogin,
  cancelLogin,
  logoutLogin,
} from './auth/coordinator.ts';
import type { LoginOptions } from './auth/types.ts';
import { activeLogin } from './auth/types.ts';
import { manualLogin } from './auth/manual.ts';
import { readCredentialFile } from './auth/credential-file.ts';
const print = (value: unknown): void => {
  process.stdout.write(JSON.stringify(value) + '\n');
};
export async function auth(args: string[]): Promise<void> {
  const config = configFromEnv();
  if (args[0] === 'session' || ['begin', 'wait', 'cancel'].includes(args[0] ?? '')) {
    await sessionCommand(args);
    return;
  }
  if (args[0] === 'login') {
    if (args.includes('--paste')) {
      await auth(['import', '--stdin']);
      return;
    }
    if (args.includes('--form')) {
      await manualForm(config);
      return;
    }
    const { options } = loginArguments(args.slice(1));
    const controller = new AbortController(),
      cancel = () => controller.abort();
    process.once('SIGINT', cancel);
    let announced = false;
    try {
      const result = await ensureLogin({
        ...options,
        config,
        signal: controller.signal,
        onStatus: (status) => {
          if (!announced && activeLogin(status.status)) {
            announced = true;
            process.stderr.write('请在 Tripo 登录窗口完成登录，完成后命令将自动继续。\n');
            if (status.login_url) process.stderr.write(status.login_url + '\n');
          }
        },
      });
      print(result);
      if (['failed', 'cancelled', 'expired'].includes(result.status)) process.exitCode = 1;
    } finally {
      process.removeListener('SIGINT', cancel);
    }
    return;
  }
  if (args[0] === 'logout') {
    print(await logoutLogin({ config }));
    return;
  }
  if (args[0] === 'import') {
    let input: string;
    if (args[1] === '--stdin') {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of process.stdin) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 131072) throw new TripoError('INVALID_CREDENTIAL', 'Input is too large.');
        chunks.push(bytes);
      }
      input = Buffer.concat(chunks).toString();
    } else if (args[1] === '--file' && args[2]) {
      input = await readCredentialFile(args[2]);
    } else throw new TripoError('INVALID_INPUT', 'Use auth import --stdin or --file PATH.');
    print(await (await manualLogin({ config })).accept(input));
    return;
  }
  if (args[0] !== 'status') throw new TripoError('INVALID_INPUT', 'Unknown auth command.');
  const app = await createApplication(config, { authentication: false });
  try {
    print(await app.studio.account());
  } finally {
    app.close();
  }
}
function loginArguments(args: string[]): { id?: string; options: LoginOptions } {
  const options: LoginOptions = {};
  let id: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const value = args[i]!;
    if (value === '--no-open') options.open = false;
    else if (value === '--no-wait') options.wait = false;
    else if (value === '--wait') options.wait = true;
    else if (value === '--force') options.force = true;
    else if (value === '--timeout') {
      const seconds = Number(args[++i]);
      if (!Number.isFinite(seconds) || seconds <= 0)
        throw new TripoError('INVALID_INPUT', 'Use a positive timeout in seconds.');
      options.timeoutMs = seconds * 1000;
    } else if (value === '--browser-executable' || value === '--cdp-endpoint') {
      const selected = args[++i];
      if (!selected || selected.startsWith('--'))
        throw new TripoError('INVALID_INPUT', 'Browser login options require a value.');
      if (value === '--browser-executable') options.executablePath = selected;
      else options.cdpEndpoint = selected;
    } else if (!value.startsWith('-') && !id) id = value;
    else throw new TripoError('INVALID_INPUT', 'Unknown login option.');
  }
  return { id, options };
}
async function sessionCommand(args: string[]): Promise<void> {
  const nested = args[0] === 'session',
    action = nested ? (args[1] ?? 'status') : args[0];
  const { id, options } = loginArguments(args.slice(nested ? 2 : 1));
  if (action === 'begin') {
    print(await beginLogin(options));
    return;
  }
  if (action === 'status') {
    print(await readLogin(id, options));
    return;
  }
  if (action === 'cancel') {
    print(await cancelLogin(id, options));
    return;
  }
  if (action === 'wait') {
    const selected = id ?? (await readLogin(undefined, options)).login_id!;
    print(await waitLogin(selected, options));
    return;
  }
  throw new TripoError('INVALID_INPUT', 'Use auth begin or auth session status|wait|cancel [login_id].');
}
async function manualForm(config: ReturnType<typeof configFromEnv>): Promise<void> {
  const manual = await manualLogin({ config }),
    store = new KeyringStore(config.keyringAccount);
  const bridge = await startAuthBridge(
    store,
    (result) => {
      print(result);
      process.removeListener('SIGINT', cancel);
      void bridge.close();
    },
    manual.accept,
  );
  const cancel = () => {
    void cancelLogin(undefined, { config }).finally(() => bridge.close());
  };
  process.once('SIGINT', cancel);
  process.stderr.write(`打开本机备用表单，导入本人的 Studio 会话：\n${bridge.url}\n`);
}
