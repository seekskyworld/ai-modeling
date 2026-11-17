/** 后台进程只收到本次登录的配置和内存快照；没有原业务命令、shell或凭据argv。 */
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { BrokerStart } from './types.ts';
import { TripoError } from '../../studio/contracts/errors.ts';

/** Pass application settings unchanged while suppressing browser protocol logging. */
export function loginDaemonEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment = { ...env };
  for (const key of Object.keys(environment))
    if (['DEBUG', 'DEBUG_FILE', 'PWDEBUG'].includes(key) || /^(?:PLAYWRIGHT|PW)_.*(?:DEBUG|LOG)/.test(key))
      delete environment[key];
  return environment;
}

export async function launchLoginDaemon(start: BrokerStart): Promise<void> {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const child = fork(fileURLToPath(new URL(`./worker.${extension}`, import.meta.url)), [], {
    execArgv: [],
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: loginDaemonEnvironment(),
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new TripoError('LOGIN_BROKER_UNAVAILABLE', 'Login coordinator did not start.')),
        10000,
      );
      const done = (error?: unknown) => {
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      child.once('error', () =>
        done(new TripoError('LOGIN_BROKER_UNAVAILABLE', 'Cannot start login coordinator.')),
      );
      child.once('exit', () =>
        done(new TripoError('LOGIN_BROKER_UNAVAILABLE', 'Login coordinator stopped during startup.')),
      );
      child.once('message', (value) => {
        const message = value as { ready?: boolean; error?: { code?: string } };
        if (message.ready) done();
        else
          done(
            new TripoError(
              message.error?.code ?? 'LOGIN_BROKER_UNAVAILABLE',
              'Login coordinator could not start.',
            ),
          );
      });
      child.send(start, (error) => {
        if (error) done(new TripoError('LOGIN_BROKER_UNAVAILABLE', 'Cannot initialize login coordinator.'));
      });
    });
    child.disconnect();
    child.unref();
  } catch (error) {
    child.kill();
    throw error;
  }
}
