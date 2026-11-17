/** 原生文件与加工交付各有独立摘要；元数据漂移不能被缓存恢复静默覆盖。 */
import type { Artifact } from '../../studio/contracts/types.ts';

export type DeliverySourcePrefix = 'source_' | 'imported_';

export function validDeliveryProof(proof: Record<string, unknown>, source: DeliverySourcePrefix): boolean {
  return (
    typeof proof.processing === 'string' &&
    proof.processing.trim().length > 0 &&
    ['', source].every(
      (prefix) =>
        typeof proof[`${prefix}sha256`] === 'string' &&
        /^[a-f0-9]{64}$/.test(proof[`${prefix}sha256`] as string) &&
        Number.isSafeInteger(proof[`${prefix}bytes`]) &&
        Number(proof[`${prefix}bytes`]) > 0,
    )
  );
}

/** 首次未下载可没有摘要；已有原生摘要只对原生字节，已有加工标记必须包含完整交付证明。 */
export function artifactMatchesDeliveryProof(
  artifact: Artifact,
  proof: Record<string, unknown>,
  source: DeliverySourcePrefix,
  requireDelivery = false,
): boolean {
  if (requireDelivery || artifact.processing !== undefined)
    return (
      artifact.sha256 === proof.sha256 &&
      artifact.bytes === proof.bytes &&
      artifact.processing === proof.processing &&
      artifact.source_sha256 === proof[`${source}sha256`]
    );
  return (
    artifact.source_sha256 === undefined &&
    (artifact.sha256 === undefined || artifact.sha256 === proof[`${source}sha256`]) &&
    (artifact.bytes === undefined || artifact.bytes === proof[`${source}bytes`])
  );
}
