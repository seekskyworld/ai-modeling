/** CLI外层先验证原请求缓存；新请求仍读调用方原文件，不能用旧产物跳过输入校验。 */
import type { Application } from './runtime.ts';
import type { Plan } from './planning.ts';
import { validatePlanFiles } from './plan-files.ts';
import {
  assertSmartSegmentLayouts,
  freezeSmartSegmentScale,
  prepareSmartSegmentScaleSource,
} from './smartsegment-scale.ts';
import { freezeSmartSegmentTransform, prepareSmartSegmentTransformSource } from './smartsegment-transform.ts';
import { scaleSourceKey } from '../core/smartsegment-scale-policy.ts';
import { smartSegmentTransformSourceKey } from '../core/smartsegment-transform-policy.ts';
import { validateAffineFiles } from './smartsegment-affine-source.ts';
import { selectAffinePlan } from './smartsegment-affine-transfer-plan.ts';
import { validateTransferFiles } from './smartsegment-affine-transfer-source.ts';

export async function validateSmartSegmentFiles(
  app: Application,
  plan: Plan,
  request: string,
): Promise<void> {
  const account = app.service.accountRef(),
    jobs = app.service.jobs;
  assertSmartSegmentLayouts(app, plan, request);
  plan = selectAffinePlan(app, plan, request);
  if (await validateTransferFiles(app, plan, request)) return;
  if (await validateAffineFiles(app, plan, request)) return;
  if (plan.smartSegmentScale && jobs.requestPolicy(account, scaleSourceKey(request))) {
    freezeSmartSegmentScale(app, plan, request);
    plan = await prepareSmartSegmentScaleSource(app, plan, request);
  } else if (
    plan.smartSegmentTransform &&
    jobs.requestPolicy(account, smartSegmentTransformSourceKey(request))
  ) {
    freezeSmartSegmentTransform(jobs, account, plan, request);
    plan = await prepareSmartSegmentTransformSource(app, plan, request);
  }
  await validatePlanFiles(plan);
}
