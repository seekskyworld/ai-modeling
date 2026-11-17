/** 官方任务类型是展示契约；原网页 operation 和所有远端身份仍单独保留。 */
import type { Job } from './types.ts';
export function taskType(job: Pick<Job, 'operation' | 'input'>): string {
  if (job.operation === 'image_process' && job.input._multiview_edit) return 'edit_multiview_image';
  if (job.operation === 'model') return `${job.input.mode}_to_model`;
  if (job.operation === 'image')
    return job.input.image_path ||
      job.input.image_paths ||
      job.input.image_asset ||
      job.input.image_assets ||
      job.input.image_sources
      ? 'generate_image'
      : 'text_to_image';
  if (job.operation === 'image_process' && job.input.action === 'multiview')
    return 'generate_multiview_image';
  return (
    (
      {
        texture: 'texture_model',
        rig: 'animate_rig',
        animate: 'animate_retarget',
        export: 'convert_model',
        import_model: 'import_model',
        remesh: 'mesh_decimate',
        segment: 'mesh_segmentation',
        resegment: 'mesh_segmentation',
        complete: 'mesh_completion',
        local_edit: 'mesh_edit',
        uv_generate: 'smart_uv',
        uv_commit: 'smart_uv',
      } as Record<string, string>
    )[job.operation] ?? job.operation
  );
}
