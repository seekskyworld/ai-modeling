/** 官方 full MCP 参数经 CLI 规划器映射到 Studio；协议进程不接触鉴权或业务实现。 */
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { ToolSpec, StudioReads } from '../commands.ts';
import { toolApplication, type Dependency } from '../tool-dependencies.ts';
import type { TaskService } from '../core/service.ts';
import { environmentValue } from '../core/environment.ts';
import { object, text, array, TripoError } from '../../studio/contracts/errors.ts';
import { usageReport } from './usage.ts';
import { validatePublicConversion } from './processing-policy.ts';
import { generationPlan, processingPlan, type Plan, type Flags } from './planning.ts';
import {
  executePlan,
  resolveJob,
  taskResult,
  waitTask,
  downloadTask,
  pipelineDetails,
  queryTasks,
  type Application,
} from './runtime.ts';
import { uploadLocal } from './uploads.ts';
import { materializeInputs } from '../artifacts/source.ts';
import { fullContract } from './full-contract.ts';
import { dryRunPlan } from './run-plan.ts';
import { taskNextAction } from './execution-policy.ts';
export const generationNames: Record<string, string> = {
  ai_modeling_text_to_3d: 'text-to-model',
  ai_modeling_image_to_3d: 'image-to-model',
  ai_modeling_multiview_to_3d: 'multiview-to-model',
  ai_modeling_image_to_splat: 'image-to-splat',
  ai_modeling_image_to_multiview: 'image-to-multiview',
  ai_modeling_edit_multiview: 'edit-multiview',
};
export const processingNames: Record<string, string> = {
  ai_modeling_import_model: 'import',
  ai_modeling_texture: 'texture',
  ai_modeling_rig: 'rig',
  ai_modeling_animate: 'retarget',
  ai_modeling_convert: 'convert',
  ai_modeling_decimate: 'decimate',
  ai_modeling_smart_uv: 'uv',
  ai_modeling_segment: 'segment',
  ai_modeling_mesh_complete: 'complete',
  ai_modeling_mesh_edit: 'edit',
  ai_modeling_smart_segment: 'smartsegment',
};
function options(x: Record<string, unknown>): Flags {
  const param = { ...x };
  for (const k of [
    'input',
    'inputs',
    'task_id',
    'front',
    'left',
    'back',
    'right',
    'multiview_task_id',
    'dry_run',
    'request_id',
    'model',
  ])
    delete param[k];
  return { model: x.model, param, requestId: x.request_id, wait: false, download: false };
}

/** 显式空图片输入是无效编辑，不得因为 falsy 值悄悄切到收费文生图。 */
function imageArguments(x: Record<string, unknown>): { kind: string; inputs: string[] } {
  const single = x.input !== undefined;
  const multiple = x.inputs !== undefined;
  if (single && multiple)
    throw new TripoError('INVALID_INPUT', 'Specify input or inputs, not both.', 'not_submitted');
  if (!single && !multiple) return { kind: 'text-to-image', inputs: [text(x.prompt)] };
  const values = multiple ? x.inputs : [x.input];
  if (
    !Array.isArray(values) ||
    !values.length ||
    values.some((value) => typeof value !== 'string' || !value.trim())
  )
    throw new TripoError(
      'INVALID_INPUT',
      'Image editing requires nonempty image references.',
      'not_submitted',
    );
  return { kind: 'image-to-image', inputs: values as string[] };
}

export function fullToolPlan(name: string, x: Record<string, unknown>): Plan {
  const flags = options(x);
  const param = object(flags.param);
  let kind = generationNames[name];
  let inputs = [text(x.input)];
  if (name === 'ai_modeling_generate_image') {
    ({ kind, inputs } = imageArguments(x));
    flags.prompt = x.prompt;
  }
  if (name === 'ai_modeling_text_to_3d') {
    inputs = [text(x.prompt)];
    delete param.prompt;
  }
  // 官方 full MCP 将这两个 prompt 当作兼容字段移除；普通 CLI 的 -p prompt 仍保留原校验。
  if (name === 'ai_modeling_image_to_3d' || name === 'ai_modeling_multiview_to_3d') delete param.prompt;
  if (name === 'ai_modeling_multiview_to_3d') {
    flags.viewSlots = ['front', 'left', 'back', 'right'].map((key) => x[key] ?? null);
    if (x.multiview_task_id && ['front', 'left', 'back', 'right'].some((key) => x[key]))
      throw new TripoError('INVALID_INPUT', 'multiview_task_id replaces explicit views.');
    inputs = x.multiview_task_id
      ? [text(x.multiview_task_id)]
      : ['front', 'left', 'back', 'right'].filter((key) => x[key]).map((key) => text(x[key]));
    if (!x.multiview_task_id && !x.front)
      throw new TripoError('INVALID_INPUT', 'multiview requires the front view.');
  }
  if (kind) {
    return generationPlan(kind, inputs, flags);
  }
  const processing = processingNames[name];
  if (!processing) throw new TripoError('INVALID_INPUT', `Not a task tool: ${name}`);
  if (processing === 'convert') validatePublicConversion(flags);
  return processingPlan(processing, text(x.input ?? x.task_id), flags);
}
export async function checkRig(app: Application, input: string, flags: Flags = {}): Promise<unknown> {
  return await executePlan(app, processingPlan('rig-check', input, flags), {
    ...flags,
    wait: true,
    download: false,
  });
}
async function queryTask(
  app: Application,
  x: Record<string, unknown>,
  wait = false,
): Promise<Record<string, unknown>> {
  const id = resolveJob(app, text(x.task_id)).job_id;
  const job = wait
    ? await waitTask(app, id, Math.min(55, Number(x.timeout_seconds ?? 55)))
    : await app.service.get(id);
  return {
    ...taskResult(job),
    ...(x.steps ? { steps: pipelineDetails(app, id) } : {}),
    output_urls: [],
    next: taskNextAction(taskResult(job)),
  };
}
/** 计划必须验证调用方的原始提示，不能用占位提示绕过实际长度和必填检查。 */
function advisoryGeneration(name: string, input: Record<string, unknown>): Plan {
  const placeholders: Record<string, Record<string, string>> = {
    ai_modeling_text_to_3d: {},
    ai_modeling_image_to_3d: { input: 'placeholder.png' },
    ai_modeling_multiview_to_3d: { front: 'front.png', back: 'back.png' },
  };
  if (!Object.hasOwn(placeholders, name))
    throw new TripoError('INVALID_INPUT', 'generation parameters only apply to 3D generation tools.');
  return fullToolPlan(name, { ...input, ...placeholders[name], dry_run: true });
}
function advisory(x: Record<string, unknown>): unknown {
  return {
    goal: x.goal,
    backend: 'studio',
    steps: array(x.steps).map((value) => {
      const item = object(value);
      const name = text(item.tool);
      const billed = Boolean(
        generationNames[name] || processingNames[name] || name === 'ai_modeling_generate_image',
      );
      return {
        ...item,
        billed,
        cost_estimate: billed ? 'not_estimated' : 'no generation charge',
        ...(item.generation
          ? {
              plan: advisoryGeneration(name, object(item.generation)),
            }
          : {}),
      };
    }),
    cost_estimate: 'not_estimated',
    notes: [
      'Studio prices are checked when submitting. An unestimated price is not zero. This advisory call creates no tasks.',
    ],
  };
}
async function callFull(name: string, x: Record<string, unknown>, app: Application): Promise<unknown> {
  if (name === 'ai_modeling_plan') return advisory(x);
  if (name === 'ai_modeling_balance') return await app.studio.account();
  if (name === 'ai_modeling_usage') return await usageReport(app, x);
  if (name === 'ai_modeling_rig_check') return await checkRig(app, text(x.input), options(x));
  if (name === 'ai_modeling_task_status' || name === 'ai_modeling_task_wait')
    return await queryTask(app, x, name === 'ai_modeling_task_wait');
  if (name === 'ai_modeling_task_list') return await queryTasks(app, array(x.task_ids).map(text));
  if (name === 'ai_modeling_download') {
    const job = await app.service.get(resolveJob(app, text(x.task_id)).job_id);
    if (job.state !== 'succeeded') throw new TripoError('INPUT_NOT_READY', 'Task has not succeeded.');
    return { task_id: job.job_id, ...(await downloadTask(app, job, { out: x.output_dir })) };
  }
  if (name === 'ai_modeling_upload_image') {
    const plan: Plan = {
      steps: [{ name: 'upload', operation: 'image', parameters: { image_path: x.url } }],
      pending_uploads: [],
      warnings: [],
    };
    const resolved = await materializeInputs(
      plan,
      app.service.config.dataDir,
      text(x.request_id) || randomUUID(),
    );
    return await uploadLocal(app, text(resolved.steps[0]?.parameters.image_path));
  }
  const plan = fullToolPlan(name, x);
  if (x.dry_run) return await dryRunPlan(plan, {});
  const result = await executePlan(app, plan, { ...options(x), wait: plan.steps.length > 1 });
  return { ...result, next: taskNextAction(result) };
}
export function fullTools(service: Dependency<TaskService>, studio: Dependency<StudioReads>): ToolSpec[] {
  const app = toolApplication(service, studio);
  return fullContract
    .filter((spec) => !spec.experimental || environmentValue('EXPERIMENTAL_MESH_EDIT') === '1')
    .map((spec) => ({
      name: spec.name,
      description: spec.description,
      jsonSchema: spec.inputSchema,
      ...(spec.name === 'ai_modeling_usage' ? { outputSchema: spec.outputSchema } : {}),
      schema: z.fromJSONSchema(spec.inputSchema),
      readOnly: [
        'ai_modeling_plan',
        'ai_modeling_balance',
        'ai_modeling_usage',
        'ai_modeling_task_status',
        'ai_modeling_task_wait',
        'ai_modeling_task_list',
      ].includes(spec.name),
      run: async (x) => await callFull(spec.name, x, app),
    }));
}
