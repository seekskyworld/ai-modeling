/** 三步原始意图、原件、导入和metadata各有独立锚；恢复只读冻结身份。 */
import type { Artifact, Job } from '../../studio/contracts/types.ts';
import type { JobStore } from '../storage/jobs.ts';
import { array, object, text } from '../../studio/contracts/errors.ts';
import { normalize } from '../../studio/contracts/schemas.ts';
import { fingerprint } from './fingerprint.ts';
import { checkedSmartSegmentAffine } from '../artifacts/smartsegment-affine-decomposition.ts';
import { hasVerifiedOutputCache } from '../artifacts/verified-output-cache.ts';
import { smartSegmentImportIdentity } from './smartsegment-transform-policy.ts';
import { assertAffineMetadata } from './smartsegment-affine-policy.ts';
import { assertTransferImportProof, completeTransferSelector } from './smartsegment-transfer-proof-policy.ts';
import {
  transferFail,
  transferIntentKey,
  transferStepKey,
  transferChildRequest,
  transferOperations,
  transferSourceKey,
  transferSourceAnchorKey,
  transferStageKey,
  transferStageAnchorKey,
  transferEditKey,
  transferEditAnchorKey,
  transferJobIdentity,
  transferInputKey,
  transferParameters,
} from './smartsegment-transfer-contract.ts';
const equal = (a: unknown, b: unknown): boolean => fingerprint(a) === fingerprint(b);
export function requireTransferCache(account: string, value: Record<string, unknown>): void {
  if (
    !hasVerifiedOutputCache(
      account,
      { sha256: text(value.sha256), bytes: Number(value.bytes) },
      text(value.cache_data_dir),
    )
  )
    return transferFail('The exact original affine source or native stage cache is missing or changed.');
}
export function transferContext(jobs: JobStore, account: string, parent: string): Record<string, unknown> {
  const intent = jobs.requestPolicy(account, transferIntentKey(parent));
  if (
    !intent ||
    intent.version !== 1 ||
    intent.mechanism !== 'pure_rotation_import' ||
    intent.native_step_count !== 3 ||
    !['file', 'reference'].includes(text(intent.source_kind)) ||
    !/^[a-f0-9]{64}$/.test(text(intent.layout)) ||
    jobs.requestPolicy(account, `smartsegment-affine-intent:${parent}`)
  )
    return transferFail(
      'The original pure-rotation three-step intent is absent, changed or conflicts with another layout.',
    );
  if (!equal(checkedSmartSegmentAffine(intent.matrix).matrix, intent.matrix))
    return transferFail('The original affine target changed.');
  for (const [index, operation] of transferOperations().entries()) {
    const step = jobs.requestPolicy(account, transferStepKey(transferChildRequest(parent, index)));
    if (
      step?.parent !== parent ||
      step.index !== index ||
      step.operation !== operation ||
      step.intent !== fingerprint(intent)
    )
      return transferFail('The original three-step transfer layout is missing or changed.');
  }
  return intent;
}
function sourceMetadata(source: Record<string, unknown>): void {
  assertAffineMetadata(source.metadata, source.complete_metadata);
  const metadata = object(source.metadata),
    preparation = object(source.preparation),
    rename = object(metadata.children_rename),
    identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  if (
    array(metadata.children_deleted).length ||
    (Object.keys(rename).length > 0 &&
      !completeTransferSelector(
        preparation.source_loader_selector,
        source,
        object(preparation.source_inspection).node_name,
      )) ||
    Object.keys(object(metadata.children_rename)).some(
      (key) => key !== object(object(source.preparation).source_inspection).node_name,
    ) ||
    Object.values(object(metadata.children_transform_matrix)).some(
      (matrix) =>
        !Array.isArray(matrix) ||
        matrix.length !== 16 ||
        matrix.some(
          (v, i) => typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v - identity[i]!) > 1e-7,
        ),
    )
  )
    return transferFail(
      'Rotation import cannot silently discard pending reference deletion, unknown rename or transform metadata.',
    );
}
function checkReferenceReceipt(jobs: JobStore, account: string, source: Record<string, unknown>): void {
  if (source.source_job_id) {
    const job = jobs.get(text(source.source_job_id)),
      artifact = job.artifacts.find((a) => a.artifact_id === source.source_artifact_id);
    if (
      job.account_ref !== account ||
      job.state !== 'succeeded' ||
      !artifact ||
      artifact.processing ||
      smartSegmentImportIdentity(job, artifact) !== source.source_identity ||
      (artifact.sha256 !== undefined && artifact.sha256 !== source.sha256) ||
      (artifact.bytes !== undefined && artifact.bytes !== source.bytes)
    )
      return transferFail('The exact original reference receipt changed.');
  }
}
export function transferSource(jobs: JobStore, account: string, parent: string) {
  const intent = transferContext(jobs, account, parent),
    source = jobs.requestPolicy(account, transferSourceKey(parent)),
    anchor = jobs.requestPolicy(account, transferSourceAnchorKey(parent));
  if (
    !source ||
    source.version !== 1 ||
    source.intent !== fingerprint(intent) ||
    anchor?.intent !== fingerprint(intent) ||
    anchor.source !== fingerprint(source)
  )
    return transferFail('The original affine transfer source or independent source anchor changed.');
  const preparation = object(source.preparation),
    parameters = object(source.first_parameters);
  if (
    preparation.version !== 1 ||
    preparation.kind !== 'pure_rotation_import_affine' ||
    preparation.mechanism !== 'pure_rotation_import' ||
    preparation.source_sha256 !== source.sha256 ||
    preparation.source_bytes !== source.bytes ||
    !equal(preparation.transform_matrix, intent.matrix) ||
    !equal(parameters.transform_matrix, preparation.import_matrix) ||
    parameters.use_original_uv !== true
  )
    return transferFail('The source, pure rotation or original affine preparation no longer agree.');
  if (intent.source_kind === 'reference') sourceMetadata(source);
  checkReferenceReceipt(jobs, account, source);
  requireTransferCache(account, source);
  return { intent, source, preparation };
}
export function transferNativeArtifact(job: Job): Artifact {
  const artifacts = job.artifacts.filter((a) => a.kind === 'model');
  if (artifacts.length !== 1 || artifacts[0]!.format !== 'glb' || artifacts[0]!.processing)
    return transferFail('The transfer stage must retain exactly one original native GLB.');
  return artifacts[0]!;
}
function stageReceipt(
  jobs: JobStore,
  account: string,
  parent: string,
  index: number,
  value: Record<string, unknown>,
) {
  const job = jobs.find(account, transferChildRequest(parent, index));
  if (
    !job ||
    job.state !== 'succeeded' ||
    job.account_ref !== account ||
    job.job_id !== value.job_id ||
    job.operation !== transferOperations()[index] ||
    job.input_hash !== fingerprint({ operation: job.operation, input: job.input }) ||
    transferJobIdentity(job) !== value.identity
  )
    return transferFail('The exact original transfer stage receipt changed.');
  const artifact = transferNativeArtifact(job);
  if (
    artifact.artifact_id !== value.artifact_id ||
    smartSegmentImportIdentity(job, artifact) !== value.artifact_identity ||
    (artifact.sha256 !== undefined && artifact.sha256 !== value.sha256) ||
    (artifact.bytes !== undefined && artifact.bytes !== value.bytes)
  )
    return transferFail('The original transfer stage artifact changed.');
  const input = jobs.requestPolicy(account, transferInputKey(job.request_id));
  if (input?.operation !== job.operation || input.input !== fingerprint(transferParameters(job.input)))
    return transferFail('The transfer stage lost its exact prepared input.');
  requireTransferCache(account, value);
  return { job, artifact };
}
export function transferStage(jobs: JobStore, account: string, parent: string, _name: 'import' = 'import') {
  const context = transferSource(jobs, account, parent),
    stage = jobs.requestPolicy(account, transferStageKey(parent)),
    anchor = jobs.requestPolicy(account, transferStageAnchorKey(parent));
  if (
    !stage ||
    stage.version !== 1 ||
    stage.source !== fingerprint(context.source) ||
    anchor?.stage !== fingerprint(stage)
  )
    return transferFail('The original imported stage or its independent anchor changed.');
  assertTransferImportProof(stage, context.source, context.preparation);
  assertAffineMetadata(stage.metadata, stage.complete_metadata);
  const metadata = object(stage.metadata);
  if (
    array(metadata.children_deleted).length ||
    Object.keys(object(metadata.children_rename)).length ||
    Object.keys(object(metadata.children_transform_matrix)).length ||
    !/^[a-f0-9]{64}$/.test(text(stage.resource_fingerprint))
  )
    return transferFail('The imported stage has pending edits or a missing exact resource binding.');
  return { ...context, stage, ...stageReceipt(jobs, account, parent, 0, stage) };
}
export function transferExpectedEditMetadata(
  source: Record<string, unknown>,
  imported: Record<string, unknown>,
) {
  const preparation = object(source.preparation),
    node = text(object(imported.imported_inspection).node_name),
    full: Record<string, unknown> = {
      ...object(imported.complete_metadata),
      children_transform_matrix: { [node]: preparation.second_matrix },
    };
  if (source.metadata) {
    full.material_factor = object(source.metadata).material_factor;
    const sourceNode = text(object(preparation.source_inspection).node_name),
      rename = object(object(source.metadata).children_rename);
    full.children_rename = Object.hasOwn(rename, sourceNode) ? { [node]: rename[sourceNode] } : {};
  }
  return full;
}
export function transferEdited(jobs: JobStore, account: string, parent: string) {
  const imported = transferStage(jobs, account, parent),
    editProof = jobs.requestPolicy(account, transferEditKey(parent)),
    anchor = jobs.requestPolicy(account, transferEditAnchorKey(parent));
  if (
    !editProof ||
    editProof.version !== 1 ||
    editProof.source !== fingerprint(imported.source) ||
    editProof.imported !== fingerprint(imported.stage) ||
    anchor?.edit !== fingerprint(editProof) ||
    editProof.sha256 !== imported.stage.sha256 ||
    editProof.bytes !== imported.stage.bytes ||
    !equal(editProof.complete_metadata, transferExpectedEditMetadata(imported.source, imported.stage)) ||
    !/^[a-f0-9]{64}$/.test(text(editProof.resource_fingerprint))
  )
    return transferFail('The exact frozen B2 metadata, raw imported bytes or edit anchor changed.');
  assertAffineMetadata(editProof.metadata, editProof.complete_metadata);
  const edited = stageReceipt(jobs, account, parent, 1, editProof);
  if (edited.job.remote_ids.project_id !== imported.job.remote_ids.project_id)
    return transferFail('The confirmed affine edit belongs to another imported project.');
  return { ...imported, imported, edit: editProof, editProof, job: edited.job, artifact: edited.artifact };
}
export function transferExpectedParameters(
  jobs: JobStore,
  account: string,
  parent: string,
  index: number,
): Record<string, unknown> {
  const context = transferSource(jobs, account, parent);
  if (index === 0) return normalize('import_model', context.source.first_parameters);
  if (index === 1) {
    const imported = transferStage(jobs, account, parent),
      metadata = transferExpectedEditMetadata(context.source, imported.stage);
    return normalize('project_edit', {
      project_id: imported.job.remote_ids.project_id,
      expected_operator_id: imported.job.remote_ids.operator_id,
      expected_metadata: imported.stage.metadata,
      replace: true,
      children_transform_matrix: metadata.children_transform_matrix,
      children_rename: metadata.children_rename,
      ...(context.intent.source_kind === 'reference' ? { material_factor: metadata.material_factor } : {}),
    });
  }
  if (index !== 2) return transferFail('Invalid affine transfer step index.');
  const edited = transferEdited(jobs, account, parent);
  return normalize('segment', {
    ...object(context.intent.segment_parameters),
    project_id: edited.job.remote_ids.project_id,
    expected_operator_id: edited.job.remote_ids.operator_id,
  });
}
