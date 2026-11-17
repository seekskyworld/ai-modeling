/** 只开放已实测的基轴旋转；矩阵本身交网页导入执行，本机仅检验，不改模型顶点。 */
import { matrix } from '../../studio/contracts/advanced.ts';
import { TripoError } from '../../studio/contracts/errors.ts';

export const smartSegmentRotationZ90 = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export interface SmartSegmentTransformIntent {
  matrix: number[];
}
export function checkedSmartSegmentTransform(
  source: string,
  transform: unknown,
): SmartSegmentTransformIntent | undefined {
  if (transform === undefined) return;
  const checked = matrix.parse(transform);
  if (checked.every((value, index) => value === (index % 5 === 0 ? 1 : 0))) return;
  if (
    !checked.every((value, index) => value === smartSegmentRotationZ90[index]) ||
    (!/^https?:\/\//i.test(source) && !/\.glb$/i.test(source))
  )
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      'This native-import route requires exact +90 degree Z rotation of a static GLB file or URL. Other verified positive TRS inputs must use the complete metadata smartsegment plan.',
      'not_submitted',
    );
  return { matrix: checked };
}

export const smartSegmentTransformWarning =
  'Exact +90 degree Z smartsegment uses a native Studio import followed by native segmentation. Before import, the self-contained static GLB must contain one triangle primitive with normals/UVs, at most 25000 faces, no skins/animation/morphs/extra material channels, a centered bounding box and longest extent 1. Every imported oriented face, normal, UV, material and embedded base-color texture must match the requested rotation before segmentation can be submitted. Native segmentation can recompute normals, repack UVs and re-encode per-part textures; it does not promise unchanged source attributes or exact part counts. Both original receipts and the complete intent are retained; resume with the original request_id.';
