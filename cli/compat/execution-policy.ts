/** 执行选项在上传和提交前统一校验；候选汇总保留每项的不确定、等待及交付失败状态。 */
import { array, object, text, TripoError } from '../../studio/contracts/errors.ts';
import { isUnquotedOperation } from '../../studio/contracts/unquoted-pricing.ts';
import type { Flags, Plan } from './planning.ts';

/** CLI 的 Number 解析可产生 NaN；不能等到付费提交后的轮询阶段才发现无效值。 */
export function validateExecutionOptions(flags: Flags): void {
  if (
    flags.timeout !== undefined &&
    (typeof flags.timeout !== 'number' ||
      !Number.isFinite(flags.timeout) ||
      flags.timeout < 0 ||
      flags.timeout > 7200)
  )
    throw new TripoError('INVALID_INPUT', 'timeout must be between 0 and 7200 seconds.', 'not_submitted');
  if (
    flags.maxCredits !== undefined &&
    (typeof flags.maxCredits !== 'number' || !Number.isFinite(flags.maxCredits) || flags.maxCredits < 0)
  )
    throw new TripoError('INVALID_INPUT', 'max-credits must be finite and nonnegative.', 'not_submitted');
}

/** 未预报价步骤可能在处理链末尾；数值预算必须在任何前置上传/付费步骤前拒绝。 */
export function validatePlanCostLimit(plan: Plan, flags: Flags): void {
  if (
    flags.maxCredits !== undefined &&
    (plan.legacyAffineUnquotedConsent ||
      plan.steps.some(
        (step) => isUnquotedOperation(step.operation) && step.parameters.accept_variable_cost === true,
      ))
  )
    throw new TripoError(
      'UNQUOTED_BUDGET_UNSUPPORTED',
      'max-credits cannot constrain import/apply operations without an advance quote. Omit the numeric budget only when explicitly accepting the unknown Studio charge for the complete processing plan.',
      'not_submitted',
    );
}

/** 仅真实进行中的状态归为 queued；结果未知及登录/输入要求不能被成功的兄弟任务掩盖。 */
export function candidateSummary(results: Record<string, unknown>[]): Record<string, unknown> {
  const statuses = results.map((result) => text(result.status));
  const attention = ['outcome_unknown', 'requires_login', 'waiting_input', 'needs_attention'].find((state) =>
    statuses.includes(state),
  );
  const pending = statuses.some((state) => ['prepared', 'submitting', 'queued', 'running'].includes(state));
  const successes = statuses.filter((state) => state === 'success').length;
  return {
    candidates: results,
    status: attention ?? (pending ? 'queued' : successes ? 'success' : 'failed'),
    partial: successes > 0 && successes < results.length,
    ...(results.some((result) => result.wait_timed_out) ? { wait_timed_out: true } : {}),
  };
}

/** 汇总返回值也检查子项；生成成功但下载失败必须能被脚本识别，继续处理只恢复原任务。 */
export function executionExitCode(result: Record<string, unknown>): number {
  const children = [
    ...array(result.candidates).map(object),
    ...(result.continuation ? [object(result.continuation)] : []),
  ].map(executionExitCode);
  if (result.download_error || children.includes(7)) return 7;
  if (
    result.wait_timed_out ||
    ['failed', 'outcome_unknown', 'requires_login', 'needs_attention'].includes(text(result.status)) ||
    children.includes(6)
  )
    return 6;
  return 0;
}

/** 指引按真实状态给出，unknown 只能核对原回执，prepared 才可用同一意图继续领取。 */
export function taskNextAction(result: Record<string, unknown>): string {
  const status = text(result.status);
  if (result.composition && text(result.next_action)) return text(result.next_action);
  if (result.download_error) return 'Retry downloading this original task; do not regenerate.';
  if (status === 'success') return 'call ai_modeling_download';
  if (status === 'outcome_unknown')
    return 'Inspect the original Studio receipt and reconcile exact remote IDs; do not resubmit.';
  if (status === 'requires_login') return 'Restore the original Studio account, then query this task.';
  if (status === 'prepared') return 'Repeat the original call with the same request_id and inputs.';
  if (status === 'waiting_input') return 'Read the original Canvas run/turn and supply its requested choice.';
  if (status === 'failed') return 'Inspect the failure before creating another task.';
  return 'call ai_modeling_task_wait';
}
