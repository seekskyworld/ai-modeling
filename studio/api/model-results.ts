/** 原生批量和 P2 多变体共用多结果管理；任何已接受身份均保留，缺失回执不能重提整批。 */
import { object, text, errorResult, sanitize, TripoError } from '../contracts/errors.ts';
import type { Job, ModelReceipt, RemoteIds, RemoteStatus } from '../contracts/types.ts';

export function hasModelResults(job: Job): boolean {
  return job.operation === 'model' && (job.input.mode === 'batch' || Array.isArray(job.input.variations));
}

export function expectedModelCount(job: Job): number {
  const values =
    job.input.mode === 'batch'
      ? (job.input.image_sources ?? job.input.image_paths ?? job.input.image_assets)
      : job.input.variations;
  return Array.isArray(values) ? values.length : 0;
}

/** 回执槽位来自原始意图，不允许损坏或旧异常数据扩展数量、重复绑定或抹掉已知身份。 */
function originalModelReceipts(job: Job): ModelReceipt[] {
  const expected = expectedModelCount(job);
  const rows: ModelReceipt[] =
    job.remote_ids.models?.map((row) => ({ ...row })) ??
    Array.from({ length: expected }, () => ({ accepted: null }));
  if (
    !Number.isInteger(expected) ||
    expected < 1 ||
    rows.length !== expected ||
    rows.some(
      (row) =>
        ![true, false, null].includes(row.accepted) ||
        (row.accepted === true && (!text(row.project_id) || !text(row.operator_id))),
    )
  )
    throw new TripoError('CONTRACT_CHANGED', 'Stored model receipts do not match the original result count.');
  const operators = rows.map((row) => row.operator_id).filter(Boolean);
  if (new Set(operators).size !== operators.length)
    throw new TripoError('CONTRACT_CHANGED', 'Stored model receipts contain a duplicate operator.');
  return rows;
}

/** 人工对账只能补空缺，不能覆盖已有回执、重复绑定或按输入顺序猜测模型身份。 */
export function reconcileModelResults(job: Job, supplied: unknown): RemoteIds {
  if (!Array.isArray(supplied) || !supplied.length)
    throw new TripoError(
      'REMOTE_ID_MISSING',
      'Supply models with receipt index, project_id and operator_id.',
    );
  const rows = originalModelReceipts(job);
  const indexes = new Set<number>();
  for (const value of supplied) {
    const row = object(value),
      index = row.index;
    if (
      typeof index !== 'number' ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= rows.length ||
      indexes.has(index)
    )
      throw new TripoError(
        'INVALID_INPUT',
        'Receipt indexes must be unique and within the original result count.',
      );
    indexes.add(index);
    const current = rows[index]!;
    const project = text(row.project_id),
      operator = text(row.operator_id);
    if (!project || !operator)
      throw new TripoError('REMOTE_ID_MISSING', 'Supply both original project and operator IDs.');
    if (
      current.accepted === false ||
      (current.project_id && current.project_id !== project) ||
      (current.operator_id && current.operator_id !== operator)
    )
      throw new TripoError('IDEMPOTENCY_CONFLICT', 'A confirmed result cannot be replaced.');
    if (rows.some((r, i) => i !== index && r.operator_id === operator))
      throw new TripoError('IDEMPOTENCY_CONFLICT', 'An operator cannot fill more than one receipt.');
    rows[index] = { ...current, accepted: true, project_id: project, operator_id: operator };
  }
  return { models: rows };
}

/** 返回顺序是服务端回执顺序；仅记录服务器实际给出的面数，避免把缺项后的结果关联到错误输入。 */
export function modelResults(raw: unknown, expected: number): RemoteIds {
  const body = object(raw);
  const rows = Array.isArray(raw) ? raw : Array.isArray(body.variations) ? body.variations : [raw];
  const seen = new Set<string>();
  const models: ModelReceipt[] = rows.map((value) => {
    const row = object(value);
    const project_id = text(row.project_id);
    const operator_id = text(row.operator_id);
    const duplicate = Boolean(operator_id && seen.has(operator_id));
    if (operator_id) seen.add(operator_id);
    const accepted =
      row.accepted === false || (typeof row.code === 'number' && row.code !== 0)
        ? false
        : project_id && operator_id && !duplicate
          ? true
          : null;
    return {
      accepted,
      ...(project_id ? { project_id } : {}),
      ...(operator_id && !duplicate ? { operator_id } : {}),
      ...(typeof row.face_limit === 'number' ? { face_limit: row.face_limit } : {}),
      ...(typeof row.code === 'number' ? { code: row.code } : {}),
    };
  });
  if (!Number.isInteger(expected) || expected < 1 || models.length > expected)
    throw new TripoError(
      'CONTRACT_CHANGED',
      'Studio returned more model receipts than requested; reconcile the original intent without resubmitting.',
      'unknown',
      { expected_count: expected, received_count: models.length, observed_receipts: models },
    );
  while (models.length < expected) models.push({ accepted: null });
  return { models };
}

export function modelResultChild(job: Job, index: number): Job {
  const row = originalModelReceipts(job)[index];
  if (!row?.operator_id || !row.project_id || row.accepted !== true)
    throw new TripoError('ARTIFACT_NOT_FOUND', 'This model result has no confirmed accepted identity.');
  return {
    ...job,
    input: { ...job.input, mode: 'image', variations: undefined },
    remote_ids: { project_id: row.project_id, operator_id: row.operator_id },
  };
}

export async function modelResultsStatus(
  job: Job,
  poll: (child: Job) => Promise<RemoteStatus>,
): Promise<RemoteStatus> {
  if (!job.remote_ids.models?.length)
    throw new TripoError('REMOTE_ID_MISSING', 'Model receipts missing; do not resubmit.');
  const rows = originalModelReceipts(job);
  const states: RemoteStatus[] = [];
  const pollErrors: { index: number; error: unknown }[] = [];
  // 少量顺序查询避免一个大批次同时占满上游连接；每项身份始终保持独立。
  for (let index = 0; index < rows.length; index++) {
    try {
      states.push(
        rows[index]?.accepted === true
          ? await poll(modelResultChild(job, index))
          : { state: 'failed', progress: 0, artifacts: [] },
      );
    } catch (error) {
      // 某项只读失败后仍检查其他回执，保留每项原身份及此前已验证/下载的字节元数据。
      pollErrors.push({ index, error: sanitize(errorResult(error)) });
      states.push({
        state: 'running',
        progress: 0,
        artifacts: job.artifacts.filter((item) => item.index === index),
      });
    }
  }
  const pending = states.some((s) => ['submitted', 'running'].includes(s.state));
  const failed = states.some((s) => s.state === 'failed');
  const login = pollErrors.some((entry) => object(entry.error).code === 'AUTH_REQUIRED');
  return {
    state: login ? 'requires_login' : pending ? 'running' : failed ? 'failed' : 'succeeded',
    progress: states.reduce((sum, s) => sum + s.progress, 0) / rows.length,
    artifacts: states.flatMap((state, index) =>
      state.artifacts.map((artifact) => ({
        ...artifact,
        artifact_id: artifact.artifact_id.startsWith('semantic-mask')
          ? `semantic-mask-${index}`
          : `model-${index}`,
        index,
      })),
    ),
    ...(failed || pollErrors.length
      ? {
          error: {
            code: rows.some((r) => r.accepted === null)
              ? 'PARTIAL_RECEIPT_UNKNOWN'
              : pollErrors.length
                ? 'MODEL_POLL_INCOMPLETE'
                : 'MODEL_RESULT_FAILED',
            items: rows,
            ...(pollErrors.length ? { poll_errors: pollErrors } : {}),
            message:
              'Inspect individual results. A missing receipt does not mean a model was not submitted; never repeat the whole batch.',
          },
        }
      : {}),
  };
}
