/** 旧任务的远端成功不能掩盖新发现产物未齐；保持原终态，只将公开交付状态标为待核验。 */
import type { Job, RemoteStatus } from '../../studio/contracts/types.ts';
import { missingSemanticMasks, requiresSemanticMask } from '../../studio/api/semantic-mask.ts';

export function canDiscoverSemanticMasks(job: Job): boolean {
  return (
    missingSemanticMasks(job) &&
    (job.state === 'succeeded' ||
      (job.state === 'failed' &&
        Boolean(job.remote_ids.models?.some((item) => item.accepted === true)) &&
        job.artifacts.some((item) => item.kind === 'model')))
  );
}

export function semanticMaskRefreshIncomplete(job: Job, refreshed: RemoteStatus): boolean {
  return (
    requiresSemanticMask(job) &&
    (missingSemanticMasks(job) || (job.state === 'succeeded' && refreshed.state !== 'succeeded'))
  );
}

export function semanticMaskSummary(job: Job): Record<string, unknown> {
  if (job.state !== 'succeeded' || !missingSemanticMasks(job)) return {};
  return {
    state: 'needs_attention',
    remote_state: 'succeeded',
    error: {
      code: 'SEGMENTATION_PREVIEW_UNVERIFIED',
      message: 'The original segmentation preview has not been confirmed for every accepted result.',
      certainty: 'read',
    },
    segmentation_preview_validation: { status: 'unverified' },
    next_action: 'Read this original task again to discover its exact preview; do not resubmit generation.',
  };
}
