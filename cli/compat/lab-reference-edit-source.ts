/** 在任何 Canvas 写入前冻结两个原件；同请求重启只复用原缓存，不能重新解释历史别名。 */
import { createHash } from 'node:crypto';
import type { Artifact, Job } from '../../studio/contracts/types.ts';
import { readInput } from '../../studio/files.ts';
import { object, text, TripoError } from '../../studio/contracts/errors.ts';
import { materializeInputs } from '../artifacts/source.ts';
import { nativeScaleBytes } from '../artifacts/smartsegment-scale-io.ts';
import { downloadArtifactBytes } from '../artifacts/download.ts';
import { createImageCache } from '../artifacts/image-cache.ts';
import { readVerifiedOutputCache, saveVerifiedOutputCache } from '../artifacts/verified-output-cache.ts';
import { verifiedArtifactBytes } from '../artifacts/recover-download.ts';
import { fingerprint } from '../core/fingerprint.ts';
import { resolveJob, type Application } from './runtime.ts';
import { inspectLabReferenceGeometry, labReferenceSourceSummary } from './lab-reference-edit-geometry.ts';
import {
  labReferenceKey,
  labReferenceFailure,
  labReferenceOutputProof,
  type LabReferenceFile,
  type LabReferenceSource,
} from './lab-reference-edit-policy.ts';
import type { LabReferenceEditIntent } from './lab-reference-edit-plan.ts';
import { readLabReferenceCache } from './lab-reference-edit-cache.ts';
import { frontendOutputRequested } from '../core/frontend-output.ts';
import { labReferenceEditPolicy } from './lab-reference-edit-policy.ts';
import { labProjectedSegmentSourceSummary } from './lab-projected-segment-geometry.ts';

const isTask = (source: string): boolean =>
  source.startsWith('@') || /^[a-f\d]{8}-[a-f\d-]{27}$/i.test(source);
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
async function taskArtifactBytes(
  app: Application,
  job: Job,
  artifact: Artifact,
  model: boolean,
  check: () => void,
): Promise<Buffer> {
  const cached =
    model && artifact.sha256 && artifact.bytes
      ? await readVerifiedOutputCache(
          job.account_ref,
          { sha256: artifact.sha256, bytes: artifact.bytes },
          app.service.config.dataDir,
        )
      : undefined;
  check();
  const delivered = cached ?? (await verifiedArtifactBytes(artifact));
  check();
  if (
    model &&
    !delivered &&
    (artifact.processing ||
      frontendOutputRequested(app.service.jobs, job) ||
      labReferenceEditPolicy(app.service.jobs, job))
  )
    return labReferenceFailure(
      'The exact processed task delivery is unavailable. Restore its verified output; its original Studio operator is not a substitute.',
    );
  const bytes =
    delivered ??
    (model
      ? await nativeScaleBytes(job, artifact, app.service.gateway, app.service.config.dataDir)
      : await downloadArtifactBytes(await app.service.gateway.artifactUrl(job, artifact), 'image'));
  check();
  if (
    (artifact.sha256 && artifact.sha256 !== sha(bytes)) ||
    (artifact.bytes && artifact.bytes !== bytes.length)
  )
    return labReferenceFailure('The selected task artifact differs from its original bytes.');
  return bytes;
}
async function taskBytes(app: Application, value: string, model: boolean, check: () => void) {
  let job = resolveJob(app, value);
  const view = await app.service.get(job.job_id);
  check();
  if (view.state !== 'succeeded')
    throw new TripoError(
      'INPUT_NOT_READY',
      'Wait for the exact source task and its output validation before Lab editing.',
      'not_submitted',
    );
  job = app.service.jobs.get(job.job_id);
  const candidates = job.artifacts.filter((a) => a.kind === (model ? 'model' : 'image'));
  if (candidates.length !== 1 || (model && candidates[0]!.format !== 'glb'))
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      'Lab reference inputs require one exact GLB or image artifact; ambiguous task outputs need an explicit file.',
      'not_submitted',
    );
  const artifact = candidates[0]!;
  const bytes = await taskArtifactBytes(app, job, artifact, model, check);
  return {
    bytes,
    provenance: {
      kind: 'task',
      job_id: job.job_id,
      artifact_id: artifact.artifact_id,
      remote_ids: job.remote_ids,
    },
  };
}
async function suppliedBytes(
  app: Application,
  value: string,
  model: boolean,
  parent: string,
  check: () => void,
) {
  if (isTask(value)) return await taskBytes(app, value, model, check);
  const key = model ? 'model_path' : 'image_path';
  const materialized = await materializeInputs(
    {
      steps: [
        { name: 'lab-input', operation: model ? 'import_model' : 'image', parameters: { [key]: value } },
      ],
      pending_uploads: [],
      warnings: [],
    },
    app.service.config.dataDir,
    `${parent}:${model ? 'model' : 'image'}`,
  );
  check();
  const input = await readInput(
    text(materialized.steps[0]!.parameters[key]),
    app.service.config.inputRoots,
    (model ? 50 : 20) * 1024 * 1024,
    model ? ['glb'] : ['png', 'jpeg', 'webp'],
  );
  check();
  return {
    bytes: input.bytes,
    provenance: { kind: /^https?:\/\//i.test(value) ? 'url' : 'file', reference: value },
  };
}

/** 已冻结来源的本地路径若仍存在，必须保持原字节；缺失文件可用原私有缓存恢复。 */
async function checkOriginalFile(
  app: Application,
  reference: string,
  frozen: LabReferenceFile,
  check: () => void,
): Promise<void> {
  if (object(frozen.provenance).kind !== 'file') return;
  try {
    const now = await readInput(reference, app.service.config.inputRoots, 50 * 1024 * 1024, [
      'glb',
      'png',
      'jpeg',
      'webp',
    ]);
    check();
    if (now.sha256 !== frozen.sha256 || now.bytes.length !== frozen.bytes)
      throw new TripoError(
        'IDEMPOTENCY_CONFLICT',
        'The local model or reference image changed under the same Lab request_id.',
        'not_submitted',
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function freezeRedoSource(
  app: Application,
  account: string,
  intent: LabReferenceEditIntent & { redo_of: NonNullable<LabReferenceEditIntent['redo_of']> },
  check: () => void,
): Promise<LabReferenceSource> {
  const jobs = app.service.jobs;
  const original = jobs.get(intent.redo_of.job_id);
  if (original.account_ref !== account || original.request_id !== intent.redo_of.request_id)
    return labReferenceFailure('The redo origin belongs to another account or request.');
  const prior = labReferenceEditPolicy(jobs, original);
  const models = original.artifacts.filter((a) => a.kind === 'model');
  if (!prior || models.length !== 1)
    return labReferenceFailure('The redo origin has no unique verified Lab model.');
  labReferenceOutputProof(jobs, original, models[0]!);
  if (
    prior.source.model.sha256 !== intent.redo_of.source_sha256 ||
    prior.source.image.sha256 !== intent.redo_of.reference_sha256 ||
    intent.source !== prior.source.model.cache_path ||
    intent.reference !== prior.source.image.cache_path ||
    fingerprint({
      bbox: intent.bbox,
      kind: intent.kind,
      projection: intent.kind === 'projected_segment' ? intent.projection : undefined,
    }) !==
      fingerprint({
        bbox: prior.intent.bbox,
        kind: prior.intent.kind,
        projection: prior.intent.kind === 'projected_segment' ? prior.intent.projection : undefined,
      })
  )
    return labReferenceFailure('The redo must retain the exact original model, reference image and region.');
  await readLabReferenceCache(account, prior.source);
  check();
  return {
    ...prior.source,
    intent: fingerprint(intent),
    model: {
      ...prior.source.model,
      provenance: { kind: 'redo', job_id: original.job_id, original: prior.source.model.provenance },
    },
    image: {
      ...prior.source.image,
      provenance: { kind: 'redo', job_id: original.job_id, original: prior.source.image.provenance },
    },
  };
}

export async function freezeLabReferenceSource(
  app: Application,
  account: string,
  parent: string,
  intent: LabReferenceEditIntent,
  check: () => void,
): Promise<LabReferenceSource> {
  const jobs = app.service.jobs,
    key = labReferenceKey(parent, 'source');
  const saved = jobs.requestPolicy(account, key) as unknown as LabReferenceSource | undefined;
  if (saved) {
    if (saved.version !== 1 || saved.intent !== fingerprint(intent))
      return labReferenceFailure('The original Lab source intent changed.');
    await readLabReferenceCache(account, saved);
    check();
    await checkOriginalFile(app, intent.source, saved.model, check);
    await checkOriginalFile(app, intent.reference, saved.image, check);
    return saved;
  }
  if (
    jobs.find(account, `${parent}-0`) ||
    jobs.requestPolicy(account, labReferenceKey(parent, 'create:start'))
  )
    return labReferenceFailure('An existing Canvas or Lab task cannot acquire a later source obligation.');
  if (intent.redo_of) {
    const reused = await freezeRedoSource(app, account, { ...intent, redo_of: intent.redo_of }, check);
    jobs.bindRequestPolicy(account, key, reused as unknown as Record<string, unknown>);
    return reused;
  }
  const model = await suppliedBytes(app, intent.source, true, parent, check);
  const image = await suppliedBytes(app, intent.reference, false, parent, check);
  const geometry =
    intent.kind === 'projected_segment'
      ? await labProjectedSegmentSourceSummary(model.bytes, image.bytes, intent.projection)
      : labReferenceSourceSummary(await inspectLabReferenceGeometry(model.bytes), intent.bbox);
  check();
  const { detectFormat } = await import('../../studio/files.ts');
  const imageFormat = detectFormat(image.bytes);
  if (!['png', 'jpeg', 'webp'].includes(imageFormat) || image.bytes.length > 20 * 1024 * 1024)
    throw new TripoError(
      'INPUT_FORMAT',
      'Lab guidance requires PNG, JPEG or WebP within 20 MiB.',
      'not_submitted',
    );
  const modelDigest = { sha256: sha(model.bytes), bytes: model.bytes.length };
  const cachedModel = await saveVerifiedOutputCache(
    { account_ref: account },
    { artifact_id: 'lab-source', kind: 'model', format: 'glb', index: 0 },
    modelDigest,
    model.bytes,
    app.service.config.dataDir,
  );
  check();
  const cache = createImageCache(app.service.config.dataDir, 'lab-reference-cache');
  const imagePath = cache.write(`source.${imageFormat}`, image.bytes);
  const result: LabReferenceSource = {
    version: 1,
    intent: fingerprint(intent),
    model: {
      ...modelDigest,
      format: 'glb',
      cache_path: cachedModel.local_path!,
      cache_data_dir: app.service.config.dataDir,
      provenance: model.provenance,
    },
    image: {
      sha256: sha(image.bytes),
      bytes: image.bytes.length,
      format: imageFormat,
      cache_path: imagePath,
      cache_data_dir: app.service.config.dataDir,
      provenance: image.provenance,
    },
    geometry,
  };
  check();
  try {
    jobs.bindRequestPolicy(account, key, result as unknown as Record<string, unknown>);
  } catch (error) {
    cache.cleanup();
    const winner = jobs.requestPolicy(account, key) as unknown as LabReferenceSource | undefined;
    if (
      !winner ||
      winner.intent !== result.intent ||
      winner.model.sha256 !== result.model.sha256 ||
      winner.image.sha256 !== result.image.sha256
    )
      throw error;
    await readLabReferenceCache(account, winner);
    check();
    return winner;
  }
  return result;
}
