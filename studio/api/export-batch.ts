/** 网页原生批量导出一次提交，保留逐项回执；部分失败不重发已接受的项目。 */
import type { StudioClient } from './client.ts';
import { Operations } from './operations.ts';
import type { Job, RemoteIds, RemoteStatus, Artifact } from '../contracts/types.ts';
import { array, object, text, errorResult, sanitize, TripoError } from '../contracts/errors.ts';
export interface BatchReceipt {
  project_id: string;
  operator_id?: string;
  code: number;
}
export async function submitExportBatch(
  client: StudioClient,
  roots: string[],
  job: Job,
): Promise<{ remote_ids: RemoteIds }> {
  const projects = array(job.input.projects).map(text);
  for (const project_id of projects) {
    await new Operations(client, roots).build({
      ...job,
      operation: 'export',
      input: { ...job.input, project_id, animations: [], with_animation: false },
    });
  }
  const result = object(
    await client.request(
      'POST',
      '/v2/studio/operation/export-batch',
      {
        ...job.input,
        format: job.input.format === 'glb' ? 'gltf' : job.input.format,
        model_version: 'default',
        with_animation: false,
        animations: [],
      },
      { paid: true, timeoutMs: 90000 },
    ),
  );
  const rows = array(result.result).map(object);
  // 缺少某项回执时把它保留为未知；已接受的 operator 仍可查询和下载，不允许重提整个批次。
  const batch = projects.map((id): BatchReceipt => {
    const matches = rows.filter((row) => row.project_id === id);
    const row = matches[0];
    if (matches.length !== 1 || typeof row?.code !== 'number' || !Number.isFinite(row.code))
      return { project_id: id, code: -1 };
    if (
      row.code === 0 &&
      (!text(row.operator_id) ||
        rows.filter((candidate) => candidate.code === 0 && candidate.operator_id === row.operator_id)
          .length !== 1)
    )
      return { project_id: id, code: -1 };
    return {
      project_id: id,
      code: row.code,
      ...(row.code === 0 ? { operator_id: text(row.operator_id) } : {}),
    };
  });
  return { remote_ids: { batch } };
}

function originalBatchReceipts(job: Job): BatchReceipt[] {
  const projects = array(job.input.projects).map(text);
  const rows: BatchReceipt[] =
    job.remote_ids.batch?.map((row) => ({ ...row })) ??
    projects.map((project_id) => ({ project_id, code: -1 }));
  if (
    !projects.length ||
    projects.some((id) => !id) ||
    new Set(projects).size !== projects.length ||
    rows.length !== projects.length ||
    rows.some(
      (row, index) =>
        row.project_id !== projects[index] ||
        !Number.isFinite(row.code) ||
        (row.code === 0 && !text(row.operator_id)),
    )
  )
    throw new TripoError('CONTRACT_CHANGED', 'Stored batch receipts do not match the original projects.');
  const originalOperators = rows.map((row) => row.operator_id).filter(Boolean);
  if (new Set(originalOperators).size !== originalOperators.length)
    throw new TripoError('CONTRACT_CHANGED', 'Stored batch receipts contain a duplicate operator.');
  return rows;
}

/** 对账按原项目身份补空缺，不根据用户给出的顺序猜测，不替换已接受或明确拒绝的回执。 */
export function reconcileExportBatch(job: Job, supplied: unknown): RemoteIds {
  if (!Array.isArray(supplied) || !supplied.length)
    throw new TripoError('REMOTE_ID_MISSING', 'Supply batch items with original project_id and operator_id.');
  const rows = originalBatchReceipts(job);
  const seen = new Set<string>();
  for (const value of supplied) {
    const suppliedRow = object(value);
    const project_id = text(suppliedRow.project_id);
    const operator_id = text(suppliedRow.operator_id);
    if (!project_id || !operator_id)
      throw new TripoError('REMOTE_ID_MISSING', 'Supply both original project and operator IDs.');
    const index = rows.findIndex((row) => row.project_id === project_id);
    if (index < 0 || seen.has(project_id))
      throw new TripoError(
        'INVALID_INPUT',
        'Receipt projects must be unique and belong to the original batch.',
      );
    seen.add(project_id);
    const current = rows[index]!;
    if (
      (current.code !== -1 && (current.code !== 0 || current.operator_id !== operator_id)) ||
      (current.operator_id && current.operator_id !== operator_id)
    )
      throw new TripoError('IDEMPOTENCY_CONFLICT', 'A confirmed batch receipt cannot be replaced.');
    if (rows.some((row, i) => i !== index && row.operator_id === operator_id))
      throw new TripoError('IDEMPOTENCY_CONFLICT', 'An operator cannot fill more than one batch receipt.');
    rows[index] = { project_id, operator_id, code: 0 };
  }
  return { batch: rows };
}

export function batchChild(job: Job, index: number): Job {
  const receipt = originalBatchReceipts(job)[index];
  if (!receipt?.operator_id)
    throw new TripoError('ARTIFACT_NOT_FOUND', 'This batch item has no accepted operator.');
  return {
    ...job,
    operation: 'export',
    remote_ids: receipt,
    input: { ...job.input, project_id: receipt.project_id, name: receipt.project_id },
  };
}
export async function exportBatchStatus(
  job: Job,
  poll: (child: Job) => Promise<RemoteStatus>,
): Promise<RemoteStatus> {
  if (!job.remote_ids.batch?.length)
    throw new TripoError('REMOTE_ID_MISSING', 'Batch receipt is missing; do not resubmit.');
  const rows = originalBatchReceipts(job);
  const results = await Promise.allSettled(
    rows.map(async (row, index) =>
      row.operator_id
        ? await poll(batchChild(job, index))
        : { state: 'failed' as const, progress: 0, artifacts: [] },
    ),
  );
  // 单项网络错误不撤销其他项目已经验明的产物；保存每项读错，不能把整批当成功或重新提交。
  const pollErrors = results.flatMap((result, index) =>
    result.status === 'rejected' ? [{ index, error: sanitize(errorResult(result.reason)) }] : [],
  );
  const states: RemoteStatus[] = results.map((result, index) =>
    result.status === 'fulfilled'
      ? result.value
      : {
          state: 'running',
          progress: 0,
          artifacts: job.artifacts.filter((artifact) => artifact.index === index),
        },
  );
  const artifacts: Artifact[] = states.flatMap((state, index) =>
    state.artifacts.map((artifact) => ({ ...artifact, artifact_id: `batch-${index}`, index })),
  );
  const pending = states.some((state) => ['submitted', 'running'].includes(state.state));
  const failed = states.some((state) => state.state === 'failed');
  const login = pollErrors.some((entry) => object(entry.error).code === 'AUTH_REQUIRED');
  return {
    state: login ? 'requires_login' : pending ? 'running' : failed ? 'failed' : 'succeeded',
    progress: states.reduce((sum, s) => sum + s.progress, 0) / rows.length,
    artifacts,
    ...(failed || pollErrors.length
      ? {
          error: {
            code: rows.some((r) => r.code === -1)
              ? 'PARTIAL_RECEIPT_UNKNOWN'
              : pollErrors.length
                ? 'BATCH_POLL_INCOMPLETE'
                : 'BATCH_ITEM_FAILED',
            items: rows,
            ...(pollErrors.length ? { poll_errors: pollErrors } : {}),
            message: 'Inspect individual receipts; never resubmit the whole batch.',
          },
        }
      : {}),
  };
}
