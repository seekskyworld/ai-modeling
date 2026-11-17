/** 查询、列表和下载共享同一份原件验收；生成成功不等于保留约束已满足。 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { JobStore } from '../storage/jobs.ts';
import type { Gateway } from '../../studio/api/gateway.ts';
import type { Artifact, Job } from '../../studio/contracts/types.ts';
import { errorResult, object, text, TripoError } from '../../studio/contracts/errors.ts';
import { outputTarget } from '../../studio/files.ts';
import { registeredFrontendTarget } from '../core/frontend-delivery.ts';
import { nativeScaleBytes } from '../artifacts/smartsegment-scale-io.ts';
import {
  hasVerifiedOutputCache,
  readVerifiedOutputCache,
  saveVerifiedOutputCache,
} from '../artifacts/verified-output-cache.ts';
import { localTarget, publishLocal } from '../local/files.ts';
import { verifyLabReferenceGeometry } from './lab-reference-edit-geometry.ts';
import { verifyLabProjectedSegment } from './lab-projected-segment-geometry.ts';
import type { LabReferenceEditIntent } from './lab-reference-edit-plan.ts';
import { readLabReferenceCache } from './lab-reference-edit-cache.ts';
import {
  assertLabReferenceBytes,
  assertLabReferenceSnapshot,
  labReferenceEditPolicy,
  labReferenceFailure,
  labReferenceIdentity,
  labReferenceOutputProof,
  labReferenceProofKey,
} from './lab-reference-edit-policy.ts';

const nextAction =
  'Read or download this original Lab task to verify its actual model. Preserve its request_id and all preparation receipts; do not regenerate.';
function route(intent: LabReferenceEditIntent) {
  return intent.kind === 'projected_segment'
    ? {
        task_type: 'mesh_segmentation',
        field: 'lab_projected_segment_validation',
        details: {
          backend: 'studio_lab',
          native_v2_engine: false,
          explicit_projection: true,
          variable_cost: true,
        },
      }
    : {
        task_type: 'mesh_edit',
        field: 'lab_reference_edit_validation',
        details: { backend: 'studio_lab', official_p2_engine: false, variable_cost: true },
      };
}
function onlyModel(job: Job): Artifact {
  const models = job.artifacts.filter((a) => a.kind === 'model');
  if (models.length !== 1 || models[0]!.format !== 'glb')
    return labReferenceFailure(
      'The original Lab job must return exactly one GLB model; text, previews or ambiguous models do not satisfy region editing.',
    );
  return models[0]!;
}
export function labReferenceEditSummary(
  jobs: JobStore,
  dataDir: string,
  job: Job,
): Record<string, unknown> | undefined {
  const policy = labReferenceEditPolicy(jobs, job);
  if (!policy) return;
  const info = route(policy.intent);
  const base = {
    task_type: info.task_type,
    [info.field]: {
      status: 'pending',
      ...info.details,
    },
    artifacts: [],
  };
  if (job.state !== 'succeeded') return base;
  try {
    const model = onlyModel(job),
      proof = labReferenceOutputProof(jobs, job, model);
    if (
      text(proof.cache_data_dir) !== dataDir ||
      !hasVerifiedOutputCache(
        job.account_ref,
        { sha256: text(proof.sha256), bytes: Number(proof.bytes) },
        dataDir,
      )
    )
      return labReferenceFailure(
        'The original verified Lab output cache is unavailable; recover the same artifact.',
      );
    return {
      task_type: info.task_type,
      state: 'succeeded',
      remote_state: 'succeeded',
      artifacts: [model],
      [info.field]: {
        ...object(proof.validation),
        ...info.details,
        source_sha256: policy.source.model.sha256,
        reference_sha256: policy.source.image.sha256,
        output_sha256: proof.sha256,
      },
    };
  } catch (error) {
    return {
      ...base,
      state: 'needs_attention',
      remote_state: 'succeeded',
      error: errorResult(error),
      next_action: nextAction,
      [info.field]: { ...object(base[info.field]), status: 'unverified' },
    };
  }
}

export async function ensureLabReferenceEditOutput(
  jobs: JobStore,
  gateway: Gateway,
  dataDir: string,
  job: Job,
  checkAccount: () => void,
): Promise<Record<string, unknown> | undefined> {
  const policy = labReferenceEditPolicy(jobs, job);
  if (!policy || job.state !== 'succeeded') return labReferenceEditSummary(jobs, dataDir, job);
  try {
    if (!job.artifacts.some((a) => a.kind === 'model')) {
      const status = await gateway.status(job);
      checkAccount();
      if (status.state === 'succeeded')
        job = jobs.update(job.job_id, job.state, { artifacts: status.artifacts });
    }
    const artifact = onlyModel(job),
      identity = labReferenceIdentity(job, artifact);
    const prior = jobs.requestPolicy(job.account_ref, labReferenceProofKey(job));
    if (prior) {
      const proof = labReferenceOutputProof(jobs, job, artifact);
      let bytes = await readVerifiedOutputCache(
        job.account_ref,
        { sha256: text(proof.sha256), bytes: Number(proof.bytes) },
        dataDir,
      );
      checkAccount();
      if (!bytes) {
        bytes = await nativeScaleBytes(job, artifact, gateway, dataDir);
        checkAccount();
        assertLabReferenceBytes(jobs, job, artifact, bytes);
        await saveVerifiedOutputCache(
          job,
          artifact,
          { sha256: text(proof.sha256), bytes: Number(proof.bytes) },
          bytes,
          dataDir,
        );
        checkAccount();
      }
      assertLabReferenceSnapshot(jobs, job, artifact);
      return labReferenceEditSummary(jobs, dataDir, jobs.get(job.job_id));
    }
    const source = await readLabReferenceCache(job.account_ref, policy.source);
    checkAccount();
    const bytes = await nativeScaleBytes(job, artifact, gateway, dataDir);
    checkAccount();
    const validation =
      policy.intent.kind === 'projected_segment'
        ? await verifyLabProjectedSegment(source.model, source.image, bytes, policy.intent.projection)
        : await verifyLabReferenceGeometry(source.model, bytes, policy.intent.bbox);
    checkAccount();
    const current = jobs.get(job.job_id),
      currentArtifact = onlyModel(current);
    if (current.state !== 'succeeded' || labReferenceIdentity(current, currentArtifact) !== identity)
      return labReferenceFailure('The Lab receipt changed during geometry verification.');
    const digest = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
    await saveVerifiedOutputCache(job, artifact, digest, bytes, dataDir);
    checkAccount();
    const latest = jobs.get(job.job_id);
    if (latest.state !== 'succeeded' || labReferenceIdentity(latest, onlyModel(latest)) !== identity)
      return labReferenceFailure('The Lab receipt changed before its proof was frozen.');
    jobs.bindRequestPolicy(job.account_ref, labReferenceProofKey(job), {
      version: 1,
      parent: policy.parent,
      identity,
      source_sha256: policy.source.model.sha256,
      reference_sha256: policy.source.image.sha256,
      ...digest,
      cache_data_dir: dataDir,
      validation,
    });
    assertLabReferenceSnapshot(jobs, job, artifact);
    return labReferenceEditSummary(jobs, dataDir, jobs.get(job.job_id));
  } catch (error) {
    const info = route(policy.intent);
    return {
      task_type: info.task_type,
      state: 'needs_attention',
      remote_state: 'succeeded',
      artifacts: [],
      error: errorResult(error),
      next_action: nextAction,
      [info.field]: {
        status: 'unverified',
        ...info.details,
      },
    };
  }
}

export async function downloadLabReferenceEditArtifact(
  jobs: JobStore,
  gateway: Gateway,
  dataDir: string,
  job: Job,
  artifact: Artifact,
  destination: { root: string; relative: string },
  checkAccount: () => void,
): Promise<Record<string, unknown> | undefined> {
  if (!labReferenceEditPolicy(jobs, job)) return;
  const view = await ensureLabReferenceEditOutput(jobs, gateway, dataDir, job, checkAccount);
  checkAccount();
  if (view?.state !== 'succeeded')
    return labReferenceFailure('The original Lab model has not passed its preservation checks.');
  const current = jobs.get(job.job_id),
    selected = onlyModel(current);
  if (selected.artifact_id !== artifact.artifact_id)
    return labReferenceFailure(
      'Only the independently verified GLB is a reference-edit delivery; previews are not model results.',
    );
  const proof = labReferenceOutputProof(jobs, current, selected);
  const bytes = await readVerifiedOutputCache(
    job.account_ref,
    { sha256: text(proof.sha256), bytes: Number(proof.bytes) },
    dataDir,
  );
  checkAccount();
  if (!bytes) return labReferenceFailure('The verified Lab output cache is missing.');
  assertLabReferenceBytes(jobs, current, selected, bytes);
  const target = await outputTarget(destination.root, destination.relative);
  checkAccount();
  if (path.extname(target).toLowerCase() !== '.glb')
    throw new TripoError('OUTPUT_EXTENSION', 'Use a .glb destination.');
  const assertCurrent = () => {
    checkAccount();
    assertLabReferenceSnapshot(jobs, current, selected);
  };
  assertCurrent();
  const latest = onlyModel(jobs.get(job.job_id));
  if (registeredFrontendTarget(latest, target, text(proof.identity))) {
    assertCurrent();
    return {
      local_path: target,
      sha256: proof.sha256,
      bytes: proof.bytes,
      format: 'glb',
      restored_from_cache: true,
      backend: 'studio_lab',
    };
  }
  await localTarget(destination.root, destination.relative, 'glb');
  assertCurrent();
  return {
    ...(await publishLocal(target, bytes, 'glb', assertCurrent)),
    restored_from_cache: true,
    backend: 'studio_lab',
  };
}
