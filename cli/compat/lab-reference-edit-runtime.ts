/** 兼容CLI的参考图编辑编排：准备步骤可恢复，付费Lab仍由统一TaskService提交与查询。 */
import type { JobStore } from '../storage/jobs.ts';
import type { Job } from '../../studio/contracts/types.ts';
import { text, errorResult, TripoError } from '../../studio/contracts/errors.ts';
import { normalize } from '../../studio/contracts/schemas.ts';
import { fingerprint } from '../core/fingerprint.ts';
import type { Flags, Plan } from './planning.ts';
import { waitTask, taskResult, downloadTask, type Application } from './runtime.ts';
import {
  labReferenceEditPrompt,
  labReferenceEditPlan,
  type LabReferenceEditIntent,
} from './lab-reference-edit-plan.ts';
import { freezeLabReferenceSource } from './lab-reference-edit-source.ts';
import { labGraphIO, prepareLabReferenceGraph, type LabGraphIO } from './lab-reference-edit-graph.ts';
import {
  labReferenceKey,
  labReferenceJobKey,
  labReferencePolicyForRequest,
  labReferenceEditPolicy,
  labReferenceFailure,
  labReferenceOutputProof,
} from './lab-reference-edit-policy.ts';
import { hasVerifiedOutputCache } from '../artifacts/verified-output-cache.ts';
import { readImageCache } from '../artifacts/image-cache.ts';
import { labProjectedSegmentPlan, labProjectedSegmentPrompt } from './lab-projected-segment-plan.ts';
import { array } from '../../studio/contracts/errors.ts';

export function assertLabReferenceEditPlan(
  jobs: JobStore,
  account: string,
  request: string,
  plan: Plan,
): void {
  const saved = jobs.requestPolicy(account, labReferenceKey(request, 'intent'));
  if (saved && (!plan.labReferenceEdit || fingerprint(saved) !== fingerprint(plan.labReferenceEdit)))
    throw new TripoError(
      'IDEMPOTENCY_CONFLICT',
      'This request already belongs to reference-guided Lab editing; its source, image, region and backend cannot change.',
      'not_submitted',
    );
  if (!plan.labReferenceEdit) {
    if (jobs.requestPolicy(account, labReferenceJobKey(`${request}-0`)))
      throw new TripoError(
        'IDEMPOTENCY_CONFLICT',
        'An original Lab reference child cannot be recovered through another plan.',
        'not_submitted',
      );
    return;
  }
  if (plan.steps.length !== 1 || plan.steps[0]!.operation !== 'canvas_lab')
    throw new TripoError(
      'INVALID_INPUT',
      'Reference Lab editing must retain its complete preparation and one Lab job.',
      'not_submitted',
    );
  if (
    !saved &&
    (jobs.find(account, `${request}-0`) ||
      jobs.find(account, `${request}-multiview`) ||
      jobs.find(account, request) ||
      jobs.requestPolicy(account, labReferenceJobKey(`${request}-0`)))
  )
    throw new TripoError(
      'IDEMPOTENCY_CONFLICT',
      'An existing task cannot acquire a new Lab reference obligation or another backend.',
      'not_submitted',
    );
  if (
    !saved &&
    ['source', 'nodes', 'graph', 'registered', 'create:start'].some((part) =>
      jobs.requestPolicy(account, labReferenceKey(request, part)),
    )
  )
    return labReferenceFailure('Orphan Lab preparation records require their original parent intent.');
}

export async function executeLabReferenceEdit(
  app: Application,
  plan: Plan,
  flags: Flags,
  request: string,
  preparationIO?: LabGraphIO,
): Promise<Record<string, unknown>> {
  const jobs = app.service.jobs,
    account = app.service.accountRef();
  assertLabReferenceEditPlan(jobs, account, request, plan);
  if (!plan.labReferenceEdit) throw new TripoError('INVALID_INPUT', 'Missing Lab reference plan.');
  const intent: LabReferenceEditIntent = plan.labReferenceEdit;
  jobs.bindRequestPolicy(
    account,
    labReferenceKey(request, 'intent'),
    intent as unknown as Record<string, unknown>,
  );
  const expected = fingerprint(intent);
  const check = () => {
    if (app.service.accountRef() !== account)
      throw new TripoError(
        'ACCOUNT_MISMATCH',
        'The active account changed during Lab preparation.',
        'not_submitted',
      );
    if (fingerprint(jobs.requestPolicy(account, labReferenceKey(request, 'intent'))) !== expected)
      return labReferenceFailure('The original Lab parent intent changed while awaiting an operation.');
  };
  const source = await freezeLabReferenceSource(app, account, request, intent, check);
  check();
  let frozen = labReferencePolicyForRequest(jobs, account, `${request}-0`);
  if (!frozen) {
    if (jobs.find(account, `${request}-0`))
      return labReferenceFailure(
        'The existing Lab job lacks its original reference-preservation obligation.',
      );
    const graph = await prepareLabReferenceGraph(
      { jobs, account, parent: request, check },
      source,
      preparationIO ?? labGraphIO(app, source),
    );
    check();
    // 准备期间本地源如被替换，不能因已上传一份缓存就静默接受不同请求。
    await freezeLabReferenceSource(app, account, request, intent, check);
    check();
    const parameters = normalize('canvas_lab', {
      node_id: graph.lab_node_id,
      asset_ids: [graph.model_asset_id, graph.image_asset_id],
      prompt:
        intent.kind === 'projected_segment'
          ? labProjectedSegmentPrompt(intent.projection, array(source.geometry.groups).length)
          : labReferenceEditPrompt(intent.bbox),
      accept_variable_cost: true,
    });
    jobs.bindRequestPolicy(account, labReferenceJobKey(`${request}-0`), {
      version: 1,
      parent: request,
      intent: expected,
      source,
      parameters,
    });
    frozen = labReferencePolicyForRequest(jobs, account, `${request}-0`)!;
  }
  check();
  const submitted = await app.service.submit(
    'canvas_lab',
    `${request}-0`,
    frozen.parameters,
    typeof flags.maxCredits === 'number' ? flags.maxCredits : 0,
  );
  check();
  const id = text(submitted.job_id);
  if (!id) return labReferenceFailure('The original TaskService Lab receipt has no local job identity.');
  jobs.linkStep(account, request, 0, id);
  jobs.assignName(
    account,
    text(flags.name) || (intent.kind === 'projected_segment' ? 'projected-segment' : 'reference-edit'),
    id,
  );
  const view =
    flags.wait === false
      ? submitted
      : await waitTask(app, id, typeof flags.timeout === 'number' ? flags.timeout : 1800);
  check();
  const result: Record<string, unknown> = {
    ...taskResult(view),
    request_id: request,
    final_request_id: `${request}-0`,
    name: jobs.name(account, id),
    warnings: plan.warnings,
    backend: 'studio_lab',
    ...(intent.kind === 'projected_segment'
      ? { native_v2_engine: false, explicit_projection: true }
      : { official_p2_engine: false }),
    variable_cost: true,
    preparation: jobs.requestPolicy(account, labReferenceKey(request, 'graph')),
  };
  if (view.state === 'succeeded' && flags.download !== false) {
    try {
      Object.assign(result, await downloadTask(app, view, { ...flags, outIsRoot: true }));
      check();
    } catch (error) {
      result.download_error = errorResult(error);
    }
  }
  return result;
}

/** redo不能把带验收义务的兼容任务降级为复制裸Lab prompt/node。 */
export function redoLabReferenceEditPlan(
  jobs: JobStore,
  dataDir: string,
  job: Job,
  seed?: unknown,
  overrides: Record<string, unknown> = {},
): Plan | undefined {
  const policy = labReferenceEditPolicy(jobs, job);
  if (!policy) return;
  if (
    seed !== undefined ||
    Object.entries(overrides).some(([key, value]) => key !== 'accept_variable_cost' || value !== true)
  )
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      'Lab reference redo preserves the original inputs and region; an explicit seed or parameter override has no verified mapping.',
      'not_submitted',
    );
  const models = job.artifacts.filter((a) => a.kind === 'model');
  if (job.state !== 'succeeded' || models.length !== 1)
    throw new TripoError(
      'INPUT_NOT_READY',
      'Verify the original Lab result before a new explicit redo; pending, failed and unknown jobs cannot be resubmitted.',
      'not_submitted',
    );
  labReferenceOutputProof(jobs, job, models[0]!);
  if (
    !hasVerifiedOutputCache(job.account_ref, policy.source.model, dataDir) ||
    !readImageCache(
      policy.source.image.cache_data_dir,
      'lab-reference-cache',
      policy.source.image.cache_path,
      policy.source.image,
    )
  )
    return labReferenceFailure('The original model or reference image cache needed for redo is unavailable.');
  const plan =
    policy.intent.kind === 'projected_segment'
      ? labProjectedSegmentPlan(policy.source.model.cache_path, {
          ref_image: policy.source.image.cache_path,
          reference_projection: policy.intent.projection,
          accept_variable_cost: true,
        })!
      : labReferenceEditPlan(policy.source.model.cache_path, {
          ref_image: policy.source.image.cache_path,
          bbox: policy.intent.bbox,
          accept_variable_cost: true,
        })!;
  plan.labReferenceEdit!.redo_of = {
    job_id: job.job_id,
    request_id: job.request_id,
    source_sha256: policy.source.model.sha256,
    reference_sha256: policy.source.image.sha256,
  };
  return plan;
}
