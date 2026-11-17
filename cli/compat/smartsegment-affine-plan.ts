/** 离线展示完整七步；只在执行时从冻结原件确定两个正TRS矩阵。 */
import type { Plan, PlannedStep } from './planning.ts';
import { checkedSmartSegmentAffine } from '../artifacts/smartsegment-affine-decomposition.ts';
import { checkedMetadataTransform } from '../artifacts/smartsegment-transform-matrix.ts';
import { TripoError } from '../../studio/contracts/errors.ts';

export interface SmartSegmentAffineIntent {
  matrix: number[];
  source_kind: 'file' | 'reference';
  source: string;
  segment_parameters: Record<string, unknown>;
}
export function smartSegmentAffineMatrix(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length !== 16) return;
  try {
    checkedMetadataTransform(value);
    return;
  } catch (error) {
    if (!(error instanceof TripoError) || error.code !== 'SMARTSEGMENT_TRANSFORM_UNVERIFIED') throw error;
  }
  return checkedSmartSegmentAffine(value).matrix;
}
export const smartSegmentAffineWarning =
  'Single-axis shear u′=u+k*v between distinct x/y/z axes (XY/XZ/YX/YZ/ZX/ZY, 0.01≤|k|≤1), and general positive-determinant affine transforms whose actual source-derived TRS factors each pass native positive-scale 0.01–100 and precision checks, use seven separately quoted native steps: identity import/exact historical copy, metadata, ordinary segmentation, all-face native merge, another exact copy, metadata and ordinary segmentation. General affine factors use a deterministic proper spectral basis computed only from the original matrix and source coordinates; ordinary positive TRS and existing single-axis factors keep their original routes. Only a centered unit-extent static single-primitive GLB with complete normals/UVs and basic opaque appearance is currently accepted. Intermediate shape, metadata and fresh merge name are checked before continuing. Final native geometry must uniquely preserve every original A(P) oriented face within the fixed 4e-5 bound; intermediate errors are not added to that bound. Normals, UVs, materials and textures may change. No local model geometry is written. Any failed/unverified stage stops the same request; successful stages are never resubmitted. These bounded families are checked per actual result and do not claim all family values were tested against Studio.';
export function smartSegmentAffinePlan(
  first: PlannedStep,
  segment: PlannedStep,
  matrix: number[],
  source: string,
  file: boolean,
  pending: string[],
): Plan {
  const edit = (name: string): PlannedStep => ({
    name,
    operation: 'project_edit',
    source: 'upstream',
    parameters: { project_id: 'upstream', expected_operator_id: 'upstream' },
  });
  return {
    smartSegmentAffine: {
      matrix,
      source_kind: file ? 'file' : 'reference',
      source,
      segment_parameters: { ...segment.parameters },
    },
    steps: [
      first,
      edit('smartsegment-affine-first-metadata'),
      { ...segment, name: 'smartsegment-affine-first' },
      {
        name: 'smartsegment-affine-merge',
        operation: 'modification',
        source: 'upstream',
        parameters: { project_id: 'upstream', expected_operator_id: 'upstream' },
      },
      {
        name: 'smartsegment-affine-copy',
        operation: 'copy',
        source: 'upstream',
        parameters: { project_id: 'upstream', operator_id: 'upstream' },
      },
      edit('smartsegment-affine-second-metadata'),
      { ...segment, name: 'smartsegment-affine-final' },
    ],
    pending_uploads: pending,
    warnings: [smartSegmentAffineWarning],
  };
}
