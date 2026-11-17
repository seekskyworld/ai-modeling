import { fileURLToPath } from 'node:url';
import { exportDistribution, exportHelp, parseExportArgs } from './distribution.ts';

try {
  const options = parseExportArgs(process.argv.slice(2));
  if (!options) process.stdout.write(exportHelp);
  else {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const result = await exportDistribution(root, options);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : 'Distribution export failed.') + '\n');
  process.exitCode = 1;
}
