/** 清单以稳定请求 ID 恢复；重新运行仍使用原提交意图，未知回执永远不创建替代任务。 */
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { lock } from 'proper-lockfile';
import { z } from 'zod';
import { makePlan, type Flags } from './planning.ts';
import { executePlan, type Application } from './runtime.ts';
import { validatePlanFiles } from './run-plan.ts';
import { array, object, errorResult, TripoError } from '../../studio/contracts/errors.ts';
import type { Artifact } from '../../studio/contracts/types.ts';
import { verifiedArtifactBytes } from '../artifacts/recover-download.ts';

const jobSchema = z
  .object({
    input: z.string().min(1).optional(),
    inputs: z.array(z.string().min(1)).min(1).max(4).optional(),
    name: z
      .string()
      .regex(/^[\p{L}\p{N}_.-]{1,100}$/u)
      .optional(),
    for: z.string().optional(),
    then: z.string().optional(),
    model: z.string().optional(),
    params: z.record(z.string(), z.unknown()).default({}),
    out: z.string().optional(),
  })
  .strict();
const manifestSchema = z
  .object({
    concurrency: z.number().int().min(1).max(4).default(2),
    defaults: jobSchema.partial().default({}),
    jobs: z.array(jobSchema).min(1).max(500),
  })
  .strict();
interface BatchState {
  version: 1;
  hash: string;
  run_id: string;
  account_ref: string;
  jobs: Record<string, Record<string, unknown>>;
}
/** 远端生成成功与文件交付成功分开：下载失败或缓存已丢失时恢复原任务，不能跳过整项。 */
async function completedBatchItem(
  result: Record<string, unknown> | undefined,
  download: unknown,
  generationExpected: boolean,
): Promise<boolean> {
  if (!result || result.status !== 'success' || result.download_error || result.wait_timed_out) return false;
  if (download === false) return true;
  const deliveries = [{ result, artifacts: array(result.artifacts).map(object) }];
  const generation = array(result.generation_downloads).map(object);
  // AR/Web 同时交付原始 GLB 和转换结果；最终文件存在不能掩盖另一份交付丢失。
  if (generationExpected && generation.length !== 1) return false;
  for (const generated of generation) {
    // P 系列生成前缀的末个贴图/PBR任务才是交付来源，不能永远拿首个白模的产物核对。
    const source = array(result.chain)
      .map(object)
      .find((step) => typeof generated.task_id === 'string' && step.task_id === generated.task_id);
    // 旧状态未保存来源时按原 request 恢复一次，不能把不明交付当作已验证完成。
    if (!source || source.status !== 'success') return false;
    deliveries.push({ result: generated, artifacts: array(source.artifacts).map(object) });
  }
  for (const delivery of deliveries) {
    const files = array(delivery.result.file_records).map(object);
    if (files.length !== delivery.artifacts.length) return false;
    for (const artifact of delivery.artifacts) {
      const file = files.find((item) => item.artifact_id === artifact.artifact_id);
      if (!file || !(await verifiedArtifactBytes(file as unknown as Artifact))) return false;
    }
  }
  return true;
}
export async function loadBatch(
  file: string,
): Promise<{ manifest: z.infer<typeof manifestSchema>; hash: string; file: string }> {
  const abs = path.resolve(file);
  const raw = await readFile(abs, 'utf8');
  if (raw.length > 4 * 1024 * 1024) throw new TripoError('INVALID_INPUT', 'Manifest exceeds 4 MiB.');
  const manifest = manifestSchema.parse(parseYaml(raw, { maxAliasCount: 50 }));
  const keys = manifest.jobs.map((j, i) => j.name ?? `job-${i + 1}`);
  if (new Set(keys).size !== keys.length)
    throw new TripoError('INVALID_INPUT', 'Duplicate job names in batch.');
  // 所有离线计划先验证，避免清单尾部拼写错误时前面的任务已经扣费。
  for (const job of manifest.jobs) {
    const spec = { ...manifest.defaults, ...job };
    const plan = makePlan(spec.inputs ?? (spec.input ? [spec.input] : []), {
      ...spec,
      param: { ...object(manifest.defaults.params), ...job.params },
    });
    // 只验证已知本地输入，沿用单任务的格式/大小规则；URL 在执行时下载，预检不联网。
    await validatePlanFiles(plan);
  }
  return { manifest, hash: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'), file: abs };
}
async function batchState(file: string, hash: string, fresh: boolean, account: string): Promise<BatchState> {
  if (!fresh) {
    try {
      const state = JSON.parse(await readFile(file, 'utf8')) as BatchState;
      if (
        state.version !== 1 ||
        state.hash !== hash ||
        typeof state.run_id !== 'string' ||
        !state.run_id ||
        !state.jobs ||
        typeof state.jobs !== 'object' ||
        Array.isArray(state.jobs)
      )
        throw new TripoError(
          'BATCH_CHANGED',
          'Manifest differs from its saved state; use a new manifest or explicit --fresh.',
        );
      if (state.account_ref !== account)
        throw new TripoError('ACCOUNT_MISMATCH', 'Batch state belongs to another Studio account.');
      // 合法任务名可等于 __proto__，状态映射必须没有 Object.prototype 的特殊 setter。
      return { ...state, jobs: Object.assign(Object.create(null) as BatchState['jobs'], state.jobs) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  const state: BatchState = {
    version: 1,
    hash,
    run_id: randomUUID(),
    account_ref: account,
    jobs: Object.create(null) as BatchState['jobs'],
  };
  const temp = file + '.' + randomUUID() + '.tmp';
  await writeFile(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temp, file);
  return state;
}
async function runLockedBatch(
  app: Application,
  batch: Awaited<ReturnType<typeof loadBatch>>,
  flags: Flags,
  assertLock: () => void,
): Promise<Record<string, unknown>> {
  const stateFile = batch.file + '.state.json';
  const state = await batchState(stateFile, batch.hash, Boolean(flags.fresh), app.service.accountRef());
  const concurrency = z
    .number()
    .int()
    .min(1)
    .max(4)
    .parse(flags.concurrency ?? batch.manifest.concurrency);
  const retries = z
    .number()
    .int()
    .min(0)
    .max(3)
    .parse(flags.retries ?? 1);
  let cursor = 0;
  let writes = Promise.resolve();
  const save = (): Promise<void> => {
    const json = JSON.stringify(state, null, 2) + '\n';
    writes = writes.then(async () => {
      assertLock();
      const temp = stateFile + '.' + randomUUID() + '.tmp';
      await writeFile(temp, json, { mode: 0o600 });
      await rename(temp, stateFile);
    });
    return writes;
  };
  const run = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      const job = batch.manifest.jobs[index];
      if (!job) return;
      assertLock();
      const key = job.name ?? `job-${index + 1}`;
      const spec = { ...batch.manifest.defaults, ...job };
      const params = { ...object(batch.manifest.defaults.params), ...job.params };
      const opts: Flags = {
        ...spec,
        param: params,
        name: key,
        requestId: `batch-${state.run_id}-${index}`,
        maxCredits: flags.maxCredits,
        download: flags.download,
        timeout: flags.timeout,
        out: job.out ?? (spec.out ? path.join(spec.out, key) : undefined),
      };
      const plan = makePlan(spec.inputs ?? (spec.input ? [spec.input] : []), opts);
      if (await completedBatchItem(state.jobs[key], flags.download, Boolean(plan.downloadGeneration)))
        continue;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          state.jobs[key] = await executePlan(app, plan, opts);
          break;
        } catch (error) {
          state.jobs[key] = { status: 'needs_attention', error: errorResult(error) };
          if (!(error instanceof TripoError) || error.certainty === 'unknown' || attempt === retries) break;
        }
      }
      await save();
    }
  };
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, batch.manifest.jobs.length) }, run),
  );
  await writes;
  const rejected = results.find((result) => result.status === 'rejected');
  if (rejected?.status === 'rejected') throw rejected.reason;
  return {
    total: batch.manifest.jobs.length,
    success: Object.values(state.jobs).filter(
      (j) => j.status === 'success' && !j.download_error && !j.wait_timed_out,
    ).length,
    failed: Object.values(state.jobs).filter((j) => j.status === 'failed').length,
    needs_attention: Object.values(state.jobs).filter(
      (j) =>
        ['needs_attention', 'outcome_unknown', 'requires_login'].includes(String(j.status)) ||
        j.wait_timed_out ||
        j.download_error,
    ).length,
    stopped: Math.max(0, batch.manifest.jobs.length - Object.keys(state.jobs).length),
    state_file: stateFile,
    jobs: state.jobs,
  };
}
/** 清单状态由跨进程锁保护；进程崩溃后 60 秒失效，只恢复原 run_id，绝不自动创建 fresh 意图。 */
export async function runBatch(
  app: Application,
  batch: Awaited<ReturnType<typeof loadBatch>>,
  flags: Flags,
): Promise<Record<string, unknown>> {
  let compromised = false;
  let release: () => Promise<void>;
  try {
    release = await lock(batch.file + '.state.json', {
      realpath: false,
      stale: 60000,
      update: 10000,
      onCompromised: () => {
        compromised = true;
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOCKED')
      throw new TripoError(
        'BATCH_IN_USE',
        'Another process is running this manifest. After a crash, allow 60 seconds for lock expiry.',
      );
    throw error;
  }
  const assertLock = (): void => {
    if (compromised)
      throw new TripoError(
        'BATCH_LOCK_LOST',
        'Batch state lock was lost; inspect the original jobs before resuming.',
      );
  };
  try {
    return await runLockedBatch(app, batch, flags, assertLock);
  } finally {
    if (!compromised) await release();
  }
}
