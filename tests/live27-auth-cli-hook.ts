/** Node loader 只替换依赖；main、callTool、认证恢复和 MCP bridge 均运行生产代码。 */
import { registerHooks } from 'node:module';
import { appendFileSync } from 'node:fs';

const replacement = new URL('./live27-auth-fixture.ts', import.meta.url).href;
const targets = [
  '../cli/core/application.ts',
  ...(process.env.LIVE27_CASE === 'flow_snapshot' ? [] : ['../cli/auth/coordinator.ts']),
].map((file) => new URL(file, import.meta.url).href);
const blocked = (name: string) =>
  'data:text/javascript,' +
  encodeURIComponent(
    name === '@napi-rs/keyring'
      ? 'export class Entry { constructor() { throw Error("Unexpected real Keychain access"); } }'
      : 'export class EnvHttpProxyAgent {} export async function fetch(){throw Error("Unexpected real network");}',
  );
registerHooks({
  resolve(specifier, context, next) {
    if (['@napi-rs/keyring', 'undici'].includes(specifier))
      return { url: blocked(specifier), shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (targets.includes(url))
      return {
        format: 'module',
        shortCircuit: true,
        source: `export * from ${JSON.stringify(replacement)};`,
      };
    return next(url, context);
  },
});
globalThis.fetch = async () => {
  throw new Error('Unexpected real fetch');
};
appendFileSync(
  process.env.LIVE27_TRACE!,
  JSON.stringify({ kind: 'cli-process', args: process.argv.slice(2) }) + '\n',
);
