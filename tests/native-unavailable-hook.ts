/** Test-only failure injection: static metadata must not load Sharp or access credentials. */
import { registerHooks } from 'node:module';

const unavailableCredentials =
  'data:text/javascript,' +
  encodeURIComponent(
    `const unavailable = () => { throw new Error("Unexpected credential access in a metadata-only command."); };
export const jsonStorageUnavailable = unavailable;
export class JsonEntry {
  getPassword = unavailable;
  setPassword = unavailable;
  deleteCredential = unavailable;
  update = unavailable;
}`,
  );

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'sharp')
      throw new Error('Synthetic native dependency failure with private diagnostic data.');
    if (/\/json-entry\.(?:ts|js)$/.test(specifier))
      return { url: unavailableCredentials, shortCircuit: true };
    return next(specifier, context);
  },
});
