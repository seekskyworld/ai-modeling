/** 新兼容导出的 JPEG 意图独立持久化；旧任务没有此标记时仍沿用原交付管线。 */
import type { Job, Artifact, Operation } from '../../studio/contracts/types.ts';
import type { JobStore } from '../storage/jobs.ts';
import { fingerprint } from './fingerprint.ts';
import { TripoError } from '../../studio/contracts/errors.ts';

export const exportJpegPolicyKey = (request: string): string => `export-jpeg-default:${request}`;
export const exportJpegProofKey = (job: Job, artifact: Artifact): string =>
  `export-jpeg-proof:${job.job_id}:${artifact.artifact_id}`;

export function canDefaultExportJpeg(input: Record<string, unknown>): boolean {
  return (
    input.format === 'glb' &&
    input.texture_packaging === 'embedded' &&
    input.texture_format === undefined &&
    input.bake !== false &&
    !input.public_model &&
    (input.scale_factor === undefined || input.scale_factor === 1) &&
    input.pivot_to_center_bottom !== true &&
    input.flatten_bottom !== true &&
    !input.part_names &&
    !input.source_metadata
  );
}

/** 新显式JPEG只在同一个已验证的纯纹理范围内复用证明；其他组合继续原有显式处理路径。 */
export function canExplicitExportJpeg(input: Record<string, unknown>): boolean {
  return input.texture_format === 'JPEG' && canDefaultExportJpeg({ ...input, texture_format: undefined });
}

/** 编码后的请求都含JPEG，但用户显式意图与默认策略必须分别冻结，不能借重试改换来源约束。 */
export function exportJpegIntent(input: Record<string, unknown>, explicit = false): string {
  return fingerprint({ ...input, texture_format: explicit ? 'JPEG' : undefined });
}

function validExplicitMode(policy: Record<string, unknown>): boolean {
  return (
    (policy.explicit === undefined || typeof policy.explicit === 'boolean') &&
    (policy.explicit !== true || policy.mode === 'jpeg')
  );
}

export function exportJpegRequested(jobs: JobStore, job: Job): boolean {
  const policy = jobs.requestPolicy(job.account_ref, exportJpegPolicyKey(job.request_id));
  if (policy && !validExplicitMode(policy))
    throw new TripoError(
      'JPEG_EXPORT_POLICY_CHANGED',
      'An explicit JPEG requirement cannot use native encoding or an invalid intent marker.',
      'read',
    );
  if (policy?.mode !== 'jpeg') return false;
  if (
    policy.version !== 1 ||
    job.operation !== 'export' ||
    job.input.texture_format !== 'JPEG' ||
    policy.project_id !== job.input.project_id ||
    policy.operator_id !== job.input.expected_operator_id ||
    !canDefaultExportJpeg({ ...job.input, texture_format: undefined }) ||
    (policy.intent !== undefined && policy.intent !== exportJpegIntent(job.input, policy.explicit === true))
  )
    throw new TripoError(
      'JPEG_EXPORT_POLICY_CHANGED',
      'The frozen JPEG export requirement does not match this task.',
      'read',
    );
  return true;
}

/** 预检和任务创建之间可能中断；同请求不能借换操作或显式编码绕开已经冻结的付费意图。 */
export function assertExportJpegIntent(
  jobs: JobStore,
  account: string,
  request: string,
  operation: Operation,
  input: Record<string, unknown>,
): void {
  const policy = jobs.requestPolicy(account, exportJpegPolicyKey(request));
  if (!policy) return;
  const original = { ...input, texture_format: undefined };
  if (
    operation !== 'export' ||
    policy.version !== 1 ||
    !['jpeg', 'native'].includes(String(policy.mode)) ||
    !validExplicitMode(policy) ||
    input.texture_format !== (policy.mode === 'jpeg' ? 'JPEG' : undefined) ||
    !canDefaultExportJpeg(original) ||
    policy.project_id !== input.project_id ||
    policy.operator_id !== input.expected_operator_id ||
    (policy.intent !== undefined && policy.intent !== exportJpegIntent(input, policy.explicit === true))
  )
    throw new TripoError(
      'IDEMPOTENCY_CONFLICT',
      'The frozen JPEG-default request belongs to a different export source or input.',
      'not_submitted',
    );
}

/** 保原生属于明确的兼容差异；任务重查仍要展示，不能只在首次 CLI 警告中短暂出现。 */
export function nativeExportEncodingReason(jobs: JobStore, job: Job): string | undefined {
  const policy = jobs.requestPolicy(job.account_ref, exportJpegPolicyKey(job.request_id));
  if (policy?.mode !== 'native') return;
  if (!validExplicitMode(policy))
    throw new TripoError(
      'JPEG_EXPORT_POLICY_CHANGED',
      'An explicit JPEG requirement cannot be reported as native-preserved.',
      'read',
    );
  if (policy.project_id !== job.input.project_id || policy.operator_id !== job.input.expected_operator_id)
    throw new TripoError('JPEG_EXPORT_POLICY_CHANGED', 'The retained native texture source changed.', 'read');
  return String(policy.reason);
}

export function exportJpegIdentity(job: Job, artifact: Artifact): string {
  return fingerprint({
    version: 1,
    account: job.account_ref,
    job_id: job.job_id,
    operation: job.operation,
    input: job.input,
    remote_ids: job.remote_ids,
    artifact_id: artifact.artifact_id,
    kind: artifact.kind,
    format: artifact.format,
    index: artifact.index,
  });
}

export const exportJpegDefaultWarning =
  'The official JPEG default is applied only to verified opaque embedded GLB textures, using local image encoding while retaining model structures. Other formats, transparent textures or unsupported texture extensions retain native encoding with an explicit warning; these cases do not establish JPEG-default equivalence.';
