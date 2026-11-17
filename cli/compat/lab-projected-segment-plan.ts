/** 明确相机的分区图是网页Lab扩展，不能伪装成原生v2任意语义参考图。 */
import { z } from 'zod';
import { text, TripoError } from '../../studio/contracts/errors.ts';
import type { Plan } from './planning.ts';
import { labInputReference, type LabReferenceMeshIntent } from './lab-reference-edit-plan.ts';

const row = z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]);
export const labReferenceProjectionSchema = z.tuple([row, row]).refine(([u, v]) => {
  const a = Math.hypot(...u.slice(0, 3)),
    b = Math.hypot(...v.slice(0, 3));
  const dot = u.slice(0, 3).reduce((sum, n, i) => sum + n * v[i]!, 0);
  return (
    a > 0 &&
    a <= 100000 &&
    b > 0 &&
    b <= 100000 &&
    Math.abs(a - b) <= 1e-8 * Math.max(a, b) &&
    Math.abs(dot) <= 1e-8 * a * b
  );
}, 'reference_projection requires two nonzero, orthogonal, equally scaled world-to-pixel rows.');
export type LabReferenceProjection = z.infer<typeof labReferenceProjectionSchema>;
export interface LabProjectedSegmentIntent extends Omit<LabReferenceMeshIntent, 'bbox' | 'kind'> {
  kind: 'projected_segment';
  projection: LabReferenceProjection;
  bbox?: never;
}
export const labProjectedSegmentWarning =
  'Reference-mask segmentation uses Studio 3D Lab with variable web billing and an explicit orthographic world-to-pixel projection. It groups each original triangle by its centroid pixel, including hidden faces; it does not infer a camera, anatomical labels, connectivity or the official v2 engine. The mask must be an opaque PNG with white background and 2–8 exact nonwhite RGB colors. Original oriented triangles, normals, default material and every mask assignment are verified before delivery. Requires accept_variable_cost=true; unknown writes are not repeated.';

export function labProjectedSegmentPlan(source: string, input: Record<string, unknown>): Plan | undefined {
  if (input.ref_image === undefined && input.reference_projection === undefined) return;
  if (!source.trim() || !text(input.ref_image).trim())
    throw new TripoError(
      'INVALID_INPUT',
      'Projected segmentation requires a model source and ref_image.',
      'not_submitted',
    );
  if (
    Object.keys(input).some(
      (key) => !['ref_image', 'reference_projection', 'accept_variable_cost'].includes(key),
    )
  )
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      'The explicit-projection Lab extension supports only ref_image, reference_projection and accept_variable_cost; no exact native model or other parameter mapping is claimed.',
      'not_submitted',
    );
  if (input.accept_variable_cost !== true)
    throw new TripoError(
      'VARIABLE_COST_NOT_ACCEPTED',
      'Pass -p accept_variable_cost=true to select variable-cost Studio Lab projected segmentation.',
      'not_submitted',
    );
  const projection = labReferenceProjectionSchema.safeParse(input.reference_projection);
  if (!projection.success)
    throw new TripoError(
      'INVALID_INPUT',
      'reference_projection must be a 2×4 orthographic world-to-pixel matrix. No camera or mask layout is inferred.',
      'not_submitted',
    );
  const intent: LabProjectedSegmentIntent = {
    version: 1,
    backend: 'studio_lab',
    kind: 'projected_segment',
    source: labInputReference(source),
    reference: labInputReference(text(input.ref_image)),
    projection: projection.data,
    accept_variable_cost: true,
  };
  return {
    labReferenceEdit: intent,
    steps: [
      {
        name: 'segment',
        operation: 'canvas_lab',
        parameters: {
          node_id: 'prepared-lab-node',
          prompt:
            'Explicit projected mask partition; exact instructions are frozen after source verification.',
          accept_variable_cost: true,
        },
      },
    ],
    pending_uploads: [intent.source, intent.reference].filter(
      (v) => !v.startsWith('@') && !/^[a-f\d]{8}-[a-f\d-]{27}$/i.test(v),
    ),
    warnings: [labProjectedSegmentWarning],
  };
}

export function labProjectedSegmentPrompt(projection: LabReferenceProjection, groups: number): string {
  return [
    'Partition the attached original GLB using the attached color-region reference PNG. This is explicit-projection partitioning, not mesh regeneration. Read the image pixels for group assignment.',
    `Use original GLB world coordinates without recentering, normalization, scaling or rotation. The orthographic mapping is u = dot(${JSON.stringify(projection[0])}, [x,y,z,1]) and v = dot(${JSON.stringify(projection[1])}, [x,y,z,1]). For each original triangle, project its world-space centroid and sample pixel (floor(u+0.5), floor(v+0.5)), including hidden/back faces. White is background. Name each output node mask_ followed by its exact nonwhite pixel color in lowercase six-digit RGB hex. Do not infer anatomy or replace the image with semantic guesses.`,
    'Preserve every original triangle exactly once, with its world vertex positions, oriented winding, world normals and original default untextured material. Never split, add, remove, remesh or paint triangles. Reindexing and duplicate vertices across group boundaries are permitted only while preserving the original triangle geometry and normals.',
    `Return exactly one self-contained GLB model artifact partitioned.glb with ${groups} nonempty root mesh nodes, one per image color. Each node has one mesh and one triangle primitive, with no other geometry. A preview or explanation is not the result. Use one Lab job; do not launch other generation jobs, external providers or an API-wallet service. If these constraints cannot be met, report the limitation honestly.`,
  ].join('\n\n');
}
