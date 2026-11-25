/** A remote chat completion is a handoff to inspection, never proof that the Canvas meets the goal. */
import type { Job } from '../../studio/contracts/types.ts';
import { array, object, text } from '../../studio/contracts/errors.ts';

export function canvasAcceptanceView(job: Job): Record<string, unknown> {
  if (!['canvas_turn', 'canvas_continue', 'canvas_node_retry'].includes(job.operation)) return {};
  const turnId =
    text(job.remote_ids.task_id) || (job.operation === 'canvas_continue' ? text(job.input.turn_id) : '');
  const sessionId = text(job.input.session_id) || text(object(job.input._node_execution).session_id);
  const actions: { tool: string; arguments: Record<string, unknown> }[] = [];
  if (turnId) actions.push({ tool: 'ai_modeling_canvas_turn_get', arguments: { turnId } });
  if (sessionId) actions.push({ tool: 'ai_modeling_canvas_session_get', arguments: { sessionId } });
  return {
    canvas_acceptance: {
      required: true,
      status:
        job.state === 'succeeded'
          ? 'needs_review'
          : job.state === 'waiting_input'
            ? 'waiting_input'
            : ['failed', 'outcome_unknown', 'requires_login'].includes(job.state)
              ? 'blocked'
              : 'pending',
      process_complete: job.state === 'succeeded',
      artifacts_checked: false,
      requirements_met: null,
      context: {
        ...(turnId ? { turn_id: turnId } : {}),
        ...(sessionId ? { session_id: sessionId } : {}),
        ...(text(job.input.node_id) ? { target_node_id: text(job.input.node_id) } : {}),
        ...(array(job.input.capabilities).length ? { capabilities: job.input.capabilities } : {}),
      },
      next_actions: actions,
      audit: {
        tool: 'ai_modeling_canvas_audit',
        command: 'canvas audit',
        required_context:
          'Read GetTurnDetail.sessionId and GetSession.canvasId; audit that Canvas and the exact turn. Select target nodes and expectations from the user goal, not the newest asset.',
      },
      guide: 'ai-modeling://guides/pipelines',
      note: 'Inspect the current Canvas and exact downloaded artifacts before delivery. HolyMolly HTML, game preview, dependencies, settled cost and gameplay require separate checks; the image/model inspector cannot verify a game. A completed turn is not artifact or visual acceptance. Continue waiting/answering when required; preserve the original turn and never resubmit an unknown write.',
    },
  };
}
