/** 自动历史引用在首次运行固定成本机任务身份；重试不能因新结果加入历史而改选来源。 */
import { isDeepStrictEqual } from 'node:util';
import { object, text, TripoError } from '../../studio/contracts/errors.ts';
import type { Plan } from './planning.ts';
import type { ImageReferenceBinding } from './image-references.ts';
import { resolveJob, type Application } from './runtime.ts';

interface SourcePosition {
  position: string;
  expression: string;
}
interface FrozenSource extends SourcePosition {
  job_id: string;
}
const automatic = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:@|@last|@last:any|@\d+)$/.test(value);
const imagePosition = (step: number, binding: number, reference: ImageReferenceBinding): string =>
  `steps.${step}.imageReferences.${binding}.${reference.target}${reference.index === undefined ? '' : `.${reference.index}`}.reference`;

function positions(plan: Plan): SourcePosition[] {
  const found: SourcePosition[] = [];
  const add = (position: string, expression: unknown): void => {
    if (automatic(expression)) found.push({ position, expression });
  };
  for (const [index, step] of plan.steps.entries()) {
    add(`steps.${index}.source`, step.source);
    for (const [bindingIndex, binding] of (step.imageReferences ?? []).entries())
      add(imagePosition(index, bindingIndex, binding), binding.reference);
  }
  add('sourceValidation.reference', plan.sourceValidation?.reference);
  return found;
}

function restoredSources(app: Application, value: unknown, intent: SourcePosition[]): FrozenSource[] {
  if (!Array.isArray(value) || value.length !== intent.length)
    throw new TripoError('CONTRACT_CHANGED', 'The saved automatic source policy is incomplete.');
  return intent.map((expected, index) => {
    const stored = object(value[index]);
    if (
      stored.position !== expected.position ||
      stored.expression !== expected.expression ||
      !text(stored.job_id)
    )
      throw new TripoError('CONTRACT_CHANGED', 'The saved automatic source policy has changed.');
    // 不能把缺失的本机任务 UUID 再解释成原生网页资产 UUID，也不能重新选择最近历史。
    const job = app.service.jobs.get(text(stored.job_id));
    if (job.account_ref !== app.service.accountRef())
      throw new TripoError('ACCOUNT_MISMATCH', 'The saved source belongs to another Studio account.');
    return { ...expected, job_id: job.job_id };
  });
}

function applySources(plan: Plan, sources: FrozenSource[]): Plan {
  const byPosition = new Map(sources.map((source) => [source.position, source.job_id]));
  return {
    ...plan,
    steps: plan.steps.map((step, index) => ({
      ...step,
      ...(step.source ? { source: byPosition.get(`steps.${index}.source`) ?? step.source } : {}),
      ...(step.imageReferences
        ? {
            imageReferences: step.imageReferences.map((binding, bindingIndex) => ({
              ...binding,
              reference: byPosition.get(imagePosition(index, bindingIndex, binding)) ?? binding.reference,
            })),
          }
        : {}),
    })),
    ...(plan.sourceValidation
      ? {
          sourceValidation: {
            ...plan.sourceValidation,
            reference: byPosition.get('sourceValidation.reference') ?? plan.sourceValidation.reference,
          },
        }
      : {}),
  };
}

/** 在来源类型校验前调用；只固定自动引用，具名 alias 和显式任务仍按调用方意图检查。 */
export function freezePlanReferences(app: Application, plan: Plan, request: string): Plan {
  const account = app.service.accountRef();
  const policyKey = `sources:${request}`;
  const intent = positions(plan);
  const saved = app.service.jobs.requestPolicy(account, policyKey);
  if (saved) {
    if (!isDeepStrictEqual(saved.intent, intent))
      throw new TripoError(
        'IDEMPOTENCY_CONFLICT',
        'The original automatic source expressions or positions have changed.',
      );
    return applySources(plan, restoredSources(app, saved.sources, intent));
  }
  if (!intent.length) return plan;
  if (
    plan.steps.some((_, index) => {
      const prior = app.service.jobs.find(account, `${request}-${index}`);
      return prior && prior.state !== 'prepared';
    })
  )
    throw new TripoError(
      'SOURCE_RECOVERY_REQUIRED',
      'This legacy run did not preserve its automatic source. Recover the original task by its fixed task ID instead of resubmitting with a history shortcut.',
      'not_submitted',
    );
  const resolved = new Map<string, string>();
  const sources = intent.map((position) => {
    if (!resolved.has(position.expression))
      resolved.set(position.expression, resolveJob(app, position.expression).job_id);
    return { ...position, job_id: resolved.get(position.expression)! };
  });
  // 数据库原子绑定会拒绝并发进程选中了不同来源，不用后到结果覆盖先前决定。
  app.service.jobs.bindRequestPolicy(account, policyKey, { intent, sources });
  return applySources(plan, sources);
}
