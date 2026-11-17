/** 本地重渲染随 CLI 取消；避免 MCP 断开后留下继续占用资源的 Blender/FFmpeg。 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export async function localProcess(
  command: string,
  args: string[],
  timeout: number,
  maxBuffer: number,
): Promise<void> {
  const controller = new AbortController();
  const stop = (): void => {
    controller.abort();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await exec(command, args, { timeout, maxBuffer, signal: controller.signal });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
