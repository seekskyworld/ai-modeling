/** 新请求的实体分流证明；本模块不持久化、不请求服务，也不改写 is_segmented 或模型字节。 */
import { createHash } from 'node:crypto';
import { TripoError } from '../../studio/contracts/errors.ts';
import { segmentEntityMetadata } from '../../studio/contracts/segment-entity.ts';
import { fingerprint } from '../core/fingerprint.ts';
import { inspectSegmentEntityCount, type SegmentEntityCount } from './segment-entity-count.ts';
export { segmentEntityMetadata } from '../../studio/contracts/segment-entity.ts';

export interface SegmentEntityIdentity {
  account_ref: string;
  project_id: string;
  operator_id: string;
}
export interface SegmentEntitySource extends SegmentEntityIdentity {
  version: 1;
  format: 'glb';
  sha256: string;
  bytes: number;
  metadata: Record<string, unknown>;
  metadata_fingerprint: string;
  inspection: SegmentEntityCount;
  strategy: 'ordinary' | 'resegment';
}
const fail = (message: string): never => {
  throw new TripoError('SEGMENT_ENTITY_SOURCE_CHANGED', message, 'not_submitted');
};
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

function assertIdentity(identity: SegmentEntityIdentity): void {
  for (const key of ['account_ref', 'project_id', 'operator_id'] as const)
    if (typeof identity[key] !== 'string' || !identity[key].trim())
      fail('The exact source identity is incomplete.');
}
export async function prepareSegmentEntitySource(
  bytes: Buffer,
  identity: SegmentEntityIdentity,
  metadata: unknown,
): Promise<SegmentEntitySource> {
  assertIdentity(identity);
  // 上层快照还带短期下载签名；只冻结稳定身份，不能让续签改变证明或落盘授权 URL。
  const binding: SegmentEntityIdentity = {
      account_ref: identity.account_ref,
      project_id: identity.project_id,
      operator_id: identity.operator_id,
    },
    originalHash = sha(bytes),
    snapshot = segmentEntityMetadata(metadata),
    inspection = await inspectSegmentEntityCount(bytes, snapshot.children_deleted as string[]);
  if (sha(bytes) !== originalHash) fail('The original source bytes changed during preparation.');
  if (!inspection.entity_count)
    throw new TripoError(
      'SEGMENT_ENTITY_EMPTY',
      'The bound source has no Mesh entity available for segmentation.',
      'not_submitted',
    );
  return {
    version: 1,
    ...binding,
    format: 'glb',
    sha256: originalHash,
    bytes: bytes.length,
    metadata: snapshot,
    metadata_fingerprint: fingerprint(snapshot),
    inspection,
    strategy: inspection.entity_count > 1 ? 'resegment' : 'ordinary',
  };
}

function assertInspection(inspected: SegmentEntityCount): void {
  if (
    !inspected ||
    inspected.version !== 1 ||
    inspected.scene !== 0 ||
    !Number.isSafeInteger(inspected.entity_count) ||
    inspected.entity_count <= 0 ||
    !Array.isArray(inspected.instances) ||
    inspected.before_deletions !== inspected.instances.length ||
    inspected.entity_count !== inspected.instances.filter((i) => i.deleted === false).length ||
    inspected.instances.some(
      (i) =>
        typeof i.name !== 'string' ||
        typeof i.deleted !== 'boolean' ||
        [i.node, i.mesh, i.primitive].some((v) => !Number.isSafeInteger(v) || v < 0),
    ) ||
    new Set(inspected.instances.map((i) => `${i.node}:${i.primitive}`)).size !== inspected.instances.length
  )
    fail('The frozen original Mesh-instance count is incomplete or changed.');
}
/** beforeSend 可同步核原账号/head/metadata/原件摘要；调用方另核持久 marker、policy 与 input_hash 跨锚。 */
export function assertSegmentEntitySource(
  proof: SegmentEntitySource,
  identity: SegmentEntityIdentity,
  metadata: unknown,
  bytes?: Buffer,
): void {
  assertIdentity(identity);
  const expected = segmentEntityMetadata(metadata),
    inspected = proof.inspection;
  assertInspection(inspected);
  if (
    proof.version !== 1 ||
    proof.format !== 'glb' ||
    !/^[a-f0-9]{64}$/.test(proof.sha256) ||
    !Number.isSafeInteger(proof.bytes) ||
    proof.bytes <= 0 ||
    proof.strategy !== (inspected.entity_count > 1 ? 'resegment' : 'ordinary') ||
    proof.metadata_fingerprint !== fingerprint(proof.metadata) ||
    fingerprint(expected) !== proof.metadata_fingerprint
  )
    fail('The frozen source count, route or complete metadata changed.');
  for (const key of ['account_ref', 'project_id', 'operator_id'] as const)
    if (proof[key] !== identity[key]) fail('The source account, project or exact operator changed.');
  if (bytes && (bytes.length !== proof.bytes || sha(bytes) !== proof.sha256))
    fail('The exact source GLB bytes changed.');
}
