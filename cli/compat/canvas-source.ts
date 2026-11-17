/** Canvas 的 run ID 不是模型项目；仅从已冻结的唯一最终产物解析网页真实模型版本。 */
import type { Job, Operation } from '../../studio/contracts/types.ts';
import { array, object, TripoError } from '../../studio/contracts/errors.ts';
import { canvasResultView, validCanvasResult } from '../../studio/contracts/canvas-result.ts';
import { validUncappedCanvasModelSource } from '../../studio/contracts/canvas-model-source.ts';

export interface CanvasModelSource {
  artifact_id: string;
  project_id: string;
  operator_id: string;
  task_type: 'mesh_completion' | 'mesh_segmentation';
}

/** 不读取会变化的画布，也不改变原任务的 remote_ids；旧中间产物不能作为后续处理的来源。 */
export function canvasModelSource(job?: Job, proof?: unknown): CanvasModelSource | undefined {
  if (job?.operation !== 'canvas_run') return;
  if (job.state !== 'succeeded')
    throw new TripoError(
      'INPUT_NOT_READY',
      'Wait for the original Canvas task and verify its final model before processing it.',
      'not_submitted',
    );
  if (proof !== undefined) {
    if (!validUncappedCanvasModelSource(job, proof))
      throw new TripoError(
        'CANVAS_MODEL_SOURCE_CONFLICT',
        'The frozen Canvas model source no longer matches the original task and artifact.',
        'not_submitted',
      );
    return {
      artifact_id: proof.artifact_id,
      project_id: proof.project_id,
      operator_id: proof.operator_id,
      task_type: 'mesh_segmentation',
    };
  }
  const view = canvasResultView(job);
  if (object(view.canvas_output_validation).status !== 'verified')
    throw new TripoError(
      'CANVAS_FINAL_ARTIFACT_UNVERIFIED',
      'Read the original Canvas task to freeze its final model identity before using it as a source.',
      'not_submitted',
    );
  const models = array(view.artifacts)
    .map(object)
    .filter((artifact) => artifact.kind === 'model');
  if (models.length !== 1)
    throw new TripoError(
      'CANVAS_MODEL_SOURCE_AMBIGUOUS',
      'This Canvas task has multiple model outputs. Use the exact project and operator of the intended final model.',
      'not_submitted',
    );
  const artifact = job.artifacts.find((candidate) => candidate.artifact_id === models[0]!.artifact_id);
  if (!artifact || !validCanvasResult(job, artifact))
    throw new TripoError(
      'CANVAS_FINAL_ARTIFACT_UNVERIFIED',
      'The selected Canvas model does not have a valid frozen final operation.',
      'not_submitted',
    );
  return {
    artifact_id: artifact.artifact_id,
    project_id: artifact.canvas_result!.project_id,
    operator_id: artifact.canvas_result!.final_operator_id,
    task_type: 'mesh_completion',
  };
}

const currentModelOperations = new Set<Operation>([
  'texture',
  'export',
  'rig',
  'remesh',
  'segment',
  'resegment',
  'complete',
  'local_edit',
  'uv_generate',
  'project_edit',
  'retexture',
  'retexture_apply',
]);

/** 冻结真实 operator 到请求意图；提交前已有统一守卫拒绝项目被后续编辑后的错误来源。 */
export function bindCanvasModelSource(
  job: Job | undefined,
  operation: Operation,
  input: Record<string, unknown>,
  proof?: unknown,
): { parameters: Record<string, unknown>; remote: { project_id: string; operator_id: string } } | undefined {
  const source = canvasModelSource(job, proof);
  if (!source) return;
  if (operation !== 'copy' && !currentModelOperations.has(operation))
    throw new TripoError(
      'INVALID_INPUT',
      'This operation cannot consume the frozen Canvas model version.',
      'not_submitted',
    );
  const parameters: Record<string, unknown> = { ...input, project_id: source.project_id };
  for (const key of ['operator_id', 'expected_operator_id', 'current_operator_id', 'source_operator_id']) {
    if (
      parameters[key] !== undefined &&
      parameters[key] !== 'upstream' &&
      parameters[key] !== source.operator_id
    )
      throw new TripoError(
        'CANVAS_SOURCE_CONFLICT',
        'The requested model version differs from the original Canvas final operation.',
        'not_submitted',
      );
    if (parameters[key] === 'upstream') parameters[key] = source.operator_id;
  }
  // save_as_new 已明确接受历史 operator；其它操作作用于项目当前版本，必须带当前版本守卫。
  if (operation === 'copy') parameters.operator_id = source.operator_id;
  else parameters.expected_operator_id = source.operator_id;
  return {
    parameters,
    remote: { project_id: source.project_id, operator_id: source.operator_id },
  };
}
