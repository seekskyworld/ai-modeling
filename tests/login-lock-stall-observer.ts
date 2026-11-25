/** Child-only observer: preserve real auth operations and report only bounded failure metadata. */
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import * as state from '../cli/auth/state.ts';
import * as transport from '../cli/auth/transport.ts';
export * from '../cli/auth/state.ts';
export * from '../cli/auth/transport.ts';

function report(phase: string, error?: unknown, elapsed = 0): void {
  const failure = error as { code?: unknown; stack?: unknown } | undefined;
  const code = failure?.code;
  const stack = typeof failure?.stack === 'string' ? failure.stack : '';
  const origin = [
    'replacePrivateWindowsFile',
    'protectPrivateWindowsPath',
    'verifyPrivateWindowsPath',
    'checkWindowsPaths',
    'readStateAttempt',
    'writeState',
  ].find((frame) => stack.includes(`at ${frame} (`));
  process.stdout.write(
    JSON.stringify({
      diagnostic: 'login_lock_stall',
      phase,
      elapsed_ms: Math.round(elapsed),
      ...(error
        ? { error_code: typeof code === 'string' && /^[A-Z_]{2,64}$/.test(code) ? code : 'UNEXPECTED_ERROR' }
        : {}),
      ...(origin ? { error_origin: origin } : {}),
    }) + '\n',
  );
}

async function observed<T>(phase: string, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await work();
  } catch (error) {
    report(phase + '_failed', error, performance.now() - started);
    throw error;
  }
}

// Observe only the broker's existing loopback timeout event, without logging its capability header.
const originalRequest = http.request;
Object.defineProperty(http, 'request', {
  value: function (...args: unknown[]) {
    const request = Reflect.apply(originalRequest, http, args) as ReturnType<typeof http.request>;
    const options = args[0] as { hostname?: unknown; path?: unknown } | undefined;
    if (options?.hostname === '127.0.0.1' && options.path === '/control')
      request.once('timeout', () => report('broker_contact_timeout'));
    return request;
  },
});
syncBuiltinESMExports();

export async function readState(...args: Parameters<typeof state.readState>) {
  return await observed('state_read', () => state.readState(...args));
}
export async function writeState(...args: Parameters<typeof state.writeState>) {
  return await observed('state_write', () => state.writeState(...args));
}
export async function contactBroker(...args: Parameters<typeof transport.contactBroker>) {
  return await observed('broker_contact', () => transport.contactBroker(...args));
}
