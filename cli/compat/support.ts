/** 官方辅助命令的 Studio 适配；制作行为继续进入同一任务执行器。 */
import { Command } from 'commander';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { auth } from '../auth.ts';
import { configFromEnv } from '../core/config.ts';
import { JsonStore } from '../../studio/auth/credentials.ts';
import { object, text, TripoError } from '../../studio/contracts/errors.ts';
import { diagnose, diagnosticFailure, type DoctorFeature } from '../doctor.ts';
import { setup, setupExitCode } from '../setup.ts';
import { pricing } from '../pricing.ts';
import { checkUpdate, updateInstructions } from '../update.ts';
import type { Application } from './runtime.ts';
import { resolveJob, downloadTask } from './runtime.ts';
import type { Plan, Flags } from './planning.ts';
import { uploadLocal } from './uploads.ts';
import { readSettings, writeSettings, contextFile } from './settings.ts';
import { openExternal, startViewer } from './desktop.ts';
import { llmSecret } from './ai.ts';
import { bundledDocs } from './documentation.ts';
import { redoPlan } from './redo.ts';
import { nativeMeshoptRequested } from './native-output-policy.ts';
import { readTextureModel } from '../core/texture-version-policy.ts';
import { readImageOutputFormat } from '../core/image-output-policy.ts';
import { readImageSize } from '../core/image-size-policy.ts';
import { readImageBackground } from '../core/image-background-policy.ts';
import { redoFrontendConvertPlan } from './frontend-convert.ts';
import { redoLabReferenceEditPlan } from './lab-reference-edit-runtime.ts';
import { attachLabModelRedoSource } from './lab-model-redo.ts';

export interface CommandContext {
  emit: (value: unknown) => void;
  usingApp: <T>(run: (app: Application) => Promise<T>) => Promise<T>;
  runPlan: (plan: Plan, flags: Flags) => Promise<void>;
  common: (cmd: Command) => Command;
}
const prefKeys = ['default_output_dir', 'active_profile', 'llm.base_url', 'llm.model', 'llm.api_key'];
function validProfile(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw new TripoError('INVALID_INPUT', 'Invalid profile name.');
  return value;
}
function registerConfig(program: Command, ctx: CommandContext): void {
  const group = program.command('config').description('global config and directory context (.ai-modeling)');
  group
    .command('list')
    .description('show effective config (keys masked)')
    .action(() => {
      const file = contextFile();
      ctx.emit({
        config: readSettings(),
        active_profile: configFromEnv().credentialProfile,
        context: file ? readSettings(file) : {},
        context_file: file,
      });
    });
  group
    .command('set <key> <value>')
    .description('set a local config value')
    .action(async (key: string, value: string) => {
      if (!prefKeys.includes(key))
        throw new TripoError(
          'INVALID_INPUT',
          `Supported Studio preferences: ${prefKeys.join(', ')}. API routing and keys cannot be configured for this backend.`,
        );
      if (key === 'active_profile') validProfile(value);
      if (key === 'llm.api_key') {
        llmSecret().setPassword(value);
        ctx.emit({ key, value: '[stored in private JSON credential storage]' });
        return;
      }
      const settings = readSettings();
      if (key.startsWith('llm.')) settings.llm = { ...object(settings.llm), [key.slice(4)]: value };
      else settings[key] = value;
      await writeSettings(settings);
      ctx.emit({ key, value });
    });
  group
    .command('unset <key>')
    .description('remove a config value')
    .action(async (key: string) => {
      if (!prefKeys.includes(key)) throw new TripoError('INVALID_INPUT', 'Unknown preference.');
      const settings = readSettings();
      if (key === 'llm.api_key') llmSecret().deleteCredential();
      else if (key.startsWith('llm.')) {
        const llm = object(settings.llm);
        delete llm[key.slice(4)];
        settings.llm = llm;
      } else delete settings[key];
      await writeSettings(settings);
      ctx.emit({ removed: key });
    });
  group
    .command('context [entries...]')
    .description('set directory context: ai-modeling config context output_dir=./assets')
    .action(async (entries: string[]) => {
      const file = contextFile() ?? path.join(process.cwd(), '.ai-modeling/context.json');
      const context = readSettings(file);
      for (const entry of entries) {
        const i = entry.indexOf('=');
        const key = entry.slice(0, i);
        if (i < 1 || !['output_dir', 'scenario', 'model', 'params'].includes(key))
          throw new TripoError('INVALID_INPUT', 'Context keys: output_dir, scenario, model, params (JSON).');
        context[key] = key === 'params' ? JSON.parse(entry.slice(i + 1)) : entry.slice(i + 1);
      }
      if (entries.length) await writeSettings(context, file);
      ctx.emit({ context, file });
    });
}
function registerAuth(program: Command, ctx: CommandContext): void {
  program
    .command('setup')
    .description('check installation and connect a Studio session without copying tokens')
    .option('--check', 'only report diagnostics; do not start a login flow')
    .option('--offline', 'check local prerequisites without reading credentials or using the network')
    .option('--no-wait', 'return a bounded login flow without waiting')
    .option('--browser-executable <path>', 'use an installed Chrome or Edge executable')
    .option('--cdp-endpoint <url>', 'connect an explicitly authorized local browser')
    .option('--timeout <seconds>', 'bound browser login up to 900 seconds', Number)
    .action(async (_flags: Flags, command: Command) => {
      const flags = command.optsWithGlobals();
      const seconds = flags.timeout === undefined ? undefined : Number(flags.timeout);
      if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0 || seconds > 900))
        throw new TripoError('INVALID_INPUT', 'Use a setup timeout between 1 and 900 seconds.');
      const result = await setup(configFromEnv(), {
        check: Boolean(flags.check),
        offline: Boolean(flags.offline),
        open: flags.open === false ? false : undefined,
        wait: flags.wait === false ? false : undefined,
        cdpEndpoint: flags.cdpEndpoint,
        executablePath: flags.browserExecutable,
        timeoutMs: seconds === undefined ? undefined : seconds * 1000,
      });
      ctx.emit(result);
      process.exitCode = setupExitCode(result);
    });
  program
    .command('login')
    .description('sign in with your Studio browser session and continue automatically')
    .option('--paste', 'read a Studio session from stdin')
    .option('--key <key>', 'API keys belong to the separate developer wallet and are rejected')
    .option('--region <region>', 'Studio region (ov)')
    .option(
      '--no-wait',
      'return the local login flow immediately; continue in the bounded background coordinator',
    )
    .option('--form', 'open the explicit manual session import form')
    .option('--force', 'start browser login even when a saved session is present')
    .option('--browser-executable <path>', 'use an explicit Chrome or Edge executable')
    .option('--cdp-endpoint <url>', 'connect to an explicitly authorized local browser endpoint')
    .option('--timeout <seconds>', 'bound the login flow, up to 900 seconds', Number)
    .action(async (flags: Flags) => {
      if (flags.key || (flags.region && flags.region !== 'ov'))
        throw new TripoError(
          'STUDIO_CAPABILITY_UNAVAILABLE',
          'This backend accepts an international Studio session, not API keys.',
        );
      const args = flags.paste ? ['import', '--stdin'] : ['login'];
      if (!flags.paste) {
        for (const [key, flag] of [
          ['wait', '--no-wait'],
          ['open', '--no-open'],
        ] as const)
          if (flags[key] === false) args.push(flag);
        if (flags.form) args.push('--form');
        if (flags.force) args.push('--force');
        for (const [key, flag] of [
          ['browserExecutable', '--browser-executable'],
          ['cdpEndpoint', '--cdp-endpoint'],
          ['timeout', '--timeout'],
        ] as const)
          if (flags[key] !== undefined) args.push(flag, String(flags[key]));
      }
      await auth(args);
    });
  program
    .command('logout')
    .description('remove the locally stored Studio session (current profile only)')
    .action(async () => await auth(['logout']));
  program
    .command('whoami')
    .description('show the active Studio profile, session status and balance')
    .action(async () => {
      const account = await ctx.usingApp(async (app) => await app.studio.account());
      ctx.emit({ profile: configFromEnv().credentialProfile, backend: 'studio', ...account });
    });
  program
    .command('use [profile]')
    .description('switch the active local profile; omit name to show it')
    .action(async (profile?: string) => {
      if (profile) {
        validProfile(profile);
        if (!new JsonStore(profile).load())
          throw new TripoError('AUTH_REQUIRED', `Sign in with --profile ${profile} first.`);
        await writeSettings({ ...readSettings(), active_profile: profile });
      }
      ctx.emit({ active_profile: profile ?? configFromEnv().credentialProfile });
    });
}
function registerDocs(program: Command, ctx: CommandContext): void {
  program
    .command('docs')
    .description('print bundled docs (default: the LLM/agent guide)')
    .option('--llm', 'print the agent-facing guide')
    .option('--topic <name>', 'commands/<cmd>, examples/<scenario>, common-errors, or project guides')
    .action(async (flags: Flags) => {
      process.stdout.write(await bundledDocs(program, text(flags.topic)));
    });
  program
    .command('doctor')
    .description('diagnose environment, session, network, and terminal capabilities')
    .option('--offline', 'check prerequisites without reading credentials or using the network')
    .option('--feature <name>', 'core, render, video or frontend-export', 'core')
    .option('--browser-executable <path>', 'diagnose an explicit Chrome/Edge executable')
    .option('--cdp-endpoint <url>', 'validate an explicitly authorized local browser endpoint')
    .action(async (flags: Flags) => {
      try {
        const result = await diagnose(configFromEnv(), {
          offline: Boolean(flags.offline),
          feature: flags.feature as DoctorFeature,
          executablePath: flags.browserExecutable as string | undefined,
          cdpEndpoint: flags.cdpEndpoint as string | undefined,
        });
        ctx.emit(result);
        if (!result.ok) process.exitCode = 1;
      } catch (error) {
        ctx.emit(diagnosticFailure(error));
        process.exitCode = 1;
      }
    });
  program
    .command('update')
    .description('show npm update instructions; --check queries the latest published version')
    .option('--check', 'check the public npm version without changing this installation')
    .action(async (flags: Flags) => ctx.emit(flags.check ? await checkUpdate() : updateInstructions()));
}
function registerViewRedo(program: Command, ctx: CommandContext): void {
  program
    .command('view')
    .description('preview a 3D result in the browser (model-viewer, local server)')
    .argument('[target]', 'task id, @last, @name, or a local .glb path (default @last)', '@last')
    .option('--keep', 'keep the preview server running until Ctrl+C')
    .action(async (target: string | undefined, flags: Flags, command: Command) => {
      const input = target ?? '@last';
      const file = /\.(glb|gltf)$/i.test(input)
        ? path.resolve(input)
        : await ctx.usingApp(async (app) => {
            const job = await app.service.get(resolveJob(app, input).job_id);
            if (job.state !== 'succeeded')
              throw new TripoError('INPUT_NOT_READY', 'Wait for the model task to finish.');
            const result = await downloadTask(app, job, {});
            return text(result.model_file);
          });
      await stat(file);
      const viewer = await startViewer(file, configFromEnv().inputRoots);
      const shouldOpen = Boolean(process.stdout.isTTY) && command.optsWithGlobals().open !== false;
      if (shouldOpen) openExternal(viewer.url);
      ctx.emit({ url: viewer.url, model_file: file, running: Boolean(flags.keep || shouldOpen) });
      if (flags.keep || shouldOpen) {
        process.once('SIGINT', viewer.close);
        process.once('SIGTERM', viewer.close);
      } else viewer.close();
    });
  ctx
    .common(
      program
        .command('redo')
        .description('re-run a previous task with a fresh seed (same everything else)')
        .argument('[target]', 'task id or @reference (default @last)', '@last')
        .option('--seed <n>', 'explicit seed for the original model or texture task', Number),
    )
    .action(async (target: string | undefined, flags: Flags) => {
      const plan = await ctx.usingApp(async (app) => {
        const source = resolveJob(app, target ?? '@last');
        const lab = redoLabReferenceEditPlan(
          app.service.jobs,
          app.service.config.dataDir,
          source,
          flags.seed,
          object(flags.param),
        );
        if (lab) return lab;
        const frontend = redoFrontendConvertPlan(
          app.service.jobs,
          app.service.config.dataDir,
          source,
          flags.seed,
          object(flags.param),
        );
        if (frontend) return frontend;
        const redo = redoPlan(
          source,
          flags.seed,
          flags.requestId
            ? app.service.jobs.find(app.service.accountRef(), `${text(flags.requestId)}-0`)
            : undefined,
          nativeMeshoptRequested(app.service.jobs, source),
          readTextureModel(app.service.jobs, source),
          readImageOutputFormat(app.service.jobs, source),
          readImageSize(app.service.jobs, source),
          readImageBackground(app.service.jobs, source),
        );
        return attachLabModelRedoSource(app.service.jobs, source, redo, object(flags.param));
      });
      await ctx.runPlan(plan, flags);
    });
}
export function registerSupport(program: Command, ctx: CommandContext): void {
  registerAuth(program, ctx);
  registerConfig(program, ctx);
  registerDocs(program, ctx);
  registerViewRedo(program, ctx);
  registerPricing(program);
  program
    .command('files')
    .description('file uploads')
    .command('upload <path>')
    .description('upload a local image/model and print the reusable Studio file_token')
    .action(async (file: string) =>
      ctx.emit(await ctx.usingApp(async (app) => await uploadLocal(app, file))),
    );
}

function registerPricing(program: Command): void {
  const group = program.command('pricing').description('inspect, verify and install reviewed Studio prices');
  group
    .command('status')
    .description('show price provenance and expiry without network or login')
    .action(async () => pricing(['status']));
  for (const command of ['verify', 'import']) {
    group
      .command(`${command} <file>`)
      .description(
        command === 'verify'
          ? 'verify a reviewed pricing snapshot and optional official evidence'
          : 'atomically install a verified pricing snapshot',
      )
      .option('--sha256 <digest>', 'independently trusted snapshot digest')
      .option('--network', 'verify official evidence hashes over HTTPS')
      .action(async (file: string, flags: Flags) =>
        pricing([
          command,
          file,
          ...(flags.sha256 ? ['--sha256', String(flags.sha256)] : []),
          ...(flags.network ? ['--network'] : []),
        ]),
      );
  }
  group
    .command('update <url>')
    .description('download a reviewed snapshot from direct HTTPS and verify its official evidence')
    .requiredOption('--sha256 <digest>', 'independently trusted snapshot digest')
    .action(async (url: string, flags: Flags) => pricing(['update', url, '--sha256', String(flags.sha256)]));
}
