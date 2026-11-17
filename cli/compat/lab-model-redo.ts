/** 重做保留原来源选择或已处理谱系，不把规范化副本静默变成普通项目输入。 */
import type { JobStore } from '../storage/jobs.ts';
import type { Job } from '../../studio/contracts/types.ts';
import type { Plan } from './planning.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import { redoLabModelSourceSelection } from './lab-model-source.ts';
import { labModelIsolationWarning } from './lab-model-isolation-layout.ts';

export function attachLabModelRedoSource(
  jobs: JobStore,
  source: Job,
  plan: Plan,
  param: Record<string, unknown>,
): Plan {
  const first = plan.steps[0];
  if (!first) return plan;
  const selection = redoLabModelSourceSelection(jobs, source, first.parameters);
  if (
    param.source_representation !== undefined &&
    (param.source_representation !== 'studio_normalized' || !selection)
  )
    throw new TripoError(
      'INVALID_INPUT',
      'Redo retains its original Studio source selection; it cannot add or change source_representation.',
      'not_submitted',
    );
  if (!selection) return plan;
  return {
    ...plan,
    warnings:
      selection.sourceRepresentation && !plan.warnings.includes(labModelIsolationWarning)
        ? [...plan.warnings, labModelIsolationWarning]
        : plan.warnings,
    steps: [{ ...first, ...selection }, ...plan.steps.slice(1)],
    ...(selection.sourceRepresentation
      ? { sourceValidation: { reference: selection.source, chain: [] } }
      : {}),
  };
}
