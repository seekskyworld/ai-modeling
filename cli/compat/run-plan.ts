/** CLI 执行前统一验证文件与候选语义；多候选保留各自回执，失败不会丢弃成功结果。 */
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { errorResult, text, TripoError } from '../../studio/contracts/errors.ts';
import { executePlan, type Application } from './runtime.ts';
import { validatePlanFiles } from './plan-files.ts';
export { validatePlanFiles } from './plan-files.ts';
import type { Flags, Plan } from './planning.ts';
import { expandSegmentationPlan } from './segmentation-plan.ts';
import { selectAffinePlan } from './smartsegment-affine-transfer-plan.ts';
import { candidateSummary, validateExecutionOptions, validatePlanCostLimit } from './execution-policy.ts';
import { preflightUnquotedPlan } from './unquoted-plan.ts';
import {
  candidateGeneration,
  freezeGenerationLayout,
  generationPrefixLength,
} from './p-series-generation.ts';

export function validateExecution(
  plan: Plan,
  flags: Flags,
  interactive = Boolean(process.stdin.isTTY),
): number {
  validateExecutionOptions(flags);
  validatePlanCostLimit(plan, flags);
  const count = Number(flags.candidates ?? 1);
  if (!Number.isInteger(count) || count < 1 || count > 4)
    throw new TripoError('INVALID_INPUT', 'candidates must be 1–4.');
  if (flags.wait === false && plan.steps.length > 1 && !plan.multiviewEdit)
    throw new TripoError('INVALID_INPUT', '--no-wait cannot execute a processing chain.');
  if (count > 1 && (plan.steps[0]?.operation !== 'model' || plan.steps[0]?.source))
    throw new TripoError('INVALID_INPUT', 'Multiple candidates require a new model generation.');
  if (count > 1 && plan.steps.length > generationPrefixLength(plan) && !interactive)
    throw new TripoError(
      'INVALID_INPUT',
      'Select candidates interactively before continuing a chain, or run the chosen task in a separate command.',
    );
  return count;
}

export async function dryRunPlan(plan: Plan, flags: Flags): Promise<Record<string, unknown>> {
  validateExecution(plan, flags);
  plan = await expandSegmentationPlan(plan, []);
  const count = validateExecution(plan, flags);
  const inputs = await validatePlanFiles(plan);
  return {
    dry_run: true,
    valid: true,
    backend: 'studio',
    ...plan,
    ...labSourcePreparationPreview(plan),
    candidates: count,
    pending_uploads: inputs,
    errors: [],
    estimated_credits: null,
    cost_estimate:
      'Studio prices are checked before submission. Offline validation does not imply zero cost.',
  };
}

/** 离线预览不打开任务库，不猜旧parent布局；额外复制及验字节义务须显式展示。 */
function labSourcePreparationPreview(plan: Plan): Record<string, unknown> {
  const source = plan.steps.find((step) => step.sourceRepresentation === 'studio_normalized')?.source;
  if (!source) return {};
  return {
    preparation_steps: [
      {
        operation: 'copy',
        source,
        applies_to: 'New requests without an existing frozen legacy layout',
        existing_first_copy_reused: plan.steps[0]?.operation === 'copy',
        before: 'downstream processing',
        verification: 'The copied GLB must match the frozen historical Studio SHA, size and all bytes.',
        may_have_separate_cost: true,
      },
    ],
    preparation_note:
      'Preparation is additional to the displayed processing steps; candidates counts generation choices, not HTTP requests. A new copy plus processing requires waiting. Offline preview does not inspect saved request state: existing requests retain their original frozen layout and child IDs.',
  };
}

/** 带固定 request 的旧 CLI 调用先只读/绑定本机布局，再做 no-wait 校验和展示；没有上传或报价。 */
export function executionPreview(app: Application, plan: Plan, flags: Flags): Plan {
  validateExecutionOptions(flags);
  validatePlanCostLimit(plan, flags);
  plan = selectAffinePlan(app, plan, text(flags.requestId));
  const count = validateExecution(plan, { ...flags, wait: true });
  const request = text(flags.requestId);
  if (count === 1) {
    const restored = freezeGenerationLayout(app, plan, request);
    validateExecution(restored, flags);
    return restored;
  }
  if (flags.wait === false && plan.steps.length > generationPrefixLength(plan))
    throw new TripoError('INVALID_INPUT', '--no-wait cannot execute a processing chain.');
  const candidates = Array.from({ length: count }, (_, i) => {
    const seed = candidateSeed(request, i);
    const restored = freezeGenerationLayout(app, candidateGeneration(plan, seed), `${request}-${i}`);
    validateExecution(restored, { ...flags, candidates: 1 });
    return restored;
  });
  const first = candidates[0]!;
  return { ...first, steps: [...first.steps, ...plan.steps.slice(generationPrefixLength(plan))] };
}

const candidateSeed = (request: string, index: number): number =>
  createHash('sha256').update(`${request}:${index}`).digest().readUInt32BE() & 0x7fffffff;

export async function executeCandidates(
  app: Application,
  plan: Plan,
  flags: Flags,
): Promise<Record<string, unknown>> {
  // 旧请求的原单步布局可能允许 no-wait；先还原所有候选，再统一校验，不能边提交边发现后续不合法。
  const count = validateExecution(plan, { ...flags, wait: true });
  const request = text(flags.requestId) || randomUUID();
  if (count === 1) return await executePlan(app, plan, { ...flags, requestId: request });
  await preflightUnquotedPlan(app, plan, flags, request);
  const prefixLength = generationPrefixLength(plan);
  if (flags.wait === false && plan.steps.length > prefixLength)
    throw new TripoError('INVALID_INPUT', '--no-wait cannot execute a processing chain.');
  const candidates = Array.from({ length: count }, (_, i) => {
    const seed = candidateSeed(request, i);
    const candidate = freezeGenerationLayout(app, candidateGeneration(plan, seed), `${request}-${i}`);
    validateExecution(candidate, { ...flags, candidates: 1 });
    return { seed, candidate };
  });
  // 同一 request_id 恢复时种子不变；各候选独立，避免重试改变已收费任务的指纹。
  const results = await Promise.all(
    candidates.map(async ({ seed, candidate }, i) => {
      try {
        return {
          index: i + 1,
          seed,
          ...(await executePlan(app, candidate, {
            ...flags,
            requestId: `${request}-${i}`,
            out: flags.out ? path.join(text(flags.out), `candidate-${i + 1}`) : undefined,
          })),
        };
      } catch (error) {
        return {
          index: i + 1,
          seed,
          request_id: `${request}-${i}`,
          status: 'failed',
          error: errorResult(error),
        };
      }
    }),
  );
  const successes = results.filter((r) => 'status' in r && r.status === 'success');
  const result = candidateSummary(results);
  if (plan.steps.length <= prefixLength || !successes.length) return result;
  const reader = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const index = Number(
      await reader.question(`Choose a successful candidate (${successes.map((r) => r.index).join(', ')}): `),
    );
    const selected = successes.find((r) => r.index === index) as Record<string, unknown> | undefined;
    if (!selected) return { ...result, continued: false, reason: 'No valid candidate selected.' };
    const steps = plan.steps
      .slice(prefixLength)
      .map((s, i) => (i ? s : { ...s, source: text(selected.task_id) }));
    return {
      ...result,
      selected: index,
      continuation: await executePlan(
        app,
        {
          ...plan,
          steps,
          downloadGeneration: false,
          generationSteps: undefined,
          generationLayout: undefined,
          generationExport: undefined,
        },
        { ...flags, requestId: `${request}-selected-${index}` },
      ),
    };
  } finally {
    reader.close();
  }
}
