/** Test-only failure injection: metadata must never try to load either native runtime. */
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';

// This test exercises the production lazy adapter instead of the normal in-memory store.
// A surprise credential access must fail in the parent before a native helper can start.
const originalSpawnSync = childProcess.spawnSync;
Object.defineProperty(childProcess, 'spawnSync', {
  value: (...args: Parameters<typeof originalSpawnSync>) => {
    if (Array.isArray(args[1]) && args[1].some((arg) => /keyring-worker\.(?:ts|js)$/.test(arg)))
      throw new Error('Unexpected credential access in a metadata-only command.');
    return Reflect.apply(originalSpawnSync, childProcess, args);
  },
});
syncBuiltinESMExports();

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'sharp' || specifier === '@napi-rs/keyring')
      throw new Error('Synthetic native dependency failure with private diagnostic data.');
    if (/\/keyring-entry\.(?:ts|js)$/.test(specifier))
      return { url: new URL(specifier, context.parentURL).href, shortCircuit: true };
    return next(specifier, context);
  },
});
