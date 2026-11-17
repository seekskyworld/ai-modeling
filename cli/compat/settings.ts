/** 本地偏好与目录上下文沿用官方命令约定；网页登录与 LLM 密钥始终存于系统凭据库。 */
import { readFileSync, existsSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { configFromEnv } from '../core/config.ts';
import { object, TripoError } from '../../studio/contracts/errors.ts';

export function readSettings(file = settingsFile()): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    return object(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    throw new TripoError('INVALID_CONFIG', `Invalid JSON settings: ${file}`);
  }
}
export function settingsFile(): string {
  return path.join(configFromEnv().dataDir, 'settings.json');
}
export async function writeSettings(value: Record<string, unknown>, file = settingsFile()): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temp, file);
}
export function contextFile(from = process.cwd()): string | undefined {
  for (let dir = path.resolve(from); ;) {
    const candidate = path.join(dir, '.ai-modeling/context.json');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
/** 仅合并声明过的制作默认值，不允许目录文件改写鉴权和远端服务地址。 */
export function contextFlags(): Record<string, unknown> {
  const file = contextFile();
  const local = file ? readSettings(file) : {};
  return {
    ...(local.scenario ? { for: local.scenario } : {}),
    ...(local.model ? { model: local.model } : {}),
    ...(local.params ? { param: object(local.params) } : {}),
  };
}

/** 目录偏好是默认根目录，各任务仍拥有独立子目录；显式 --out 的精确目标由调用方保留。 */
export function defaultOutputRoot(): string {
  const file = contextFile();
  const local = file ? readSettings(file) : {};
  const value = local.output_dir ?? readSettings().default_output_dir;
  if (value === undefined) return process.cwd();
  if (typeof value !== 'string' || !value.trim())
    throw new TripoError('INVALID_CONFIG', 'output_dir must be a nonempty path.');
  return path.resolve(file && local.output_dir ? path.dirname(path.dirname(file)) : process.cwd(), value);
}
