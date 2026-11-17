/** 逐视图子请求可独立恢复；原始四槽和指令先冻结，未知子回执不会被再次提交。 */
import { randomUUID } from 'node:crypto';
import { fingerprint } from '../core/fingerprint.ts';
import {
  isMultiviewBundle,
  multiviewBundle,
  multiviewSources,
  multiviewChildren,
  multiviewNames,
  type MultiviewSource,
} from '../core/multiview-bundle.ts';
import { resolveMultiviewReference } from '../../studio/api/discovery.ts';
import { text, errorResult, TripoError } from '../../studio/contracts/errors.ts';
import { taskType } from '../../studio/contracts/task-type.ts';
import type { Job, Quote } from '../../studio/contracts/types.ts';
import type { Plan, Flags } from './planning.ts';
import { resolveJob, executePlan, waitTask, downloadTask, taskResult, type Application } from './runtime.ts';

async function sourceViews(
  app: Application,
  reference: string,
): Promise<{ reference: string; sources: MultiviewSource[] }> {
  let job: Job;
  try {
    job = resolveJob(app, reference);
  } catch (error) {
    if (!(error instanceof TripoError) || error.code !== 'JOB_NOT_FOUND' || reference.startsWith('@'))
      throw error;
    return { reference, sources: await resolveMultiviewReference(app.studio.client, reference) };
  }
  if ((await app.service.get(job.job_id)).state !== 'succeeded')
    throw new TripoError(
      'INPUT_NOT_READY',
      'Wait for the source multiview task to succeed.',
      'not_submitted',
    );
  job = app.service.jobs.get(job.job_id);
  if (isMultiviewBundle(job))
    return { reference: job.job_id, sources: multiviewSources(app.service.jobs, job) };
  if (taskType(job) !== 'generate_multiview_image')
    throw new TripoError(
      'INVALID_INPUT',
      'edit-multiview requires a generated four-view task, not independent image candidates.',
      'not_submitted',
    );
  return {
    reference: job.job_id,
    sources: await resolveMultiviewReference(app.studio.client, text(job.remote_ids.asset_id)),
  };
}

function localQuote(): Quote {
  const now = new Date().toISOString();
  return {
    known: true,
    credits: 0,
    hard_limit: false,
    source: 'local_view_composition',
    observed_at: now,
    expires_at: now,
    explanation:
      'The local four-view receipt has no additional charge. Each native image-edit child is quoted and billed separately.',
  };
}

async function prepareBundle(app: Application, plan: Plan, request: string): Promise<Job> {
  const intent = plan.multiviewEdit!,
    account = app.service.accountRef(),
    key = `${request}-multiview`;
  const existing = app.service.jobs.find(account, key);
  if (existing) {
    if (fingerprint(multiviewBundle(existing).intent) !== fingerprint(intent))
      throw new TripoError(
        'IDEMPOTENCY_CONFLICT',
        'The original multiview source, model or view instructions changed.',
        'not_submitted',
      );
    return existing;
  }
  const resolved = await sourceViews(app, intent.source);
  const definition = {
    version: 1,
    intent,
    source_reference: resolved.reference,
    sources: resolved.sources,
    children: intent.prompts.map((item) => ({
      view: item.view,
      request_id: `${request}-view-${item.view}-0`,
    })),
  };
  const root = app.service.jobs.prepare(
    account,
    key,
    'image_process',
    { action: 'multiview', _multiview_edit: definition },
    localQuote(),
  );
  // 这里只登记本机组合，没有远端提交窗口，也不占账号的付费提交租约。
  const submitted = app.service.jobs.update(root.job_id, 'submitted');
  app.service.jobs.linkStep(account, `multiview:${root.job_id}`, 0, root.job_id);
  return submitted;
}

export async function executeMultiviewEdit(
  app: Application,
  plan: Plan,
  flags: Flags,
): Promise<Record<string, unknown>> {
  const request = text(flags.requestId) || randomUUID();
  let root = await prepareBundle(app, plan, request);
  const saved = multiviewBundle(root);
  let submissionError: Record<string, unknown> | undefined;
  for (const [index, item] of saved.children.entries()) {
    const children = multiviewChildren(app.service.jobs, root);
    if (
      children.some(
        (child) =>
          child &&
          ['outcome_unknown', 'failed', 'requires_login', 'waiting_input', 'submitting'].includes(
            child.state,
          ),
      )
    )
      break;
    const child = children[index];
    if (child && child.state !== 'prepared') continue;
    const original = plan.steps[index]!;
    const source = saved.sources[multiviewNames.indexOf(item.view)]!;
    const parameters = { ...original.parameters, image_asset: { ...source } };
    try {
      await executePlan(
        app,
        { steps: [{ ...original, source: undefined, parameters }], pending_uploads: [], warnings: [] },
        {
          ...flags,
          requestId: item.request_id.slice(0, -2),
          wait: false,
          download: false,
          name: `edit-${item.view}`,
        },
      );
    } catch (error) {
      submissionError = errorResult(error);
      break;
    }
    const created = app.service.jobs.find(root.account_ref, item.request_id);
    if (created)
      app.service.jobs.linkStep(root.account_ref, `multiview:${root.job_id}`, index + 1, created.job_id);
  }
  app.service.jobs.assignName(root.account_ref, text(flags.name) || 'edited-multiview', root.job_id);
  const view =
    flags.wait === false
      ? await app.service.get(root.job_id)
      : await waitTask(app, root.job_id, typeof flags.timeout === 'number' ? flags.timeout : 1800);
  root = app.service.jobs.get(root.job_id);
  const result = {
    ...taskResult(view),
    name: app.service.jobs.name(root.account_ref, root.job_id),
    warnings: plan.warnings,
    ...(submissionError ? { submission_error: submissionError } : {}),
  };
  if (view.state === 'succeeded' && flags.download !== false) {
    try {
      Object.assign(result, await downloadTask(app, view, { ...flags, outIsRoot: true }));
    } catch (error) {
      Object.assign(result, { download_error: errorResult(error) });
    }
  }
  return result;
}
