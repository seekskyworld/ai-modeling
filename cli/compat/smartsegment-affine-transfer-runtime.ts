/** 三次原生操作之间先验原件；失败保原请求和产物，恢复不拟合矩阵或重提已受理任务。 */
import type { Flags, Plan } from './planning.ts';
import { executePlan, downloadTask, taskResult, type Application } from './runtime.ts';
import { array, errorResult, object, TripoError } from '../../studio/contracts/errors.ts';
import {
  transferChildRequest,
  transferExpectedParameters,
  transferFail,
  transferGroupRequest,
  transferOperations,
} from '../core/smartsegment-affine-transfer-policy.ts';
import { assertScaleAccount } from './smartsegment-scale.ts';
import { freezePlanReferences } from './source-policy.ts';
import { freezeTransferIntent, prepareTransferSource } from './smartsegment-affine-transfer-source.ts';
import {
  freezeTransferImport,
  freezeTransferEdit,
  preflightTransferStep,
} from './smartsegment-affine-transfer-stages.ts';

export async function executeSmartSegmentTransfer(
  app: Application,
  plan: Plan,
  flags: Flags,
  parent: string,
): Promise<Record<string, unknown>> {
  if (flags.wait === false)
    throw new TripoError(
      'INVALID_INPUT',
      '--no-wait cannot execute the three-step affine transfer.',
      'not_submitted',
    );
  const account = freezeTransferIntent(app, plan, parent);
  plan = freezePlanReferences(app, plan, parent);
  await prepareTransferSource(app, plan, parent);
  const chain: Record<string, unknown>[] = [];
  let last: Record<string, unknown> | undefined;
  const result = (): Record<string, unknown> => ({
    ...last,
    request_id: parent,
    final_request_id: last?.request_id,
    chain,
    warnings: plan.warnings,
    native_step_count: 3,
    native_affine_mechanism: 'pure_rotation_import',
  });
  try {
    for (const [index, operation] of transferOperations().entries()) {
      assertScaleAccount(app, account);
      if (index === 1) await freezeTransferImport(app, parent);
      if (index === 2) await freezeTransferEdit(app, parent);
      await preflightTransferStep(app, parent, index);
      const parameters = transferExpectedParameters(app.service.jobs, account, parent, index);
      last = await executePlan(
        app,
        {
          steps: [{ name: plan.steps[index]!.name, operation, parameters }],
          pending_uploads: [],
          warnings: [],
        },
        { ...flags, requestId: transferGroupRequest(parent, index), download: false },
      );
      chain.push(...(array(last.chain).length ? array(last.chain).map(object) : [last]));
      if (last.status !== 'success') return result();
    }
    const job = app.service.jobs.find(account, transferChildRequest(parent, 2));
    if (!job) return transferFail('The original final affine transfer receipt is missing.');
    const current = await app.service.get(job.job_id);
    assertScaleAccount(app, account);
    last = taskResult(current);
    if (last.status === 'success' && flags.download !== false) {
      try {
        Object.assign(last, await downloadTask(app, current, { ...flags, outIsRoot: true }));
      } catch (error) {
        last.download_error = errorResult(error);
      }
    }
    return result();
  } catch (error) {
    if (!last) throw error;
    return {
      ...result(),
      status: 'needs_attention',
      error: errorResult(error),
      next_action:
        'Inspect and resume this complete original affine request. Preserve its request_id and all original native receipts; do not resubmit completed or unknown steps.',
    };
  }
}
