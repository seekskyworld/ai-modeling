/** 分割判据读取完整 metadata；CLI 原件证明与 Studio 发送前检查共用规范化。 */
import { isDeepStrictEqual } from 'node:util';
import { TripoError } from './errors.ts';
import { metadataFields } from './metadata.ts';
import { matrix } from './advanced.ts';

export function segmentEntityMetadata(value: unknown): Record<string, unknown> {
  try {
    const original = value ?? {};
    if (!original || typeof original !== 'object' || Array.isArray(original)) throw new Error('metadata');
    const encoded = JSON.stringify(original);
    if (!encoded || !isDeepStrictEqual(original, JSON.parse(encoded))) throw new Error('json');
    const result: Record<string, unknown> = JSON.parse(encoded);
    for (const [key, schema] of Object.entries(metadataFields))
      result[key] = schema.parse(result[key] ?? (key === 'children_deleted' ? [] : {}));
    // Studio 的未编辑根矩阵实际返回 []；保留原表示以核对完整 metadata。
    if (
      result.transform_matrix !== undefined &&
      !(Array.isArray(result.transform_matrix) && result.transform_matrix.length === 0)
    )
      result.transform_matrix = matrix.parse(result.transform_matrix);
    return result;
  } catch {
    throw new TripoError(
      'SEGMENT_ENTITY_SOURCE_CHANGED',
      'The exact segment source metadata is malformed or incomplete.',
      'not_submitted',
    );
  }
}
