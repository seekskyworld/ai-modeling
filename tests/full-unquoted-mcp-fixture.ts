/** Real stdio MCP and CLI bridge; only upstream application dependencies use a test loader. */
import { fileURLToPath } from 'node:url';
import { serve } from '../mcp/server.ts';
await serve(
  {
    command: process.execPath,
    args: [
      '--import',
      fileURLToPath(new URL('./full-unquoted-cli-hook.ts', import.meta.url)),
      fileURLToPath(new URL('../cli/main.ts', import.meta.url)),
    ],
    env: process.env,
  },
  (process.argv[2] ?? 'full') as 'full' | 'default',
);
