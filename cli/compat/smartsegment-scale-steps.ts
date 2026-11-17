/** 只在已验原版本上构造真实name→delta；每一阶段均保存足够的身份与输入供跨进程恢复。 */
import { createHash } from 'node:crypto';
import type { Plan } from './planning.ts';
import type { Application } from './runtime.ts';
import { array, object, text, TripoError } from '../../studio/contracts/errors.ts';
import { operationSchemas } from '../../studio/contracts/schemas.ts';
import { metadataFields } from '../../studio/contracts/metadata.ts';
import { smartSegmentScaleSnapshot } from '../../studio/api/smartsegment-scale-source.ts';
import {
  inspectSmartSegmentScaleSource,
  inspectSmartSegmentScaleReference,
} from '../artifacts/smartsegment-scale-proof.ts';
import { verifySmartSegmentTransformedImport } from '../artifacts/smartsegment-transform-proof.ts';
import { nativeScaleBytes } from '../artifacts/smartsegment-scale-io.ts';
import { saveVerifiedOutputCache } from '../artifacts/verified-output-cache.ts';
import { smartSegmentImportIdentity } from '../core/smartsegment-transform-policy.ts';
import { fingerprint } from '../core/fingerprint.ts';
import {
  scaleBase,
  scaleBaseKey,
  scaleContext,
  scaleEditKey,
  scaleEditedSource,
  scaleInputKey,
  scaleJobIdentity,
  scaleNativeModel,
  scaleSource,
  scaleStageJob,
  freezeScaleSegmentRoute,
} from '../core/smartsegment-scale-policy.ts';
import { assertScaleAccount, prepareScaleReference, readScaleOriginal } from './smartsegment-scale.ts';
import { smartSegmentIdentity } from './smartsegment-scale-plan.ts';

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
export function assertUneditedScaleMetadata(metadata: Record<string, unknown>): void {
  for (const [key, schema] of Object.entries(metadataFields)) schema.parse(metadata[key]);
  const matrices = Object.values(object(metadata.children_transform_matrix));
  if (
    array(metadata.children_deleted).length ||
    matrices.some(
      (m) => !Array.isArray(m) || m.length !== 16 || m.some((v, i) => v !== smartSegmentIdentity[i]),
    )
  )
    throw new TripoError(
      'SMARTSEGMENT_SCALE_SOURCE_EDITED',
      'Apply or remove existing geometry edits before using this source for metadata-scale. The original project was not changed.',
      'not_submitted',
    );
  // 网页默认metadata为metallic=0/roughness=.5，原生GLB可保留.9等独立材质值。
  // 两者各自冻结：保留网页scalar原值，不据不相等推断用户有未应用的编辑。
}
async function freezeScaleBase(app: Application, parent: string): Promise<void> {
  const account = app.service.accountRef(),
    jobs = app.service.jobs,
    { source } = scaleSource(jobs, account, parent);
  if (jobs.requestPolicy(account, scaleBaseKey(parent))) {
    scaleBase(jobs, account, parent);
    return;
  }
  const first = scaleStageJob(jobs, account, parent, 0),
    artifact = scaleNativeModel(first),
    original = await readScaleOriginal(app, account, parent),
    bytes = await nativeScaleBytes(first, artifact, app.service.gateway, app.service.config.dataDir),
    inspection = await (source.kind === 'reference'
      ? inspectSmartSegmentScaleReference(bytes)
      : inspectSmartSegmentScaleSource(bytes));
  if (first.operation === 'copy') {
    if (sha(bytes) !== source.sha256)
      throw new TripoError(
        'SMARTSEGMENT_SCALE_COPY_CHANGED',
        'The copied historical GLB differs from its exact original bytes.',
        'not_submitted',
      );
  } else await verifySmartSegmentTransformedImport(original, bytes, smartSegmentIdentity);
  const snapshot = await smartSegmentScaleSnapshot(
    app.studio.client,
    account,
    text(first.remote_ids.project_id),
    text(first.remote_ids.operator_id),
    false,
  );
  assertUneditedScaleMetadata(snapshot.metadata);
  await saveVerifiedOutputCache(
    first,
    artifact,
    { sha256: sha(bytes), bytes: bytes.length },
    bytes,
    app.service.config.dataDir,
  );
  assertScaleAccount(app, account);
  scaleSource(jobs, account, parent);
  scaleNativeModel(jobs.get(first.job_id), { sha256: sha(bytes), bytes: bytes.length });
  jobs.bindArtifactPolicy(first, artifact, scaleBaseKey(parent), {
    version: 1,
    identity: smartSegmentImportIdentity(first, artifact),
    artifact_id: artifact.artifact_id,
    sha256: sha(bytes),
    bytes: bytes.length,
    source_sha256: source.sha256,
    inspection,
    metadata: snapshot.metadata,
    source_metadata: source.kind === 'reference' ? source.metadata : snapshot.metadata,
  });
}
async function metadataParameters(app: Application, parent: string, parameters: Record<string, unknown>) {
  await freezeScaleBase(app, parent);
  const frozen = scaleBase(app.service.jobs, app.service.accountRef(), parent),
    metadata = object(frozen.proof.source_metadata),
    inspection = object(frozen.proof.inspection),
    names =
      inspection.version === 2
        ? array(inspection.roots).map((root) => text(object(root).node_name))
        : [text(inspection.node_name)];
  if (!names.length || names.some((name) => !name) || new Set(names).size !== names.length)
    throw new TripoError(
      'SMARTSEGMENT_SCALE_UNVERIFIED',
      'The original root mesh has no stable name.',
      'not_submitted',
    );
  return {
    ...parameters,
    expected_metadata: frozen.proof.metadata,
    replace: true,
    children_deleted: [],
    children_rename: metadata.children_rename,
    children_transform_matrix: {
      ...object(metadata.children_transform_matrix),
      ...Object.fromEntries(names.map((name) => [name, frozen.intent.matrix])),
    },
    material_factor: metadata.material_factor,
  };
}
async function freezeScaleEdit(app: Application, parent: string): Promise<void> {
  const account = app.service.accountRef(),
    jobs = app.service.jobs;
  if (jobs.requestPolicy(account, scaleEditKey(parent))) {
    scaleEditedSource(jobs, account, parent);
    return;
  }
  const frozen = scaleBase(jobs, account, parent),
    edit = scaleStageJob(jobs, account, parent, 1),
    snapshot = await smartSegmentScaleSnapshot(
      app.studio.client,
      account,
      text(edit.remote_ids.project_id),
      text(edit.remote_ids.operator_id),
      false,
    ),
    expected = Object.fromEntries(
      ['children_deleted', 'children_rename', 'children_transform_matrix', 'material_factor'].map((k) => [
        k,
        edit.input[k],
      ]),
    );
  if (fingerprint(snapshot.metadata) !== fingerprint(expected))
    throw new TripoError(
      'SMARTSEGMENT_SCALE_METADATA_CHANGED',
      'The returned metadata head did not preserve the exact requested delta.',
      'not_submitted',
    );
  const artifact = scaleNativeModel(edit),
    bytes = await nativeScaleBytes(edit, artifact, app.service.gateway, app.service.config.dataDir);
  if (sha(bytes) !== frozen.proof.sha256)
    throw new TripoError(
      'SMARTSEGMENT_SCALE_METADATA_CHANGED',
      'Metadata unexpectedly changed the underlying original GLB before segmentation.',
      'not_submitted',
    );
  assertScaleAccount(app, account);
  scaleBase(jobs, account, parent);
  scaleNativeModel(jobs.get(edit.job_id), { sha256: sha(bytes), bytes: bytes.length });
  jobs.bindArtifactPolicy(edit, artifact, scaleEditKey(parent), {
    version: 1,
    identity: scaleJobIdentity(edit),
    artifact_identity: smartSegmentImportIdentity(edit, artifact),
    base_identity: frozen.proof.identity,
    metadata: snapshot.metadata,
    sha256: sha(bytes),
    bytes: bytes.length,
  });
}

export async function prepareSmartSegmentScaleStep(
  app: Application,
  plan: Plan,
  parent: string,
  index: number,
  parameters: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!plan.smartSegmentScale) return parameters;
  const account = app.service.accountRef(),
    jobs = app.service.jobs,
    request = `${parent}-${index}`,
    step = plan.steps[index]!,
    existing = jobs.requestPolicy(account, scaleInputKey(request));
  scaleContext(jobs, account, parent);
  if (index === 0) {
    parameters = operationSchemas[step.operation].parse(parameters);
    if (step.operation === 'copy') await prepareScaleReference(app, plan, parent, parameters);
    const frozen = scaleSource(jobs, account, parent);
    if (fingerprint(parameters) !== fingerprint(frozen.source.parameters))
      throw new TripoError(
        'IDEMPOTENCY_CONFLICT',
        'The original scale import/copy parameters changed.',
        'not_submitted',
      );
  } else if (index === 1) {
    await freezeScaleBase(app, parent);
    parameters = existing ? object(existing.parameters) : await metadataParameters(app, parent, parameters);
  } else {
    await freezeScaleEdit(app, parent);
    freezeScaleSegmentRoute(jobs, account, parent);
  }
  const parsed = operationSchemas[step.operation].parse(parameters);
  assertScaleAccount(app, account);
  jobs.bindRequestPolicy(account, scaleInputKey(request), {
    version: 1,
    parent,
    index,
    operation: step.operation,
    input: fingerprint(parsed),
    parameters: parsed,
  });
  return parsed;
}
