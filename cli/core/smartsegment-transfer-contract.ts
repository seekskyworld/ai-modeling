/** 三步纯旋转导入有独立持久身份，不能退回六/七步或普通segment。 */
import type { Job } from '../../studio/contracts/types.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import { fingerprint } from './fingerprint.ts';
export const transferFail = (message: string): never => {
  throw new TripoError('SMARTSEGMENT_TRANSFER_UNVERIFIED', message, 'not_submitted');
};
export const transferIntentKey = (parent: string): string => `smartsegment-affine-transfer-intent:${parent}`;
export const transferSourceKey = (parent: string): string => `smartsegment-affine-transfer-source:${parent}`;
export const transferSourceAnchorKey = (parent: string): string =>
  `smartsegment-affine-transfer-source-anchor:${parent}`;
export const transferStepKey = (request: string): string => `smartsegment-affine-transfer-step:${request}`;
export const transferInputKey = (request: string): string => `smartsegment-affine-transfer-input:${request}`;
export const transferStageKey = (parent: string, _stage: 'import' = 'import'): string =>
  `smartsegment-affine-transfer-stage:${parent}:import`;
export const transferStageAnchorKey = (parent: string, _stage: 'import' = 'import'): string =>
  `smartsegment-affine-transfer-stage-anchor:${parent}:import`;
export const transferEditKey = (parent: string): string => `smartsegment-affine-transfer-edit:${parent}`;
export const transferEditAnchorKey = (parent: string): string =>
  `smartsegment-affine-transfer-edit-anchor:${parent}`;
export const transferOutputKey = (job: Job): string => `smartsegment-affine-transfer-output:${job.job_id}`;
export const transferOutputAnchorKey = (job: Job): string =>
  `smartsegment-affine-transfer-output-anchor:${job.job_id}`;
export function transferGroupRequest(parent: string, index: number): string {
  if (![0, 1, 2].includes(index))
    return transferFail('The pure-rotation affine route has exactly three steps.');
  return `${parent}:smartsegment-affine-transfer:${index}`;
}
export const transferChildRequest = (parent: string, index: number): string =>
  `${transferGroupRequest(parent, index)}-0`;
export const transferOperations = (): ['import_model', 'project_edit', 'segment'] => [
  'import_model',
  'project_edit',
  'segment',
];
export function transferChild(request: string): { parent: string; index: number } | undefined {
  const match = /^(.*):smartsegment-affine-transfer:([012])-0$/.exec(request);
  return match ? { parent: match[1]!, index: Number(match[2]) } : undefined;
}
export const transferJobIdentity = (job: Job): string =>
  fingerprint({
    account: job.account_ref,
    job: job.job_id,
    request: job.request_id,
    input_hash: job.input_hash,
    operation: job.operation,
    input: job.input,
    remote: job.remote_ids,
  });
export function transferParameters(input: Record<string, unknown>): Record<string, unknown> {
  const value = { ...input };
  delete value._input_files;
  delete value._smartsegment_affine_transfer;
  return value;
}
export function transferGeometryFields(stage: Record<string, unknown>): Record<string, unknown> {
  const result = { ...stage };
  for (const name of [
    'source',
    'job_id',
    'artifact_id',
    'identity',
    'artifact_identity',
    'metadata',
    'complete_metadata',
    'resource_fingerprint',
    'cache_data_dir',
  ])
    delete result[name];
  return result;
}
