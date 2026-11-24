/** 官方 MCP 常用工具映射到 CLI 执行器；协议适配层无需理解任务实现。 */
import { z } from 'zod';
import type { ToolSpec, StudioReads } from '../commands.ts';
import { toolApplication, type Dependency } from '../tool-dependencies.ts';
import type { TaskService } from '../core/service.ts';
import { makePlan } from './planning.ts';
import { classifyMakeInputs } from './make-input.ts';
import { executePlan, resolveJob, taskResult, waitTask, downloadTask, historyResult } from './runtime.ts';
import { text, object, array, TripoError } from '../../studio/contracts/errors.ts';
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
          pbr: z
            .boolean()
            .default(false)
            .describe(
              'PBR for image/text generation or texture steps from existing tasks. For a model file, use an explicit then texture:pbr=true step.',
            ),
          accept_variable_cost: z
            .literal(true)
            .optional()
            .describe(
              'Explicitly accept unknown Studio charges for the initial model-file import under a current reviewed snapshot. Omit max_estimated_credits. For a later UV compression step, pass accept_variable_cost=true inside that then step; this does not grant blanket consent to the chain.',
            ),
          max_estimated_credits: z
            .number()
            .finite()
            .nonnegative()
            .optional()
            .describe(
              'Maximum reviewed estimate per step, not an upstream spending cap. Cannot be combined with explicitly accepted unquoted import/apply steps.',
            ),
          output_dir: z.string().optional(),
          request_id: z.string().optional(),
          timeout: z.number().int().min(0).max(7200).default(1800),
          no_wait: z.boolean().default(false),
          no_download: z.boolean().default(false),
        })
        .strict(),
      readOnly: false,
      run: async (x) => {
        const modelInput = classifyMakeInputs([text(x.input)]).kind === 'model';
        if (x.accept_variable_cost === true && !modelInput)
          throw new TripoError(
            'STUDIO_CAPABILITY_UNAVAILABLE',
            'Top-level accept_variable_cost only applies to an initial model-file import. For a later unquoted processing step, set accept_variable_cost=true inside that then step.',
            'not_submitted',
          );
        if (modelInput && x.pbr === true)
          throw new TripoError(
            'STUDIO_CAPABILITY_UNAVAILABLE',
            'Importing a model file does not generate PBR textures. Omit top-level pbr and select an explicit then texture:pbr=true step.',
            'not_submitted',
          );
        const flags = {
          for: x.scenario,
          then: x.then,
          model: x.model,
          param: modelInput
            ? { ...(x.accept_variable_cost === true ? { accept_variable_cost: true } : {}) }
            : { pbr: x.pbr, ...(x.pbr ? { texture: true } : {}) },
          ...(x.max_estimated_credits === undefined ? {} : { maxCredits: x.max_estimated_credits }),
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
