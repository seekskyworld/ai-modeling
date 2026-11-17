/** 打印只交接已有成功产物；默认规划，显式执行才启动本机协议或下载原文件。 */
import { z } from 'zod';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolSpec, StudioReads } from '../commands.ts';
import { toolApplication, type Dependency } from '../tool-dependencies.ts';
import type { TaskService } from '../core/service.ts';
import { resolveJob, type Application } from './runtime.ts';
import type { Artifact, Job } from '../../studio/contracts/types.ts';
import { text, TripoError } from '../../studio/contracts/errors.ts';
import { needsExportTransform } from '../../studio/contracts/export-options.ts';
import { batchChild } from '../../studio/api/export-batch.ts';
import { allowedDownload } from '../artifacts/download.ts';
import {
  printPlatform,
  printTargets,
  printDelivery,
  printProtocol,
  printExportSuggestion,
  readPrintShop,
  printShopVendor,
  printTargetKeys,
  type PrintPlatform,
} from '../../studio/printing.ts';

export const printTargetsInput = z.object({}).strict();
const printFields = {
  task_id: z
    .string()
    .min(1)
    .describe(
      'An existing successful OBJ export for local or 3MF export for slicers; ZIP packages are downloaded only. No new export is created.',
    ),
  target: z.enum(printTargetKeys),
  artifact_id: z
    .string()
    .min(1)
    .optional()
    .describe('Required when the export task contains multiple artifacts.'),
  output_dir: z
    .string()
    .min(1)
    .optional()
    .describe('Caller-selected download directory for unsupported protocols or launch fallback.'),
};
export const printPlanInput = z.object(printFields).strict();
export const printOpenInput = z
  .object({
    ...printFields,
    execute: z
      .boolean()
      .default(false)
      .describe(
        'Explicitly allow opening the native slicer or downloading the original file. Omit to plan only.',
      ),
  })
  .strict();
export const printShopInput = z.object({ project_id: z.string().min(1) }).strict();

export interface PrintingRuntime {
  platform?: string;
  launch?: (protocol: string, platform: PrintPlatform) => Promise<void>;
}

export function listPrintTargets(input: unknown = {}, platform = process.platform): Record<string, unknown> {
  printTargetsInput.parse(input);
  const current = printPlatform(platform);
  return {
    platform: current,
    targets: printTargets(current),
    note: 'This hands existing files to a slicer. It does not validate printability or start a print job.',
  };
}

function printSource(
  app: Application,
  input: z.infer<typeof printPlanInput>,
): { job: Job; source: Job; artifact: Artifact } {
  const job = resolveJob(app, input.task_id);
  if (job.state !== 'succeeded')
    throw new TripoError('INPUT_NOT_READY', 'Wait for the existing export task to succeed before printing.');
  const requiredFormat = input.target === 'local' ? 'obj' : '3mf';
  if (!['export', 'export_batch'].includes(job.operation) || job.input.format !== requiredFormat)
    throw new TripoError(
      'INVALID_INPUT',
      `This print target requires an existing ${requiredFormat.toUpperCase()} export task. Explicitly export the model first.`,
    );
  if (!input.artifact_id && job.artifacts.length !== 1)
    throw new TripoError('INVALID_INPUT', 'Select the exact artifact_id from this multi-result export task.');
  const artifact = input.artifact_id
    ? job.artifacts.find((item) => item.artifact_id === input.artifact_id)
    : job.artifacts[0];
  if (!artifact || artifact.kind !== 'model')
    throw new TripoError('ARTIFACT_NOT_FOUND', 'No model artifact has that artifact_id.');
  if (
    input.target === 'local'
      ? !['obj', 'zip'].includes(artifact.format)
      : !['3mf', 'zip'].includes(artifact.format)
  )
    throw new TripoError(
      'ARTIFACT_FORMAT_MISMATCH',
      input.target === 'local'
        ? 'The saved artifact is not an OBJ file or its ZIP package.'
        : 'The saved artifact is not a 3MF file or its ZIP package.',
    );
  const source = job.operation === 'export_batch' ? batchChild(job, artifact.index) : job;
  if (!text(source.remote_ids.project_id))
    throw new TripoError('REMOTE_ID_MISSING', 'The original export project identity is missing.');
  return { job, source, artifact };
}

async function launchPrintProtocol(protocol: string, platform: PrintPlatform): Promise<void> {
  const command = platform === 'mac' ? 'open' : platform === 'windows' ? 'explorer.exe' : 'xdg-open';
  // execFile 的异常可能包含完整参数；调用方只返回固定错误码，绝不暴露签名深链。
  await promisify(execFile)(command, [protocol], { shell: false, timeout: 10000, maxBuffer: 1024 });
}

function printPlan(
  selected: ReturnType<typeof printSource>,
  input: z.infer<typeof printPlanInput>,
  platform: PrintPlatform,
): Record<string, unknown> {
  const { job, source, artifact } = selected;
  const transformed = job.operation === 'export' && needsExportTransform(job.input);
  const packaged = input.target !== 'local' && artifact.format === 'zip';
  const delivery = transformed || packaged ? 'download' : printDelivery(input.target, platform);
  return {
    task_id: job.job_id,
    artifact_id: artifact.artifact_id,
    project_id: source.remote_ids.project_id,
    ...(source.remote_ids.operator_id ? { operator_id: source.remote_ids.operator_id } : {}),
    format: artifact.format,
    export_format: job.input.format,
    target: input.target,
    platform,
    delivery,
    ...(input.target === 'local'
      ? {
          vertex_colors_requested: job.input.export_vertex_colors === true,
          colors_verified: false,
          ...(job.input.export_vertex_colors !== true
            ? {
                warnings: [
                  'The original OBJ export did not request vertex colors; downloading it cannot establish multi-color output.',
                ],
              }
            : {}),
        }
      : {}),
    ...(transformed
      ? {
          delivery_reason:
            'The final export requires local processing; its raw remote URL is not the processed file.',
        }
      : packaged
        ? {
            delivery_reason:
              'The original export is a ZIP package. Download and inspect it before importing the contained 3MF into a slicer.',
          }
        : {}),
    ...(input.output_dir ? { output_dir: path.resolve(input.output_dir) } : {}),
    ...(delivery === 'download' && !input.output_dir ? { required_arguments: ['output_dir'] } : {}),
    suggested_website_export: printExportSuggestion(
      text(source.remote_ids.project_id),
      input.target,
      platform,
    ),
    note: 'The export settings are a website reference; this handoff reuses the selected original task and creates no new export.',
    dry_run: true,
    handoff_requested: false,
    print_started: false,
  };
}

/** CLI 与 MCP 共用同一执行入口；runtime 仅供受控测试注入平台/启动器。 */
export async function openPrint(
  app: Application,
  input: unknown,
  runtime: PrintingRuntime = {},
): Promise<Record<string, unknown>> {
  const x = printOpenInput.parse(input);
  const selected = printSource(app, x);
  const platform = printPlatform(runtime.platform ?? process.platform);
  const plan = printPlan(selected, x, platform);
  if (!x.execute) return plan;
  const downloadOriginal = async (fallback: boolean): Promise<Record<string, unknown>> => {
    if (!x.output_dir)
      throw new TripoError('INVALID_INPUT', 'Supply output_dir to download this original export.');
    const name =
      text(selected.source.remote_ids.project_id)
        .replace(/[^A-Za-z0-9_-]/g, '_')
        .slice(0, 128) || selected.job.job_id;
    const saved = await app.service.download(
      selected.job.job_id,
      selected.artifact.artifact_id,
      path.join(path.resolve(x.output_dir), `${name}.${selected.artifact.format}`),
    );
    // 下载恢复可能附带远端错误细节；打印交接只返回已验证的本地文件元数据。
    const file = Object.fromEntries(
      [
        'job_id',
        'artifact_id',
        'local_path',
        'format',
        'bytes',
        'sha256',
        'processing',
        'source_sha256',
        'restored_from_cache',
      ]
        .filter((key) => saved[key] !== undefined)
        .map((key) => [key, saved[key]]),
    );
    return { ...plan, dry_run: false, delivery: 'download', fallback, file };
  };
  if (plan.delivery === 'download') return await downloadOriginal(false);
  const url = await app.service.gateway.artifactUrl(selected.job, selected.artifact);
  if (!allowedDownload(url))
    throw new TripoError('DOWNLOAD_HOST_DENIED', 'Artifact URL is outside Tripo storage hosts.');
  const protocol = printProtocol(x.target, url, text(selected.source.remote_ids.project_id), platform);
  if (!protocol) return await downloadOriginal(false);
  try {
    await (runtime.launch ?? launchPrintProtocol)(protocol, platform);
  } catch {
    if (x.output_dir) return await downloadOriginal(true);
    throw new TripoError(
      'PRINT_HANDOFF_FAILED',
      'Could not open the slicer. Supply output_dir to download the original export instead.',
    );
  }
  return {
    ...plan,
    dry_run: false,
    handoff_requested: true,
    note: 'The system accepted the application handoff request. Import completion and printing are controlled by the slicer.',
  };
}

export async function printShop(app: Application, input: unknown): Promise<Record<string, unknown>> {
  const x = printShopInput.parse(input);
  const client = app.studio.client.forAccount(app.service.accountRef());
  const status = await readPrintShop(client, x.project_id);
  return {
    vendor: printShopVendor.name,
    vendor_url: printShopVendor.url,
    ...status,
    ...(status.reason === 'private_project'
      ? {
          next: {
            tool: 'ai_modeling_project_visibility',
            arguments: { project_id: x.project_id, visibility: 'shareable' },
          },
          note: 'Explicitly make the original project shareable with the native visibility command before providing its ID to the print shop.',
        }
      : {
          note: status.ready
            ? 'Provide this project ID on the vendor website. No visibility change or order has been submitted.'
            : 'The website does not allow sharing this private project.',
        }),
    order_submitted: false,
  };
}

export function printingTools(service: Dependency<TaskService>, studio: Dependency<StudioReads>): ToolSpec[] {
  const app = toolApplication(service, studio);
  return [
    {
      name: 'ai_modeling_print_targets',
      description:
        'List Studio slicer targets and current-platform protocol/download support. No app is opened.',
      schema: printTargetsInput,
      readOnly: true,
      run: async (input) => listPrintTargets(input),
    },
    {
      name: 'ai_modeling_print_plan',
      description:
        'Plan handing an existing standalone 3MF export to a slicer or downloading an existing OBJ/export ZIP. Returns metadata, never signed URLs; does not export, download, or open an app.',
      schema: printPlanInput,
      readOnly: true,
      run: (input) => openPrint(app, { ...input, execute: false }),
    },
    {
      name: 'ai_modeling_print_open',
      description:
        'Hand an existing successful standalone 3MF export to a Studio-compatible slicer, or download an original export ZIP/OBJ. Defaults to plan only; execute=true explicitly opens/downloads to output_dir. No new export or print order is created.',
      schema: printOpenInput,
      readOnly: false,
      run: (input) => openPrint(app, input),
    },
    {
      name: 'ai_modeling_print_shop',
      description:
        'Read JuJuBit print-shop information for a project. Private projects require a separate explicit native visibility action; never publishes a project or creates an order.',
      schema: printShopInput,
      readOnly: true,
      run: (input) => printShop(app, input),
    },
  ];
}
