/** 无服务端幂等键的准备写：SQLite冻结唯一attempt，成功回执另存；未知窗口永不重发。 */
import { randomUUID } from 'node:crypto';
import type { JobStore } from '../storage/jobs.ts';
import { fingerprint } from '../core/fingerprint.ts';
import { object, text, TripoError } from '../../studio/contracts/errors.ts';
import { labReferenceKey } from './lab-reference-edit-policy.ts';

export interface LabJournal {
  jobs: JobStore;
  account: string;
  parent: string;
  check: () => void;
}
export function labPreparationUnknown(parent: string, stage: string): never {
  throw new TripoError(
    'LAB_PREPARATION_OUTCOME_UNKNOWN',
    `The original ${stage} preparation has a send marker without a verified receipt. Preserve this request and reconcile it; it will not be submitted again.`,
    'unknown',
    { request_id: parent, preparation_stage: stage },
  );
}
export async function labJournalStep(
  context: LabJournal,
  stage: string,
  input: Record<string, unknown>,
  run: () => Promise<Record<string, unknown>>,
  reconcile?: (start: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>,
): Promise<Record<string, unknown>> {
  const { jobs, account, parent, check } = context,
    inputHash = fingerprint(input);
  const startKey = labReferenceKey(parent, `${stage}:start`),
    receiptKey = labReferenceKey(parent, `${stage}:receipt`);
  check();
  let start = jobs.requestPolicy(account, startKey);
  const receipt = jobs.requestPolicy(account, receiptKey);
  if (receipt) {
    if (
      !start ||
      start.input !== inputHash ||
      receipt.input !== inputHash ||
      receipt.attempt !== start.attempt
    )
      throw new TripoError(
        'IDEMPOTENCY_CONFLICT',
        'The frozen Lab preparation receipt differs from its original attempt.',
        'not_submitted',
      );
    return object(receipt.result);
  }
  if (start) {
    if (start.input !== inputHash)
      throw new TripoError(
        'IDEMPOTENCY_CONFLICT',
        'The Lab preparation input changed under its original request.',
        'not_submitted',
      );
    const recovered = reconcile ? await reconcile(start) : undefined;
    check();
    if (!recovered) return labPreparationUnknown(parent, stage);
    jobs.bindRequestPolicy(account, receiptKey, {
      attempt: start.attempt,
      input: inputHash,
      result: recovered,
    });
    return recovered;
  }
  const attempt = randomUUID();
  start = { version: 1, attempt, input: inputHash, parameters: input };
  try {
    jobs.bindRequestPolicy(account, startKey, start);
  } catch (error) {
    // 相同输入不表示领取成功；只有本进程的随机token才有派发权。
    const winner = jobs.requestPolicy(account, startKey);
    if (winner && winner.input === inputHash && text(winner.attempt) !== attempt)
      return labPreparationUnknown(parent, stage);
    throw error;
  }
  check();
  if (jobs.requestPolicy(account, startKey)?.attempt !== attempt) return labPreparationUnknown(parent, stage);
  const result = await run();
  check();
  if (jobs.requestPolicy(account, startKey)?.attempt !== attempt) return labPreparationUnknown(parent, stage);
  jobs.bindRequestPolicy(account, receiptKey, { attempt, input: inputHash, result });
  return result;
}
