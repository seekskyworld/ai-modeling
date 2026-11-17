/** 工具注册只做参数与协议边界转换，业务状态均由核心服务维护。 */
import { z } from 'zod';
import { compatibleTools } from './compat/tools.ts';
import { fullTools } from './compat/full-tools.ts';
import { printingTools } from './compat/printing.ts';
import { resources, callResource } from '../studio/api/resources.ts';
import { canvasResources, callCanvas } from '../studio/api/canvas.ts';
import { extractionMemory } from './storage/extraction.ts';
import { canvasUploadOptionsSchema, uploadCanvasFile } from '../studio/api/canvas-upload.ts';
import { errorResult, object, text, TripoError } from '../studio/contracts/errors.ts';
import { discoverCapabilities } from '../studio/api/discovery.ts';
import { id, operationSchemas, submissionSchema } from '../studio/contracts/schemas.ts';
import { jobView, type TaskService } from './core/service.ts';
import { executePlan, type Application } from './compat/runtime.ts';
import { expandSegmentationPlan } from './compat/segmentation-plan.ts';
import type { Operation } from '../studio/contracts/types.ts';
import type { StudioGateway } from '../studio/api/gateway.ts';
import { variableCanvasOperations } from '../studio/contracts/canvas-agent.ts';
import { motionPresetSchema, listMotionPresets } from '../studio/contracts/motion-presets.ts';
import { existingArtifactSchema } from '../studio/api/existing-artifact.ts';
import { downloadAccountArtifact } from './artifacts/library-download.ts';
import { localOperations, runLocal } from './local/operations.ts';
import { operationDescriptions } from './core/operation-descriptions.ts';
import { exportFrontend, frontendExportSchema, frontendExportDescription } from './core/frontend-export.ts';
import { runtimeTools } from './runtime/tools.ts';
import { authenticationTools } from './auth/tools.ts';
import { toolApplication, type Dependency } from './tool-dependencies.ts';
import { assetsListSchema, listAssets } from './assets/list.ts';

const operations = z.enum(Object.keys(operationSchemas) as [Operation, ...Operation[]]);
const pagination = {
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).max(1000000).default(0),
};
export interface ToolSpec {
  name: string;
  description: string;
  schema: z.ZodType;
  jsonSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  readOnly: boolean;
  destructive?: boolean;
  run: (input: Record<string, unknown>) => Promise<unknown>;
}
export interface StudioReads {
  assets: StudioGateway['assets'];
  client: Pick<StudioGateway['client'], 'request'>;
}
export function toolRegistry(
  service: Dependency<TaskService>,
  studio: Dependency<StudioReads>,
  toolset = 'studio',
): ToolSpec[] {
  const context = toolApplication(service, studio);
  if (toolset === 'full') return fullTools(service, studio);
  if (toolset === 'default')
    return [...compatibleTools(service, studio), nativeOperationTool('image', context)];
  if (toolset !== 'studio') throw new TripoError('INVALID_INPUT', 'toolset must be default, full or studio.');
  const definitions: ToolSpec[] = [
    ...authenticationTools(() => context.service.config),
    ...runtimeTools(() => context.service.config),
    ...printingTools(service, studio),
    {
      name: 'ai_modeling_frontend_export',
      description: frontendExportDescription,
      schema: frontendExportSchema,
      readOnly: false,
      run: async (input) =>
        await exportFrontend(context.service, context.studio.client as StudioGateway['client'], input),
    },
    ...localOperations.map((spec) => ({
      name: `ai_modeling_${spec.name}`,
      description: spec.description,
      schema: spec.schema,
      readOnly: spec.readOnly ?? false,
      run: async (input: Record<string, unknown>) => await runLocal(context.service.config, spec, input),
    })),
    {
      name: 'ai_modeling_asset_download',
      description:
        'Download an existing Studio or Canvas asset, a template image shown by the webpage, exact applied motion, segmentation preview, Lab file/input representation or UV layout to a caller-selected path. Creates no generation or export task; requires the exact source context. Segmentation previews are normalized images, not original-image pixel masks.',
      schema: existingArtifactSchema,
      readOnly: false,
      run: async (x) =>
        await downloadAccountArtifact(context.studio.client as StudioGateway['client'], context.service, x),
    },
    {
      name: 'ai_modeling_motion_presets',
      description:
        'List Studio preset animation identifiers by skeleton and category. Uses a dated local catalogue; no login required.',
      schema: motionPresetSchema,
      readOnly: true,
      run: async (x) => listMotionPresets(x),
    },
    {
      name: 'ai_modeling_canvas_upload',
      description:
        'Upload an image, model or Lab video to a Canvas project. Model imports support a transform and UV preservation; optionally wait for the accepted input asset to become ready. No node is added automatically.',
      schema: canvasUploadOptionsSchema.extend({ project_id: id, file_path: z.string().min(1) }),
      readOnly: false,
      run: async (x) => {
        const { project_id, file_path, ...options } = x;
        return await uploadCanvasFile(
          context.studio.client as StudioGateway['client'],
          String(project_id),
          String(file_path),
          context.service.config.inputRoots,
          canvasUploadOptionsSchema.parse(options),
        );
      },
    },
    {
      name: 'ai_modeling_account_status',
      description: 'Check your Studio session and credits. Returns no credentials.',
      schema: z.object({}).strict(),
      readOnly: true,
      run: async () => await context.service.gateway.account(),
    },
    {
      name: 'ai_modeling_capabilities',
      description: 'List implemented operations plus live account quota. Unknown permissions remain unknown.',
      schema: z.object({}).strict(),
      readOnly: true,
      run: async () => {
        return {
          contract_version: 'studio-2026-11-12',
          operations: Object.keys(operationSchemas),
          ...(await discoverCapabilities(context.studio.client)),
        };
      },
    },
    {
      name: 'ai_modeling_assets_list',
      description: 'List your Studio model or image assets using bounded pagination.',
      schema: assetsListSchema,
      readOnly: true,
      run: async (x) => await listAssets(context.studio, x),
    },
    {
      name: 'ai_modeling_quote',
      description:
        'Estimate credits before discounts from reviewed current evidence. Unknown prices block submission. Estimates are not an upstream spending cap.',
      schema: z.object({ operation: operations, parameters: z.record(z.string(), z.unknown()) }).strict(),
      readOnly: true,
      run: async (x) => await context.service.quote(x.operation as Operation, x.parameters),
    },
    {
      name: 'ai_modeling_jobs_list',
      description: 'List persistent local jobs for the current verified account.',
      schema: z.object(pagination).strict(),
      readOnly: true,
      run: async (x) => context.service.list(Number(x.limit), Number(x.offset)),
    },
    {
      name: 'ai_modeling_job_get',
      description:
        'Refresh a job using its original remote ID. Never resubmits generation. wait_seconds is bounded to 30.',
      schema: z.object({ job_id: id, wait_seconds: z.number().int().min(0).max(30).default(0) }).strict(),
      readOnly: true,
      run: async (x) => await context.service.get(String(x.job_id), Number(x.wait_seconds)),
    },
    {
      name: 'ai_modeling_artifact_download',
      description:
        'Download an available artifact from a completed job, including completed steps of a failed Canvas run, to a caller-selected absolute destination_path. Optional configured roots can restrict access. Checks format and SHA256; never overwrites.',
      schema: z
        .object({
          job_id: id,
          artifact_id: id,
          destination_path: z.string().min(1).max(4096).optional(),
          relative_path: z.string().min(1).max(4096).optional(),
        })
        .strict()
        .refine(
          (x) => Boolean(x.destination_path) !== Boolean(x.relative_path),
          'Supply exactly one destination_path or relative_path.',
        ),
      readOnly: false,
      run: async (x) =>
        await context.service.download(
          String(x.job_id),
          String(x.artifact_id),
          String(x.destination_path ?? x.relative_path),
        ),
    },
    {
      name: 'ai_modeling_job_reconcile',
      description:
        'Link an outcome_unknown job or missing export/model batch receipts to exact original Studio IDs after manual reconciliation. Read-only upstream verification; no new generation.',
      schema: z
        .object({
          job_id: id,
          remote_ids: z
            .object({
              task_id: id.optional(),
              asset_id: id.optional(),
              project_id: id.optional(),
              operator_id: id.optional(),
              batch: z
                .array(z.object({ project_id: id, operator_id: id }).strict())
                .min(1)
                .max(10)
                .optional(),
              models: z
                .array(
                  z
                    .object({ index: z.number().int().nonnegative(), project_id: id, operator_id: id })
                    .strict(),
                )
                .min(1)
                .max(10)
                .optional(),
            })
            .strict(),
        })
        .strict(),
      readOnly: false,
      run: async (x) => await context.service.reconcile(String(x.job_id), x.remote_ids),
    },
  ];
  for (const operation of operations.options) definitions.push(nativeOperationTool(operation, context));
  for (const spec of resources)
    definitions.push({
      name: `ai_modeling_${spec.name}`,
      description: spec.description,
      schema: spec.schema,
      readOnly: spec.readOnly,
      destructive: spec.destructive,
      run: async (x) => await callResource(context.studio.client as StudioGateway['client'], spec, x),
    });
  for (const spec of canvasResources)
    definitions.push({
      name: `ai_modeling_canvas_${spec.name}`,
      description: spec.description,
      schema: spec.schema,
      readOnly: spec.readOnly,
      destructive: spec.destructive,
      run: async (x) =>
        await callCanvas(
          context.studio.client as StudioGateway['client'],
          spec,
          x,
          extractionMemory(context.service),
        ),
    });
  definitions.push(...compatibleTools(service, studio));
  return definitions;
}
/** Shared Studio input and execution for the default image tool and the extended registry. */
function nativeOperationTool(operation: Operation, context: ReturnType<typeof toolApplication>): ToolSpec {
  const names: Partial<Record<Operation, string>> = {
    image: 'ai_modeling_image_generate',
    model: 'ai_modeling_model_generate',
    texture: 'ai_modeling_texture_generate',
    rig: 'ai_modeling_model_rig',
    animate: 'ai_modeling_model_animate',
    export: 'ai_modeling_model_export',
  };
  return {
    name: names[operation] ?? `ai_modeling_${operation}`,
    description: `${operationDescriptions[operation]}. Uses your Studio account and a stable request_id. Reuse returns the original job; changed input conflicts; outcome_unknown must never be blindly retried.`,
    schema:
      variableCanvasOperations.has(operation) || operation === 'refine_submit'
        ? z.object({ request_id: id, parameters: operationSchemas[operation] }).strict()
        : submissionSchema.extend({ parameters: operationSchemas[operation] }),
    readOnly: false,
    run: async (x) => await submitOperation(context.service, context.studio, operation, x),
  };
}
/** 带矩阵的手工标签保存与 CLI 使用同一原生处理链；MCP 仍保持 Studio job 包装。 */
async function submitOperation(
  service: TaskService,
  studio: StudioReads,
  operation: Operation,
  input: Record<string, unknown>,
): Promise<unknown> {
  const parameters = object(input.parameters);
  if (operation === 'modification' && parameters.indices_path) {
    const plan = await expandSegmentationPlan(
      { steps: [{ name: operation, operation, parameters }], pending_uploads: [], warnings: [] },
      service.config.inputRoots,
    );
    if (plan.steps.length > 1) {
      const result = await executePlan({ service, studio } as Application, plan, {
        requestId: text(input.request_id),
        maxCredits: Number(input.max_estimated_credits ?? 0),
        wait: true,
        download: false,
        timeout: 180,
      });
      return {
        ...jobView(service.jobs.get(text(result.task_id))),
        chain: result.chain,
        warnings: plan.warnings,
      };
    }
  }
  return await service.submit(
    operation,
    text(input.request_id),
    parameters,
    Number(input.max_estimated_credits ?? 0),
  );
}
export async function callTool(
  definitions: ToolSpec[],
  name: string,
  input: unknown,
  beforeRun?: (tool: ToolSpec, parameters: Record<string, unknown>) => Promise<void>,
): Promise<{
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}> {
  let parameters: Record<string, unknown> | undefined;
  try {
    const tool = definitions.find((tool) => tool.name === name);
    if (!tool) throw new TripoError('UNKNOWN_TOOL', 'No tool has that name.');
    parameters = tool.schema.parse(input ?? {}) as Record<string, unknown>;
    await beforeRun?.(tool, parameters);
    const data = { result: await tool.run(parameters) };
    return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
  } catch (error) {
    if (error instanceof TripoError && error.code === 'AUTH_REQUIRED' && parameters?.request_id)
      error.details = { ...error.details, request_id: parameters.request_id };
    const details =
      error instanceof z.ZodError
        ? {
            code: 'INVALID_INPUT',
            issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
          }
        : errorResult(error);
    const data = { error: details };
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(data) }],
      structuredContent: data,
    };
  }
}

/** Pure schema discovery shares the executable registry but never resolves its runtime dependencies. */
export function toolMetadata(toolset = 'studio') {
  const unavailable = (): never => {
    throw new Error('Tool metadata cannot execute a runtime.');
  };
  return toolRegistry(unavailable, unavailable, toolset).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.jsonSchema ?? z.toJSONSchema(tool.schema, { target: 'draft-7', io: 'input' }),
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    annotations: {
      readOnlyHint: tool.readOnly,
      destructiveHint: tool.destructive ?? false,
      openWorldHint: true,
    },
  }));
}
