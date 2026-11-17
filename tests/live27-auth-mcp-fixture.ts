/** 官方 SDK 的真 stdio 边界向带测试loader的正式 CLI 发起一次调用。 */
import { fileURLToPath } from 'node:url';
import { serve } from '../mcp/server.ts';

await serve(
  {
    command: process.execPath,
    args: [
      '--import',
      fileURLToPath(new URL('./live27-auth-cli-hook.ts', import.meta.url)),
      fileURLToPath(new URL('../cli/main.ts', import.meta.url)),
    ],
    env: process.env,
  },
  (process.argv[2] ?? 'studio') as 'studio' | 'full' | 'default',
);
