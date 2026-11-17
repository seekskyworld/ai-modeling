/** Inspect the actual npm inventory without building, writing a tarball, or publishing. */
import { fileURLToPath } from 'node:url';
import { packageInventory, validatePackageInventory } from './package-validation.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
try {
  const result = await validatePackageInventory(root, packageInventory(root));
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : 'Package validation failed.') + '\n');
  process.exitCode = 1;
}
