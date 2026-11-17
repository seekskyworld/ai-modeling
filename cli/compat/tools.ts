/** 官方 MCP 常用工具映射到 CLI 执行器；协议适配层无需理解任务实现。 */
import { z } from 'zod';
import type { ToolSpec, StudioReads } from '../commands.ts';
import { toolApplication, type Dependency } from '../tool-dependencies.ts';
import type { TaskService } from '../core/service.ts';
import { makePlan } from './planning.ts';
import { executePlan, resolveJob, taskResult, waitTask, downloadTask, historyResult } from './runtime.ts';
import { text, object, array } from '../../studio/contracts/errors.ts';
export function compatibleTools(
  service: Dependency<TaskService>,
  studio: Dependency<StudioReads>,
): ToolSpec[] {
  const app = toolApplication(service, studio);
  return [
    {
      name: 'ai_modeling_make',
      description:
        'Generate a 3D asset from text, an image path, a model file path, or an existing task id. Blocks until finished; downloads artifacts locally and returns file paths. Uses your Studio web credits.',
      schema: z
        .object({
          input: z.string().min(1),
          scenario: z.string().optional(),
          then: z.string().optional(),
          model: z.string().optional(),
          pbr: z.boolean().default(false),
          output_dir: z.string().optional(),
          request_id: z.string().optional(),
          timeout: z.number().int().min(0).max(7200).default(1800),
          no_wait: z.boolean().default(false),
          no_download: z.boolean().default(false),
        })
        .strict(),
      readOnly: false,
      run: async (x) => {
        const flags = {
          for: x.scenario,
          then: x.then,
          model: x.model,
          param: { pbr: x.pbr, ...(x.pbr ? { texture: true } : {}) },
          out: x.output_dir,
          requestId: x.request_id,
          timeout: x.timeout,
          wait: !x.no_wait,
          download: !x.no_download,
        };
        return await executePlan(app, makePlan([text(x.input)], flags), flags);
      },
    },
    {
      name: 'ai_modeling_task_get',
      description: 'Get the status/details of a Tripo task by id.',
      schema: z.object({ task_id: z.string().min(1) }).strict(),
      readOnly: true,
      run: async (x) => taskResult(await app.service.get(resolveJob(app, text(x.task_id)).job_id)),
    },
    {
      name: 'ai_modeling_task_wait',
      description: 'Block until a Tripo task finishes; optionally download artifacts.',
      schema: z
        .object({
          task_id: z.string().min(1),
          download: z.boolean().default(true),
          output_dir: z.string().optional(),
          timeout: z.number().int().min(0).max(7200).default(1800),
        })
        .strict(),
      readOnly: false,
      run: async (x) => {
        const job = await waitTask(app, resolveJob(app, text(x.task_id)).job_id, Number(x.timeout));
        return {
          ...taskResult(job),
          ...(x.download && job.state === 'succeeded'
            ? await downloadTask(app, job, { out: x.output_dir })
            : {}),
        };
      },
    },
    {
      name: 'ai_modeling_balance',
      description: 'Get the account credit balance.',
      schema: z.object({}).strict(),
      readOnly: true,
      run: async () => await app.service.gateway.account(),
    },
    {
      name: 'ai_modeling_history',
      description: 'List recent tasks created by this CLI (task ids, names, statuses, output dirs).',
      schema: z.object({ limit: z.number().int().min(1).max(100).default(10) }).strict(),
      readOnly: true,
      run: async (x) =>
        array(app.service.list(Number(x.limit), 0).jobs).map((job) => historyResult(app, object(job))),
    },
  ];
}
