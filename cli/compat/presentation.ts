/** 终端显示与机器输出分离；管道和 --json 始终保持单条结构化结果。 */
import { inspect } from 'node:util';
import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import { text, object, errorResult } from '../../studio/contracts/errors.ts';
import type { CommandContext } from './support.ts';
import type { Plan, Flags } from './planning.ts';

export function printResult(value: unknown): void {
  const json = !process.stdout.isTTY || process.argv.includes('--json');
  if (json) {
    process.stdout.write(JSON.stringify(value ?? null) + '\n');
    return;
  }
  // --quiet 只控制进度日志，TTY 的最终业务结果仍须写入 stdout，和官方 CLI 一致。
  const body = object(value);
  if (body.task_id) {
    process.stdout.write(`${String(body.status)}  ${String(body.task_id)}\n`);
    for (const key of [
      'name',
      'output_dir',
      'model_file',
      'preview',
      'credits_consumed',
      'normalize_scale',
      'normalize_scale_provenance',
      'normalize_scale_validation',
      'error',
      'download_error',
      'warnings',
    ])
      if (body[key] !== undefined) process.stdout.write(`${key}: ${inspect(body[key], { colors: false })}\n`);
    return;
  }
  process.stdout.write(inspect(value, { colors: false, depth: 5, compact: false }) + '\n');
}

export async function confirmPlan(plan: Plan, flags: Flags): Promise<boolean> {
  if (flags.yes || flags.dryRun || !process.stdin.isTTY || !process.stderr.isTTY) return true;
  process.stderr.write(
    'ai-modeling plan\n' +
      plan.steps
        .map(
          (s, i) =>
            `  ${i + 1}. ${s.name}${s.parameters.model_version ? ` (${s.parameters.model_version})` : ''}${s.preflight ? ' [read-only check]' : ''}`,
        )
        .join('\n') +
      '\n',
  );
  for (const warning of plan.warnings) process.stderr.write(`  ${warning}\n`);
  process.stderr.write('Website prices are checked before each submission.\n');
  const reader = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await reader.question('Run this plan? [y/N] ')).trim());
  } finally {
    reader.close();
  }
}

export function registerHome(program: Command, ctx: CommandContext): void {
  program.action(async () => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      program.outputHelp();
      return;
    }
    process.stdout.write('ai-modeling — Tripo Studio\n');
    try {
      const state = await ctx.usingApp(async (app) => ({
        account: await app.studio.account(),
        last: app.service.jobs.list(app.service.accountRef(), 1, 0, 'succeeded')[0],
      }));
      process.stdout.write(
        `${object(state.account).balance} website credits${state.last ? ` · last ${state.last.job_id}` : ''}\n`,
      );
    } catch (error) {
      process.stdout.write(
        text(errorResult(error).message) + '\nUse ai-modeling login to import a Studio session.\n',
      );
    }
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    let args: string[] = [];
    try {
      const choice = (
        await reader.question('1 AI plan   2 Make   3 View last   4 Balance   5 Help   Enter Exit\n> ')
      ).trim();
      if (choice === '1') args = ['ai'];
      else if (choice === '2') {
        const input = (await reader.question('Description or file path: ')).trim();
        if (input) args = ['make', input];
      } else if (choice === '3') args = ['view', '@last'];
      else if (choice === '4') args = ['balance'];
      else if (choice === '5') args = ['--help'];
    } finally {
      reader.close();
    }
    if (args.length) await program.parseAsync(args, { from: 'user' });
  });
}
