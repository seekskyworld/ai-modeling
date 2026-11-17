/** 显式表示选择先于网络冻结；旧普通任务不追补新义务，已选请求也不能去掉选择绕过来源证明。 */
import { isDeepStrictEqual } from 'node:util';
import type { JobStore } from '../storage/jobs.ts';
import type { Job, Operation } from '../../studio/contracts/types.ts';
import { array, object, text, TripoError } from '../../studio/contracts/errors.ts';
import { fingerprint } from '../core/fingerprint.ts';
import {
  labModelOriginal,
  labModelSourceFail,
  type LabModelRepresentation,
} from './lab-model-source-policy.ts';

export interface LabModelSourceStep {
  operation: Operation;
  source?: string;
  sourceRepresentation?: LabModelRepresentation;
}
interface SelectionIntent {
  index: number;
  operation: Operation;
  source: string;
  representation: LabModelRepresentation;
}
const selectionKey = (request: string): string => `lab-model-selection:${request}`;
const conflict = (message: string): never => {
  throw new TripoError('IDEMPOTENCY_CONFLICT', message, 'not_submitted');
};
function selections(steps: LabModelSourceStep[]): SelectionIntent[] {
  return steps.flatMap((step, index) => {
    if (step.sourceRepresentation === undefined) return [];
    if (step.sourceRepresentation !== 'studio_normalized' || !step.source || step.source === 'upstream')
      return labModelSourceFail('Select studio_normalized only for a direct existing Lab task reference.');
    return [
      { index, operation: step.operation, source: step.source, representation: step.sourceRepresentation },
    ];
  });
}
function binding(jobs: JobStore, account: string, index: number, job: Job): Record<string, unknown> {
  if (job.account_ref !== account)
    throw new TripoError('ACCOUNT_MISMATCH', 'The selected Lab task belongs to another account.');
  const original = labModelOriginal(jobs, job);
  return {
    index,
    job_id: job.job_id,
    original_identity: original.identity,
    original_proof: fingerprint(original.proof),
  };
}
/** resolveLocalReference 只能查本机任务；恢复对同一表达式使用已冻结 UUID，不再次解释同名 alias。 */
export function freezeLabModelSourceSelection<T extends LabModelSourceStep>(
  jobs: JobStore,
  account: string,
  parentRequest: string,
  steps: T[],
  resolveLocalReference: (source: string) => Job,
): T[] {
  const intent = selections(steps),
    saved = jobs.requestPolicy(account, selectionKey(parentRequest));
  if (!saved && !intent.length) return steps;
  if (saved && (saved.version !== 1 || !isDeepStrictEqual(saved.intent, intent)))
    return conflict('The original source_representation selection, operation or source reference changed.');
  let bindings: Record<string, unknown>[];
  if (saved) {
    bindings = array(saved.bindings).map(object);
    if (bindings.length !== intent.length)
      return conflict('The original Lab source selection bindings are incomplete.');
    for (const [i, selected] of intent.entries()) {
      const prior = bindings[i]!;
      if (prior.index !== selected.index || !text(prior.job_id))
        return conflict('The original Lab source selection index changed.');
      const current = binding(jobs, account, selected.index, jobs.get(text(prior.job_id)));
      if (!isDeepStrictEqual(current, prior))
        return conflict('The selected original Lab task or output proof changed.');
    }
  } else {
    if (
      jobs.find(account, parentRequest) ||
      steps.some((_, index) => jobs.find(account, `${parentRequest}-${index}`))
    )
      return conflict(
        'An existing downstream request cannot acquire a later Studio representation selection.',
      );
    bindings = intent.map((selected) =>
      binding(jobs, account, selected.index, resolveLocalReference(selected.source)),
    );
    jobs.bindRequestPolicy(account, selectionKey(parentRequest), { version: 1, intent, bindings });
  }
  const byIndex = new Map(bindings.map((item) => [item.index, text(item.job_id)]));
  return steps.map((step, index) => (byIndex.has(index) ? { ...step, source: byIndex.get(index)! } : step));
}

export {
  bindLabModelSourceDelivery,
  assertLabModelSourceSubmission,
  labModelSourceSummary,
  redoLabModelSourceSelection,
} from './lab-model-lineage.ts';
