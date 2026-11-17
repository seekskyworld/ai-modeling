/** 网页 gizmo 的正向 TRS delta 走 metadata；根上传矩阵不能代替这一条已验链。 */
import { matrix } from '../../studio/contracts/advanced.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import { checkedMetadataTransform } from '../artifacts/smartsegment-transform-matrix.ts';
import { smartSegmentRotationZ90 } from './smartsegment-transform-plan.ts';

export const smartSegmentIdentity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export interface SmartSegmentScaleIntent {
  matrix: number[];
  source_kind: 'file' | 'reference';
}
export function smartSegmentScaleMatrix(value: unknown, source: string): number[] | undefined {
  if (value === undefined) return;
  const m = matrix.parse(value);
  if (m.every((v, i) => v === smartSegmentIdentity[i])) return;
  // 已发布的精确Rz90文件两步链保持原意图和恢复身份，task/project使用新metadata链。
  if (
    m.every((v, i) => v === smartSegmentRotationZ90[i]) &&
    (/^https?:\/\//i.test(source) || /\.glb$/i.test(source))
  )
    return;
  try {
    return checkedMetadataTransform(m).matrix;
  } catch (error) {
    if (!(error instanceof TripoError)) throw error;
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      error.message + ' This is the verified client range, not a Studio service limit.',
      'not_submitted',
    );
  }
}
export const smartSegmentScaleWarning =
  'Positive TRS uses a native identity import for GLB files/URLs, or an exact-version copy for an owned task/project, followed by native metadata and segmentation. Each step retains its own receipt and possible cost. Files/URLs require one centered unit-extent static GLB triangle primitive with complete normals/UVs and a basic opaque material. Owned task/project sources additionally accept centered unit-extent independent named roots, each with one primitive and complete normals/UVs plus opaque scalar or embedded base-color material. New owned references explicitly freeze the verified ordinary segmentation route after original-byte inspection, including one entity with a retained is_segmented flag; the default resegment route and old requests are unchanged. Existing geometry metadata must be identity. Finite translation, proper orthogonal rotation and positive axis scales 0.01–100 are the current verification range; this three-step route rejects shear, projection, reflection and numerically unresolvable translations. The separate seven-step bounded affine route has its own original-source and fixed-error obligations. Original bytes, source version, metadata head and all three steps are frozen. Native segmented geometry must uniquely preserve every requested oriented face before get/list/download reports a verified result. Native normals, UV packing and texture encoding can change; multi-root ordinary segmentation can also remove UVs and materials. The result verifies geometry, not source appearance preservation. Ordinary segmentation checks the exact metadata head locally; the upstream body has no atomic compare-and-swap. No source asset or native output geometry is edited locally.';
