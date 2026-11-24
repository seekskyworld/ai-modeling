/** Synthetic child process; diagnostics include only fixed stages, codes and elapsed time. */
import path from 'node:path';
import { registerHooks } from 'node:module';
import type { BrowserLoginOptions, LoginRuntime } from '../cli/auth/types.ts';

const observer = new URL('./login-lock-stall-observer.ts', import.meta.url).href;
const observedModules = new Set([
  new URL('../cli/auth/state.ts', import.meta.url).href,
  new URL('../cli/auth/transport.ts', import.meta.url).href,
]);
registerHooks({
  resolve(specifier, context, next) {
    const resolved = next(specifier, context);
    return observedModules.has(resolved.url) && context.parentURL !== observer
      ? { url: observer, shortCircuit: true }
      : resolved;
  },
});
const { JsonStore } = await import('../studio/auth/credentials.ts');
const { beginLogin } = await import('../cli/auth/coordinator.ts');
const { startLoginBroker } = await import('../cli/auth/broker.ts');

const started = performance.now();
let phase = 'starting';
let storeReads = 0;
const errorCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && /^[A-Z_]{2,64}$/.test(code) ? code : 'UNEXPECTED_ERROR';
};
const report = (next: string, details: { error_code?: string; status?: string; accepted?: boolean } = {}) => {
  phase = next;
  process.stdout.write(
    JSON.stringify({
      diagnostic: 'login_lock_stall',
      phase,
      elapsed_ms: Math.round(performance.now() - started),
      store_reads: storeReads,
      ...details,
    }) + '\n',
  );
};

let broker: Awaited<ReturnType<typeof startLoginBroker>> | undefined;
try {
  const directory = process.argv[2];
  if (!directory || !path.isAbsolute(directory)) throw new Error('Missing synthetic directory.');
  const config = {
    dataDir: directory,
    credentialProfile: path.basename(directory),
    inputRoots: [],
    outputDir: '',
  };
  const candidate = {
    cookie: 'synthetic-cookie-only',
    deviceId: 'synthetic-device',
    accountRef: 'synthetic-account',
    importedAt: '2026-11-17T00:00:00Z',
  };
  const store = new JsonStore(config.credentialProfile);
  const load = store.load.bind(store);
  let stall = false;
  store.load = () => {
    storeReads++;
    if (stall) {
      stall = false;
      report('store_stalled');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000);
    }
    return load();
  };
  let browserOptions: BrowserLoginOptions | undefined;
  const runtime: LoginRuntime = {
    store,
    verify: async () => {
      report('candidate_verified');
      stall = true;
      return { session: candidate, result: { authenticated: true } };
    },
    browser: async (options) => {
      browserOptions = options;
      report('browser_ready');
      if (!options.signal.aborted)
        await new Promise<void>((resolve) =>
          options.signal.addEventListener('abort', () => resolve(), { once: true }),
        );
    },
    launch: async (start) => {
      report('broker_start');
      broker = await startLoginBroker(start, runtime);
      report('broker_ready');
    },
  };
  report('begin_login');
  const status = await beginLogin({ config, open: true }, runtime);
  report('begin_result', {
    status: status.status,
    ...(status.error ? { error_code: errorCode(status.error) } : {}),
  });
  if (!browserOptions)
    throw Object.assign(new Error('Synthetic browser was not started.'), { code: 'TEST_BROWSER_NOT_READY' });
  report('accept_candidate');
  const accepted = await browserOptions.accept(candidate);
  report('candidate_result', { accepted });
} catch (error) {
  const failedPhase = phase;
  report(failedPhase + '_failed', { error_code: errorCode(error) });
  process.exitCode = 1;
} finally {
  report('broker_closing');
  try {
    await broker?.close();
    report('worker_complete');
  } catch (error) {
    report('broker_close_failed', { error_code: errorCode(error) });
    process.exitCode = 1;
  }
}
