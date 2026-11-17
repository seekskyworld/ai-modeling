/** 元素拆分清单失效状态采用独立文件与跨进程锁；不迁移任务库，也不保存凭证或素材 URL。 */
import path from 'node:path';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { lock } from 'proper-lockfile';
import { z } from 'zod';
import { fingerprint } from '../core/fingerprint.ts';
import type { TaskService } from '../core/service.ts';
import type {
  DetectionEpoch,
  ExtractionMemory,
  ExtractionScope,
} from '../../studio/api/canvas-extraction-memory.ts';
import { array, object, TripoError } from '../../studio/contracts/errors.ts';

const stateSchema = z
  .object({
    version: z.literal(1),
    scope: z.string(),
    epochs: z.record(
      z.string().regex(/^[a-f0-9]{64}$/),
      z
        .object({
          assetIds: z.array(z.string()),
          runId: z.string(),
          stepId: z.string(),
          revision: z.string().regex(/^\d+$/),
        })
        .strict(),
    ),
  })
  .strict();

export class ExtractionFileMemory implements ExtractionMemory {
  private directory: string;
  isDetection: ExtractionMemory['isDetection'];
  constructor(directory: string, isDetection: ExtractionMemory['isDetection']) {
    this.directory = directory;
    this.isDetection = isDetection;
  }
  async transact<T>(scope: ExtractionScope, run: (epochs: Record<string, DetectionEpoch>) => T): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const key = fingerprint(scope),
      file = path.join(this.directory, key + '.json');
    let compromised = false;
    let release: () => Promise<void>;
    try {
      release = await lock(file, {
        realpath: false,
        retries: 0,
        stale: 120000,
        onCompromised: () => {
          compromised = true;
        },
      });
    } catch {
      throw new TripoError(
        'EXTRACTION_STATE_BUSY',
        'Another extraction plan is updating this node; retry this read.',
      );
    }
    const temp = file + '.' + randomUUID() + '.tmp';
    try {
      const state = await readState(file, key),
        result = run(state.epochs);
      await writeFile(temp, JSON.stringify(state) + '\n', { mode: 0o600, flag: 'wx' });
      if (compromised)
        throw new TripoError('EXTRACTION_STATE_BUSY', 'Extraction state lock was lost; retry this read.');
      await rename(temp, file);
      return result;
    } finally {
      await rm(temp, { force: true });
      await release();
    }
  }
}
async function readState(file: string, key: string) {
  try {
    const state = stateSchema.parse(JSON.parse(await readFile(file, 'utf8')));
    if (state.scope !== key) throw new Error('scope');
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { version: 1 as const, scope: key, epochs: {} as Record<string, DetectionEpoch> };
    throw new TripoError(
      'EXTRACTION_STATE_INVALID',
      'Extraction state is unreadable; preserve it before repairing local state.',
    );
  }
}

export function extractionMemory(service: TaskService): ExtractionMemory {
  return new ExtractionFileMemory(path.join(service.config.dataDir, 'extraction-state'), (receipt) => {
    // GetRun 不回显 action/参数；必须核对本机原 Detect 回执和同一已保存版本，不能只猜资产变化。
    for (let offset = 0; ; offset += 100) {
      const jobs = service.jobs.list(receipt.account, 100, offset);
      const job = jobs.find(
        (value) => value.operation === 'canvas_run' && value.remote_ids.task_id === receipt.runId,
      );
      if (job)
        return (
          job.input.action === 'detect' &&
          job.input.canvas_id === receipt.canvasId &&
          job.input.revision === receipt.revision &&
          array(job.input.node_ids).length === 1 &&
          array(job.input.node_ids)[0] === receipt.nodeId &&
          array(job.input._canvas_quotes)
            .map(object)
            .some((quote) => quote.node_id === receipt.nodeId && quote.extraction_context === receipt.context)
        );
      if (jobs.length < 100) return false;
    }
  });
}
