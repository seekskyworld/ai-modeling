/** MCP 启动沿用同包子进程，确保所有业务仍从 CLI 回流。 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TripoError } from '../../studio/contracts/errors.ts';
export function launchMcp(toolset: string): void {
  if (!['default', 'full', 'studio'].includes(toolset))
    throw new TripoError('INVALID_INPUT', 'toolset must be default, full or studio.');
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL(`../../mcp/main.${extension}`, import.meta.url)), '--toolset', toolset],
    { stdio: 'inherit', shell: false },
  );
  process.once('SIGINT', () => child.kill('SIGINT'));
  process.once('SIGTERM', () => child.kill('SIGTERM'));
  child.once('error', () => {
    process.stderr.write('MCP process failed to start.\n');
    process.exitCode = 7;
  });
  child.once('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}
