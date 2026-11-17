/** 命令只装配本地运行时管理，status不创建任务服务或数据目录。 */
import type { Command } from 'commander';
import { configFromEnv } from '../core/config.ts';
import { runtimeStatus, installRuntime } from './assets.ts';
import { runtimeStatusSchema, runtimeInstallSchema } from './tools.ts';

export function registerRuntime(program: Command, emit: (value: unknown) => void): void {
  const group = program
    .command('runtime')
    .description('Studio extension: verify or install the pinned website frontend engine locally');
  group
    .command('status')
    .description('verify cached runtime files without network, login or directory creation')
    .option('--source-dir <dir>', 'check a supplied directory instead of the private cache')
    .action((flags: { sourceDir?: string }) => {
      const input = runtimeStatusSchema.parse({ source_dir: flags.sourceDir });
      emit(runtimeStatus(configFromEnv(), input.source_dir));
    });
  group
    .command('install')
    .description('verify both official runtime files and install them without network or overwriting')
    .requiredOption('--source-dir <dir>', 'directory containing both exact official runtime filenames')
    .action((flags: { sourceDir: string }) => {
      const input = runtimeInstallSchema.parse({ source_dir: flags.sourceDir });
      emit(installRuntime(configFromEnv(), input.source_dir));
    });
}
