/** 来源链只冻结网页实际模型版本；导出回执不是可编辑模型，UV 候选也必须先应用。 */
import type { Job, Operation } from '../../studio/contracts/types.ts';
import { text, TripoError } from '../../studio/contracts/errors.ts';
import { fingerprint } from '../core/fingerprint.ts';

export const labModelDeliveryKey = (request: string): string => `lab-model-delivery:${request}`;
export const labModelConflict = (message: string): never => {
  throw new TripoError('IDEMPOTENCY_CONFLICT', message, 'not_submitted');
};
const operatorKeys = [
  'operator_id',
  'expected_operator_id',
  'current_operator_id',
  'source_operator_id',
  'candidate_operator_id',
] as const;
const continuations = new Set<Operation>([
  'copy',
  'texture',
  'export',
  'rig',
  'remesh',
  'segment',
  'resegment',
  'local_edit',
  'uv_generate',
  'uv_commit',
  'project_edit',
  'retexture',
  'retexture_apply',
  'complete',
  'modification',
]);
export interface LabModelProcessingTarget {
  project_id: string;
  operator_id: string;
  basis: 'model_receipt' | 'export_input_model' | 'uv_candidate';
}
/** 不含可追加的下载路径、缓存或显示状态；输入与全部远端身份都必须稳定。 */
export function labModelJobIdentity(job: Job): Record<string, unknown> {
  return {
    job_id: job.job_id,
    account_ref: job.account_ref,
    request_id: job.request_id,
    operation: job.operation,
    input_hash: job.input_hash,
    input: fingerprint(job.input),
    remote_ids: fingerprint(job.remote_ids),
  };
}
export function labModelProcessingTarget(source: Job, operation: Operation): LabModelProcessingTarget {
  if (!continuations.has(operation))
    return labModelConflict('This continuation has no verified exact Studio model-version binding.');
  if (source.operation === 'uv_generate' && operation !== 'uv_commit')
    return labModelConflict('Apply the exact generated UV candidate before using it as a model source.');
  const project_id = text(source.remote_ids.project_id),
    operator_id = text(
      source.operation === 'export' ? source.input.expected_operator_id : source.remote_ids.operator_id,
    );
  if (!project_id || !operator_id)
    return labModelConflict('The preceding task has no exact reusable Studio model receipt.');
  if (source.operation === 'export' && project_id !== source.input.project_id)
    return labModelConflict('The exported task no longer identifies its original Studio model.');
  return {
    project_id,
    operator_id,
    basis:
      source.operation === 'export'
        ? 'export_input_model'
        : source.operation === 'uv_generate'
          ? 'uv_candidate'
          : 'model_receipt',
  };
}
export function labModelSourceParameters(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    ['project_id', ...operatorKeys].filter((key) => input[key] !== undefined).map((key) => [key, input[key]]),
  );
}
function requiredOperators(
  source: Job,
  operation: Operation,
  target: LabModelProcessingTarget,
): Record<string, string> {
  if (operation === 'uv_commit') {
    if (
      source.operation !== 'uv_generate' ||
      !text(source.input.current_operator_id) ||
      source.input.project_id !== target.project_id
    )
      return labModelConflict(
        'UV application requires the exact generated candidate and its original base model.',
      );
    return {
      current_operator_id: text(source.input.current_operator_id),
      candidate_operator_id: target.operator_id,
    };
  }
  if (operation === 'copy') return { operator_id: target.operator_id };
  return {
    expected_operator_id: target.operator_id,
    ...(operation === 'uv_generate' ? { current_operator_id: target.operator_id } : {}),
    ...(operation === 'local_edit' ? { source_operator_id: target.operator_id } : {}),
    ...(operation === 'resegment' ? { operator_id: target.operator_id } : {}),
  };
}
/** 首次绑定可补 schema 已支持的版本守卫；校验/恢复只核对，绝不替换调用方给出的另一个版本。 */
export function bindLabModelProcessingTarget(
  source: Job,
  operation: Operation,
  input: Record<string, unknown>,
  fill: boolean,
): { target: LabModelProcessingTarget; parameters: Record<string, unknown> } {
  const target = labModelProcessingTarget(source, operation),
    required = requiredOperators(source, operation, target);
  if (input.project_id !== target.project_id)
    return labModelConflict('The downstream project differs from its verified preceding model.');
  for (const key of operatorKeys) {
    const expected = required[key] ?? (operation === 'uv_commit' ? undefined : target.operator_id);
    if (
      input[key] !== undefined &&
      (input[key] !== expected || (key === 'candidate_operator_id' && operation !== 'uv_commit'))
    )
      return labModelConflict('A downstream model operator differs from its verified processing source.');
  }
  for (const [key, value] of Object.entries(required)) {
    if (input[key] === undefined && fill) input[key] = value;
    if (input[key] !== value) return labModelConflict('The downstream exact model-version guard is missing.');
  }
  return { target, parameters: labModelSourceParameters(input) };
}
