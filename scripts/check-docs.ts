import { fileURLToPath } from 'node:url';
import { checkDocumentation, sourceDocumentationInventory } from './documentation-check.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const result = await checkDocumentation(root, await sourceDocumentationInventory(root));
if (result.errors.length) {
  process.stderr.write(result.errors.join('\n') + '\n');
  process.exitCode = 1;
} else process.stdout.write(JSON.stringify(result) + '\n');
