/** 原始来源、完整父意图和三个子身份先冻结；恢复不重新解释当前项目或自动历史。 */
import type { Plan } from './planning.ts';
import { createHash } from 'node:crypto';
import { resolveJob, type Application } from './runtime.ts';
import { object, text, TripoError } from '../../studio/contracts/errors.ts';
import type { Artifact } from '../../studio/contracts/types.ts';
import { operationSchemas } from '../../studio/contracts/schemas.ts';
import { readModelInput } from '../../studio/files.ts';
import { resolveProjectReference } from '../../studio/api/discovery.ts';
import { smartSegmentScaleSnapshot } from '../../studio/api/smartsegment-scale-source.ts';
import { materializeInputs } from '../artifacts/source.ts';
import { prepareNativeAffineTransfer } from '../artifacts/smartsegment-affine-transfer-proof.ts';
import { nativeScaleBytes, scaleUrlBytes } from '../artifacts/smartsegment-scale-io.ts';
import { readVerifiedOutputCache, saveVerifiedOutputCache } from '../artifacts/verified-output-cache.ts';
import { smartSegmentImportIdentity } from '../core/smartsegment-transform-policy.ts';
import { scaleNativeModel } from '../core/smartsegment-scale-policy.ts';
import { fingerprint } from '../core/fingerprint.ts';
import { completeTransferSelector } from '../core/smartsegment-transfer-proof-policy.ts';
import {
  transferChildRequest,
  transferContext,
  transferFail,
  transferIntentKey,
  transferOperations,
  transferSource,
  transferSourceAnchorKey,
  transferSourceKey,
  transferStepKey,
} from '../core/smartsegment-affine-transfer-policy.ts';
import {
  affineChildRequest,
  affineIntentKey,
  affineSourceKey,
  affineStepKey,
  assertAffineMetadata,
} from '../core/smartsegment-affine-policy.ts';
import { assertScaleAccount, assertSmartSegmentLayouts } from './smartsegment-scale.ts';
import { assertUneditedScaleMetadata } from './smartsegment-scale-steps.ts';

const sourceArtifact: Artifact = {
  artifact_id: 'smartsegment-affine-transfer-source',
  kind: 'model',
  format: 'glb',
  index: 0,
};
/** 历史回执已有摘要时不能用另一个有效GLB重定义原源；身份键本身不包含内容摘要。 */
export function assertTransferDeclaredBytes(artifact: Artifact, bytes: Buffer): void {
  if (
    (artifact.sha256 !== undefined && artifact.sha256 !== createHash('sha256').update(bytes).digest('hex')) ||
    (artifact.bytes !== undefined && artifact.bytes !== bytes.length)
  )
    return transferFail('The native bytes differ from the exact original artifact digest or byte count.');
}
/** 网页rename作用于loader原名；单节点的映射也须先证明原名未被消毒或碰撞改写。 */
function assertSourceRename(
  metadata: Record<string, unknown> | undefined,
  preparation: Record<string, unknown>,
): void {
  if (!metadata) return;
  const names = Object.keys(object(metadata.children_rename)),
    node = object(preparation.source_inspection).node_name;
  if (
    names.length &&
    !completeTransferSelector(
      preparation.source_loader_selector,
      { sha256: preparation.source_sha256, bytes: preparation.source_bytes },
      node,
    )
  )
    return transferFail(
      'The original Studio display rename cannot be bound to a stable loaded node name before import. The original project was not changed.',
    );
  if (names.some((name) => name !== node))
    return transferFail(
      'A Studio rename refers to a node absent from the original single-primitive source. Resolve that metadata before transferring; the project was not changed.',
    );
}
export function freezeTransferIntent(app: Application, plan: Plan, parent: string): string {
  const account = app.service.accountRef(),
    jobs = app.service.jobs;
  assertSmartSegmentLayouts(app, plan, parent);
  if (!plan.smartSegmentAffine) return transferFail('The complete affine intent is required.');
  if (jobs.requestPolicy(account, affineIntentKey(parent)))
    return transferFail('A frozen seven-step affine request cannot acquire a new three-step route.');
  const operations = transferOperations(),
    saved = jobs.requestPolicy(account, transferIntentKey(parent));
  if (fingerprint(plan.steps.map((s) => s.operation)) !== fingerprint(operations))
    return transferFail('The complete original three-step native affine transfer layout is required.');
  if (
    !saved &&
    operations.some(
      (_, i) => jobs.find(account, transferChildRequest(parent, i)) || jobs.find(account, `${parent}-${i}`),
    )
  )
    return transferFail('Existing native steps cannot acquire a later affine obligation.');
  if (
    !saved &&
    Array.from({ length: 7 }, (_, i) => i).some(
      (i) =>
        jobs.find(account, affineChildRequest(parent, i)) ||
        jobs.find(account, `${parent}-${i}`) ||
        jobs.requestPolicy(account, affineStepKey(affineChildRequest(parent, i))),
    )
  )
    return transferFail('Existing native tasks cannot acquire a new affine transfer obligation.');
  if (
    !saved &&
    (jobs.requestPolicy(account, transferSourceKey(parent)) ||
      jobs.requestPolicy(account, affineSourceKey(parent)) ||
      operations.some((_, index) =>
        jobs.requestPolicy(account, transferStepKey(transferChildRequest(parent, index))),
      ))
  )
    return transferFail(
      'Orphan source or step policies require their original parent intent; they cannot be rebound.',
    );
  if (saved && operations.some((_, i) => jobs.find(account, transferChildRequest(parent, i))))
    transferContext(jobs, account, parent);
  const intent = {
    version: 1,
    mechanism: 'pure_rotation_import',
    native_step_count: 3,
    ...plan.smartSegmentAffine,
    layout: fingerprint(
      plan.steps.map(({ name, operation, parameters, source }) => ({ name, operation, parameters, source })),
    ),
  };
  jobs.bindRequestPolicy(account, transferIntentKey(parent), intent);
  operations.forEach((operation, index) =>
    jobs.bindRequestPolicy(account, transferStepKey(transferChildRequest(parent, index)), {
      parent,
      index,
      operation,
      intent: fingerprint(intent),
    }),
  );
  transferContext(jobs, account, parent);
  return account;
}
export async function readTransferCache(
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
  transferContext(app.service.jobs, account, parent);
  if (!bytes)
    return transferFail(
      'An original affine source or native-stage cache is missing or changed. Recover its original bytes without resubmitting.',
    );
  return bytes;
}
export async function prepareTransferSource(app: Application, plan: Plan, parent: string): Promise<void> {
  const account = app.service.accountRef(),
    jobs = app.service.jobs,
    intent = transferContext(jobs, account, parent);
  if (jobs.requestPolicy(account, transferSourceKey(parent))) {
    const saved = transferSource(jobs, account, parent);
    await readTransferCache(app, account, parent, saved.source);
    transferSource(jobs, account, parent);
    return;
  }
  if (transferOperations().some((_, index) => jobs.find(account, transferChildRequest(parent, index))))
    return transferFail('Existing affine steps lack their original pre-submission source proof.');
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
    if (input.format !== 'glb')
      return transferFail('Native affine smartsegment requires original GLB bytes.');
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
        return transferFail('The affine source must be an original owned static native GLB task.');
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
    identity = { ...identity, source_project_id: project, source_operator_id: operator };
    parameters = { name: 'smartsegment-affine-transfer', use_original_uv: true };
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
    if (local) assertTransferDeclaredBytes(scaleNativeModel(local), bytes);
  }
  const preparation = await prepareNativeAffineTransfer(bytes, intent.matrix);
  assertSourceRename(metadata, preparation);
  const cache = await saveVerifiedOutputCache(
    { account_ref: account },
    sourceArtifact,
    { sha256: preparation.source_sha256, bytes: bytes.length },
    bytes,
    app.service.config.dataDir,
  );
  parameters = operationSchemas.import_model.parse({
    ...parameters,
    model_path: cache.local_path,
    transform_matrix: preparation.import_matrix,
    use_original_uv: true,
  });
  assertScaleAccount(app, account);
  transferContext(jobs, account, parent);
  if (identity.source_job_id) {
    const job = jobs.get(text(identity.source_job_id));
    if (smartSegmentImportIdentity(job, scaleNativeModel(job)) !== identity.source_identity)
      return transferFail('The original affine task changed during preparation.');
    assertTransferDeclaredBytes(scaleNativeModel(job), bytes);
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
  jobs.bindRequestPolicy(account, transferSourceKey(parent), source);
  jobs.bindRequestPolicy(account, transferSourceAnchorKey(parent), {
    intent: fingerprint(intent),
    source: fingerprint(source),
  });
  transferSource(jobs, account, parent);
}

/** 外层文件预检只在原source已冻结时改读内容缓存，原意图仍先逐字段校验。 */
export async function validateTransferFiles(app: Application, plan: Plan, parent: string): Promise<boolean> {
  if (
    !plan.smartSegmentAffine ||
    !app.service.jobs.requestPolicy(app.service.accountRef(), transferSourceKey(parent))
  )
    return false;
  freezeTransferIntent(app, plan, parent);
  const { source } = transferSource(app.service.jobs, app.service.accountRef(), parent);
  await readTransferCache(app, app.service.accountRef(), parent, source);
  return true;
}
