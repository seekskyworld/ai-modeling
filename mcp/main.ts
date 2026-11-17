#!/usr/bin/env node
/** 独立 MCP 启动入口；业务调用全部由同包 CLI 子进程执行。 */
import { serve } from './server.ts';
import { VERSION } from '../version.ts';
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(
    'ai-modeling mcp [--toolset full|default|studio]\nStudio tools over stdio. Business operations run through the bundled ai-modeling CLI.\n',
  );
  process.exit(0);
}
if (args.includes('--version')) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}
const toolset = args[0] === '--toolset' ? args[1] : 'studio';
if (toolset !== 'full' && toolset !== 'default' && toolset !== 'studio')
  throw new Error('toolset must be default, full or studio');
const server = await serve(undefined, toolset);
process.once('SIGINT', () => {
  void server.close();
});
process.once('SIGTERM', () => {
  void server.close();
});
