/** 由持久链提供的已验分割路线；不属于公开 JSON 输入，也不改写上游模型状态。 */
import { isDeepStrictEqual } from 'node:util';
import { object, TripoError } from '../contracts/errors.ts';
import { metadataFields } from '../contracts/metadata.ts';
import type { Job } from '../contracts/types.ts';
import { segmentEntityMetadata } from '../contracts/segment-entity.ts';
import { segmentResourceFingerprint } from './segment-entity-snapshot.ts';

export interface NativeSegmentRoute {
  strategy: 'ordinary';
  project_id: string;
  expected_operator_id: string;
  metadata: Record<string, unknown>;
}
export interface EntitySegmentRoute {
  kind: 'verified_entities';
  strategy: 'ordinary' | 'resegment';
  project_id: string;
  expected_operator_id: string;
  metadata: Record<string, unknown>;
  resource_fingerprint: string;
  entity_count: number;
}
export interface SubmissionOptions {
  segmentRoute?: NativeSegmentRoute | EntitySegmentRoute;
  nativeMetadataSource?: {
    project_id: string;
    expected_operator_id: string;
    metadata: Record<string, unknown>;
    resource_fingerprint: string;
  };
  nativeMergeSource?: {
    project_id: string;
    expected_operator_id: string;
    metadata: Record<string, unknown>;
    complete_metadata?: Record<string, unknown>;
  };
}
/** 冻结的完整metadata和原模型资源跨报价/余额等待后仍须与最终读取一致。 */
export function assertNativeMetadataSource(
  job: Job,
  detail: Record<string, unknown>,
  options?: SubmissionOptions,
): void {
  const source = options?.nativeMetadataSource;
  if (!source) return;
  if (job.operation !== 'project_edit')
    throw new TripoError(
      'INVALID_INPUT',
      'A native metadata source only applies to project_edit.',
      'not_submitted',
    );
  assertEntityRoute(
    { ...source, kind: 'verified_entities', entity_count: 1, strategy: 'ordinary' },
    job.input,
    detail,
  );
}
/** 已证分割原件的标签合并须跨预算与会话等待保留同一份 metadata。 */
export function assertNativeMergeSource(
  job: Job,
  detail: Record<string, unknown>,
  options?: SubmissionOptions,
): void {
  const source = options?.nativeMergeSource;
  if (!source) return;
  const operator = object(detail.operator),
    metadata = object(operator.metadata);
  if (
    job.operation !== 'modification' ||
    job.input.project_id !== source.project_id ||
    job.input.expected_operator_id !== source.expected_operator_id ||
    detail.id !== source.project_id ||
    operator.operator_id !== source.expected_operator_id ||
    operator.status !== 'success'
  )
    throw new TripoError('PROJECT_CHANGED', 'The verified native merge source changed.', 'not_submitted');
  for (const [key, schema] of Object.entries(metadataFields)) {
    const actual = schema.safeParse(metadata[key] ?? (key === 'children_deleted' ? [] : {})),
      expected = schema.safeParse(source.metadata[key]);
    if (!actual.success || !expected.success || !isDeepStrictEqual(actual.data, expected.data))
      throw new TripoError('PROJECT_CHANGED', 'The verified native merge metadata changed.', 'not_submitted');
  }
  if (
    source.complete_metadata &&
    !isDeepStrictEqual(segmentEntityMetadata(metadata), source.complete_metadata)
  )
    throw new TripoError('PROJECT_CHANGED', 'The complete native merge metadata changed.', 'not_submitted');
}
export function assertSegmentRouteOperation(job: Job, options?: SubmissionOptions): void {
  if (options?.nativeMetadataSource && job.operation !== 'project_edit')
    throw new TripoError(
      'INVALID_INPUT',
      'A native metadata source only applies to project_edit.',
      'not_submitted',
    );
  if (options?.nativeMergeSource && job.operation !== 'modification')
    throw new TripoError(
      'INVALID_INPUT',
      'A native merge source only applies to modification.',
      'not_submitted',
    );
  if (options?.segmentRoute && job.operation !== 'segment')
    throw new TripoError(
      'INVALID_INPUT',
      'A native segment route only applies to segmentation.',
      'not_submitted',
    );
}
/** 旧请求继续按网页状态选路；独立来源仅在完整受信策略存在时走普通端点。 */
export function nativeSegmentJob(
  job: Job,
  detail: Record<string, unknown>,
  options?: SubmissionOptions,
): Job {
  if (options?.segmentRoute) {
    assertNativeSegmentRoute(options.segmentRoute, job.input, detail);
    return options.segmentRoute.strategy === 'resegment'
      ? {
          ...job,
          operation: 'resegment',
          input: { ...job.input, operator_id: options.segmentRoute.expected_operator_id },
        }
      : job;
  }
  return job.operation === 'segment' &&
    job.input.model_version === 'v2.0-20260430' &&
    object(detail.operator).is_segmented === true
    ? {
        ...job,
        operation: 'resegment',
        input: { ...job.input, operator_id: object(detail.operator).operator_id },
      }
    : job;
}
function assertEntityRoute(
  route: EntitySegmentRoute,
  input: Record<string, unknown>,
  detail: Record<string, unknown>,
): void {
  const operator = object(detail.operator),
    metadata = object(operator.metadata);
  if (
    route.kind !== 'verified_entities' ||
    !Number.isSafeInteger(route.entity_count) ||
    route.entity_count < 1 ||
    route.strategy !== (route.entity_count > 1 ? 'resegment' : 'ordinary') ||
    input.project_id !== route.project_id ||
    (input.expected_operator_id !== undefined && input.expected_operator_id !== route.expected_operator_id) ||
    detail.id !== route.project_id ||
    operator.operator_id !== route.expected_operator_id ||
    operator.status !== 'success' ||
    route.resource_fingerprint !== segmentResourceFingerprint(String(detail.model_url ?? '')) ||
    !isDeepStrictEqual(segmentEntityMetadata(metadata), route.metadata)
  )
    throw new TripoError(
      'PROJECT_CHANGED',
      'The verified segment entities or their exact source changed.',
      'not_submitted',
    );
}
/** 上游普通端点没有 CAS；此处只作最后一次读到的确切版本和完整 metadata 比较。 */
export function assertNativeSegmentRoute(
  route: NativeSegmentRoute | EntitySegmentRoute,
  input: Record<string, unknown>,
  detail: Record<string, unknown>,
): void {
  if ('kind' in route) return assertEntityRoute(route, input, detail);
  const operator = object(detail.operator),
    metadata = object(operator.metadata);
  if (
    route.strategy !== 'ordinary' ||
    input.project_id !== route.project_id ||
    input.expected_operator_id !== route.expected_operator_id ||
    detail.id !== route.project_id ||
    operator.operator_id !== route.expected_operator_id ||
    operator.status !== 'success'
  )
    throw new TripoError('PROJECT_CHANGED', 'The frozen ordinary-segment source changed.', 'not_submitted');
  for (const [key, schema] of Object.entries(metadataFields)) {
    const actual = schema.parse(metadata[key] ?? (key === 'children_deleted' ? [] : {})),
      expected = schema.parse(route.metadata[key]);
    if (!isDeepStrictEqual(actual, expected))
      throw new TripoError(
        'PROJECT_CHANGED',
        'The frozen ordinary-segment metadata changed.',
        'not_submitted',
      );
  }
}
