/** 官方 convert 默认保留已有骨骼/动作；最终选择落入原任务输入，恢复不能追加新动作。 */
import type { StudioClient } from '../../studio/api/client.ts';
import { exportAnimationSource } from '../../studio/api/export-source.ts';
import { array, text, TripoError } from '../../studio/contracts/errors.ts';
import type { Job } from '../../studio/contracts/types.ts';

export const importedAnimationWarning =
  'Embedded GLB skeleton and motion preservation has been verified on a 65-bone walk sample, with Studio coordinate normalization and an export timeline offset; it is not guaranteed for arbitrary files or rigs. Automatic preservation uses the rig and motions explicitly reported by Studio; use with_animation=false for an intentional static result.';

type SourceJob = Pick<Job, 'operation' | 'input' | 'remote_ids'>;
function sourceOperator(source?: SourceJob, currentOperator?: string): string | undefined {
  if (!source) return currentOperator;
  // Canvas 的 remote_ids 只保存 run，调用方已从冻结 final 解析真实模型版本。
  if (source.operation === 'canvas_run') return currentOperator;
  if (source.operation === 'export') return text(source.input.expected_operator_id) || undefined;
  if (source.operation === 'animate') return text(source.input.expected_operator_id) || undefined;
  return text(source.remote_ids.operator_id) || undefined;
}
function preferredAnimations(source?: SourceJob): string[] | undefined {
  if (source?.operation === 'animate') return [text(source.remote_ids.operator_id)];
  if (source?.operation === 'export') return array(source.input.animations).map(text);
  return undefined;
}
function assertSourceSkeleton(source: SourceJob | undefined, rigged: boolean): void {
  if (source?.operation === 'export' && source.input.with_animation === true && !rigged)
    throw new TripoError(
      'ANIMATION_SOURCE_UNVERIFIED',
      'The original exported skeleton is no longer present in the source project.',
      'not_submitted',
    );
}

export async function applyDefaultExportAnimations(
  client: Pick<StudioClient, 'request'>,
  parameters: Record<string, unknown>,
  currentOperator?: string,
  source?: SourceJob,
  existing?: Job,
  requireStatic = false,
): Promise<Record<string, unknown>> {
  const result = { ...parameters };
  if (existing?.operation === 'export' && existing.input.project_id === result.project_id) {
    result.with_animation = existing.input.with_animation;
    result.animations = existing.input.animations;
    const expected = sourceOperator(source);
    if (existing.input.expected_operator_id !== undefined)
      result.expected_operator_id = expected ?? existing.input.expected_operator_id;
    return result;
  }
  const expected = text(result.expected_operator_id) || sourceOperator(source, currentOperator);
  const state = await exportAnimationSource(client, text(result.project_id), expected);
  assertSourceSkeleton(source, state.is_rigged);
  // 明确静态的导出来源不应因项目随后新增动作而变成动画输入。
  const staticSource = source?.operation === 'export' && source.input.with_animation === false;
  if (state.is_rigged && !staticSource && (requireStatic || result.bake === false))
    throw new TripoError(
      'STUDIO_CAPABILITY_UNAVAILABLE',
      'This static conversion cannot preserve the source skeleton or animation. Set with_animation=false explicitly to request a static result.',
      'not_submitted',
    );
  const preferred = preferredAnimations(source);
  const animations = staticSource ? [] : (preferred ?? state.animations);
  if (animations.some((id) => !state.animations.includes(id)))
    throw new TripoError(
      'ANIMATION_NOT_READY',
      'The original source motions are no longer available.',
      'not_submitted',
    );
  result.with_animation = !staticSource && state.is_rigged;
  result.animations = animations;
  result.expected_operator_id = state.operator_id;
  return result;
}
