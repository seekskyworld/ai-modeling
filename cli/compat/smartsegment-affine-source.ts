/** 原始来源、完整父意图和七个子身份先冻结；恢复不重新解释当前项目或自动历史。 */
import type { Plan } from './planning.ts';
import { resolveJob, type Application } from './runtime.ts';
import { text, TripoError } from '../../studio/contracts/errors.ts';
import type { Artifact } from '../../studio/contracts/types.ts';
import { operationSchemas } from '../../studio/contracts/schemas.ts';
import { readModelInput } from '../../studio/files.ts';
import { resolveProjectReference } from '../../studio/api/discovery.ts';
import { smartSegmentScaleSnapshot } from '../../studio/api/smartsegment-scale-source.ts';
import { materializeInputs } from '../artifacts/source.ts';
import { prepareSmartSegmentAffine } from '../artifacts/smartsegment-affine-proof.ts';
import { nativeScaleBytes, scaleUrlBytes } from '../artifacts/smartsegment-scale-io.ts';
import { readVerifiedOutputCache, saveVerifiedOutputCache } from '../artifacts/verified-output-cache.ts';
import { smartSegmentImportIdentity } from '../core/smartsegment-transform-policy.ts';
import { scaleNativeModel } from '../core/smartsegment-scale-policy.ts';
import { fingerprint } from '../core/fingerprint.ts';
import {
  affineChildRequest,
  affineContext,
  affineFail,
  affineIntentKey,
  affineOperations,
  affineSource,
  affineSourceAnchorKey,
  affineSourceKey,
  affineStepKey,
  assertAffineMetadata,
} from '../core/smartsegment-affine-policy.ts';
import { assertScaleAccount, assertSmartSegmentLayouts } from './smartsegment-scale.ts';
import { assertUneditedScaleMetadata } from './smartsegment-scale-steps.ts';

const sourceArtifact: Artifact = {
  artifact_id: 'smartsegment-affine-source',
  kind: 'model',
  format: 'glb',
  index: 0,
};
export function freezeAffineIntent(app: Application, plan: Plan, parent: string): string {
  const account = app.service.accountRef(),
    jobs = app.service.jobs;
  assertSmartSegmentLayouts(app, plan, parent);
  if (!plan.smartSegmentAffine) return affineFail('The complete affine intent is required.');
  const operations = affineOperations(plan.smartSegmentAffine.source_kind),
    saved = jobs.requestPolicy(account, affineIntentKey(parent));
  if (fingerprint(plan.steps.map((s) => s.operation)) !== fingerprint(operations))
    return affineFail('The complete original seven-step native affine layout is required.');
  if (
    !saved &&
    operations.some(
      (_, i) => jobs.find(account, affineChildRequest(parent, i)) || jobs.find(account, `${parent}-${i}`),
    )
  )
    return affineFail('Existing native steps cannot acquire a later affine obligation.');
  if (saved && operations.some((_, i) => jobs.find(account, affineChildRequest(parent, i))))
    affineContext(jobs, account, parent);
  const intent = {
    version: 1,
    ...plan.smartSegmentAffine,
    layout: fingerprint(
      plan.steps.map(({ name, operation, parameters, source }) => ({ name, operation, parameters, source })),
    ),
  };
  jobs.bindRequestPolicy(account, affineIntentKey(parent), intent);
  operations.forEach((operation, index) =>
    jobs.bindRequestPolicy(account, affineStepKey(affineChildRequest(parent, index)), {
      parent,
      index,
      operation,
      intent: fingerprint(intent),
    }),
  );
  affineContext(jobs, account, parent);
  return account;
}
export async function readAffineCache(
  app: Application,
  account: string,
  parent: string,
  value: Record<string, unknown>,
): Promise<Buffer> {
  const bytes = await readVerifiedOutputCache(
    account,
    { sha256: text(value.sha256), bytes: Number(value.bytes) },
    text(value.cache_data_dir),
  );
  assertScaleAccount(app, account);
  affineContext(app.service.jobs, account, parent);
  if (!bytes)
    return affineFail(
      'An original affine source or native-stage cache is missing or changed. Recover its original bytes without resubmitting.',
    );
  return bytes;
}
export async function prepareAffineSource(app: Application, plan: Plan, parent: string): Promise<void> {
  const account = app.service.accountRef(),
    jobs = app.service.jobs,
    intent = affineContext(jobs, account, parent);
  if (jobs.requestPolicy(account, affineSourceKey(parent))) {
    const saved = affineSource(jobs, account, parent);
    await readAffineCache(app, account, parent, saved.source);
    affineSource(jobs, account, parent);
    return;
  }
  if (
    affineOperations(intent.source_kind).some((_, index) =>
      jobs.find(account, affineChildRequest(parent, index)),
    )
  )
    return affineFail('Existing affine steps lack their original pre-submission source proof.');
  let bytes: Buffer,
    parameters: Record<string, unknown>,
    metadata: Record<string, unknown> | undefined,
    completeMetadata: Record<string, unknown> | undefined,
    identity: Record<string, unknown> = {};
  if (intent.source_kind === 'file') {
    const materialized = await materializeInputs(
      { ...plan, steps: [plan.steps[0]!] },
      app.service.config.dataDir,
      parent,
    );
    parameters = operationSchemas.import_model.parse(materialized.steps[0]!.parameters);
    const input = await readModelInput(text(parameters.model_path), app.service.config.inputRoots);
    if (input.format !== 'glb') return affineFail('Native affine smartsegment requires original GLB bytes.');
    bytes = input.bytes;
  } else {
    const ref = text(plan.steps[0]!.source);
    let project: string, operator: string, local: ReturnType<typeof resolveJob> | undefined;
    try {
      local = resolveJob(app, ref);
      const artifact = scaleNativeModel(local);
      if (
        local.state !== 'succeeded' ||
        local.operation === 'canvas_run' ||
        artifact.canvas_result ||
        artifact.processing
      )
        return affineFail('The affine source must be an original owned static native GLB task.');
      project = text(local.remote_ids.project_id);
      operator = text(local.remote_ids.operator_id);
      identity = {
        source_job_id: local.job_id,
        source_artifact_id: artifact.artifact_id,
        source_identity: smartSegmentImportIdentity(local, artifact),
      };
    } catch (error) {
      if (!(error instanceof TripoError) || error.code !== 'JOB_NOT_FOUND' || ref.startsWith('@'))
        throw error;
      const resolved = await resolveProjectReference(app.studio.client, ref);
      project = text(resolved.project_id);
      operator = text(resolved.operator_id);
    }
    parameters = operationSchemas.copy.parse({ project_id: project, operator_id: operator });
    const snapshot = await smartSegmentScaleSnapshot(app.studio.client, account, project, operator, true);
    metadata = snapshot.metadata;
    completeMetadata = snapshot.complete_metadata;
    assertAffineMetadata(metadata, completeMetadata);
    assertUneditedScaleMetadata(metadata);
    bytes = local
      ? await nativeScaleBytes(
          local,
          scaleNativeModel(local),
          app.service.gateway,
          app.service.config.dataDir,
        )
      : await scaleUrlBytes(snapshot.url, app.service.config.dataDir);
  }
  const preparation = await prepareSmartSegmentAffine(bytes, intent.matrix);
  const cache = await saveVerifiedOutputCache(
    { account_ref: account },
    sourceArtifact,
    { sha256: preparation.source_sha256, bytes: bytes.length },
    bytes,
    app.service.config.dataDir,
  );
  if (intent.source_kind === 'file')
    parameters = operationSchemas.import_model.parse({ ...parameters, model_path: cache.local_path });
  assertScaleAccount(app, account);
  affineContext(jobs, account, parent);
  if (identity.source_job_id) {
    const job = jobs.get(text(identity.source_job_id));
    if (smartSegmentImportIdentity(job, scaleNativeModel(job)) !== identity.source_identity)
      return affineFail('The original affine task changed during preparation.');
  }
  const source = {
    version: 1,
    intent: fingerprint(intent),
    sha256: preparation.source_sha256,
    bytes: bytes.length,
    preparation,
    first_parameters: parameters,
    metadata,
    complete_metadata: completeMetadata,
    cache_data_dir: app.service.config.dataDir,
    ...identity,
  };
  jobs.bindRequestPolicy(account, affineSourceKey(parent), source);
  jobs.bindRequestPolicy(account, affineSourceAnchorKey(parent), {
    intent: fingerprint(intent),
    source: fingerprint(source),
  });
  affineSource(jobs, account, parent);
}

/** 外层文件预检只在原source已冻结时改读内容缓存，原意图仍先逐字段校验。 */
export async function validateAffineFiles(app: Application, plan: Plan, parent: string): Promise<boolean> {
  if (
    !plan.smartSegmentAffine ||
    !app.service.jobs.requestPolicy(app.service.accountRef(), affineSourceKey(parent))
  )
    return false;
  freezeAffineIntent(app, plan, parent);
  const { source } = affineSource(app.service.jobs, app.service.accountRef(), parent);
  await readAffineCache(app, app.service.accountRef(), parent, source);
  return true;
}
