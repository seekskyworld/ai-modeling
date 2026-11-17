/** 独立入口只接受父进程IPC；本地broker终止后强制结束，不能留下永久登录守护进程。 */
import { startLoginBroker } from './broker.ts';
import { defaultLoginRuntime } from './runtime.ts';
import { safeLoginError } from './state.ts';
import type { BrokerStart } from './types.ts';

const startup = setTimeout(() => process.exit(1), 10000);
process.once('message', async (value) => {
  clearTimeout(startup);
  try {
    const start = value as BrokerStart;
    const broker = await startLoginBroker(start, defaultLoginRuntime(start.config));
    process.send?.({ ready: true });
    const stop = () => {
      void broker.close();
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    await broker.closed;
    process.exit(0);
  } catch (error) {
    process.send?.({ error: safeLoginError(error) }, () => process.exit(1));
    setTimeout(() => process.exit(1), 50);
  }
});
