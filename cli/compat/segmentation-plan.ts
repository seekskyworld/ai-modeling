/** 原生 apply_indices 不继承新部件名的矩阵；使用网页 metadata→export 保住可观察的尺寸。 */
import { segmentationInput } from '../../studio/segmentation.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import type { SegmentationFile } from '../../studio/contracts/segmentation.ts';
import type { Plan, PlannedStep } from './planning.ts';
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const sameMatrix = (a: number[], b: number[]): boolean => a.every((v, i) => Math.abs(v - b[i]!) <= 1e-6);

/** 一个输出部件只能附加一个仿射变换；不同变换的源部件合成同一标签时不得静默丢变换。 */
export function segmentTransforms(state: SegmentationFile): Record<string, number[]> {
  const transforms = new Map<number, number[]>();
  for (const [mesh, encoded] of Object.entries(state.part_indices)) {
    const matrix = state.source_transforms[mesh]!;
    for (const label of new Set(Buffer.from(encoded, 'base64'))) {
      const existing = transforms.get(label);
      if (existing && !sameMatrix(existing, matrix))
        throw new TripoError(
          'SEGMENTATION_TRANSFORM_CONFLICT',
          'This segment combines differently transformed parts. Export the transformed source through Studio and import it as a new editable model first.',
          'not_submitted',
        );
      transforms.set(label, matrix);
    }
  }
  if ([...transforms.values()].every((matrix) => sameMatrix(matrix, identity))) return {};
  return Object.fromEntries(
    [...transforms].map(([label, matrix]) => [state.snapshot.part_names[label]!, matrix]),
  );
}
/** CLI 与 MCP 共用处理链；每步独立持久化，结果未知或失败时不重提已成功分割。 */
export async function expandSegmentationPlan(plan: Plan, roots: string[]): Promise<Plan> {
  if (
    plan.steps.length !== 1 ||
    plan.steps[0]!.operation !== 'modification' ||
    !plan.steps[0]!.parameters.indices_path
  )
    return plan;
  const first = plan.steps[0]!;
  const { state } = await segmentationInput(first.parameters, roots);
  const transforms = segmentTransforms(state);
  if (!Object.keys(transforms).length) return plan;
  const steps: PlannedStep[] = [
    first,
    {
      name: 'preserve-segment-transforms',
      operation: 'project_edit',
      source: 'upstream',
      parameters: { expected_operator_id: 'upstream', children_transform_matrix: transforms },
    },
    {
      name: 'export-segmented-model',
      operation: 'export',
      source: 'upstream',
      parameters: { format: 'glb' },
    },
  ];
  return {
    ...plan,
    steps,
    warnings: [
      ...plan.warnings,
      'Saving transformed parts uses native modification, metadata and GLB export as three recoverable steps.',
      'The final GLB uses Studio export orientation, pivot and node naming. Editable part names and transforms remain in the saved Studio project.',
    ],
  };
}
