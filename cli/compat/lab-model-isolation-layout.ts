/** 新显式来源先复制历史版本；首次布局一旦冻结，升级和恢复不得移动已存在的子请求索引。 */
import type { JobStore } from '../storage/jobs.ts';
import type { Plan } from './planning.ts';
import { fingerprint } from '../core/fingerprint.ts';
import { labModelConflict, labModelSourceParameters } from './lab-model-lineage-target.ts';

export const labModelIsolationLayoutKey = (request: string): string =>
  `lab-model-isolation-layout:${request}`;
export const labModelIsolationRequestKey = (request: string): string => `lab-model-copy-request:${request}`;
export const labModelIsolationWarning =
  'A new explicitly selected Lab source is copied from its exact historical Studio operator before processing. The copy must preserve the frozen GLB bytes; saved display/material metadata may differ and is disclosed. Each processing step keeps its own request and possible cost.';
function intent(plan: Plan): string {
  return fingerprint({
    steps: plan.steps.map(({ warnings: _warnings, ...step }) => step),
    sourceValidation: plan.sourceValidation,
  });
}
function legacy(jobs: JobStore, account: string, request: string, plan: Plan): boolean {
  return Boolean(
    jobs.requestPolicy(account, `lab-model-selection:${request}`) ||
    jobs.requestPolicy(account, `sources:${request}`) ||
    jobs.find(account, request) ||
    Array.from({ length: plan.steps.length + 1 }, (_, i) => jobs.find(account, `${request}-${i}`)).some(
      Boolean,
    ),
  );
}
function selectedSource(selected: Plan['steps']): string {
  const source = selected[0]?.source;
  if (
    !source ||
    source === 'upstream' ||
    selected.some((step) => step.source !== source || step.sourceRepresentation !== 'studio_normalized')
  )
    return labModelConflict('Lab isolation requires one explicitly selected original Lab task.');
  return source;
}
/** 必须先于 freezePlanReferences / freezeLabModelSourceSelection；普通未选来源不增加新策略。 */
export function freezeLabModelIsolationLayout(
  jobs: JobStore,
  account: string,
  request: string,
  plan: Plan,
): Plan {
  const selected = plan.steps.filter((step) => step.sourceRepresentation !== undefined),
    saved = jobs.requestPolicy(account, labModelIsolationLayoutKey(request));
  if (!saved && !selected.length) return plan;
  const originalIntent = intent(plan);
  if (
    saved &&
    (saved.version !== 1 ||
      saved.intent !== originalIntent ||
      !['legacy', 'copy', 'existing_copy'].includes(String(saved.mode)))
  )
    return labModelConflict(
      'The original Lab source isolation layout or selected processing intent changed.',
    );
  // 旧策略/任务连新layout标记也不补写，保持其request_policies原字符串和集合。
  if (!saved && legacy(jobs, account, request, plan)) return plan;
  const source = selectedSource(selected);
  const mode = saved?.mode ?? (plan.steps[0]?.operation === 'copy' ? 'existing_copy' : 'copy');
  if (mode !== 'legacy' && plan.steps[0]?.sourceRepresentation !== 'studio_normalized')
    return labModelConflict('A new isolated Lab source must be the first processing source.');
  const sourceGuards = plan.steps.flatMap((step, index) =>
    step.sourceRepresentation ? [{ index, parameters: labModelSourceParameters(step.parameters) }] : [],
  );
  const policy = { version: 1, intent: originalIntent, mode, source_guards: sourceGuards };
  jobs.bindRequestPolicy(account, labModelIsolationLayoutKey(request), policy);
  if (mode === 'legacy') return plan;
  jobs.bindRequestPolicy(account, labModelIsolationRequestKey(`${request}-0`), {
    version: 1,
    parent: request,
    layout: fingerprint(policy),
  });
  const steps = plan.steps.map((step, index) => {
    if (mode === 'existing_copy' && index === 0) return step;
    if (step.sourceRepresentation === undefined) return step;
    // 精确旧operator不能留在隔离后的项目上；原守卫另存并在copy提交前按原来源逐个核验。
    const parameters = { ...step.parameters };
    for (const key of Object.keys(labModelSourceParameters(parameters))) parameters[key] = 'upstream';
    const changed = { ...step, parameters, source: 'upstream' };
    delete changed.sourceRepresentation;
    return changed;
  });
  if (mode === 'copy')
    steps.unshift({
      name: 'lab-source-copy',
      operation: 'copy',
      source,
      sourceRepresentation: 'studio_normalized',
      parameters: { project_id: 'upstream', operator_id: 'upstream' },
    });
  return {
    ...plan,
    steps,
    warnings: plan.warnings.includes(labModelIsolationWarning)
      ? plan.warnings
      : [...plan.warnings, labModelIsolationWarning],
  };
}
