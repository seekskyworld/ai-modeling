/** 冻结的提交意图决定交付阶段，当前图参数和最新资产不能改写旧任务的要求。 */
import type { Artifact, CanvasResultBinding, Job } from './types.ts';
import { array, object, text, TripoError } from './errors.ts';

export function canvasCapNodes(job: Job): string[] {
  if (job.operation !== 'canvas_run') return [];
  return (
    array(job.input._canvas_quotes)
      .map(object)
      // 当前网页目录默认 true，且省略参数的既有真实 run 也产生 mesh_fill；仅显式 false 关闭。
      .filter((q) => q.node_type === 'SEGMENTATION' && object(q.parameters).quick_cap !== false)
      .map((q) => text(q.node_id))
  );
}
export function canvasFinalId(binding: CanvasResultBinding): string {
  return `${binding.asset_id}-cap-${binding.final_operator_id}`;
}
export function validCanvasResult(job: Job, artifact: Artifact): boolean {
  const b = artifact.canvas_result;
  return Boolean(
    b &&
    b.version === 1 &&
    b.stage === 'segmentation_quick_cap' &&
    b.job_id === job.job_id &&
    b.account_ref === job.account_ref &&
    b.input_hash === job.input_hash &&
    b.canvas_id === job.input.canvas_id &&
    b.run_id === job.remote_ids.task_id &&
    canvasCapNodes(job).filter((id) => id === b.node_id).length === 1 &&
    [
      b.run_id,
      b.step_id,
      b.task_id,
      b.asset_id,
      b.project_id,
      b.segment_operator_id,
      b.final_operator_id,
    ].every((id) => typeof id === 'string' && /^[a-z\d-]+$/i.test(id)) &&
    b.segment_operator_id !== b.final_operator_id &&
    artifact.artifact_id === canvasFinalId(b) &&
    artifact.kind === 'model' &&
    artifact.format === 'glb',
  );
}

/** 旧错误下载保留在中间产物列表；未建立唯一最终身份前不能默认交付原始分割件。 */
export function canvasResultView(job: Job): Record<string, unknown> {
  const nodes = canvasCapNodes(job);
  if (!nodes.length) return {};
  const finals = job.artifacts.filter((a) => validCanvasResult(job, a));
  const verified = nodes.every(
    (node) => finals.filter((a) => a.canvas_result!.node_id === node).length === 1,
  );
  const oldIds = new Set(finals.map((a) => a.canvas_result!.asset_id));
  const intermediate = job.artifacts.filter(
    (a) => oldIds.has(a.artifact_id) || (a.kind === 'model' && !verified && !validCanvasResult(job, a)),
  );
  return {
    artifacts: job.artifacts.filter((a) => !intermediate.includes(a)),
    ...(intermediate.length ? { intermediate_artifacts: intermediate } : {}),
    canvas_output_validation: {
      status: verified ? 'verified' : 'unverified',
      stage: 'segmentation_quick_cap',
    },
    ...(!verified && job.state === 'succeeded'
      ? {
          state: 'needs_attention',
          remote_state: 'succeeded',
          next_action:
            'Read the original Canvas task to verify its final capped model; do not rerun or use an uncapped intermediate as the result.',
        }
      : {}),
  };
}
export function assertCanvasArtifact(job: Job, artifact: Artifact): void {
  if (!canvasCapNodes(job).length) return;
  if (artifact.canvas_result && !validCanvasResult(job, artifact))
    throw new TripoError(
      'CANVAS_RESULT_IDENTITY_CHANGED',
      'The frozen final Canvas result belongs to another task or stage.',
      'read',
    );
  const view = canvasResultView(job);
  if (array(view.intermediate_artifacts).some((a) => object(a).artifact_id === artifact.artifact_id))
    throw new TripoError(
      'CANVAS_FINAL_ARTIFACT_UNVERIFIED',
      'This is an uncapped intermediate, not the requested final Canvas model. Read the original task to resolve its final artifact.',
      'read',
    );
}
