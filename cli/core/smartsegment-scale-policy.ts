/** metadata 三步义务属于整个 request；换入口、布局中断或换回执不能跳过验收。 */
import type { Artifact, Job, Operation } from '../../studio/contracts/types.ts';
import type { JobStore } from '../storage/jobs.ts';
import { array, object, text, TripoError } from '../../studio/contracts/errors.ts';
import type { NativeSegmentRoute, SubmissionOptions } from '../../studio/api/segment-route.ts';
import { fingerprint } from './fingerprint.ts';
import { completeScaleOutputProof } from './smartsegment-scale-proof-policy.ts';
import { smartSegmentImportIdentity } from './smartsegment-transform-policy.ts';

export const scaleIntentKey = (request: string): string => `smartsegment-scale-intent:${request}`;
export const scaleStepKey = (request: string): string => `smartsegment-scale-step:${request}`;
export const scaleInputKey = (request: string): string => `smartsegment-scale-input:${request}`;
export const scaleSourceKey = (request: string): string => `smartsegment-scale-source:${request}`;
export const scaleBaseKey = (request: string): string => `smartsegment-scale-base:${request}`;
export const scaleEditKey = (request: string): string => `smartsegment-scale-edit:${request}`;
export const scaleRouteKey = (request: string): string => `smartsegment-scale-route:${request}`;
export const scaleOutputKey = (job: Job, artifact: Artifact): string =>
  `smartsegment-scale-output:${job.job_id}:${artifact.artifact_id}`;
export const scaleJobIdentity = (job: Job): string =>
  fingerprint({
    account: job.account_ref,
    job: job.job_id,
    operation: job.operation,
    input: job.input,
    remote: job.remote_ids,
  });
export function scaleParameters(input: Record<string, unknown>): Record<string, unknown> {
  const parameters = { ...input };
  delete parameters._input_files;
  delete parameters._smartsegment_affine;
  return parameters;
}
const fail = (message: string): never => {
  throw new TripoError('SMARTSEGMENT_SCALE_UNVERIFIED', message, 'not_submitted');
};
/** 每次重验都维持唯一原生 GLB 条件；后补下载摘要只能与冻结原件一致。 */
export function scaleNativeModel(job: Job, expected?: Record<string, unknown>): Artifact {
  const models = job.artifacts.filter((artifact) => artifact.kind === 'model');
  const artifact = models[0];
  if (
    job.state !== 'succeeded' ||
    models.length !== 1 ||
    !artifact ||
    artifact.format !== 'glb' ||
    artifact.processing ||
    (expected?.sha256 !== undefined &&
      artifact.sha256 !== undefined &&
      artifact.sha256 !== expected.sha256) ||
    (expected?.bytes !== undefined && artifact.bytes !== undefined && artifact.bytes !== expected.bytes)
  )
    return fail('The frozen source must retain its one native GLB and original verified bytes.');
  return artifact;
}
/** 最终分割必须同时保留唯一原生模型和语义预览，不能在下载 await 后丢弃验收依赖。 */
export function scaleNativeOutput(job: Job, expected?: Record<string, unknown>): Artifact {
  const masks = job.artifacts.filter((artifact) => artifact.artifact_id === 'semantic-mask');
  if (masks.length !== 1 || masks[0]!.kind !== 'image' || masks[0]!.format !== 'png')
    throw new TripoError(
      'SMARTSEGMENT_SCALE_OUTPUT_PENDING',
      'The original segmentation must retain its unique native GLB and PNG mask.',
      'read',
    );
  return scaleNativeModel(job, expected);
}
export function scaleContext(jobs: JobStore, account: string, parent: string) {
  const intent = jobs.requestPolicy(account, scaleIntentKey(parent));
  if (!intent || intent.version !== 1) return fail('The original metadata-scale intent is missing.');
  if (
    intent.reference_segmentation_strategy !== undefined &&
    (intent.reference_segmentation_strategy !== 'ordinary' || intent.first_operation !== 'copy')
  )
    return fail('The original reference segmentation obligation is invalid.');
  for (let index = 0; index < 3; index++) {
    const step = jobs.requestPolicy(account, scaleStepKey(`${parent}-${index}`));
    if (step?.parent !== parent || step.index !== index || step.intent !== fingerprint(intent))
      return fail('The metadata-scale layout is incomplete. Resume the original complete request.');
  }
  return intent;
}
export function scaleSource(jobs: JobStore, account: string, parent: string) {
  const intent = scaleContext(jobs, account, parent),
    source = jobs.requestPolicy(account, scaleSourceKey(parent));
  if (
    !source ||
    (source.version !== 1 && source.version !== 2) ||
    source.intent !== fingerprint(intent) ||
    !text(source.sha256)
  )
    return fail('The original metadata-scale source has not been frozen.');
  if ((intent.reference_segmentation_strategy === 'ordinary') !== (source.version === 2))
    return fail('The original reference route obligation cannot be downgraded to a legacy source.');
  if (
    (source.version === 2 ||
      object(source.inspection).version === 2 ||
      source.segmentation_strategy !== undefined) &&
    (source.kind !== 'reference' ||
      (object(source.inspection).version !== 1 && object(source.inspection).version !== 2) ||
      source.segmentation_strategy !== 'ordinary')
  )
    return fail('The verified reference source must retain its original ordinary-segment strategy.');
  if (source.source_job_id) {
    const job = jobs.get(text(source.source_job_id)),
      artifact = scaleNativeModel(job, source);
    if (
      job.account_ref !== account ||
      job.state !== 'succeeded' ||
      artifact.artifact_id !== source.source_artifact_id ||
      smartSegmentImportIdentity(job, artifact) !== source.source_identity
    )
      return fail('The frozen task source changed. No new copy or segmentation was submitted.');
  }
  return { intent, source };
}
export function scaleStageJob(jobs: JobStore, account: string, parent: string, index: number): Job {
  const job = jobs.find(account, `${parent}-${index}`),
    binding = jobs.requestPolicy(account, scaleInputKey(`${parent}-${index}`));
  if (
    !job ||
    job.state !== 'succeeded' ||
    !binding ||
    job.operation !== binding.operation ||
    fingerprint(scaleParameters(job.input)) !== binding.input
  )
    return fail('A preceding metadata-scale step is missing, changed or incomplete.');
  return job;
}
export function scaleBase(jobs: JobStore, account: string, parent: string) {
  const frozen = scaleSource(jobs, account, parent),
    job = scaleStageJob(jobs, account, parent, 0),
    proof = jobs.requestPolicy(account, scaleBaseKey(parent)),
    artifact = scaleNativeModel(job, proof);
  if (
    !proof ||
    artifact.artifact_id !== proof.artifact_id ||
    proof.source_sha256 !== frozen.source.sha256 ||
    proof.identity !== smartSegmentImportIdentity(job, artifact)
  )
    return fail('The verified copy or identity import changed.');
  return { ...frozen, base: job, proof, artifact };
}
export function scaleEditedSource(jobs: JobStore, account: string, parent: string) {
  const frozen = scaleBase(jobs, account, parent),
    edit = scaleStageJob(jobs, account, parent, 1),
    proof = jobs.requestPolicy(account, scaleEditKey(parent)),
    artifact = scaleNativeModel(edit, proof);
  if (
    !proof ||
    proof.identity !== scaleJobIdentity(edit) ||
    proof.artifact_identity !== smartSegmentImportIdentity(edit, artifact) ||
    proof.base_identity !== frozen.proof.identity ||
    edit.remote_ids.project_id !== frozen.base.remote_ids.project_id ||
    !edit.remote_ids.operator_id
  )
    return fail('The confirmed metadata head changed or its proof is missing.');
  return { ...frozen, edit, editProof: proof };
}

/** 新引用按已验实体冻结路线；旧单root请求没有策略键，不自动改换原生路线。 */
function expectedScaleRoute(jobs: JobStore, account: string, parent: string) {
  const frozen = scaleEditedSource(jobs, account, parent),
    inspection = object(frozen.source.inspection);
  if (frozen.source.segmentation_strategy === undefined) return;
  const roots = inspection.version === 2 ? array(inspection.roots).map(object) : [inspection],
    names = roots.map((root) => text(root.node_name)),
    metadata = {
      ...object(frozen.source.metadata),
      children_deleted: [],
      children_transform_matrix: {
        ...object(object(frozen.source.metadata).children_transform_matrix),
        ...Object.fromEntries(names.map((name) => [name, frozen.intent.matrix])),
      },
    },
    submittedMetadata = Object.fromEntries(
      ['children_deleted', 'children_rename', 'children_transform_matrix', 'material_factor'].map((key) => [
        key,
        frozen.edit.input[key],
      ]),
    );
  if (
    frozen.source.kind !== 'reference' ||
    frozen.source.segmentation_strategy !== 'ordinary' ||
    (inspection.version !== 1 && inspection.version !== 2) ||
    roots.length < (inspection.version === 2 ? 2 : 1) ||
    roots.length > 64 ||
    names.some((name) => !name) ||
    new Set(names).size !== names.length ||
    fingerprint(frozen.proof.inspection) !== fingerprint(inspection) ||
    fingerprint(submittedMetadata) !== fingerprint(metadata) ||
    fingerprint(frozen.editProof.metadata) !== fingerprint(metadata)
  )
    return fail('The ordinary-segment source, every named delta and confirmed metadata must remain exact.');
  return {
    version: 1,
    strategy: 'ordinary' as const,
    source_sha256: frozen.source.sha256,
    source_bytes: frozen.source.bytes,
    source_inspection: fingerprint(inspection),
    intent: fingerprint(frozen.intent),
    edit_identity: scaleJobIdentity(frozen.edit),
    project_id: text(frozen.edit.remote_ids.project_id),
    expected_operator_id: text(frozen.edit.remote_ids.operator_id),
    metadata,
  };
}
export function freezeScaleSegmentRoute(jobs: JobStore, account: string, parent: string): void {
  const expected = expectedScaleRoute(jobs, account, parent);
  if (expected) {
    if (!jobs.requestPolicy(account, scaleRouteKey(parent)) && jobs.find(account, `${parent}-2`))
      return fail(
        'The original native submission is missing its frozen route; a later proof cannot replace it.',
      );
    jobs.bindRequestPolicy(account, scaleRouteKey(parent), expected);
  }
  scaleSegmentRoute(jobs, account, parent);
}
export function scaleSegmentRoute(
  jobs: JobStore,
  account: string,
  parent: string,
): NativeSegmentRoute | undefined {
  const expected = expectedScaleRoute(jobs, account, parent),
    saved = jobs.requestPolicy(account, scaleRouteKey(parent));
  if (!expected) {
    if (saved) return fail('An original single-root request cannot acquire another native segment route.');
    return;
  }
  if (!saved || fingerprint(saved) !== fingerprint(expected))
    return fail(
      'The frozen ordinary-segment route is missing or changed. Resume the complete original request.',
    );
  return {
    strategy: expected.strategy,
    project_id: expected.project_id,
    expected_operator_id: expected.expected_operator_id,
    metadata: expected.metadata,
  };
}
export function scaleSubmissionOptions(jobs: JobStore, job: Job): SubmissionOptions | undefined {
  if (!smartSegmentScaleRequested(jobs, job)) return;
  const parent = /^(.*)-2$/.exec(job.request_id)![1]!,
    segmentRoute = scaleSegmentRoute(jobs, job.account_ref, parent);
  return segmentRoute ? { segmentRoute } : undefined;
}

export function assertSmartSegmentScaleStep(
  jobs: JobStore,
  account: string,
  request: string,
  operation: Operation,
  input: Record<string, unknown>,
): void {
  const step = jobs.requestPolicy(account, scaleStepKey(request)),
    parent = text(step?.parent) || /^(.*)-[012]$/.exec(request)?.[1];
  if (!parent || !jobs.requestPolicy(account, scaleIntentKey(parent))) return;
  const { source } = scaleSource(jobs, account, parent),
    binding = jobs.requestPolicy(account, scaleInputKey(request));
  if (
    !step ||
    !binding ||
    binding.operation !== operation ||
    binding.input !== fingerprint(scaleParameters(input))
  )
    return fail('The complete metadata-scale request must prepare this exact component input.');
  if (step.index === 0) {
    if (operation === 'import_model' && object(input._input_files)[text(input.model_path)] !== source.sha256)
      return fail('The original identity-import source bytes changed.');
    return;
  }
  const previous =
    step.index === 1 ? scaleBase(jobs, account, parent).base : scaleEditedSource(jobs, account, parent).edit;
  if (
    input.project_id !== previous.remote_ids.project_id ||
    input.expected_operator_id !== previous.remote_ids.operator_id
  )
    return fail('The metadata-scale component no longer targets its exact preceding version.');
  if (step.index === 2) scaleSegmentRoute(jobs, account, parent);
}

export function smartSegmentScaleRequested(jobs: JobStore, job: Job): boolean {
  const parent = /^(.*)-2$/.exec(job.request_id)?.[1];
  return Boolean(parent && jobs.requestPolicy(job.account_ref, scaleIntentKey(parent)));
}
export function scaleOutputContext(jobs: JobStore, job: Job) {
  const parent = /^(.*)-2$/.exec(job.request_id)?.[1];
  if (!parent || job.operation !== 'segment') return fail('Invalid metadata-scale result identity.');
  assertSmartSegmentScaleStep(jobs, job.account_ref, job.request_id, job.operation, job.input);
  return { parent, ...scaleEditedSource(jobs, job.account_ref, parent) };
}
export function scaleOutputProof(jobs: JobStore, job: Job, artifact: Artifact) {
  const context = scaleOutputContext(jobs, job),
    proof = jobs.requestPolicy(job.account_ref, scaleOutputKey(job, artifact));
  if (scaleNativeOutput(job, proof).artifact_id !== artifact.artifact_id)
    return fail('The original segmentation artifact changed.');
  if (!proof) return;
  if (
    !completeScaleOutputProof(proof, context.source, context.intent) ||
    proof.identity !== smartSegmentImportIdentity(job, artifact) ||
    proof.source_sha256 !== context.source.sha256 ||
    proof.intent !== fingerprint(context.intent) ||
    (artifact.sha256 && artifact.sha256 !== proof.sha256) ||
    (artifact.bytes && artifact.bytes !== proof.bytes)
  )
    return fail('The verified metadata-scale output no longer belongs to the original receipt and bytes.');
  return proof;
}
export function assertScaleOutputSnapshot(jobs: JobStore, expected: Job, artifact: Artifact): Job {
  const current = jobs.get(expected.job_id),
    latest = scaleNativeOutput(current);
  if (
    current.state !== 'succeeded' ||
    latest.artifact_id !== artifact.artifact_id ||
    smartSegmentImportIdentity(current, latest) !== smartSegmentImportIdentity(expected, artifact)
  )
    return fail('The original segmented output changed during verification or download.');
  scaleOutputContext(jobs, current);
  scaleOutputProof(jobs, current, latest);
  return current;
}
