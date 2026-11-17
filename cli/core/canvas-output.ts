/** 读/下载期间还要复核冻结身份，最终模型第一次下载后固定摘要，远端不能静默换件。 */
import { createHash } from 'node:crypto';
import type { Artifact, Job } from '../../studio/contracts/types.ts';
import { assertCanvasArtifact, validCanvasResult } from '../../studio/contracts/canvas-result.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import { fingerprint } from './fingerprint.ts';

export function assertCanvasSnapshot(original: Job, artifact: Artifact, current: Job): Artifact {
  const saved = current.artifacts.find((a) => a.artifact_id === artifact.artifact_id);
  if (
    !saved ||
    !validCanvasResult(current, saved) ||
    current.account_ref !== original.account_ref ||
    current.input_hash !== original.input_hash ||
    fingerprint(current.remote_ids) !== fingerprint(original.remote_ids) ||
    fingerprint(saved.canvas_result) !== fingerprint(artifact.canvas_result)
  )
    throw new TripoError(
      'CANVAS_RESULT_IDENTITY_CHANGED',
      'The frozen Canvas result changed while downloading.',
      'read',
    );
  assertCanvasArtifact(current, saved);
  return saved;
}
export function assertCanvasBytes(artifact: Artifact, bytes: Buffer): void {
  if (
    artifact.sha256 &&
    (artifact.bytes !== bytes.length || artifact.sha256 !== createHash('sha256').update(bytes).digest('hex'))
  )
    throw new TripoError(
      'CANVAS_RESULT_CONTENT_CHANGED',
      'The downloaded model differs from this original capped result.',
      'read',
    );
}
