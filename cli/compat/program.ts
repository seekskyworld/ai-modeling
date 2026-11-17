/** 兼容官方 tripo-cli 的命令词与常用选项；所有执行都进入本项目 Studio 后端。 */
import { Command, CommanderError } from 'commander';
import { randomUUID } from 'node:crypto';
import { VERSION } from '../../version.ts';
import { configFromEnv } from '../core/config.ts';
import { z } from 'zod';
import { createApplication } from '../core/application.ts';
import { operationDescriptions } from '../core/operation-descriptions.ts';
import { object, text, array, TripoError, errorResult } from '../../studio/contracts/errors.ts';
import { resources, callResource } from '../../studio/api/resources.ts';
import { canvasResources, callCanvas } from '../../studio/api/canvas.ts';
import { extractionMemory } from '../storage/extraction.ts';
import { canvasUploadOptionsSchema, uploadCanvasFile } from '../../studio/api/canvas-upload.ts';
import { loadBatch, runBatch } from './batch.ts';
import { processingInput } from './input.ts';
import { registerSupport } from './support.ts';
import { registerPrinting } from './printing-program.ts';
import { listModels } from './catalog.ts';
import { printResult, confirmPlan, registerHome } from './presentation.ts';
import { contextFlags } from './settings.ts';
import { notifyDone } from './desktop.ts';
import {
  dryRunPlan,
  executeCandidates,
  executionPreview,
  validateExecution,
  validatePlanFiles,
} from './run-plan.ts';
import { registerCompletion } from './completion.ts';
import { registerRuntime } from '../runtime/commands.ts';
import { registerSkill } from '../install/commands.ts';
import { registerAssets } from '../assets/commands.ts';
import { exportGolutraPlugin } from '../integrations/golutra-agent.ts';
import { resourceOptions, resourceInput } from './resource-options.ts';
import { motionPresetSchema, listMotionPresets } from '../../studio/contracts/motion-presets.ts';
import { existingArtifactSchema } from '../../studio/api/existing-artifact.ts';
import { downloadAccountArtifact } from '../artifacts/library-download.ts';
import { registerAi } from './ai.ts';
import { launchMcp } from './launch.ts';
import { applyOfficialHelp } from './help.ts';
import { validatePublicConversion } from './processing-policy.ts';
import { validateSmartSegmentFiles } from './smartsegment-file-preflight.ts';
import { operationSchemas, normalize } from '../../studio/contracts/schemas.ts';
import type { Operation } from '../../studio/contracts/types.ts';
import { eventSchema, readCanvasEvents } from '../../studio/api/canvas-events.ts';
import { localOperations, runLocal } from '../local/operations.ts';
import { exportFrontend, frontendExportSchema, frontendExportDescription } from '../core/frontend-export.ts';
import { generationPlan, processingPlan, makePlan, type Flags, type Plan } from './planning.ts';
import {
  resolveJob,
  taskResult,
  waitTask,
  downloadTask,
  pipelineDetails,
  queryTasks,
  historyResult,
  taskExitCode,
  type Application,
} from './runtime.ts';
import { prepareAuthentication } from '../auth/recovery.ts';
export const emit = printResult;
async function usingApp<T>(run: (app: Application) => Promise<T>): Promise<T> {
  const app = await createApplication();
  try {
    await prepareAuthentication(app.service.config, app.service.credentials);
    return await run(app);
  } finally {
    app.close();
  }
}
export function collectParam(raw: string, previous: Record<string, unknown>): Record<string, unknown> {
  const index = raw.indexOf('=');
  if (index <= 0) throw new TripoError('INVALID_INPUT', '--param expects key=value.');
  const key = raw.slice(0, index).trim();
  if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new TripoError('INVALID_INPUT', 'Invalid parameter name.');
  const value = raw.slice(index + 1).trim();
  let decoded: unknown = value;
  try {
    decoded = JSON.parse(value);
  } catch {
    /* 非 JSON 文本保持原样，如格式名或提示词。 */
  }
  return { ...previous, [key]: decoded };
}
function common(cmd: Command): Command {
  return cmd
    .option('-o, --out <dir>', 'output directory (default ./ai-modeling-out/...)')
    .option('--no-wait', 'submit only; do not wait for completion')
    .option('--no-download', 'wait but skip downloading artifacts')
    .option('--notify', 'desktop notification when done')
    .option('--timeout <seconds>', 'watch timeout in seconds', Number)
    .option('--name <name>', 'history name for @references')
    .option('-p, --param <key=value>', 'extra API parameter (repeatable)', collectParam, {})
    .option('--request-id <id>', 'Studio extension: reuse the original submission intent')
    .option('--max-credits <n>', 'Studio extension: maximum estimated credits per step', Number)
    .option('--dry-run', 'plan + validate only; no network calls, uploads or credits');
}
async function runPlan(plan: Plan, flags: Flags): Promise<void> {
  const recoveryLayout = Boolean(
    flags.requestId && (plan.generationLayout || plan.smartSegmentAffine) && !flags.dryRun,
  );
  const guardedSource = Boolean(
    flags.requestId && (plan.smartSegmentScale || plan.smartSegmentTransform || plan.smartSegmentAffine),
  );
  validateExecution(plan, recoveryLayout ? { ...flags, wait: true } : flags);
  if (flags.dryRun) {
    emit(await dryRunPlan(plan, flags));
    return;
  }
  if (!guardedSource) await validatePlanFiles(plan);
  if (!recoveryLayout && !(await confirmPlan(plan, flags))) {
    emit({ cancelled: true });
    return;
  }
  flags = { ...flags, requestId: text(flags.requestId) || randomUUID() };
  let result: Record<string, unknown>;
  try {
    result = await usingApp(async (app) => {
      if (guardedSource) await validateSmartSegmentFiles(app, plan, text(flags.requestId));
      if (recoveryLayout && !(await confirmPlan(executionPreview(app, plan, flags), flags)))
        return { cancelled: true };
      return await executeCandidates(app, plan, flags);
    });
  } catch (error) {
    if (error instanceof TripoError && error.code === 'AUTH_REQUIRED')
      error.details = { ...error.details, request_id: flags.requestId };
    throw error;
  }
  emit(result);
  if (flags.notify)
    await notifyDone(`Task ${String(result.task_id ?? 'candidates')}: ${String(result.status)}`);
  process.exitCode = taskExitCode(result);
}
function registerGenerate(program: Command): void {
  const group = program
    .command('generate')
    .description('deterministic generation endpoints (text/image/multiview → model/image/splat)');
  const definitions = [
    ['text-to-model', 'text → 3D model', '<prompt...>'],
    ['image-to-model', 'single image → 3D model', '<input>'],
    [
      'multiview-to-model',
      '2–4 view images, or one image-to-multiview/edit-multiview task → 3D model',
      '<inputs...>',
    ],
    ['text-to-image', 'text → image (concept art / t_pose templates)', '<prompt...>'],
    ['image-to-multiview', 'single image → multi-view images', '<input>'],
    ['edit-multiview', 'edit views of a multiview task', '<input>'],
    ['image-to-splat', 'image → gaussian splat', '<input>'],
    [
      'image-to-image',
      'image(s) + prompt → edited image (several images: cite them as image[1], image[2], ...)',
      '<inputs...>',
    ],
  ] as const;
  for (const [name, description, arity] of definitions)
    common(
      group
        .command(`${name} ${arity}`)
        .description(description)
        .option('--model <model>', 'model version override')
        .option('--prompt <text>', 'prompt for prompt-guided endpoints')
        .option(
          '--edit-base',
          'Studio extension: first image is the edit base; remaining images are additional references',
        ),
    ).action(async (input: string | string[], flags: Flags) => {
      await runPlan(generationPlan(name, Array.isArray(input) ? input : [input], flags), flags);
    });
}
const processGroups: Record<string, { description: string; commands: [string, string, string[]][] }> = {
  model: {
    description: 'model processing: texture / convert / import',
    commands: [
      [
        'texture',
        're-texture a model (task/@last/file/url)',
        ['--model <v>', '--texture-quality <q>', '--texture-alignment <a>'],
      ],
      [
        'convert',
        'convert format (GLTF/USDZ/FBX/OBJ/STL/3MF)',
        [
          '--format <format>',
          '--texture-size <n>',
          '--texture-format <f>',
          '--face-limit <n>',
          '--quad',
          '--flatten-bottom',
          '--fbx-preset <p>',
          '--export-orientation <o>',
          '--scale-factor <n>',
          '--pivot-to-center-bottom',
          '--export-vertex-colors',
        ],
      ],
      ['import', 'import an external model file/url (GLB/GLTF/FBX/OBJ/STL ≤150MB)', []],
    ],
  },
  anim: {
    description: 'animation: check (riggability) / rig / retarget',
    commands: [
      [
        'rig',
        'rig a model (skeleton binding)',
        ['--model <v>', '--rig-type <type>', '--spec <spec>', '--out-format <f>'],
      ],
      [
        'retarget',
        'apply preset animations to a rigged task',
        ['--animation <name...>', '--out-format <f>', '--animate-in-place'],
      ],
    ],
  },
  mesh: {
    description: 'mesh ops: segment / complete / decimate / uv / smartsegment',
    commands: [
      ['segment', 'segment a model into parts', ['--model <v>']],
      ['complete', 'complete/fill segmented parts (needs a segment task)', ['--completion-mode <m>']],
      [
        'decimate',
        'high-poly → low-poly (bakes textures by default)',
        ['--model <v>', '--face-limit <n>', '--quad', '--smart-uv', '--no-bake'],
      ],
      [
        'uv',
        'smart UV unwrap; remaps textures/rig/animation (input ≤80k equivalent triangles)',
        ['--no-bake', '--export-orientation <o>'],
      ],
      [
        'smartsegment',
        'smart segmentation (image or model pipeline)',
        ['--seg-type <t>', '--granularity <g>', '--hint <text>'],
      ],
      [
        'edit',
        'local retry/refine inside a bounding box (P2 pipeline, model P2-20260801)',
        ['--bbox <x1,y1,z1,x2,y2,z2>', '--face-limit <n>', '--ref-image <file-or-url>', '--model <v>'],
      ],
    ],
  },
};
function registerProcessing(program: Command): void {
  for (const [name, definition] of Object.entries(processGroups)) {
    const group = program.command(name).description(definition.description);
    for (const [step, description, options] of definition.commands) {
      const cmd = common(
        group.command(`${step} ${step === 'import' ? '<input>' : '[input]'}`).description(description),
      );
      for (const option of options) {
        const description = option.slice(2).replace(/ <.*$/, '').replaceAll('-', ' ');
        if (option.endsWith('<n>')) cmd.option(option, description, Number);
        else cmd.option(option, description);
      }
      cmd.action(async (input: string | undefined, flags: Flags) => {
        if (step === 'convert') validatePublicConversion(flags);
        await runPlan(processingPlan(step, await processingInput(input), flags), flags);
      });
    }
    if (name === 'anim')
      common(
        group
          .command('check [input]')
          .description('rig-check: is this model riggable? (GLB/FBX/OBJ/STL input)'),
      ).action(async (input: string | undefined, flags: Flags) => {
        await runPlan(processingPlan('rig-check', await processingInput(input), flags), flags);
      });
  }
}
function registerTask(program: Command): void {
  const task = program.command('task').description('query, list, and watch tasks');
  for (const action of ['get', 'watch'])
    task
      .command(`${action} <task-id>`)
      .description(
        action === 'get'
          ? 'fetch one task (accepts @last/@name)'
          : 'block until a task finishes (progress on stderr; stdout carries only the final JSON)',
      )
      .option('--download', 'download artifacts if successful')
      .option('-o, --out <dir>', 'output directory for --download')
      .option('--timeout <seconds>', 'timeout in seconds', Number)
      .option('--step', 'include pipeline step details')
      .action(async (ref: string, flags: Flags) => {
        const result = await usingApp(async (app) => {
          const id = resolveJob(app, ref).job_id;
          const job =
            action === 'watch'
              ? await waitTask(app, id, Number(flags.timeout ?? 1800))
              : await app.service.get(id);
          return {
            ...taskResult(job),
            ...(flags.step ? { steps: pipelineDetails(app, id) } : {}),
            ...(flags.download && job.state === 'succeeded' ? await downloadTask(app, job, flags) : {}),
          };
        });
        emit(result);
        if (action === 'watch') process.exitCode = taskExitCode(result);
      });
  task
    .command('list [task-ids...]')
    .description('batch-query tasks (default: recent history)')
    .option('--limit <n>', 'how many from history', Number, 10)
    .action(async (refs: string[], flags: Flags) =>
      emit(
        await usingApp(async (app) => {
          const ids = refs.length
            ? refs
            : app.service.jobs.list(app.service.accountRef(), Number(flags.limit)).map((j) => j.job_id);
          return await queryTasks(app, ids);
        }),
      ),
    );
  program
    .command('history')
    .description('recent tasks created by this CLI (@name references)')
    .option('--limit <n>', 'rows', Number, 20)
    .action(async (flags: Flags) =>
      emit(
        await usingApp(async (app) =>
          array(app.service.list(Number(flags.limit), 0).jobs).map((job) => historyResult(app, object(job))),
        ),
      ),
    );
}
function registerResources(program: Command): void {
  const canvas = program
    .command('canvas')
    .description('Studio Canvas projects, graph edits and result selection');
  const watch = canvas
    .command('watch')
    .description('stream bounded Agent or Lab events as NDJSON; resume using after_id')
    .action(async (flags: Flags) => {
      const result = await usingApp(
        async (app) =>
          await readCanvasEvents(app.studio.client, resourceInput(flags, eventSchema), (event) =>
            process.stdout.write(JSON.stringify({ event }) + '\n'),
          ),
      );
      emit({ ...object(result), events: undefined });
    });
  resourceOptions(watch, eventSchema);
  const upload = canvas
    .command('upload <file>')
    .description('upload a Canvas image, model or Lab video; optionally wait for the input asset to be ready')
    .requiredOption('--project-id <id>', 'Canvas project ID')
    .action(async (file: string, flags: Flags) =>
      emit(
        await usingApp(
          async (app) =>
            await uploadCanvasFile(
              app.studio.client,
              text(flags.projectId),
              file,
              app.service.config.inputRoots,
              canvasUploadOptionsSchema.parse(resourceInput(flags, canvasUploadOptionsSchema)),
            ),
        ),
      ),
    );
  resourceOptions(upload, canvasUploadOptionsSchema);
  for (const spec of canvasResources) {
    const command = canvas
      .command(spec.name.replaceAll('_', '-'))
      .description(spec.description)
      .option('--input <json>', 'validated operation parameters as JSON', '{}')
      .action(async (flags: Flags) =>
        emit(
          await usingApp(
            async (app) =>
              await callCanvas(
                app.studio.client,
                spec,
                resourceInput(flags, spec.schema),
                extractionMemory(app.service),
              ),
          ),
        ),
      );
    resourceOptions(command, spec.schema);
  }
  const studio = program
    .command('studio')
    .description('Studio-only asset, image, UV, motion and project operations');
  const frontendSchema = frontendExportSchema.omit({ request_id: true });
  const frontend = studio
    .command('frontend-export')
    .description(frontendExportDescription)
    .option('--request-id <id>', 'reuse the original frontend export intent and authorization')
    .option('--input <json>', 'validated frontend export parameters as JSON', '{}')
    .action(async (flags: Flags) => {
      const input = resourceInput(flags, frontendSchema);
      if (flags.requestId !== undefined) {
        if (input.request_id !== undefined)
          throw new TripoError('INVALID_INPUT', 'request_id was provided in both --input and --request-id.');
        input.request_id = flags.requestId;
      }
      emit(await usingApp(async (app) => await exportFrontend(app.service, app.studio.client, input)));
    });
  resourceOptions(frontend, frontendSchema);
  for (const spec of localOperations) {
    const command = (spec.group === 'canvas' ? canvas : studio)
      .command((spec.group === 'canvas' ? spec.name.replace(/^canvas_/, '') : spec.name).replaceAll('_', '-'))
      .description(spec.description)
      .action(async (flags: Flags) =>
        emit(await runLocal(configFromEnv(), spec, resourceInput(flags, spec.schema))),
      );
    resourceOptions(command, spec.schema);
  }
  const presets = studio
    .command('motion-presets')
    .description('list Studio preset animations by skeleton and category (offline catalogue)')
    .action((flags: Flags) => emit(listMotionPresets(resourceInput(flags, motionPresetSchema))));
  resourceOptions(presets, motionPresetSchema);
  const existingDownload = studio
    .command('asset-download')
    .description('download an existing Studio or Canvas asset, Lab file or UV layout without a new task')
    .action(async (flags: Flags) =>
      emit(
        await usingApp(
          async (app) =>
            await downloadAccountArtifact(
              app.studio.client,
              app.service,
              resourceInput(flags, existingArtifactSchema),
            ),
        ),
      ),
    );
  resourceOptions(existingDownload, existingArtifactSchema);
  for (const [operation, schema] of Object.entries(operationSchemas)) {
    const cmd = common(
      studio
        .command(operation.replaceAll('_', '-'))
        .description(operationDescriptions[operation as Operation]),
    )
      .option('--input <json>', 'validated operation parameters as JSON', '{}')
      .action(async (flags: Flags) => {
        const parameters = normalize(operation as Operation, resourceInput(flags, schema));
        await runPlan(
          {
            steps: [{ name: operation, operation: operation as Operation, parameters }],
            pending_uploads: [],
            warnings: [],
          },
          flags,
        );
      });
    resourceOptions(cmd, schema);
  }
  for (const spec of resources) {
    const command = studio
      .command(spec.name.replaceAll('_', '-'))
      .description(spec.description)
      .option('--input <json>', 'validated operation parameters as JSON', '{}')
      .action(async (flags: Flags) =>
        emit(
          await usingApp(
            async (app) => await callResource(app.studio.client, spec, resourceInput(flags, spec.schema)),
          ),
        ),
      );
    resourceOptions(command, spec.schema);
  }
}
function globals(command: Command): void {
  command
    .option(
      '--json',
      command.parent
        ? 'machine-readable output on stdout'
        : 'machine-readable output on stdout (auto-enabled when piped)',
    )
    .option(
      '--yes',
      command.parent ? 'skip confirmations' : 'skip confirmations (auto-enabled when headless)',
    )
    .option('--quiet', 'suppress progress logs on stderr')
    .option('--no-open', 'never auto-open the browser/viewer')
    .option(
      '--profile <name>',
      !command.parent
        ? 'use a named account profile for this command (like AI_MODELING_PROFILE)'
        : command.name() === 'logout'
          ? 'log out a specific profile instead of the active one'
          : 'use a named account profile',
    );
  for (const child of command.commands) globals(child);
}
export function buildProgram(): Command {
  const program = new Command()
    .name('ai-modeling')
    .description(
      'ai-modeling — turn a sentence or an image into engine-ready 3D assets\nBackend: your Tripo Studio web account and credits',
    )
    .version(VERSION, '-v, --version')
    .exitOverride();
  common(
    program
      .command('make')
      .argument('<input...>', 'prompt text, image file(s), model file, URL, task id, or @last')
      .description('turn text / images / a model file / a task ref into 3D artifacts (the magic command)')
      .option('--for <scenario>', 'scenario preset')
      .option('--then <steps>', 'processing chain, e.g. "texture,rig,convert:fbx"')
      .option('--model <model>', 'force model version (tripo-v3.1 / tripo-p1 / tripo-p2 / ...)')
      .option('-n, --candidates <n>', 'generate N candidates', Number, 1)
      .option('--seed <n>', 'model_seed for reproducible geometry', Number),
  ).action(async (inputs: string[], flags: Flags) => {
    const defaults = contextFlags();
    flags = { ...defaults, ...flags, param: { ...object(defaults.param), ...object(flags.param) } };
    await runPlan(makePlan(inputs, flags), flags);
  });
  registerGenerate(program);
  registerProcessing(program);
  registerTask(program);
  registerResources(program);
  registerRuntime(program, emit);
  registerSkill(program, emit);
  registerAssets(program, { emit, usingApp });
  registerPrinting(program, { emit, usingApp });
  registerSupport(program, { emit, usingApp, runPlan, common });
  registerAi(program, { emit, usingApp, runPlan, common });
  const mcp = program
    .command('mcp')
    .description('run as an MCP server over stdio')
    .option(
      '--toolset <name>',
      'default (6 tools), full (official contracts), studio (web extensions)',
      'default',
    )
    .action((flags: Flags) => launchMcp(text(flags.toolset)));
  mcp
    .command('export')
    .description('export native MCP client integration files without registering or enabling them')
    .requiredOption('--target <name>', 'client integration target: golutra-agent')
    .requiredOption('--out <dir>', 'new output directory whose parent already exists')
    .option('--toolset <name>', 'default, full or studio', 'studio')
    .option(
      '--env <name>',
      'explicit non-secret environment variable name to pass through (repeatable)',
      (name: string, previous: string[]) => [...previous, name],
      [],
    )
    .action(async (options: { target: string; out: string; toolset: string; env: string[] }) => {
      if (options.target !== 'golutra-agent')
        throw new TripoError('INVALID_INPUT', 'The supported MCP export target is golutra-agent.');
      emit(await exportGolutraPlugin(options));
    });
  program
    .command('topup')
    .description('show the Studio billing entry; subscription and payment management are outside this tool')
    .option('--no-watch', 'show the Studio URL without polling')
    .action(() =>
      emit({
        url: 'https://studio.tripo3d.ai/',
        backend: 'studio',
        message: 'Manage Studio credits in the website; API-wallet purchases are separate.',
        payment_started: false,
      }),
    );
  registerCompletion(program);
  program
    .command('batch')
    .description('bulk pipelines from a YAML manifest')
    .command('run <manifest>')
    .description('run all jobs (resumable: finished jobs are skipped on re-run)')
    .option('--concurrency <n>', 'parallel jobs, 1–4', Number)
    .option('--retries <n>', 'retry count for calls with no uncertain submission', Number, 1)
    .option('--fresh', 'create new submission intents for all jobs')
    .option('--no-download', 'skip downloads')
    .option('--max-credits <n>', 'maximum estimated credits per step', Number)
    .action(async (file: string, flags: Flags) => {
      const batch = await loadBatch(file);
      const result = await usingApp(async (app) => await runBatch(app, batch, flags));
      emit(result);
      if (result.success !== result.total) process.exitCode = 6;
    });
  program
    .command('balance')
    .description('query credit balance')
    .action(async () => emit(await usingApp(async (app) => await app.studio.account())));
  program
    .command('usage')
    .description('query credit usage')
    .option('--page <n>', 'page', Number, 1)
    .option('--limit <n>', 'rows', Number, 20)
    .action(async (flags: Flags) =>
      emit(
        await usingApp(
          async (app) =>
            await callResource(
              app.studio.client,
              resources.find((r) => r.name === 'usage')!,
              { page_num: flags.page, page_size: flags.limit },
            ),
        ),
      ),
    );
  program
    .command('models')
    .description('list available models and capabilities')
    .action(() => emit(listModels()));
  registerHome(program, { emit, usingApp, runPlan, common });
  globals(program);
  applyOfficialHelp(program);
  program.addHelpText(
    'after',
    '\nShared guidance: ai-modeling guides list | guides read usage|commands|pipelines\n',
  );
  program.hook('preAction', (_cmd, action) => {
    // Commander 的叶命令默认值不能覆盖用户在根命令显式传入的全局选项。
    for (const key of ['json', 'yes', 'quiet', 'open', 'profile']) {
      for (let command: Command | null = action; command; command = command.parent) {
        const source = command.getOptionValueSource(key);
        if (source !== undefined && source !== 'default') {
          action.setOptionValueWithSource(key, command.getOptionValue(key), source);
          break;
        }
      }
    }
    const profile = action.optsWithGlobals().profile;
    if (profile) process.env.AI_MODELING_PROFILE = String(profile);
  });
  return program;
}
export function exitCode(code: unknown): number {
  const codes: Record<string, number> = {
    AUTH_REQUIRED: 3,
    ACCOUNT_MISMATCH: 3,
    INSUFFICIENT_CREDITS: 4,
    ESTIMATE_EXCEEDS_BUDGET: 4,
    CONTENT_AUDIT_REJECTED: 5,
    REMOTE_TASK_FAILED: 6,
    NETWORK_ERROR: 7,
    UPSTREAM_ERROR: 7,
    JOB_NOT_FOUND: 8,
    RATE_LIMITED: 9,
    INTERNAL_ERROR: 1,
  };
  return codes[text(code)] ?? 2;
}
export async function runCompatible(args: string[]): Promise<void> {
  try {
    await buildProgram().parseAsync(args, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return;
    const detail =
      error instanceof z.ZodError
        ? { code: 'INVALID_INPUT', issues: error.issues.map((i) => ({ path: i.path, message: i.message })) }
        : error instanceof CommanderError
          ? { code: 'INVALID_INPUT', message: error.message }
          : errorResult(error);
    const upstream = object(detail).upstream_exit_code;
    process.exitCode =
      typeof upstream === 'number' && upstream >= 1 && upstream <= 255 ? upstream : exitCode(detail.code);
    emit({
      error: text(detail.message) || 'Invalid command parameters.',
      exit_code: process.exitCode,
      code: detail.code,
      studio_error: detail,
      ...(detail.remote_code !== undefined ? { api_code: detail.remote_code } : {}),
      ...(detail.http_status !== undefined ? { http_status: detail.http_status } : {}),
    });
  }
}
