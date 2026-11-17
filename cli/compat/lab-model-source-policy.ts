/** 显式选择的网页表示另存证明；不得改写原 Lab remote_ids、原件哈希或旧保真义务。 */
import type { JobStore } from '../storage/jobs.ts';
import type { Artifact, Job, Operation } from '../../studio/contracts/types.ts';
import type { LabModelSourceTarget } from '../../studio/contracts/lab-model-source.ts';
import { array, object, text, TripoError } from '../../studio/contracts/errors.ts';
import { fingerprint } from '../core/fingerprint.ts';
import {
  labReferenceEditPolicy,
  labReferenceIdentity,
  labReferenceOutputProof,
} from './lab-reference-edit-policy.ts';
import {
  labModelNormalTolerance,
  labModelPositionTolerance,
  type LabModelGeometryProof,
} from './lab-model-geometry.ts';
import type { LabModelPartitionGeometryProof } from './lab-model-partition-geometry.ts';
import {
  labModelPartitionExpectation,
  validLabModelPartitionProof,
  type LabModelPartitionExpectation,
} from './lab-model-partition-policy.ts';

export type LabModelRepresentation = 'studio_normalized';
export interface LabModelSourceProof {
  version: 1 | 2;
  representation: LabModelRepresentation;
  task_type: 'mesh_edit' | 'mesh_segmentation';
  job_id: string;
  account_ref: string;
  request_id: string;
  input_hash: string;
  lab_output_identity: string;
  lab_output_proof: string;
  target: LabModelSourceTarget;
  geometry: LabModelGeometryProof | LabModelPartitionGeometryProof;
  cache_data_dir: string;
}
export const labModelSourceKey = (job: Pick<Job, 'job_id'>): string => `lab-model-source:${job.job_id}`;
export const labModelSourceFail = (message: string): never => {
  throw new TripoError('LAB_MODEL_SOURCE_UNVERIFIED', message, 'not_submitted');
};
export function labModelOriginal(
  jobs: JobStore,
  job: Job,
): {
  artifact: Artifact;
  proof: Record<string, unknown>;
  identity: string;
  task_type: LabModelSourceProof['task_type'];
  partition?: LabModelPartitionExpectation;
} {
  const policy = labReferenceEditPolicy(jobs, job),
    models = job.artifacts.filter((a) => a.kind === 'model');
  if (
    !policy ||
    (policy.intent.kind !== undefined && policy.intent.kind !== 'projected_segment') ||
    job.state !== 'succeeded' ||
    models.length !== 1 ||
    models[0]!.format !== 'glb'
  )
    return labModelSourceFail(
      'Select one successfully verified Lab mesh_edit or projected-segmentation result. Raw Lab results have no admitted downstream representation.',
    );
  const artifact = models[0]!,
    proof = labReferenceOutputProof(jobs, job, artifact);
  return {
    artifact,
    proof,
    identity: labReferenceIdentity(job, artifact),
    task_type: policy.intent.kind === 'projected_segment' ? 'mesh_segmentation' : 'mesh_edit',
    ...(policy.intent.kind === 'projected_segment' ? { partition: labModelPartitionExpectation(proof) } : {}),
  };
}
const digest = (v: unknown): boolean => /^[a-f0-9]{64}$/.test(text(v));
const positive = (v: unknown): boolean => Number.isSafeInteger(v) && Number(v) > 0;
function sameIdentity(
  job: Job,
  p: Record<string, unknown>,
  original: ReturnType<typeof labModelOriginal>,
): boolean {
  const t = object(p.target);
  return (
    p.version === (original.partition ? 2 : 1) &&
    p.representation === 'studio_normalized' &&
    p.task_type === original.task_type &&
    p.job_id === job.job_id &&
    p.account_ref === job.account_ref &&
    p.request_id === job.request_id &&
    p.input_hash === job.input_hash &&
    p.lab_output_identity === original.identity &&
    p.lab_output_proof === fingerprint(original.proof) &&
    t.lab_job_id === job.remote_ids.task_id &&
    t.node_id === job.input.node_id &&
    t.artifact_id === original.artifact.artifact_id &&
    ['node_asset_id', 'project_id', 'operator_id'].every((k) => /^[a-z0-9-]{1,128}$/i.test(text(t[k]))) &&
    digest(t.resource_identity) &&
    Boolean(text(p.cache_data_dir))
  );
}
function validGeometry(value: unknown, original: ReturnType<typeof labModelOriginal>): boolean {
  const g = object(value),
    before = object(g.original),
    after = object(g.studio),
    n = object(g.normalization);
  return (
    g.version === (original.partition ? 2 : 1) &&
    (!original.partition || validPartitionShape(g, original.partition)) &&
    g.status === 'verified' &&
    g.representation === 'studio_normalized' &&
    before.sha256 === original.proof.sha256 &&
    before.bytes === original.proof.bytes &&
    positive(before.faces) &&
    before.faces === after.faces &&
    g.matched_oriented_faces === before.faces &&
    digest(after.sha256) &&
    positive(after.bytes) &&
    array(n.center).length === 3 &&
    array(n.center).every((x) => typeof x === 'number' && Number.isFinite(x)) &&
    typeof n.scale === 'number' &&
    Number.isFinite(n.scale) &&
    n.scale > 0 &&
    validPrecision(g)
  );
}
function validPartitionShape(g: Record<string, unknown>, expected: LabModelPartitionExpectation): boolean {
  const before = object(g.original),
    after = object(g.studio),
    count = expected.groups.length;
  return (
    validLabModelPartitionProof(g.partition, expected) &&
    before.faces === Object.values(expected.faces).reduce((sum, n) => sum + n, 0) &&
    before.primitives === count &&
    after.primitives === count &&
    fingerprint(array(before.nodes).map(text).sort()) === fingerprint(expected.groups) &&
    fingerprint(array(after.nodes).map(text).sort()) === fingerprint(expected.groups)
  );
}
function validPrecision(g: Record<string, unknown>): boolean {
  return (
    g.vertex_tolerance === labModelPositionTolerance &&
    g.normal_tolerance === labModelNormalTolerance &&
    typeof g.maximum_vertex_error === 'number' &&
    g.maximum_vertex_error >= 0 &&
    g.maximum_vertex_error <= labModelPositionTolerance &&
    typeof g.maximum_normal_angle === 'number' &&
    g.maximum_normal_angle >= 0 &&
    g.maximum_normal_angle <= labModelNormalTolerance &&
    g.material_failures === 0 &&
    g.original_coordinates_preserved === false &&
    g.original_normal_precision_preserved === false
  );
}
/** 目前只验自动保存后的静态无纹理来源；后来的编辑 metadata 不能只靠相同 operator 名字混入。 */
export function assertLabModelMetadata(target: LabModelSourceTarget): void {
  const m = object(target.metadata),
    keys = [
      'transform_matrix',
      'children_transform_matrix',
      'children_deleted',
      'children_rename',
      'material_factor',
    ];
  if (target.is_pbr !== false || Object.keys(m).some((key) => !keys.includes(key)))
    labModelSourceFail('Only the verified untextured Studio Lab representation is admitted.');
  for (const key of keys.filter((k) => k !== 'material_factor')) {
    const value = m[key];
    if (value !== undefined && value !== null && (typeof value !== 'object' || Object.keys(value).length))
      labModelSourceFail('The saved Lab representation has later geometry or display-name edits.');
  }
  const factor = object(m.material_factor);
  if (
    Object.keys(factor).length !== 2 ||
    !['metallic', 'roughness'].every(
      (k) => typeof factor[k] === 'number' && Number(factor[k]) >= 0 && Number(factor[k]) <= 1,
    )
  )
    labModelSourceFail('The saved Lab material metadata is incomplete.');
}
export function labModelSourceProof(jobs: JobStore, job?: Job): LabModelSourceProof | undefined {
  if (job?.operation !== 'canvas_lab') return;
  const saved = jobs.requestPolicy(job.account_ref, labModelSourceKey(job));
  if (!saved) return;
  const original = labModelOriginal(jobs, job);
  if (!sameIdentity(job, saved, original) || !validGeometry(saved.geometry, original))
    return labModelSourceFail(
      'The frozen Lab/Canvas/Studio representation proof differs from the original verified task.',
    );
  const proof = saved as unknown as LabModelSourceProof;
  assertLabModelMetadata(proof.target);
  return proof;
}
const supported = new Set<Operation>([
  'copy',
  'texture',
  'export',
  'rig',
  'remesh',
  'segment',
  'resegment',
  'local_edit',
  'uv_generate',
  'project_edit',
  'retexture',
  'retexture_apply',
]);
export function bindLabModelSource(
  jobs: JobStore,
  job: Job | undefined,
  operation: Operation,
  input: Record<string, unknown>,
  representation?: LabModelRepresentation,
): { parameters: Record<string, unknown>; remote: { project_id: string; operator_id: string } } | undefined {
  if (representation === undefined) return;
  if (representation !== 'studio_normalized' || !job || !supported.has(operation))
    return labModelSourceFail('This operation cannot use the selected Studio Lab representation.');
  const proof = labModelSourceProof(jobs, job);
  if (!proof)
    return labModelSourceFail('Prepare the exact selected Lab representation before downstream processing.');
  const t = proof.target,
    parameters = { ...input };
  if (
    parameters.project_id !== undefined &&
    parameters.project_id !== 'upstream' &&
    parameters.project_id !== t.project_id
  )
    return labModelSourceFail('The requested project differs from the frozen Lab representation.');
  parameters.project_id = t.project_id;
  for (const key of ['operator_id', 'expected_operator_id', 'current_operator_id', 'source_operator_id']) {
    if (parameters[key] !== undefined && parameters[key] !== 'upstream' && parameters[key] !== t.operator_id)
      return labModelSourceFail('The requested operation differs from the frozen Lab representation.');
    if (parameters[key] === 'upstream') parameters[key] = t.operator_id;
  }
  if (operation === 'copy') parameters.operator_id = t.operator_id;
  else parameters.expected_operator_id = t.operator_id;
  return { parameters, remote: { project_id: t.project_id, operator_id: t.operator_id } };
}
export function labModelSourceDisclosure(proof: LabModelSourceProof): Record<string, unknown> {
  return {
    representation: proof.representation,
    source_task_id: proof.job_id,
    ...proof.target,
    original: proof.geometry.original,
    studio: proof.geometry.studio,
    normalization: proof.geometry.normalization,
    maximum_vertex_error: proof.geometry.maximum_vertex_error,
    maximum_normal_angle: proof.geometry.maximum_normal_angle,
    vertex_tolerance: proof.geometry.vertex_tolerance,
    normal_tolerance: proof.geometry.normal_tolerance,
    original_coordinates_preserved: false,
    original_normal_precision_preserved: false,
    ...(proof.version === 2 && proof.geometry.version === 2
      ? {
          source_kind: 'projected_segment',
          source_task_type: proof.task_type,
          partition: proof.geometry.partition,
        }
      : {}),
    note:
      proof.version === 1
        ? 'Explicitly uses the webpage Studio representation: centered/scaled geometry, quantized normals and possibly renamed nodes or merged primitives. The original Lab delivery and its preservation proof remain separate.'
        : 'Explicitly uses the webpage Studio-normalized projected partition: original group names and oriented-face memberships are verified separately from centered/scaled coordinates and quantized normals. The original Lab mask and original-precision proof remain unchanged.',
  };
}
