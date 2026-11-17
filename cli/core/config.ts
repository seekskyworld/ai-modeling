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
  credentialProfile: string;
}

export function configFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  location: { home: string; platform: NodeJS.Platform } = { home: os.homedir(), platform: process.platform },
): Config {
  const paths = location.platform === 'win32' ? path.win32 : path.posix;
  const home = location.home;
  const dataBase =
    location.platform === 'darwin'
      ? paths.join(home, 'Library/Application Support')
      : location.platform === 'win32'
        ? (env.LOCALAPPDATA ?? paths.join(home, 'AppData/Local'))
        : (env.XDG_DATA_HOME ?? paths.join(home, '.local/share'));
  const dataDir = paths.resolve(environmentValue('DATA_DIR', env) ?? paths.join(dataBase, 'ai-modeling'));
  const output = environmentValue('OUTPUT_DIR', env);
  const inputs = environmentValue('INPUT_ROOTS', env);
  const settingsFile = paths.join(dataDir, 'settings.json');
  const settings: Record<string, unknown> = existsSync(settingsFile)
    ? JSON.parse(readFileSync(settingsFile, 'utf8'))
    : {};
  return {
    dataDir,
    // 素材位置属于调用方；仅显式配置时才启用目录限制，内部状态仍遵守系统数据目录约定。
    outputDir: output ? paths.resolve(output) : '',
    inputRoots: inputs
      ? inputs
          .split(paths.delimiter)
          .filter(Boolean)
          .map((p) => paths.resolve(p))
      : [],
    credentialProfile:
      environmentValue('PROFILE', env) ??
      (typeof settings.active_profile === 'string' ? settings.active_profile : 'default'),
  };
}

export async function initializeDirectories(config: Config): Promise<void> {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(config.dataDir, 0o700);
  if (config.outputDir) await mkdir(config.outputDir, { recursive: true, mode: 0o700 });
}
