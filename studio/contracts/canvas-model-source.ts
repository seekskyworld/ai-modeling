/** 显式关闭封口的 Canvas 分割来源证明；只存稳定身份，不存签名 URL、时间或当前图版本。 */
import type { Job } from './types.ts';
import { array, object, text } from './errors.ts';

export interface UncappedCanvasModelSourceProof {
  version: 1;
  job_id: string;
  account_ref: string;
  input_hash: string;
  canvas_id: string;
  run_id: string;
  node_id: string;
  step_id: string;
  task_id: string;
  artifact_id: string;
  asset_id: string;
  project_id: string;
  operator_id: string;
  task_type: 'mesh_segmentation';
}

/** 首次解析与恢复共用原冻结意图；缺省 true、多个节点或多个模型不能走此受限路径。 */
export function uncappedCanvasModelIntent(job: Job): { node_id: string; artifact_id: string } | undefined {
  const quotes = array(job.input._canvas_quotes).map(object),
    requested = array(job.input.node_ids),
    models = job.artifacts.filter((artifact) => artifact.kind === 'model'),
    quote = quotes[0],
    model = models[0];
  if (
    job.operation !== 'canvas_run' ||
    job.state !== 'succeeded' ||
    !job.account_ref ||
    !job.input_hash ||
    !text(job.input.canvas_id) ||
    !text(job.remote_ids.task_id) ||
    quotes.length !== 1 ||
    quote?.node_type !== 'SEGMENTATION' ||
    object(quote.parameters).quick_cap !== false ||
    requested.length !== 1 ||
    requested[0] !== quote.node_id ||
    !text(quote.node_id) ||
    models.length !== 1 ||
    model?.format !== 'glb' ||
    model.canvas_result ||
    !model.artifact_id
  )
    return;
  return { node_id: text(quote.node_id), artifact_id: model.artifact_id };
}

export function validUncappedCanvasModelSource(
  job: Job,
  proof: unknown,
): proof is UncappedCanvasModelSourceProof {
  const intent = uncappedCanvasModelIntent(job),
    value = object(proof);
  return Boolean(
    intent &&
    value.version === 1 &&
    value.job_id === job.job_id &&
    value.account_ref === job.account_ref &&
    value.input_hash === job.input_hash &&
    value.canvas_id === job.input.canvas_id &&
    value.run_id === job.remote_ids.task_id &&
    value.node_id === intent.node_id &&
    value.artifact_id === intent.artifact_id &&
    value.asset_id === intent.artifact_id &&
    value.operator_id === value.task_id &&
    value.task_type === 'mesh_segmentation' &&
    ['canvas_id', 'run_id', 'node_id', 'step_id', 'task_id', 'asset_id', 'project_id', 'operator_id'].every(
      (key) => typeof value[key] === 'string' && /^[a-z\d-]{1,128}$/i.test(value[key]),
    ),
  );
}
