/** 网页预检会随模型和服务变化；自动骨架/动作决定须在付费前固定，恢复时沿用原顺序。 */
import { isDeepStrictEqual } from 'node:util';
import { callResource, resources } from '../../studio/api/resources.ts';
import { object, text, TripoError } from '../../studio/contracts/errors.ts';
import { materializeInputs } from '../artifacts/source.ts';
import { compileChainTail, type Plan, type PlannedStep } from './planning.ts';
import type { Application } from './runtime.ts';

async function readCheck(app: Application, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  return object(
    await callResource(
      app.studio.client,
      resources.find((r) => r.name === 'rig_check')!,
      input,
    ),
  );
}

export async function checkedRigChain(
  app: Application,
  plan: Plan,
  index: number,
  parameters: Record<string, unknown>,
  request: string,
  previous?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const input = { project_id: parameters.project_id, model_version: parameters.model_version };
  const chainIndex = plan.steps[index]!.chainIndex;
  if (!plan.chainIntent || chainIndex === undefined) return await readCheck(app, input);
  const account = app.service.accountRef();
  const policyKey = `rig-chain:${request}-${index}`;
  const intent = JSON.parse(
    JSON.stringify({ input, chain: plan.chainIntent, tail: plan.steps.slice(index + 1) }),
  );
  const saved = app.service.jobs.requestPolicy(account, policyKey);
  if (saved) {
    if (!isDeepStrictEqual(saved.intent, intent))
      throw new TripoError('IDEMPOTENCY_CONFLICT', 'The original rig-check chain intent has changed.');
    applyDecision(plan, index, saved);
    return object(saved.check);
  }
  const check = await readCheck(app, input);
  if (check.riggable !== true) return check;
  // 旧版已提交的链没有自动决策记录；保持原编排，不用新建议重排或重新收费。
  const legacy = plan.steps
    .slice(index + 1)
    .some((_, offset) => app.service.jobs.find(account, `${request}-${index + 1 + offset}`));
  const sourceJob = previous ? app.service.jobs.get(text(previous.job_id)) : undefined;
  const priorRig = plan.steps.slice(0, index).findLast((step) => step.operation === 'rig' && !step.preflight);
  const compiled = legacy
    ? {
        steps: plan.steps.slice(index + 1),
        warnings: [
          'This legacy chain keeps its original step order; the new rig recommendation is not applied to already submitted work.',
        ],
      }
    : compileChainTail(
        plan.chainIntent,
        chainIndex + 1,
        previous ? 'upstream' : text(plan.steps[index]!.source),
        text(check.rig_type) || undefined,
        text(priorRig?.parameters.rig_type) ||
          (sourceJob?.operation === 'rig' ? text(sourceJob.input.rig_type) : undefined),
      );
  const materialized = await materializeInputs(
    { ...plan, steps: compiled.steps },
    app.service.config.dataDir,
    request,
  );
  const decision = { intent, check, steps: materialized.steps, warnings: compiled.warnings, legacy };
  app.service.jobs.bindRequestPolicy(account, policyKey, decision);
  applyDecision(plan, index, decision);
  return check;
}

function applyDecision(plan: Plan, index: number, decision: Record<string, unknown>): void {
  plan.steps.splice(index + 1, plan.steps.length, ...(decision.steps as PlannedStep[]));
  plan.warnings.push(...(decision.warnings as string[]));
}
