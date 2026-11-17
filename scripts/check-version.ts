import { readFile } from 'node:fs/promises';
import { PACKAGE_NAME, VERSION } from '../version.ts';

const root = new URL('../', import.meta.url);
const metadata = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const lock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'));
if (
  metadata.version !== VERSION ||
  lock.version !== VERSION ||
  lock.packages?.['']?.version !== VERSION ||
  metadata.name !== PACKAGE_NAME ||
  lock.name !== metadata.name ||
  lock.packages?.['']?.name !== metadata.name
)
  throw new Error(
    'Package and lockfile identities must match. Run npm install --package-lock-only after changing package.json.',
  );
process.stdout.write(
  JSON.stringify({ name: metadata.name, version: VERSION, lockfile: 'consistent' }) + '\n',
);
