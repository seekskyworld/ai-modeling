/** 未预报价的导入/应用可能位于链尾；只读核对当前价格合同，先于上传和首个付费步骤。 */
import { TripoError } from '../../studio/contracts/errors.ts';
import { acceptsUnquotedBudget, isUnquotedOperation } from '../../studio/contracts/unquoted-pricing.ts';
import type { Operation, Quote } from '../../studio/contracts/types.ts';
import type { Flags, Plan } from './planning.ts';
import type { Application } from './runtime.ts';
import { selectAffinePlan } from './smartsegment-affine-transfer-plan.ts';
import { transferChildRequest } from '../core/smartsegment-affine-transfer-policy.ts';
import { affineChildRequest } from '../core/smartsegment-affine-policy.ts';
import { affineBillingParameters } from './smartsegment-affine-billing.ts';

/** 仅显式未预报价合同传 undefined；既有 Canvas/Lab 及固定报价保持原提交行为。 */
export function unquotedWithoutMaximum(
  operation: Operation,
  parameters: Record<string, unknown>,
  quote: Quote,
  flags: Flags,
): boolean {
  return (
    isUnquotedOperation(operation) &&
    !quote.known &&
    quote.credits === undefined &&
    quote.variable === true &&
    parameters.accept_variable_cost === true &&
    flags.maxCredits === undefined
  );
}

export async function preflightUnquotedPlan(
  app: Application,
  plan: Plan,
  flags: Flags,
  request: string,
): Promise<void> {
  // 旧仿射链按已冻结的实际布局/子身份恢复，不能把新三步的占位位置当作历史回执。
  plan = selectAffinePlan(app, plan, request);
  if (!plan.steps.some((step) => isUnquotedOperation(step.operation))) return;
  const account = app.service.accountRef();
  for (const [index, step] of plan.steps.entries()) {
    const childRequest = plan.smartSegmentAffine
      ? plan.steps.length === 7
        ? affineChildRequest(request, index)
        : transferChildRequest(request, index)
      : `${request}-${index}`;
    const existing = app.service.jobs.find(account, childRequest);
    // 依照实际链顺序先恢复前置回执。进行中、失败或结果未知时，未来步骤尚不可提交，
    // 不能由其当前价格遮蔽原状态；未来步骤真正执行前仍有单步报价/提交检查。
    if (existing?.operation === step.operation && existing.state !== 'prepared') {
      if (existing.state !== 'succeeded') return;
      continue;
    }
    if (!isUnquotedOperation(step.operation)) continue;
    const parameters = plan.legacyAffineUnquotedConsent
      ? affineBillingParameters(app, plan, request, index, step.parameters)
      : step.parameters;
    // 三类操作只依赖审阅快照，不调用 gateway.prepareInput，不读取/上传未来生成的文件。
    // 实际提交仍重新验证当前报价，预检不冻结或延长本轮快照授权。
    const quote = await app.service.pricing.quote(step.operation, parameters);
    if (app.service.accountRef() !== account)
      throw new TripoError(
        'ACCOUNT_MISMATCH',
        'The account changed during processing-price preflight.',
        'not_submitted',
      );
    const maximum = typeof flags.maxCredits === 'number' ? flags.maxCredits : undefined;
    acceptsUnquotedBudget(step.operation, parameters, quote, maximum);
    if (quote.known && quote.credits !== undefined && maximum !== undefined && quote.credits > maximum)
      throw new TripoError(
        'ESTIMATE_EXCEEDS_BUDGET',
        'A processing step exceeds max-credits before the chain starts.',
        'not_submitted',
      );
  }
}
