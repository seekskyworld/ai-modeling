/** 七次真实原生操作自动编排；任何门槛失败保留原回执，不更换请求或本地修模型。 */
import type { Flags, Plan } from './planning.ts';
import { downloadTask, executePlan, taskResult, type Application } from './runtime.ts';
import { array, errorResult, object, text, TripoError } from '../../studio/contracts/errors.ts';
import { smartSegmentScaleSnapshot } from '../../studio/api/smartsegment-scale-source.ts';
import { nativeScaleBytes } from '../artifacts/smartsegment-scale-io.ts';
import {
  prepareSmartSegmentAffineMerge,
  verifySmartSegmentAffineMerge,
} from '../artifacts/smartsegment-affine-proof.ts';
import { saveVerifiedOutputCache } from '../artifacts/verified-output-cache.ts';
import { scaleNativeModel } from '../core/smartsegment-scale-policy.ts';
import { smartSegmentImportIdentity } from '../core/smartsegment-transform-policy.ts';
import { fingerprint } from '../core/fingerprint.ts';
import {
  affineChildRequest,
  affineFail,
  affineGroupRequest,
  affineJobIdentity,
  affineSource,
  affineStage,
  affineStageAnchorKey,
  affineStageKey,
  assertAffineMetadata,
} from '../core/smartsegment-affine-policy.ts';
import { freezePlanReferences } from './source-policy.ts';
import { assertScaleAccount } from './smartsegment-scale.ts';
import { assertUneditedScaleMetadata } from './smartsegment-scale-steps.ts';
import { freezeAffineIntent, prepareAffineSource, readAffineCache } from './smartsegment-affine-source.ts';
import { affineBillingParameters } from './smartsegment-affine-billing.ts';

function componentPlan(app: Application, parent: string, stage: 'first' | 'second'): Plan {
  const { intent, source, preparation } = affineSource(app.service.jobs, app.service.accountRef(), parent),
    first = stage === 'first',
    merged = first ? undefined : affineStage(app.service.jobs, app.service.accountRef(), parent, 'merge'),
    parameters = first
      ? object(source.first_parameters)
      : { project_id: merged!.job.remote_ids.project_id, operator_id: merged!.job.remote_ids.operator_id },
    operation = first && intent.source_kind === 'file' ? ('import_model' as const) : ('copy' as const);
  return {
    smartSegmentScale: {
      matrix: preparation[first ? 'first_matrix' : 'second_matrix'] as number[],
      source_kind: operation === 'import_model' ? 'file' : 'reference',
    },
    steps: [
      {
        name: `smartsegment-affine-${stage}-source`,
        operation,
        parameters,
        ...(operation === 'copy' && (first ? source.source_job_id : merged?.job.job_id)
          ? { source: text(first ? source.source_job_id : merged!.job.job_id) }
          : {}),
      },
      {
        name: `smartsegment-affine-${stage}-metadata`,
        operation: 'project_edit',
        source: 'upstream',
        parameters: { project_id: 'upstream', expected_operator_id: 'upstream' },
      },
      {
        name: `smartsegment-affine-${stage}`,
        operation: 'segment',
        source: 'upstream',
        parameters: object(intent.segment_parameters),
      },
    ],
    pending_uploads: [],
    warnings: [],
  };
}
async function freezeStage(app: Application, parent: string, name: 'first' | 'merge'): Promise<void> {
  const account = app.service.accountRef(),
    jobs = app.service.jobs;
  if (jobs.requestPolicy(account, affineStageKey(parent, name))) {
    affineStage(jobs, account, parent, name);
    return;
  }
  const context = affineSource(jobs, account, parent),
    job = jobs.find(account, affineChildRequest(parent, name === 'first' ? 2 : 3));
  if (!job || job.state !== 'succeeded')
    return affineFail('The original native affine stage is not complete.');
  const artifact = scaleNativeModel(job),
    bytes = await nativeScaleBytes(job, artifact, app.service.gateway, app.service.config.dataDir),
    original = await readAffineCache(app, account, parent, context.source);
  let proof: Record<string, unknown>;
  if (name === 'first') proof = await prepareSmartSegmentAffineMerge(original, context.preparation, bytes);
  else {
    const first = affineStage(jobs, account, parent, 'first');
    proof = await verifySmartSegmentAffineMerge(
      original,
      context.preparation,
      await readAffineCache(app, account, parent, first.stage),
      bytes,
    );
  }
  const snapshot = await smartSegmentScaleSnapshot(
    app.studio.client,
    account,
    text(job.remote_ids.project_id),
    text(job.remote_ids.operator_id),
    false,
  );
  assertUneditedScaleMetadata(snapshot.metadata);
  assertAffineMetadata(snapshot.metadata, snapshot.complete_metadata);
  if (name === 'first') assertMergeName(snapshot.metadata, text(proof.merge_name));
  const byteProof = {
    sha256: text(proof[name === 'first' ? 'first_sha256' : 'merged_sha256']),
    bytes: bytes.length,
  };
  await saveVerifiedOutputCache(job, artifact, byteProof, bytes, app.service.config.dataDir);
  assertScaleAccount(app, account);
  affineSource(jobs, account, parent);
  const current = jobs.get(job.job_id),
    latest = scaleNativeModel(current);
  if (
    affineJobIdentity(current) !== affineJobIdentity(job) ||
    smartSegmentImportIdentity(current, latest) !== smartSegmentImportIdentity(job, artifact)
  )
    return affineFail('The original native affine stage changed during verification.');
  const stage = {
    ...proof,
    version: 1,
    source: fingerprint(context.source),
    job_id: job.job_id,
    artifact_id: artifact.artifact_id,
    identity: affineJobIdentity(job),
    artifact_identity: smartSegmentImportIdentity(job, artifact),
    ...byteProof,
    metadata: snapshot.metadata,
    complete_metadata: snapshot.complete_metadata,
    cache_data_dir: app.service.config.dataDir,
  };
  jobs.bindArtifactPolicy(job, artifact, affineStageKey(parent, name), stage);
  jobs.bindRequestPolicy(account, affineStageAnchorKey(parent, name), { stage: fingerprint(stage) });
  affineStage(jobs, account, parent, name);
}
function assertMergeName(metadata: Record<string, unknown>, name: string): void {
  const used = new Set([
    ...Object.keys(object(metadata.children_transform_matrix)),
    ...Object.keys(object(metadata.children_rename)),
    ...Object.values(object(metadata.children_rename)).map(text),
    ...array(metadata.children_deleted).map(text),
  ]);
  if (!name || used.has(name))
    return affineFail(
      'The frozen native affine merge name collides with current metadata. Existing metadata must not be cleared or renamed to continue.',
    );
}
async function mergePlan(app: Application, parent: string): Promise<Plan> {
  const account = app.service.accountRef(),
    jobs = app.service.jobs,
    first = affineStage(jobs, account, parent, 'first'),
    existing = jobs.find(account, affineChildRequest(parent, 3));
  if (!existing || existing.state === 'prepared') {
    const snapshot = await smartSegmentScaleSnapshot(
      app.studio.client,
      account,
      text(first.job.remote_ids.project_id),
      text(first.job.remote_ids.operator_id),
      false,
    );
    assertScaleAccount(app, account);
    affineStage(jobs, account, parent, 'first');
    assertUneditedScaleMetadata(snapshot.metadata);
    assertAffineMetadata(snapshot.metadata, snapshot.complete_metadata);
    assertMergeName(snapshot.metadata, text(first.stage.merge_name));
    if (fingerprint(snapshot.complete_metadata) !== fingerprint(first.stage.complete_metadata))
      return affineFail('The native first-stage metadata changed before merging.');
  }
  return {
    steps: [
      {
        name: 'smartsegment-affine-merge',
        operation: 'modification',
        parameters: {
          project_id: first.job.remote_ids.project_id,
          expected_operator_id: first.job.remote_ids.operator_id,
          part_indices: first.stage.part_indices,
          part_indices_name: first.stage.part_indices_name,
        },
      },
    ],
    pending_uploads: [],
    warnings: [],
  };
}
export async function executeSmartSegmentAffine(
  app: Application,
  plan: Plan,
  flags: Flags,
  parent: string,
): Promise<Record<string, unknown>> {
  if (flags.wait === false)
    throw new TripoError(
      'INVALID_INPUT',
      '--no-wait cannot execute the seven-step native affine chain.',
      'not_submitted',
    );
  const account = freezeAffineIntent(app, plan, parent);
  plan = freezePlanReferences(app, plan, parent);
  await prepareAffineSource(app, plan, parent);
  const chain: Record<string, unknown>[] = [];
  let last: Record<string, unknown> | undefined;
  const result = (): Record<string, unknown> => ({
    ...last,
    request_id: parent,
    final_request_id: last?.request_id,
    chain,
    warnings: plan.warnings,
    native_step_count: 7,
  });
  try {
    for (const stage of ['first', 'merge', 'second'] as const) {
      assertScaleAccount(app, account);
      const child = stage === 'merge' ? await mergePlan(app, parent) : componentPlan(app, parent, stage);
      if (stage !== 'second') {
        const index = stage === 'merge' ? 3 : 0;
        child.steps[0] = {
          ...child.steps[0]!,
          parameters: affineBillingParameters(app, plan, parent, index, child.steps[0]!.parameters, true),
        };
      }
      last = await executePlan(app, child, {
        ...flags,
        requestId: affineGroupRequest(parent, stage),
        download: false,
      });
      chain.push(...(array(last.chain).length ? array(last.chain).map(object) : [last]));
      if (last.status !== 'success') return result();
      if (stage !== 'second') await freezeStage(app, parent, stage);
    }
    const job = jobsFinal(app, account, parent);
    const current = await app.service.get(job.job_id);
    assertScaleAccount(app, account);
    last = taskResult(current);
    if (last.status === 'success' && flags.download !== false) {
      try {
        Object.assign(last, await downloadTask(app, current, { ...flags, outIsRoot: true }));
      } catch (error) {
        last.download_error = errorResult(error);
      }
    }
    return result();
  } catch (error) {
    if (!last) throw error;
    return {
      ...result(),
      status: 'needs_attention',
      error: errorResult(error),
      next_action:
        'Inspect and resume the complete original affine request; do not replace its request_id or resubmit completed stages.',
    };
  }
}
function jobsFinal(app: Application, account: string, parent: string) {
  const job = app.service.jobs.find(account, affineChildRequest(parent, 6));
  if (!job) return affineFail('The original final affine receipt is missing.');
  return job;
}
