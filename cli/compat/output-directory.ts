/** 配置默认值适用于所有 CLI/MCP 下载；恢复优先沿用已保存目录，避免换目录后重复交付。 */
import path from 'node:path';
import { array, object, text } from '../../studio/contracts/errors.ts';
import { defaultOutputRoot } from './settings.ts';
import type { Flags } from './planning.ts';

export function outputDirectory(job: Record<string, unknown>, flags: Flags): string {
  const explicit = text(flags.out);
  // 新任务入口的 --out 是任务目录的根；task get/watch 与独立下载仍是精确目标目录。
  if (explicit && flags.outIsRoot !== true) return path.resolve(explicit);
  const saved = new Set(
    array(job.artifacts)
      .map(object)
      .map((a) => text(a.local_path))
      .filter(Boolean)
      .map((file) => path.dirname(file)),
  );
  if (!explicit && saved.size === 1) return path.resolve([...saved][0]!);
  const name =
    (text(job.name) || text(flags.name) || 'task')
      .trim()
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, text(job.name) ? 60 : 32)
      .replace(/-+$/, '') || 'task';
  return path.join(
    explicit ? path.resolve(explicit) : defaultOutputRoot(),
    'ai-modeling-out',
    `${name}-${text(job.job_id).slice(0, 8)}`,
  );
}
