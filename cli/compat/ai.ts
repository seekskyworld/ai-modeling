/** 交互向导和可选 LLM 只生成声明式计划；执行与校验仍由同一 CLI 规划器承担。 */
import type { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { JsonEntry } from '../../studio/auth/json-entry.ts';
import { z } from 'zod';
import { networkFetch } from '../../studio/api/client.ts';
import { object, text, array, TripoError } from '../../studio/contracts/errors.ts';
import { readSettings } from './settings.ts';
import { makePlan, type Flags } from './planning.ts';
import type { CommandContext } from './support.ts';
import { expertPlanSchema as planSchema, buildExpertPlan, type PlanningMessage } from './ai-plan.ts';
export function llmSecret(): JsonEntry {
  return new JsonEntry('ai-modeling-llm', 'default');
}
async function chatJson(messages: PlanningMessage[], llm: Record<string, unknown>): Promise<unknown> {
  const base = new URL(text(llm.base_url));
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password)
    throw new TripoError(
      'INVALID_CONFIG',
      'LLM base_url must be an HTTP(S) URL without embedded credentials.',
    );
  const key = llmSecret().getPassword();
  const response = await networkFetch(`${base.href.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(60000),
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({
      model: llm.model,
      response_format: { type: 'json_object' },
      messages,
    }),
  });
  if (!response.ok)
    throw new TripoError('LLM_REQUEST_FAILED', `Planning provider returned HTTP ${response.status}.`);
  const payload = object(await response.json());
  return JSON.parse(text(object(object(array(payload.choices)[0]).message).content));
}
export function registerAi(program: Command, ctx: CommandContext): void {
  ctx
    .common(
      program
        .command('ai')
        .argument('[request...]', 'e.g. "a low-poly knight for my mobile game, with a run animation"')
        .description('describe what you want in natural language; plan it, confirm, then run')
        .option('--wizard', 'force wizard mode even when an LLM is configured'),
    )
    .action(async (request: string[], flags: Flags, command: Command) => {
      const llm = object(readSettings().llm);
      const prompt = request.join(' ').trim();
      const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
      let planned: z.infer<typeof planSchema>;
      if (!flags.wizard && llm.base_url && llm.model && prompt) {
        const ask = interactive
          ? async (question: string): Promise<string> => {
              const reader = createInterface({ input: process.stdin, output: process.stderr });
              try {
                return await reader.question(question + ' ');
              } finally {
                reader.close();
              }
            }
          : undefined;
        planned = await buildExpertPlan(prompt, (messages) => chatJson(messages, llm), ask);
      } else {
        if (!interactive)
          throw new TripoError(
            'INVALID_INPUT',
            'wizard mode needs an interactive terminal; use ai-modeling make --for <scenario> or configure llm.base_url/llm.model.',
          );
        const reader = createInterface({ input: process.stdin, output: process.stderr });
        try {
          const description = prompt || (await reader.question('What would you like to create? '));
          const scenario = await reader.question(
            'Scenario (game-mobile/game-pc/film/print/ar-web/anim/toy; empty for none): ',
          );
          planned = planSchema.parse({
            prompt: description,
            ...(scenario.trim() ? { scenario: scenario.trim() } : {}),
          });
        } finally {
          reader.close();
        }
      }
      const options: Flags = {
        ...flags,
        for: planned.scenario,
        model: planned.model,
        then: planned.then,
        param: { ...planned.params, ...object(flags.param) },
      };
      const plan = makePlan([planned.prompt], options);
      if (!flags.dryRun && interactive && !command.optsWithGlobals().yes) {
        process.stderr.write(
          JSON.stringify({ ...plan, backend: 'studio', pricing: 'checked before submission' }, null, 2) +
            '\n',
        );
        const reader = createInterface({ input: process.stdin, output: process.stderr });
        try {
          if (!/^y(es)?$/i.test((await reader.question('Run this plan? [y/N] ')).trim())) {
            ctx.emit({ cancelled: true });
            return;
          }
        } finally {
          reader.close();
        }
      }
      await ctx.runPlan(plan, { ...options, yes: true });
    });
}
