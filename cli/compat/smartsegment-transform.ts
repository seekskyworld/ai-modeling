/** 先冻结完整两步意图和原始字节，导入回执通过证明后才允许原生分割。 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Plan } from './planning.ts';
import type { Application } from './runtime.ts';
import type { Artifact, Job } from '../../studio/contracts/types.ts';
import type { JobStore } from '../storage/jobs.ts';
import { object, text, TripoError } from '../../studio/contracts/errors.ts';
import { readModelInput } from '../../studio/files.ts';
import { fingerprint } from '../core/fingerprint.ts';
import { materializeInputs } from '../artifacts/source.ts';
import { download } from '../artifacts/download.ts';
import { verifiedArtifactBytes } from '../artifacts/recover-download.ts';
import { readVerifiedOutputCache, saveVerifiedOutputCache } from '../artifacts/verified-output-cache.ts';
import {
  inspectSmartSegmentTransformSource,
  verifySmartSegmentTransformedImport,
} from '../artifacts/smartsegment-transform-proof.ts';
import {
  smartSegmentImportIdentity,
  smartSegmentTransformIntentKey,
  smartSegmentTransformSourceKey,
  smartSegmentTransformStepKey,
  smartSegmentTransformProofKey,
} from '../core/smartsegment-transform-policy.ts';

const sourceArtifact: Artifact = {
  artifact_id: 'smartsegment-transform-source',
  kind: 'model',
  format: 'glb',
  index: 0,
};

export function freezeSmartSegmentTransform(
  jobs: JobStore,
  account: string,
  plan: Plan,
  request: string,
): string | undefined {
  const key = smartSegmentTransformIntentKey(request),
    saved = jobs.requestPolicy(account, key);
  if (!plan.smartSegmentTransform) {
    if (saved)
      throw new TripoError(
        'IDEMPOTENCY_CONFLICT',
        'The original request included a transformed smartsegment chain.',
        'not_submitted',
      );
    return;
  }
  if (
    plan.steps.length !== 2 ||
    plan.steps[0]?.operation !== 'import_model' ||
    plan.steps[1]?.operation !== 'segment'
  )
    throw new TripoError(
      'SMARTSEGMENT_TRANSFORM_UNVERIFIED',
      'A transformed smartsegment requires exactly one native import followed by one segmentation.',
      'not_submitted',
    );
  if (!saved && plan.steps.some((_, i) => jobs.find(account, `${request}-${i}`)))
    throw new TripoError(
      'IDEMPOTENCY_CONFLICT',
      'An existing run cannot acquire a new transformed smartsegment intent.',
      'not_submitted',
    );
  // 来源URL只存摘要，完整两步参数均参与意图；恢复不能换路径、提示、粒度或矩阵。
  jobs.bindRequestPolicy(account, key, {
    version: 1,
    matrix: plan.smartSegmentTransform.matrix,
    intent: fingerprint(
      plan.steps.map(({ operation, parameters, source }) => ({ operation, parameters, source })),
    ),
  });
  for (const [index, step] of plan.steps.entries())
    jobs.bindRequestPolicy(account, smartSegmentTransformStepKey(`${request}-${index}`), {
      version: 1,
      parent_request: request,
      index,
      ...(index === 1 ? { parameters: step.parameters } : {}),
    });
  return account;
}

export async function prepareSmartSegmentTransformSource(
  app: Application,
  plan: Plan,
  request: string,
): Promise<Plan> {
  if (!plan.smartSegmentTransform) return plan;
  const account = app.service.accountRef(),
    jobs = app.service.jobs,
    key = smartSegmentTransformSourceKey(request),
    intent = jobs.requestPolicy(account, smartSegmentTransformIntentKey(request)),
    saved = jobs.requestPolicy(account, key);
  if (!intent || (saved && saved.intent !== fingerprint(intent)))
    throw new TripoError(
      'IDEMPOTENCY_CONFLICT',
      'The transformed smartsegment intent changed.',
      'not_submitted',
    );
  let bytes: Buffer;
  let inspection: Record<string, unknown>;
  if (saved) {
    const cached = await readVerifiedOutputCache(
      account,
      { sha256: text(saved.sha256), bytes: Number(saved.bytes) },
      text(saved.cache_data_dir),
    );
    if (!cached)
      throw new TripoError(
        'SMARTSEGMENT_TRANSFORM_SOURCE_MISSING',
        'The original transformed smartsegment source cache is missing or changed; the original import is not resubmitted.',
        'not_submitted',
      );
    bytes = cached;
    inspection = object(saved.inspection);
  } else {
    if (jobs.find(account, `${request}-0`))
      throw new TripoError(
        'SMARTSEGMENT_TRANSFORM_UNVERIFIED',
        'The existing import lacks a frozen original-source proof; recover it without adding a transform claim.',
        'not_submitted',
      );
    plan = await materializeInputs(plan, app.service.config.dataDir, request);
    const file = await readModelInput(
      text(plan.steps[0]!.parameters.model_path),
      app.service.config.inputRoots,
    );
    if (file.format !== 'glb')
      throw new TripoError(
        'INPUT_FORMAT',
        'Transformed smartsegment requires a self-contained GLB.',
        'not_submitted',
      );
    bytes = file.bytes;
    inspection = await inspectSmartSegmentTransformSource(bytes);
  }
  const cached = await saveVerifiedOutputCache(
      { account_ref: account },
      sourceArtifact,
      { sha256: text(inspection.sha256), bytes: bytes.length },
      bytes,
      app.service.config.dataDir,
    ),
    parameters = {
      ...plan.steps[0]!.parameters,
      model_path: saved ? object(saved.import_parameters).model_path : cached.local_path,
    };
  if (account !== app.service.accountRef())
    throw new TripoError(
      'ACCOUNT_MISMATCH',
      'The account changed while freezing the transformed source.',
      'not_submitted',
    );
  jobs.bindRequestPolicy(account, key, {
    version: 1,
    intent: fingerprint(intent),
    sha256: inspection.sha256,
    bytes: bytes.length,
    inspection,
    import_input: fingerprint(parameters),
    import_parameters: parameters,
    cache_data_dir: saved?.cache_data_dir ?? app.service.config.dataDir,
  });
  return { ...plan, steps: [{ ...plan.steps[0]!, parameters }, plan.steps[1]!] };
}

async function importedBytes(app: Application, job: Job, artifact: Artifact): Promise<Buffer> {
  const local = await verifiedArtifactBytes(artifact);
  if (local) return local;
  const root = path.join(app.service.config.dataDir, 'smartsegment-transform-checks');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temp = await mkdtemp(path.join(root, 'import-'));
  try {
    const file = await download(
      await app.service.gateway.artifactUrl(job, artifact),
      temp,
      'import.glb',
      'glb',
    );
    return await readFile(file.local_path);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

function checkedImportSource(
  jobs: JobStore,
  account: string,
  request: string,
  previous?: Record<string, unknown>,
): { source: Job; artifact: Artifact } {
  const source = jobs.get(text(previous?.job_id)),
    models = source.artifacts.filter((a) => a.kind === 'model'),
    artifact = models[0],
    valid = source.account_ref === account;
  if (
    !valid ||
    source.operation !== 'import_model' ||
    source.request_id !== `${request}-0` ||
    source.state !== 'succeeded' ||
    models.length !== 1 ||
    artifact?.format !== 'glb' ||
    artifact.processing ||
    !source.remote_ids.project_id ||
    !source.remote_ids.operator_id
  )
    throw new TripoError(
      'SMARTSEGMENT_TRANSFORM_UNVERIFIED',
      'The original transformed import has no unique successful native GLB receipt.',
      'not_submitted',
    );
  return { source, artifact };
}
export async function verifySmartSegmentTransformImport(
  app: Application,
  plan: Plan,
  request: string,
  previous?: Record<string, unknown>,
  index = 1,
): Promise<void> {
  if (!plan.smartSegmentTransform || index !== 1) return;
  const account = app.service.accountRef(),
    jobs = app.service.jobs,
    { source, artifact } = checkedImportSource(jobs, account, request, previous),
    intent = jobs.requestPolicy(account, smartSegmentTransformIntentKey(request)),
    original = jobs.requestPolicy(account, smartSegmentTransformSourceKey(request)),
    key = smartSegmentTransformProofKey(request),
    saved = jobs.requestPolicy(account, key);
  if (!intent || !original || original.intent !== fingerprint(intent))
    throw new TripoError(
      'SMARTSEGMENT_TRANSFORM_UNVERIFIED',
      'The original transformed source proof is missing.',
      'not_submitted',
    );
  const identity = smartSegmentImportIdentity(source, artifact);
  if (
    saved &&
    (saved.intent !== fingerprint(intent) ||
      saved.source_sha256 !== original.sha256 ||
      saved.import_identity !== identity)
  )
    throw new TripoError(
      'SMARTSEGMENT_TRANSFORM_SOURCE_CHANGED',
      'The frozen transformed import identity changed.',
      'not_submitted',
    );
  if (
    saved &&
    (await readVerifiedOutputCache(
      account,
      { sha256: text(saved.imported_sha256), bytes: Number(saved.imported_bytes) },
      app.service.config.dataDir,
    ))
  ) {
    if (app.service.accountRef() !== account)
      throw new TripoError(
        'ACCOUNT_MISMATCH',
        'The account changed while reading the verified transform cache.',
        'not_submitted',
      );
    const current = checkedImportSource(jobs, account, request, previous);
    if (smartSegmentImportIdentity(current.source, current.artifact) !== identity)
      throw new TripoError(
        'SMARTSEGMENT_TRANSFORM_SOURCE_CHANGED',
        'The verified original import changed while reading its cache.',
        'not_submitted',
      );
    return;
  }
  const input = await readVerifiedOutputCache(
    account,
    { sha256: text(original.sha256), bytes: Number(original.bytes) },
    app.service.config.dataDir,
  );
  if (!input)
    throw new TripoError(
      'SMARTSEGMENT_TRANSFORM_SOURCE_MISSING',
      'The original source cache is missing; segmentation was not submitted.',
      'not_submitted',
    );
  try {
    const output = await importedBytes(app, source, artifact),
      validation = await verifySmartSegmentTransformedImport(input, output);
    await saveVerifiedOutputCache(
      source,
      artifact,
      { sha256: text(validation.imported_sha256), bytes: output.length },
      output,
      app.service.config.dataDir,
    );
    if (account !== app.service.accountRef())
      throw new TripoError(
        'ACCOUNT_MISMATCH',
        'The account changed during transformed import verification.',
        'not_submitted',
      );
    jobs.bindArtifactPolicy(source, artifact, key, {
      ...validation,
      intent: fingerprint(intent),
      import_job_id: source.job_id,
      artifact_id: artifact.artifact_id,
      import_identity: identity,
    });
  } catch (error) {
    if (error instanceof TripoError)
      error.details = { ...error.details, original_import_task_id: source.job_id, request_id: request };
    throw error;
  }
}
