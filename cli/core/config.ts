/** 数据目录与输出目录显式分离，源码目录不保存会话或用户产物。 */
import os from 'node:os';
import path from 'node:path';
import { mkdir, chmod } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { environmentValue } from './environment.ts';

export interface Config {
  dataDir: string;
  outputDir: string;
  inputRoots: string[];
  keyringAccount: string;
}

export function configFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  location: { home: string; platform: NodeJS.Platform } = { home: os.homedir(), platform: process.platform },
): Config {
  const home = location.home;
  const dataBase =
    location.platform === 'darwin'
      ? path.join(home, 'Library/Application Support')
      : (env.XDG_DATA_HOME ?? path.join(home, '.local/share'));
  const dataDir = path.resolve(environmentValue('DATA_DIR', env) ?? path.join(dataBase, 'ai-modeling'));
  const output = environmentValue('OUTPUT_DIR', env);
  const inputs = environmentValue('INPUT_ROOTS', env);
  const settingsFile = path.join(dataDir, 'settings.json');
  const settings: Record<string, unknown> = existsSync(settingsFile)
    ? JSON.parse(readFileSync(settingsFile, 'utf8'))
    : {};
  return {
    dataDir,
    // 素材位置属于调用方；仅显式配置时才启用目录限制，内部状态仍遵守系统数据目录约定。
    outputDir: output ? path.resolve(output) : '',
    inputRoots: inputs
      ? inputs
          .split(path.delimiter)
          .filter(Boolean)
          .map((p) => path.resolve(p))
      : [],
    keyringAccount:
      environmentValue('PROFILE', env) ??
      (typeof settings.active_profile === 'string' ? settings.active_profile : 'default'),
  };
}

export async function initializeDirectories(config: Config): Promise<void> {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  await chmod(config.dataDir, 0o700);
  if (config.outputDir) await mkdir(config.outputDir, { recursive: true, mode: 0o700 });
}
