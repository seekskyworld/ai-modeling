/** 两次TRS与原生merge属于同一七步意图；任何单步入口均须保留父级原始剪切义务。 */
import type { Artifact, Job, Operation } from '../../studio/contracts/types.ts';
import type { JobStore } from '../storage/jobs.ts';
import type { SubmissionOptions } from '../../studio/api/segment-route.ts';
import { array, object, text, TripoError } from '../../studio/contracts/errors.ts';
import { fingerprint } from './fingerprint.ts';
import { smartSegmentImportIdentity } from './smartsegment-transform-policy.ts';
import { hasVerifiedOutputCache } from '../artifacts/verified-output-cache.ts';
import { checkedSmartSegmentAffine } from '../artifacts/smartsegment-affine-decomposition.ts';
import { segmentEntityMetadata } from '../../studio/contracts/segment-entity.ts';
import { assertSmartSegmentScaleStep, scaleContext, scaleSource } from './smartsegment-scale-policy.ts';

export const affineIntentKey = (parent: string): string => `smartsegment-affine-intent:${parent}`;
export const affineSourceKey = (parent: string): string => `smartsegment-affine-source:${parent}`;
export const affineSourceAnchorKey = (parent: string): string =>
  `smartsegment-affine-source-anchor:${parent}`;
export const affineStepKey = (request: string): string => `smartsegment-affine-step:${request}`;
export const affineInputKey = (request: string): string => `smartsegment-affine-input:${request}`;
export const affineStageKey = (parent: string, stage: 'first' | 'merge'): string =>
  `smartsegment-affine-stage:${parent}:${stage}`;
export const affineStageAnchorKey = (parent: string, stage: 'first' | 'merge'): string =>
  `smartsegment-affine-stage-anchor:${parent}:${stage}`;
export const affineOutputKey = (job: Job): string => `smartsegment-affine-output:${job.job_id}`;
export const affineChildRequest = (parent: string, index: number): string =>
  index < 3
    ? `${parent}:smartsegment-affine:first-${index}`
    : index === 3
      ? `${parent}:smartsegment-affine:merge-0`
      : `${parent}:smartsegment-affine:second-${index - 4}`;
export const affineGroupRequest = (parent: string, stage: 'first' | 'merge' | 'second'): string =>
  `${parent}:smartsegment-affine:${stage}`;
function child(request: string): { parent: string; index: number } | undefined {
  const match = /^(.*):smartsegment-affine:(first|merge|second)-([012])$/.exec(request);
  if (!match) return;
  const index = Number(match[3]);
  if (match[2] === 'merge' && index !== 0) return fail('The merge stage has exactly one original task.');
  return { parent: match[1]!, index: match[2] === 'first' ? index : match[2] === 'merge' ? 3 : 4 + index };
}
export function affineFinalParent(job: Job): string | undefined {
  const selected = child(job.request_id);
  const marker = object(job.input._smartsegment_affine);
  if (job.input._smartsegment_affine !== undefined)
    return text(marker.parent) || '__invalid_affine_identity__';
  if (selected?.index === 6) return selected.parent;
  // marker被删且request被改名也不能退回旧M2成功；哈希是prepared时的独立完整输入锚。
  if (
    job.operation === 'segment' &&
    job.input_hash !== fingerprint({ operation: job.operation, input: job.input })
  )
    return '__unverified_segment_identity__';
  return;
}
export function freezeAffineSubmissionMarker(
  jobs: JobStore,
  account: string,
  request: string,
  operation: Operation,
  input: Record<string, unknown>,
): void {
  const selected = child(request);
  if (selected?.index !== 6) return;
  affineContext(jobs, account, selected.parent);
  if (operation !== 'segment') return fail('The final native affine obligation requires segmentation.');
  input._smartsegment_affine = { version: 1, parent: selected.parent, request_id: request };
}
export const affineJobIdentity = (job: Job): string =>
  fingerprint({
    account: job.account_ref,
    job: job.job_id,
    operation: job.operation,
    input: job.input,
    remote: job.remote_ids,
  });
export function affineParameters(input: Record<string, unknown>): Record<string, unknown> {
  const parameters = { ...input };
  delete parameters._input_files;
  delete parameters._smartsegment_affine;
  return parameters;
}
/** Billing consent is separate from source/merge semantics, but remains in every immutable input fingerprint. */
function affineBusinessParameters(input: Record<string, unknown>): Record<string, unknown> {
  const parameters = { ...input };
  delete parameters.accept_variable_cost;
  return parameters;
}
export const affineFail = (message: string): never => {
  throw new TripoError('SMARTSEGMENT_AFFINE_UNVERIFIED', message, 'not_submitted');
};
const fail = affineFail;
export function assertAffineMetadata(metadata: unknown, complete: unknown): void {
  if (!complete || typeof complete !== 'object' || Array.isArray(complete))
    return fail('The complete original affine metadata is missing.');
  const normalized = segmentEntityMetadata(complete),
    identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  if (
    fingerprint(normalized) !== fingerprint(complete) ||
    fingerprint(metadata) !==
      fingerprint(
        Object.fromEntries(
          ['children_deleted', 'children_rename', 'children_transform_matrix', 'material_factor'].map(
            (key) => [key, normalized[key]],
          ),
        ),
      ) ||
    (normalized.transform_matrix !== undefined &&
      !(Array.isArray(normalized.transform_matrix) && normalized.transform_matrix.length === 0) &&
      fingerprint(normalized.transform_matrix) !== fingerprint(identity))
  )
    return fail('The complete affine metadata changed or has an unapplied root transform.');
}
export function affineOperations(kind: unknown): Operation[] {
  if (!['file', 'reference'].includes(text(kind))) return fail('The original affine source kind is missing.');
  return [
    kind === 'file' ? 'import_model' : 'copy',
    'project_edit',
    'segment',
    'modification',
    'copy',
    'project_edit',
    'segment',
  ];
}
export function affineContext(jobs: JobStore, account: string, parent: string) {
  const intent = jobs.requestPolicy(account, affineIntentKey(parent));
  if (!intent || intent.version !== 1) return fail('The complete original affine intent is missing.');
  const checked = checkedSmartSegmentAffine(intent.matrix),
    operations = affineOperations(intent.source_kind);
  if (fingerprint(checked.matrix) !== fingerprint(intent.matrix)) return fail('The affine matrix changed.');
  for (let index = 0; index < operations.length; index++) {
    const binding = jobs.requestPolicy(account, affineStepKey(affineChildRequest(parent, index)));
    if (
      binding?.parent !== parent ||
      binding.index !== index ||
      binding.operation !== operations[index] ||
      binding.intent !== fingerprint(intent)
    )
      return fail('The original seven-step affine layout is missing or changed.');
  }
  return intent;
}
function requireCache(account: string, value: Record<string, unknown>): void {
  if (
    !hasVerifiedOutputCache(
      account,
      { sha256: text(value.sha256), bytes: Number(value.bytes) },
      text(value.cache_data_dir),
    )
  )
    return fail('An original affine source or native stage cache is missing or changed.');
}
export function affineSource(jobs: JobStore, account: string, parent: string) {
  const intent = affineContext(jobs, account, parent),
    source = jobs.requestPolicy(account, affineSourceKey(parent)),
    anchor = jobs.requestPolicy(account, affineSourceAnchorKey(parent));
  if (
    !source ||
    source.version !== 1 ||
    source.intent !== fingerprint(intent) ||
    anchor?.intent !== fingerprint(intent) ||
    anchor.source !== fingerprint(source)
  )
    return fail('The original affine source preparation or its independent binding changed.');
  const preparation = object(source.preparation);
  if (intent.source_kind === 'reference') assertAffineMetadata(source.metadata, source.complete_metadata);
  if (
    preparation.source_sha256 !== source.sha256 ||
    preparation.source_bytes !== source.bytes ||
    fingerprint(preparation.transform_matrix) !== fingerprint(intent.matrix)
  )
    return fail('The affine preparation no longer describes the original source and requested matrix.');
  if (source.source_job_id) {
    const job = jobs.get(text(source.source_job_id)),
      artifact = job.artifacts.find((a) => a.artifact_id === source.source_artifact_id);
    if (
      job.account_ref !== account ||
      job.state !== 'succeeded' ||
      !artifact ||
      artifact.processing ||
      smartSegmentImportIdentity(job, artifact) !== source.source_identity
    )
      return fail('The exact historical affine source job changed.');
  }
  requireCache(account, source);
  return { intent, source, preparation };
}
function artifactBytesMatch(artifact: Artifact, proof: Record<string, unknown>): boolean {
  return (
    (artifact.sha256 === undefined || artifact.sha256 === proof.sha256) &&
    (artifact.bytes === undefined || artifact.bytes === proof.bytes)
  );
}
export function affineStage(jobs: JobStore, account: string, parent: string, name: 'first' | 'merge') {
  const context = affineSource(jobs, account, parent),
    stage = jobs.requestPolicy(account, affineStageKey(parent, name)),
    anchor = jobs.requestPolicy(account, affineStageAnchorKey(parent, name));
  if (
    !stage ||
    stage.version !== 1 ||
    stage.source !== fingerprint(context.source) ||
    anchor?.stage !== fingerprint(stage)
  )
    return fail('The original affine intermediate proof is missing or changed.');
  assertAffineMetadata(stage.metadata, stage.complete_metadata);
  const index = name === 'first' ? 2 : 3,
    job = jobs.find(account, affineChildRequest(parent, index));
  const artifact = job?.artifacts.find((a) => a.artifact_id === stage.artifact_id);
  if (
    !job ||
    job.state !== 'succeeded' ||
    job.job_id !== stage.job_id ||
    affineJobIdentity(job) !== stage.identity ||
    !artifact ||
    artifact.processing ||
    artifact.kind !== 'model' ||
    artifact.format !== 'glb' ||
    smartSegmentImportIdentity(job, artifact) !== stage.artifact_identity ||
    !artifactBytesMatch(artifact, stage)
  )
    return fail('The exact original affine stage receipt or native bytes changed.');
  requireCache(account, stage);
  return { ...context, stage, job, artifact };
}
function inputDependencies(jobs: JobStore, account: string, parent: string, index: number) {
  const context = affineSource(jobs, account, parent);
  const first = index >= 3 ? affineStage(jobs, account, parent, 'first') : undefined;
  const merged = index >= 4 ? affineStage(jobs, account, parent, 'merge') : undefined;
  return {
    context,
    first,
    merged,
    bindings: {
      source: fingerprint(context.source),
      ...(first ? { first: fingerprint(first.stage) } : {}),
      ...(merged ? { merge: fingerprint(merged.stage) } : {}),
    },
  };
}
/** 此函数只在兼容编排已解析原有来源和metadata义务后调用，公开service入口不能补建。 */
export function prepareAffineComponent(
  jobs: JobStore,
  account: string,
  request: string,
  operation: Operation,
  parameters: Record<string, unknown>,
): void {
  const selected = child(request);
  if (!selected) return;
  const { parent, index } = selected,
    { context, first, merged, bindings } = inputDependencies(jobs, account, parent, index);
  if (affineOperations(context.intent.source_kind)[index] !== operation)
    return fail('The affine operation changed.');
  if (index === 0) {
    const expected = object(context.source.first_parameters);
    if (
      fingerprint(affineBusinessParameters(affineParameters(parameters))) !==
      fingerprint(affineBusinessParameters(expected))
    )
      return fail('The first affine operation changed its exact original source.');
  }
  if (index === 3) {
    const expected = {
      project_id: first!.job.remote_ids.project_id,
      expected_operator_id: first!.job.remote_ids.operator_id,
      part_indices: first!.stage.part_indices,
      part_indices_name: first!.stage.part_indices_name,
    };
    if (fingerprint(affineBusinessParameters(parameters)) !== fingerprint(expected))
      return fail('The native affine merge labels or exact source changed.');
  }
  if (
    index === 4 &&
    fingerprint(parameters) !==
      fingerprint({
        project_id: merged!.job.remote_ids.project_id,
        operator_id: merged!.job.remote_ids.operator_id,
      })
  )
    return fail('The second affine TRS must copy the exact verified merge.');
  if ([1, 5].includes(index)) {
    const matrix = context.preparation[index === 1 ? 'first_matrix' : 'second_matrix'];
    const sourcePolicy = jobs.requestPolicy(
      account,
      `smartsegment-scale-source:${affineGroupRequest(parent, index === 1 ? 'first' : 'second')}`,
    );
    const node = text(object(sourcePolicy?.inspection).node_name),
      maps = object(parameters.children_transform_matrix);
    if (!node || fingerprint(maps[node]) !== fingerprint(matrix))
      return fail('The requested native TRS delta changed.');
  }
  if ([2, 6].includes(index)) {
    const options = (value: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(value).filter(([key]) => !['project_id', 'expected_operator_id'].includes(key)),
      );
    if (fingerprint(options(parameters)) !== fingerprint(options(object(context.intent.segment_parameters))))
      return fail('The affine segmentation parameters changed.');
  }
  const binding = { version: 1, operation, input: fingerprint(affineParameters(parameters)), ...bindings };
  if (!jobs.requestPolicy(account, affineInputKey(request)) && jobs.find(account, request))
    return fail('An existing affine component cannot acquire a later input proof.');
  jobs.bindRequestPolicy(account, affineInputKey(request), binding);
}
export function assertAffineStep(
  jobs: JobStore,
  account: string,
  request: string,
  operation: Operation,
  input: Record<string, unknown>,
): void {
  const selected = child(request);
  if (!selected) return;
  const { context, bindings } = inputDependencies(jobs, account, selected.parent, selected.index);
  const saved = jobs.requestPolicy(account, affineInputKey(request));
  if (
    !saved ||
    saved.version !== 1 ||
    saved.operation !== operation ||
    operation !== affineOperations(context.intent.source_kind)[selected.index] ||
    saved.input !== fingerprint(affineParameters(input)) ||
    Object.entries(bindings).some(([key, value]) => saved[key] !== value)
  )
    return fail('The complete affine chain did not prepare this exact original component.');
  if (selected.index !== 3) {
    const first = selected.index < 3,
      group = affineGroupRequest(selected.parent, first ? 'first' : 'second'),
      stage = scaleContext(jobs, account, group),
      source = scaleSource(jobs, account, group).source;
    if (
      fingerprint(stage.matrix) !==
        fingerprint(context.preparation[first ? 'first_matrix' : 'second_matrix']) ||
      source.sha256 !==
        (first ? context.source.sha256 : affineStage(jobs, account, selected.parent, 'merge').stage.sha256)
    )
      return fail('The original native affine TRS component source or matrix changed.');
    assertSmartSegmentScaleStep(jobs, account, request, operation, input);
  }
}
export function affineSubmissionOptions(jobs: JobStore, job: Job): SubmissionOptions | undefined {
  const selected = child(job.request_id);
  if (selected?.index !== 3) return;
  assertAffineStep(jobs, job.account_ref, job.request_id, job.operation, job.input);
  const first = affineStage(jobs, job.account_ref, selected.parent, 'first');
  return {
    nativeMergeSource: {
      project_id: text(first.job.remote_ids.project_id),
      expected_operator_id: text(first.job.remote_ids.operator_id),
      metadata: object(first.stage.metadata),
      complete_metadata: object(first.stage.complete_metadata),
    },
  };
}
export function affineOutputContext(jobs: JobStore, job: Job) {
  const parent = affineFinalParent(job);
  if (!parent || job.operation !== 'segment') return fail('Invalid final affine task.');
  const marker = object(job.input._smartsegment_affine);
  if (
    marker.version !== 1 ||
    marker.parent !== parent ||
    marker.request_id !== affineChildRequest(parent, 6) ||
    job.request_id !== marker.request_id ||
    job.input_hash !== fingerprint({ operation: job.operation, input: job.input })
  )
    return fail('The final native affine task lost its original immutable input marker.');
  const source = affineSource(jobs, job.account_ref, parent),
    first = affineStage(jobs, job.account_ref, parent, 'first'),
    merged = affineStage(jobs, job.account_ref, parent, 'merge');
  for (let index = 0; index < 7; index++) {
    const step = jobs.find(job.account_ref, affineChildRequest(parent, index));
    if (
      !step ||
      step.state !== 'succeeded' ||
      (index === 6 && (step.job_id !== job.job_id || affineJobIdentity(step) !== affineJobIdentity(job)))
    )
      return fail('The seven original affine receipts are incomplete.');
    assertAffineStep(jobs, job.account_ref, step.request_id, step.operation, step.input);
  }
  const artifact = job.artifacts.find((a) => a.kind === 'model');
  if (
    job.artifacts.filter((a) => a.kind === 'model').length !== 1 ||
    artifact?.format !== 'glb' ||
    artifact.processing ||
    job.artifacts.filter((a) => a.artifact_id === 'semantic-mask' && a.format === 'png' && a.kind === 'image')
      .length !== 1
  )
    return fail('The final affine result must retain one original GLB and its PNG mask.');
  return { parent, ...source, first, merged, artifact };
}
function completeAffineGeometry(
  value: unknown,
  source: Record<string, unknown>,
  output: Record<string, unknown>,
  matrix: unknown,
  faces: number,
): boolean {
  const p = object(value),
    error = p.maximum_position_error;
  return (
    p.version === 1 &&
    p.source_sha256 === source.sha256 &&
    p.source_bytes === source.bytes &&
    p.sha256 === output.sha256 &&
    p.bytes === output.bytes &&
    fingerprint(p.transform_matrix) === fingerprint(matrix) &&
    p.matched_oriented_faces === faces &&
    typeof error === 'number' &&
    Number.isFinite(error) &&
    error >= 0 &&
    error <= 4e-5 &&
    object(p.tolerance).position === 4e-5 &&
    p.uses_geometry_fit === false &&
    p.native_result_modified === false &&
    array(p.parts).length > 0 &&
    array(p.parts).reduce<number>((sum, part) => sum + Number(object(part).faces), 0) === faces
  );
}
function matchingFields(value: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, item]) => value[key] === item);
}
function completeProjectedFinal(
  context: ReturnType<typeof affineOutputContext>,
  value: unknown,
  faces: number,
): boolean {
  const projected = object(value),
    frozen = context.merged.stage,
    error = projected.maximum_position_error;
  return (
    matchingFields(projected, {
      version: 1,
      kind: 'projected_final_preflight',
      source_sha256: context.source.sha256,
      source_bytes: context.source.bytes,
      merged_sha256: frozen.sha256,
      merged_bytes: frozen.bytes,
      expected_corner_sha256: context.preparation.final_expected_corner_sha256,
      matched_oriented_faces: faces,
      actual_final_output_verified: false,
      uses_geometry_fit: false,
      native_result_modified: false,
    }) &&
    fingerprint(projected.transform_matrix) === fingerprint(context.preparation.transform_matrix) &&
    fingerprint(projected.second_matrix) === fingerprint(context.preparation.second_matrix) &&
    fingerprint(projected.expected_bounds) === fingerprint(context.preparation.final_expected_bounds) &&
    /^[a-f0-9]{64}$/.test(text(projected.projected_corner_sha256)) &&
    typeof error === 'number' &&
    Number.isFinite(error) &&
    error >= 0 &&
    error <= 4e-5 &&
    object(projected.tolerance).position === 4e-5 &&
    fingerprint(projected) === fingerprint(frozen.projected_final_geometry)
  );
}
function completeAffineMerge(
  context: ReturnType<typeof affineOutputContext>,
  value: unknown,
  faces: number,
): boolean {
  if (context.preparation.family !== 'general')
    return completeAffineGeometry(
      value,
      context.source,
      context.merged.stage,
      context.preparation.first_matrix,
      faces,
    );
  const p = object(value),
    frozen = context.merged.stage;
  return (
    matchingFields(p, {
      version: 1,
      kind: 'general_affine_merge_projected_preflight',
      stage: 'native_affine_merge',
      source_sha256: context.source.sha256,
      source_bytes: context.source.bytes,
      sha256: frozen.sha256,
      bytes: frozen.bytes,
      merged_sha256: frozen.sha256,
      merged_bytes: frozen.bytes,
      first_sha256: context.first.stage.sha256,
      first_bytes: context.first.stage.bytes,
      preparation: fingerprint(context.preparation),
      merge_name: context.first.stage.merge_name,
      uses_geometry_fit: false,
      native_result_modified: false,
    }) &&
    ['parts', 'bounds', 'appearance', 'merged_inspection', 'first_geometry'].every(
      (key) => fingerprint(p[key]) === fingerprint(frozen[key]),
    ) &&
    completeAffineGeometry(
      p.first_native_preserved,
      context.first.stage,
      frozen,
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      faces,
    ) &&
    fingerprint(p.first_native_preserved) === fingerprint(frozen.first_native_preserved) &&
    completeProjectedFinal(context, p.projected_final_geometry, faces)
  );
}
function assertAffineIntermediateProof(
  context: ReturnType<typeof affineOutputContext>,
  proof: Record<string, unknown>,
  faces: number,
): void {
  if (
    proof.stage !== 'native_affine_final' ||
    proof.preparation !== fingerprint(context.preparation) ||
    proof.first_sha256 !== context.first.stage.sha256 ||
    proof.first_bytes !== context.first.stage.bytes ||
    proof.merged_sha256 !== context.merged.stage.sha256 ||
    proof.merged_bytes !== context.merged.stage.bytes ||
    proof.merge_name !== context.first.stage.merge_name ||
    proof.accumulated_tolerance_used !== false ||
    fingerprint(proof.first_matrix) !== fingerprint(context.preparation.first_matrix) ||
    fingerprint(proof.second_matrix) !== fingerprint(context.preparation.second_matrix) ||
    !completeAffineGeometry(
      proof.first_geometry,
      context.source,
      context.first.stage,
      context.preparation.first_matrix,
      faces,
    ) ||
    !completeAffineMerge(context, proof.merge_geometry, faces) ||
    !completeAffineGeometry(
      proof.second_native_geometry,
      context.merged.stage,
      proof,
      context.preparation.second_matrix,
      faces,
    )
  )
    return fail('The full affine intermediate geometry proofs are missing or changed.');
}
export function affineOutputProof(jobs: JobStore, job: Job): Record<string, unknown> | undefined {
  const context = affineOutputContext(jobs, job),
    proof = jobs.requestPolicy(job.account_ref, affineOutputKey(job));
  if (!proof) return;
  const faces = Number(object(context.preparation.source_inspection).faces);
  assertAffineIntermediateProof(context, proof, faces);
  if (
    proof.identity !== smartSegmentImportIdentity(job, context.artifact) ||
    proof.intent !== fingerprint(context.intent) ||
    proof.source_binding !== fingerprint(context.source) ||
    proof.first_binding !== fingerprint(context.first.stage) ||
    proof.merge_binding !== fingerprint(context.merged.stage) ||
    !Number.isSafeInteger(faces) ||
    faces <= 0 ||
    !completeAffineGeometry(proof, context.source, proof, context.intent.matrix, faces) ||
    !artifactBytesMatch(context.artifact, proof)
  )
    return fail('The original direct-shear output proof is incomplete or changed.');
  return proof;
}
export function assertAffineDelivery(jobs: JobStore, job: Job, artifact?: Artifact): void {
  if (!affineFinalParent(job)) return;
  const proof = affineOutputProof(jobs, job);
  if (!proof) return fail('Verify the complete original shear before delivering any final artifact.');
  requireCache(job.account_ref, proof);
  if (artifact?.kind === 'model' && (artifact.sha256 !== proof.sha256 || artifact.bytes !== proof.bytes))
    return fail('The delivered affine model differs from the original proved output.');
}
