/** 新请求用纯旋转导入三步；已冻结七步按原布局恢复，不能借新路线重提旧请求。 */
import type { Plan, PlannedStep } from './planning.ts';
import type { Application } from './runtime.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import { affineIntentKey } from '../core/smartsegment-affine-policy.ts';
import { smartSegmentAffinePlan } from './smartsegment-affine-plan.ts';
import { smartSegmentIdentity } from './smartsegment-scale-plan.ts';

export const smartSegmentTransferWarning =
  'New positive-determinant affine smartsegment requests use three separately quoted native operations: import the unchanged original GLB with a source-derived proper rotation, write the second TRS as native metadata, then ordinary segmentation. Both matrices and import normalization are frozen from the original source and requested matrix before submission. The source must be a centered unit-extent static single-primitive GLB with complete normals/UVs and basic opaque appearance; each actual import must preserve its normalized oriented faces, source normals, UVs and embedded texture bytes before continuing. An original Studio display rename on the single source node is mapped to the verified imported node; unrelated stale rename keys are rejected before submission. Original Studio material fields are restored exactly, including partial maps. The final native output must independently match every original A(P) face and every B2(actual import) face at the fixed 4e-5 bound. Tolerances are never accumulated and no model geometry is locally rewritten. Final segmentation can change normals, UVs, materials and textures. Original seven-step requests retain their frozen route and receipts; failed or unknown stages are never replaced or resubmitted. This per-result verification does not claim every matrix or source was tested against Studio.';

export function transferAffinePlan(plan: Plan): Plan {
  const intent = plan.smartSegmentAffine;
  if (!intent || plan.steps.length === 3) return plan;
  const original = plan.steps[0]!,
    parameters =
      intent.source_kind === 'file'
        ? { ...original.parameters }
        : { name: 'smartsegment-affine-transfer', use_original_uv: true };
  // 纯R依赖实际原件坐标；离线计划不伪造identity输入，执行时才从完整冻结source填入。
  delete (parameters as Record<string, unknown>).transform_matrix;
  const imported: PlannedStep = {
    name: original.operation === 'copy' ? 'smartsegment-affine-transfer-import' : original.name,
    operation: 'import_model',
    parameters,
    ...(original.source ? { source: original.source } : {}),
  };
  return {
    ...plan,
    steps: [
      imported,
      {
        name: 'smartsegment-affine-transfer-metadata',
        operation: 'project_edit',
        source: 'upstream',
        parameters: { project_id: 'upstream', expected_operator_id: 'upstream' },
      },
      {
        name: 'smartsegment-affine-transfer-final',
        operation: 'segment',
        source: 'upstream',
        parameters: { ...intent.segment_parameters },
      },
    ],
    warnings: [smartSegmentTransferWarning],
  };
}

export function legacyAffinePlan(plan: Plan): Plan {
  const intent = plan.smartSegmentAffine;
  if (!intent || plan.steps.length === 7) return plan;
  const file = intent.source_kind === 'file',
    first: PlannedStep = file
      ? {
          ...plan.steps[0]!,
          parameters: { ...plan.steps[0]!.parameters, transform_matrix: smartSegmentIdentity },
        }
      : {
          name: 'smartsegment-affine-copy',
          operation: 'copy',
          parameters: { project_id: 'upstream', operator_id: 'upstream' },
          source: plan.steps[0]!.source ?? intent.source,
        };
  return smartSegmentAffinePlan(
    first,
    {
      name: 'smartsegment',
      operation: 'segment',
      source: 'upstream',
      parameters: { ...intent.segment_parameters },
    },
    intent.matrix,
    intent.source,
    file,
    plan.pending_uploads,
  );
}

/** 只读选择；已有子任务但缺父意图由后续冻结守卫拒绝，不能在此补义务。 */
export function selectAffinePlan(app: Application, plan: Plan, parent: string): Plan {
  if (!plan.smartSegmentAffine) return plan;
  const jobs = app.service.jobs,
    account = app.service.accountRef(),
    legacy = jobs.requestPolicy(account, affineIntentKey(parent)),
    transfer = jobs.requestPolicy(account, `smartsegment-affine-transfer-intent:${parent}`);
  if (legacy && transfer)
    throw new TripoError(
      'IDEMPOTENCY_CONFLICT',
      'Both affine routes are bound to this request. Recover its original complete records without submitting.',
      'not_submitted',
    );
  return legacy ? legacyAffinePlan(plan) : transferAffinePlan(plan);
}
