/** Test-only process boundary: synthetic OS home/Keychain, disposable state and loopback-only HTTP. */
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Socket } from 'node:net';
import { EnvHttpProxyAgent, MockAgent, setGlobalDispatcher } from 'undici';

const sandbox = process.env.MODELING_TEST_SANDBOX;
if (!sandbox) throw new Error('Run offline tests through node scripts/run-tests.ts.');
const isTest = /\.test\.[cm]?[jt]s$/.test(process.argv[1] ?? '');
const worker = isTest
  ? `${path.basename(process.argv[1]!)}-${process.pid}`
  : (process.env.MODELING_TEST_WORKER ?? 'controller');
process.env.MODELING_TEST_WORKER = worker;
const directory = path.join(sandbox, worker);
const syntheticHome = path.join(directory, 'os-user');
mkdirSync(syntheticHome, { recursive: true, mode: 0o700 });
if (isTest || !process.env.AI_MODELING_DATA_DIR) {
  process.env.AI_MODELING_DATA_DIR = path.join(directory, 'data');
  process.env.AI_MODELING_OUTPUT_DIR = path.join(directory, 'output');
  process.env.AI_MODELING_PROFILE = `offline-${worker}`;
}
const originalUserInfo = os.userInfo;
Object.defineProperty(os, 'homedir', { value: () => syntheticHome });
Object.defineProperty(os, 'userInfo', { value: () => ({ ...originalUserInfo(), homedir: syntheticHome }) });
syncBuiltinESMExports();
const keyring =
  'data:text/javascript,' +
  encodeURIComponent(`
const values = new Map();
export const isolatedTestStore = true;
export class Entry {
  constructor(service, account) { this.key = JSON.stringify([service, account]); }
  getPassword() { return values.get(this.key) ?? null; }
  setPassword(value) { values.set(this.key, value); }
  deleteCredential() { values.delete(this.key); }
}`);
// Business-store tests retain an in-process synthetic store. Process-boundary tests exercise
// keyring-process directly with explicit synthetic child helpers, never a real native store.
const isolatedEntry =
  'data:text/javascript,' + encodeURIComponent('export { Entry } from "@napi-rs/keyring";');
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@napi-rs/keyring') return { url: keyring, shortCircuit: true };
    if (/\/keyring-entry\.(?:ts|js)$/.test(specifier)) return { url: isolatedEntry, shortCircuit: true };
    return next(specifier, context);
  },
});
const network = new MockAgent();
network.disableNetConnect();
network.enableNetConnect(/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/);
setGlobalDispatcher(network);
EnvHttpProxyAgent.prototype.dispatch = function (options, handler) {
  return network.dispatch(options, handler);
};
// Cover transports that do not use fetch/undici, including Node HTTP and SDK clients.
const originalConnect = Socket.prototype.connect;
Object.defineProperty(Socket.prototype, 'connect', {
  value: function (this: Socket, ...args: unknown[]) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const options = first && typeof first === 'object' ? (first as Record<string, unknown>) : {};
    const socketPath = typeof first === 'string' ? first : options.path;
    const host = String(options.host ?? (typeof args[1] === 'string' ? args[1] : 'localhost')).toLowerCase();
    const allowed =
      typeof socketPath === 'string'
        ? path.resolve(socketPath).startsWith(sandbox + path.sep)
        : ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
    if (!allowed)
      throw Object.assign(new Error('Offline tests cannot open external sockets.'), {
        code: 'TEST_NETWORK_BLOCKED',
      });
    return Reflect.apply(originalConnect, this, args);
  },
});
