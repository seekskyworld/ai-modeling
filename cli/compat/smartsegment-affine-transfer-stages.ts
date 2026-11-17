/** 每个原生阶段分别冻结原件和完整metadata；后续步骤只能从已核锚派生，不能用当前项目代替。 */
import { createHash } from 'node:crypto';
import type { Application } from './runtime.ts';
import { object, text } from '../../studio/contracts/errors.ts';
import { smartSegmentScaleSnapshot } from '../../studio/api/smartsegment-scale-source.ts';
import { segmentResourceFingerprint } from '../../studio/api/segment-entity-snapshot.ts';
import { verifyTransferImport } from '../artifacts/smartsegment-affine-transfer-proof.ts';
import { nativeScaleBytes } from '../artifacts/smartsegment-scale-io.ts';
import { saveVerifiedOutputCache } from '../artifacts/verified-output-cache.ts';
import { assertAffineMetadata } from '../core/smartsegment-affine-policy.ts';
import { scaleNativeModel } from '../core/smartsegment-scale-policy.ts';
import { smartSegmentImportIdentity } from '../core/smartsegment-transform-policy.ts';
import { fingerprint } from '../core/fingerprint.ts';
import {
  transferChildRequest,
  transferEditKey,
  transferEditAnchorKey,
  transferEdited,
  transferExpectedParameters,
  transferFail,
  transferJobIdentity,
  transferSource,
  transferStage,
  transferStageKey,
  transferStageAnchorKey,
} from '../core/smartsegment-affine-transfer-policy.ts';
import { assertScaleAccount } from './smartsegment-scale.ts';
import { assertUneditedScaleMetadata } from './smartsegment-scale-steps.ts';
import { readTransferCache, assertTransferDeclaredBytes } from './smartsegment-affine-transfer-source.ts';

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

export async function freezeTransferImport(app: Application, parent: string): Promise<void> {
  const account = app.service.accountRef(),
    jobs = app.service.jobs;
  if (jobs.requestPolicy(account, transferStageKey(parent, 'import'))) {
    const saved = transferStage(jobs, account, parent, 'import');
    await readTransferCache(app, account, parent, saved.stage);
    transferStage(jobs, account, parent, 'import');
    return;
  }
  if ([1, 2].some((index) => jobs.find(account, transferChildRequest(parent, index))))
    return transferFail('A later affine transfer task cannot acquire a replacement import proof.');
  const context = transferSource(jobs, account, parent),
    job = jobs.find(account, transferChildRequest(parent, 0));
  if (!job || job.state !== 'succeeded')
    return transferFail('The original pure-rotation import receipt is not complete.');
  const artifact = scaleNativeModel(job),
    bytes = await nativeScaleBytes(job, artifact, app.service.gateway, app.service.config.dataDir);
  assertTransferDeclaredBytes(artifact, bytes);
  const original = await readTransferCache(app, account, parent, context.source),
    proof = await verifyTransferImport(original, context.preparation, bytes),
    snapshot = await smartSegmentScaleSnapshot(
      app.studio.client,
      account,
      text(job.remote_ids.project_id),
      text(job.remote_ids.operator_id),
      false,
    );
  assertUneditedScaleMetadata(snapshot.metadata);
  assertAffineMetadata(snapshot.metadata, snapshot.complete_metadata);
  if (
    Object.keys(object(snapshot.metadata.children_rename)).length ||
    Object.keys(object(snapshot.metadata.children_transform_matrix)).length
  )
    return transferFail('The new native import has unexpected pending node metadata.');
  const byteProof = { sha256: sha(bytes), bytes: bytes.length };
  await saveVerifiedOutputCache(job, artifact, byteProof, bytes, app.service.config.dataDir);
  assertScaleAccount(app, account);
  transferSource(jobs, account, parent);
  const current = jobs.get(job.job_id),
    latest = scaleNativeModel(current);
  assertTransferDeclaredBytes(latest, bytes);
  if (
    transferJobIdentity(current) !== transferJobIdentity(job) ||
    smartSegmentImportIdentity(current, latest) !== smartSegmentImportIdentity(job, artifact)
  )
    return transferFail('The native import receipt changed during verification.');
  const stage = {
    ...proof,
    version: 1,
    source: fingerprint(context.source),
    job_id: job.job_id,
    artifact_id: artifact.artifact_id,
    identity: transferJobIdentity(job),
    artifact_identity: smartSegmentImportIdentity(job, artifact),
    ...byteProof,
    metadata: snapshot.metadata,
    complete_metadata: snapshot.complete_metadata,
    resource_fingerprint: segmentResourceFingerprint(snapshot.url),
    cache_data_dir: app.service.config.dataDir,
  };
  jobs.bindArtifactPolicy(job, artifact, transferStageKey(parent, 'import'), stage);
  jobs.bindRequestPolicy(account, transferStageAnchorKey(parent, 'import'), { stage: fingerprint(stage) });
  transferStage(jobs, account, parent, 'import');
}

export async function freezeTransferEdit(app: Application, parent: string): Promise<void> {
  const account = app.service.accountRef(),
    jobs = app.service.jobs;
  if (jobs.requestPolicy(account, transferEditKey(parent))) {
    const saved = transferEdited(jobs, account, parent);
    await readTransferCache(app, account, parent, saved.edit);
    transferEdited(jobs, account, parent);
    return;
  }
  if (jobs.find(account, transferChildRequest(parent, 2)))
    return transferFail('A final affine transfer task cannot acquire a replacement metadata proof.');
  const imported = transferStage(jobs, account, parent, 'import'),
    parameters = transferExpectedParameters(jobs, account, parent, 1),
    job = jobs.find(account, transferChildRequest(parent, 1));
  if (!job || job.state !== 'succeeded')
    return transferFail('The original affine transfer metadata receipt is not complete.');
  const snapshot = await smartSegmentScaleSnapshot(
      app.studio.client,
      account,
      text(job.remote_ids.project_id),
      text(job.remote_ids.operator_id),
      false,
    ),
    changes = {
      children_transform_matrix: parameters.children_transform_matrix,
      ...(parameters.children_rename === undefined ? {} : { children_rename: parameters.children_rename }),
      ...(parameters.material_factor === undefined ? {} : { material_factor: parameters.material_factor }),
    },
    expected = { ...object(imported.stage.metadata), ...changes },
    complete = { ...object(imported.stage.complete_metadata), ...changes };
  if (
    fingerprint(snapshot.metadata) !== fingerprint(expected) ||
    fingerprint(snapshot.complete_metadata) !== fingerprint(complete)
  )
    return transferFail('The native metadata result did not preserve the complete frozen import metadata.');
  const artifact = scaleNativeModel(job),
    bytes = await nativeScaleBytes(job, artifact, app.service.gateway, app.service.config.dataDir);
  assertTransferDeclaredBytes(artifact, bytes);
  if (sha(bytes) !== imported.stage.sha256 || bytes.length !== imported.stage.bytes)
    return transferFail('The metadata operation changed the underlying original native import bytes.');
  const byteProof = { sha256: sha(bytes), bytes: bytes.length };
  await saveVerifiedOutputCache(job, artifact, byteProof, bytes, app.service.config.dataDir);
  assertScaleAccount(app, account);
  transferStage(jobs, account, parent, 'import');
  const current = jobs.get(job.job_id),
    latest = scaleNativeModel(current);
  assertTransferDeclaredBytes(latest, bytes);
  if (
    transferJobIdentity(current) !== transferJobIdentity(job) ||
    smartSegmentImportIdentity(current, latest) !== smartSegmentImportIdentity(job, artifact)
  )
    return transferFail('The native metadata receipt changed during verification.');
  const edit = {
    version: 1,
    source: fingerprint(imported.source),
    imported: fingerprint(imported.stage),
    job_id: job.job_id,
    artifact_id: artifact.artifact_id,
    identity: transferJobIdentity(job),
    artifact_identity: smartSegmentImportIdentity(job, artifact),
    ...byteProof,
    metadata: snapshot.metadata,
    complete_metadata: snapshot.complete_metadata,
    resource_fingerprint: segmentResourceFingerprint(snapshot.url),
    cache_data_dir: app.service.config.dataDir,
  };
  jobs.bindArtifactPolicy(job, artifact, transferEditKey(parent), edit);
  jobs.bindRequestPolicy(account, transferEditAnchorKey(parent), { edit: fingerprint(edit) });
  transferEdited(jobs, account, parent);
}

/** 已提交或终态任务只恢复原回执；仅未提交步骤重新核原head，完整守卫还须跨报价等待保留。 */
export async function preflightTransferStep(app: Application, parent: string, index: number): Promise<void> {
  if (index === 0) return;
  const account = app.service.accountRef(),
    jobs = app.service.jobs,
    existing = jobs.find(account, transferChildRequest(parent, index));
  if (existing && existing.state !== 'prepared') return;
  const source =
      index === 1 ? transferStage(jobs, account, parent, 'import') : transferEdited(jobs, account, parent),
    proof = object('edit' in source ? source.edit : source.stage),
    job = source.job,
    snapshot = await smartSegmentScaleSnapshot(
      app.studio.client,
      account,
      text(job.remote_ids.project_id),
      text(job.remote_ids.operator_id),
      false,
    );
  assertScaleAccount(app, account);
  if (index === 1) transferStage(jobs, account, parent, 'import');
  else transferEdited(jobs, account, parent);
  if (
    fingerprint(snapshot.complete_metadata) !== fingerprint(proof.complete_metadata) ||
    segmentResourceFingerprint(snapshot.url) !== proof.resource_fingerprint
  )
    return transferFail('The exact native source changed before the next affine transfer step.');
}
