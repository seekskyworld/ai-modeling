/** 真实 stdio 服务子进程使用受控上游，断线重连仍共用 SQLite。 */
import { serve } from '../mcp/server.ts';
await serve(
  { command: process.execPath, args: ['tests/cli-fixture.ts', process.argv[2]!] },
  process.argv[3] === 'default' ? 'default' : 'studio',
);
