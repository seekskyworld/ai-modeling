/** 独立三步父义务覆盖所有提交、查看与GLB/PNG交付入口。 */
import type { Artifact, Job, Operation } from '../../studio/contracts/types.ts';
import type { SubmissionOptions } from '../../studio/api/segment-route.ts';
import type { JobStore } from '../storage/jobs.ts';
import { object, text } from '../../studio/contracts/errors.ts';
import { fingerprint } from './fingerprint.ts';
import { smartSegmentImportIdentity } from './smartsegment-transform-policy.ts';
import { assertTransferFinalProof } from './smartsegment-transfer-proof-policy.ts';
import {
  transferFail,
  transferChild,
  transferChildRequest,
  transferOperations,
  transferInputKey,
  transferJobIdentity,
  transferParameters,
  transferGeometryFields,
  transferOutputKey,
  transferOutputAnchorKey,
} from './smartsegment-transfer-contract.ts';
import {
  transferSource,
  transferStage,
  transferEdited,
  transferExpectedParameters,
  transferNativeArtifact,
  requireTransferCache,
} from './smartsegment-transfer-state.ts';
export * from './smartsegment-transfer-contract.ts';
export * from './smartsegment-transfer-state.ts';

function inputBindings(jobs: JobStore, account: string, parent: string, index: number) {
  const source = transferSource(jobs, account, parent);
  return {
    source: fingerprint(source.source),
    ...(index >= 1 ? { imported: fingerprint(transferStage(jobs, account, parent).stage) } : {}),
    ...(index >= 2 ? { edit: fingerprint(transferEdited(jobs, account, parent).edit) } : {}),
  };
}
export function prepareTransferComponent(
  jobs: JobStore,
  account: string,
  request: string,
  operation: Operation,
  parameters: Record<string, unknown>,
): void {
  const child = transferChild(request);
  if (!child) return;
  const expected = transferExpectedParameters(jobs, account, child.parent, child.index);
  if (
    operation !== transferOperations()[child.index] ||
    fingerprint(transferParameters(parameters)) !== fingerprint(expected)
  )
    return transferFail('The original affine transfer parameters or predecessor changed.');
  const binding = {
    version: 1,
    operation,
    input: fingerprint(expected),
    ...inputBindings(jobs, account, child.parent, child.index),
  };
  if (!jobs.requestPolicy(account, transferInputKey(request)) && jobs.find(account, request))
    return transferFail('An existing native transfer task cannot acquire a replacement input proof.');
  jobs.bindRequestPolicy(account, transferInputKey(request), binding);
}
export function assertTransferStep(
  jobs: JobStore,
  account: string,
  request: string,
  operation: Operation,
  input: Record<string, unknown>,
): void {
  const child = transferChild(request);
  if (!child) return;
  const expected = transferExpectedParameters(jobs, account, child.parent, child.index),
    saved = jobs.requestPolicy(account, transferInputKey(request)),
    bindings = inputBindings(jobs, account, child.parent, child.index);
  if (
    !saved ||
    saved.version !== 1 ||
    operation !== transferOperations()[child.index] ||
    saved.operation !== operation ||
    saved.input !== fingerprint(expected) ||
    saved.input !== fingerprint(transferParameters(input)) ||
    Object.entries(bindings).some(([key, value]) => saved[key] !== value)
  )
    return transferFail('The exact original affine transfer step or its dependencies changed.');
}
export function transferFinalParent(job: Job): string | undefined {
  const child = transferChild(job.request_id),
    marker = object(job.input._smartsegment_affine_transfer);
  if (job.input._smartsegment_affine_transfer !== undefined)
    return text(marker.parent) || '__invalid_transfer_identity__';
  if (child?.index === 2) return child.parent;
  if (
    job.operation === 'segment' &&
    job.input_hash !== fingerprint({ operation: job.operation, input: job.input })
  )
    return '__unverified_segment_identity__';
  return;
}
export function freezeTransferSubmissionMarker(
  jobs: JobStore,
  account: string,
  request: string,
  operation: Operation,
  input: Record<string, unknown>,
): void {
  const child = transferChild(request);
  if (child?.index !== 2) return;
  const context = transferSource(jobs, account, child.parent);
  if (operation !== 'segment')
    return transferFail('The final transfer obligation requires ordinary native segmentation.');
  input._smartsegment_affine_transfer = {
    version: 1,
    parent: child.parent,
    request_id: request,
    mechanism: 'pure_rotation_import',
    intent: fingerprint(context.intent),
    source: fingerprint(context.source),
  };
}
export function transferSubmissionOptions(jobs: JobStore, job: Job): SubmissionOptions | undefined {
  const child = transferChild(job.request_id);
  if (!child || child.index === 0) return;
  assertTransferStep(jobs, job.account_ref, job.request_id, job.operation, job.input);
  if (child.index === 1) {
    const imported = transferStage(jobs, job.account_ref, child.parent);
    return {
      nativeMetadataSource: {
        project_id: text(imported.job.remote_ids.project_id),
        expected_operator_id: text(imported.job.remote_ids.operator_id),
        metadata: object(imported.stage.complete_metadata),
        resource_fingerprint: text(imported.stage.resource_fingerprint),
      },
    };
  }
  const edited = transferEdited(jobs, job.account_ref, child.parent);
  return {
    segmentRoute: {
      kind: 'verified_entities',
      strategy: 'ordinary',
      entity_count: 1,
      project_id: text(edited.job.remote_ids.project_id),
      expected_operator_id: text(edited.job.remote_ids.operator_id),
      metadata: object(edited.edit.complete_metadata),
      resource_fingerprint: text(edited.edit.resource_fingerprint),
    },
  };
}
export function transferOutputContext(jobs: JobStore, job: Job) {
  const parent = transferFinalParent(job),
    marker = object(job.input._smartsegment_affine_transfer);
  if (
    !parent ||
    job.operation !== 'segment' ||
    marker.version !== 1 ||
    marker.parent !== parent ||
    marker.request_id !== job.request_id ||
    job.request_id !== transferChildRequest(parent, 2) ||
    marker.mechanism !== 'pure_rotation_import' ||
    job.input_hash !== fingerprint({ operation: job.operation, input: job.input })
  )
    return transferFail('The final affine transfer lost its original immutable input marker.');
  const context = transferSource(jobs, job.account_ref, parent),
    imported = transferStage(jobs, job.account_ref, parent),
    edited = transferEdited(jobs, job.account_ref, parent);
  if (marker.intent !== fingerprint(context.intent) || marker.source !== fingerprint(context.source))
    return transferFail('The final transfer no longer binds the original target and source.');
  for (let index = 0; index < 3; index++) {
    const step = jobs.find(job.account_ref, transferChildRequest(parent, index));
    if (
      !step ||
      step.state !== 'succeeded' ||
      (index === 2 && (step.job_id !== job.job_id || transferJobIdentity(step) !== transferJobIdentity(job)))
    )
      return transferFail('The three original native transfer receipts are incomplete.');
    assertTransferStep(jobs, job.account_ref, step.request_id, step.operation, step.input);
  }
  const artifact = transferNativeArtifact(job),
    masks = job.artifacts.filter(
      (a) => a.artifact_id === 'semantic-mask' && a.kind === 'image' && a.format === 'png' && !a.processing,
    );
  if (masks.length !== 1)
    return transferFail('The final transfer must retain its exact original GLB and PNG mask.');
  return { parent, ...context, imported, edited, artifact, mask: masks[0]! };
}
function artifactMatches(artifact: Artifact, proof: Record<string, unknown>): boolean {
  return (
    (artifact.sha256 === undefined || artifact.sha256 === proof.sha256) &&
    (artifact.bytes === undefined || artifact.bytes === proof.bytes)
  );
}
export function transferOutputProof(jobs: JobStore, job: Job): Record<string, unknown> | undefined {
  const context = transferOutputContext(jobs, job),
    proof = jobs.requestPolicy(job.account_ref, transferOutputKey(job)),
    anchor = jobs.requestPolicy(job.account_ref, transferOutputAnchorKey(job));
  if (!proof) {
    if (anchor)
      return transferFail('The final transfer output proof is missing while its independent anchor remains.');
    return;
  }
  assertTransferFinalProof(
    proof,
    context.source,
    context.preparation,
    context.imported.stage,
    transferGeometryFields(context.imported.stage),
  );
  const mask = object(proof.mask);
  if (
    anchor?.output !== fingerprint(proof) ||
    proof.identity !== smartSegmentImportIdentity(job, context.artifact) ||
    proof.intent !== fingerprint(context.intent) ||
    proof.source_binding !== fingerprint(context.source) ||
    proof.import_binding !== fingerprint(context.imported.stage) ||
    proof.edit_binding !== fingerprint(context.edited.edit) ||
    !artifactMatches(context.artifact, proof) ||
    mask.artifact_id !== context.mask.artifact_id ||
    mask.identity !== smartSegmentImportIdentity(job, context.mask) ||
    mask.format !== 'png' ||
    !/^[a-f0-9]{64}$/.test(text(mask.sha256)) ||
    !Number.isSafeInteger(mask.bytes) ||
    Number(mask.bytes) <= 0 ||
    !artifactMatches(context.mask, mask)
  )
    return transferFail('The complete affine GLB/PNG proof or independent output anchor changed.');
  return proof;
}
export function assertTransferDelivery(jobs: JobStore, job: Job, artifact?: Artifact): void {
  if (!transferFinalParent(job)) return;
  const proof = transferOutputProof(jobs, job);
  if (!proof)
    return transferFail('Verify the original A(P) and B2(import) before delivering any transfer artifact.');
  requireTransferCache(job.account_ref, proof);
  requireTransferCache(job.account_ref, { ...object(proof.mask), cache_data_dir: proof.cache_data_dir });
  if (artifact) {
    const expected = artifact.kind === 'model' ? proof : object(proof.mask);
    const context = transferOutputContext(jobs, job),
      original = artifact.kind === 'model' ? context.artifact : context.mask;
    if (
      smartSegmentImportIdentity(job, artifact) !== smartSegmentImportIdentity(job, original) ||
      !artifactMatches(artifact, expected)
    )
      return transferFail('The delivered transfer artifact differs from its original proof.');
  }
}
export function assertTransferSnapshot(jobs: JobStore, expected: Job): Job {
  const current = jobs.get(expected.job_id);
  if (transferJobIdentity(current) !== transferJobIdentity(expected) || current.state !== 'succeeded')
    return transferFail('The final affine transfer identity changed across an asynchronous boundary.');
  const before = transferOutputContext(jobs, expected),
    after = transferOutputContext(jobs, current);
  for (const key of ['artifact', 'mask'] as const) {
    if (
      smartSegmentImportIdentity(expected, before[key]) !== smartSegmentImportIdentity(current, after[key]) ||
      (before[key].sha256 !== undefined && before[key].sha256 !== after[key].sha256) ||
      (before[key].bytes !== undefined && before[key].bytes !== after[key].bytes)
    )
      return transferFail('The exact native GLB or PNG receipt changed across an asynchronous boundary.');
  }
  transferOutputProof(jobs, current);
  return current;
}
