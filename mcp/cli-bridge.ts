/** 用 JSON/stdin 调用 CLI；进程中断不会自动重提可能已扣费的命令。 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface CliInvocation {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}
const MAX_OUTPUT = 16 * 1024 * 1024;

export class CliBridge {
  private children = new Set<ChildProcess>();
  private invocation: CliInvocation;
  constructor(invocation?: CliInvocation) {
    const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    this.invocation = invocation ?? {
      command: process.execPath,
      args: [fileURLToPath(new URL(`../cli/main.${extension}`, import.meta.url))],
    };
  }
  /** 输出只接受 CLI 的 JSON；子进程 stderr 不回传，防止意外泄漏上游内容。 */
  async run(args: string[], input?: unknown, signal?: AbortSignal): Promise<unknown> {
    return await new Promise((resolve, reject) => {
      const child = spawn(this.invocation.command, [...this.invocation.args, ...args], {
        env: this.invocation.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      });
      this.children.add(child);
      const chunks: Buffer[] = [];
      let bytes = 0;
      let stopped = false;
      const stop = (): void => {
        stopped = true;
        child.kill('SIGTERM');
      };
      // CLI 网络调用自身有界；此上限用于挂死进程，停止后仍需查询原任务。
      const timer = setTimeout(stop, 7250000);
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) stop();
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT) stop();
        else chunks.push(chunk);
      });
      child.stderr.resume();
      child.stdin.on('error', () => {
        /* EPIPE 由 close 统一返回，不重试提交。 */
      });
      child.once('error', () => reject(new Error('CLI_PROCESS_START_FAILED')));
      child.once('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
        this.children.delete(child);
        if (stopped) {
          reject(new Error('CLI_INTERRUPTED_CHECK_JOB'));
          return;
        }
        try {
          const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (code !== 0 && (!result || typeof result !== 'object' || !('error' in result))) {
            reject(new Error('CLI_FAILED_WITHOUT_STRUCTURED_ERROR'));
            return;
          }
          resolve(result);
        } catch {
          reject(new Error('CLI_INVALID_JSON'));
        }
      });
      child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
    });
  }
  async call(
    name: string,
    input: unknown,
    signal?: AbortSignal,
    toolset = 'studio',
  ): Promise<Record<string, unknown>> {
    try {
      const result = await this.run(['call', name, '--input-stdin', '--toolset', toolset], input, signal);
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('CLI_INVALID_JSON');
      return result as Record<string, unknown>;
    } catch (error) {
      return { error: { code: error instanceof Error ? error.message : 'CLI_FAILED', retryable: false } };
    }
  }
  close(): void {
    for (const child of this.children) child.kill('SIGTERM');
  }
}
