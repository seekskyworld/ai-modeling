/** 参考图局部编辑复用网页 Lab；显式披露引擎/计费差异，未证明的参数不丢弃。 */
import path from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { Plan } from './planning.ts';
import { text, TripoError } from '../../studio/contracts/errors.ts';
import type { LabProjectedSegmentIntent } from './lab-projected-segment-plan.ts';

const triple = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
export const labReferenceBboxSchema = z
  .tuple([triple, triple])
  .refine(
    ([a, b]) => a.every((v, i) => v < b[i]!),
    'bbox requires strictly increasing minimum/maximum coordinates.',
  );
export type LabReferenceBbox = z.infer<typeof labReferenceBboxSchema>;
export interface LabReferenceMeshIntent {
  version: 1;
  backend: 'studio_lab';
  source: string;
  reference: string;
  bbox: LabReferenceBbox;
  accept_variable_cost: true;
  kind?: never;
  /** 仅redo规划器写入，执行时按原任务策略验证，不能信任任意本地缓存路径。 */
  redo_of?: { job_id: string; request_id: string; source_sha256: string; reference_sha256: string };
}
export type LabReferenceEditIntent = LabReferenceMeshIntent | LabProjectedSegmentIntent;
export const labReferenceEditWarning =
  'Reference-guided region editing uses Studio 3D Lab with variable web-account billing, not the official fixed P2 engine or its price. Requires explicit accept_variable_cost=true. The verified route accepts one static, untextured GLB with normals and a bounded region; it checks preserved outside triangles, normals/materials, no new outside geometry and a changed inside region. Semantic fidelity is an AI result, not a deterministic guarantee. Explicit face_limit, compression, textures, skins and animations are unavailable. Each Canvas preparation receipt and the Lab job are persistent; unknown writes are not repeated.';

export function labInputReference(value: string): string {
  if (/^https?:\/\//i.test(value) || /^@/.test(value) || /^[a-f\d]{8}-(?:[a-f\d-]){27}$/i.test(value))
    return value;
  if (/^(?:file_|task_|studio_file_)/.test(value))
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      'Use a local file, HTTP(S) URL or a local Studio task reference for Lab editing.',
      'not_submitted',
    );
  return path.resolve(value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value);
}
export function labReferenceEditPlan(source: string, input: Record<string, unknown>): Plan | undefined {
  if (input.ref_image === undefined) return;
  if (!source.trim() || !text(input.ref_image).trim())
    throw new TripoError(
      'INVALID_INPUT',
      'Reference editing needs a model source and ref_image.',
      'not_submitted',
    );
  const allowed = new Set(['ref_image', 'bbox', 'accept_variable_cost']);
  if (Object.keys(input).some((key) => !allowed.has(key)))
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      'The Lab reference route supports only bbox, ref_image and accept_variable_cost; explicit face_limit, model and compression have no verified mapping.',
      'not_submitted',
    );
  if (input.accept_variable_cost !== true)
    throw new TripoError(
      'VARIABLE_COST_NOT_ACCEPTED',
      'Reference-guided mesh editing uses variable Studio Lab credits. Pass -p accept_variable_cost=true to select this backend explicitly.',
      'not_submitted',
    );
  const parsed = labReferenceBboxSchema.safeParse(input.bbox);
  if (!parsed.success)
    throw new TripoError(
      'INVALID_INPUT',
      'bbox must be [[minX,minY,minZ],[maxX,maxY,maxZ]] with finite, strictly increasing coordinates.',
      'not_submitted',
    );
  const intent: LabReferenceMeshIntent = {
    version: 1,
    backend: 'studio_lab',
    source: labInputReference(source),
    reference: labInputReference(text(input.ref_image)),
    bbox: parsed.data,
    accept_variable_cost: true,
  };
  return {
    labReferenceEdit: intent,
    steps: [
      {
        name: 'edit',
        operation: 'canvas_lab',
        parameters: {
          node_id: 'prepared-lab-node',
          prompt: 'Reference-guided region editing; exact instructions are frozen after source verification.',
          accept_variable_cost: true,
        },
      },
    ],
    pending_uploads: [intent.source, intent.reference].filter(
      (v) => !v.startsWith('@') && !/^[a-f\d]{8}-[a-f\d-]{27}$/i.test(v),
    ),
    warnings: [labReferenceEditWarning],
  };
}

export function labReferenceEditPrompt(bbox: LabReferenceBbox): string {
  return [
    'Edit only the attached GLB using the attached image as semantic SHAPE guidance. These are an isolated model copy and its reference image; do not change any existing Studio project.',
    `Use the original GLB world coordinates without recentering, normalizing, rotating or scaling the model. The edit region is the axis-aligned box min=${JSON.stringify(bbox[0])}, max=${JSON.stringify(bbox[1])}. Read the reference image pixels and use its visible shape to guide the selected region.`,
    'Replace or refine geometry completely enclosed by this box. Keep every original triangle with at least one vertex outside the box unchanged: same world vertex positions, oriented winding, normals, material and attributes. Keep the rest of the model unchanged. Do not add geometry outside the box, change only colors, add a flat image billboard or return the unchanged source. Preserve crossing triangles even if the cut boundary cannot be stitched.',
    'Return exactly one actual modified self-contained GLB model artifact called edited.glb. A JSON explanation or preview is supporting information, never a substitute for the GLB. Perform this as one Lab job. Do not launch other generation jobs, external model providers or an API-wallet service. If these constraints cannot be met, state the limitation honestly without claiming success or substituting another model.',
  ].join('\n\n');
}
