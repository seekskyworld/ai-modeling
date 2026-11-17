/** 媒体保持结构验证；Lab 任意文件只核传输字节，并显式说明未验证文件内部语义。 */
import { detectFormat } from '../../studio/files.ts';
import { validateCanvasVideo } from '../../studio/api/canvas-input.ts';
import type { ArtifactContentHint } from '../../studio/contracts/artifact-source.ts';
import { TripoError } from '../../studio/contracts/errors.ts';

export function downloadedContent(bytes: Buffer, expected: string, hint: ArtifactContentHint = {}) {
  if (hint.byte_size !== undefined && bytes.length !== hint.byte_size)
    throw new TripoError('INVALID_ARTIFACT', 'Artifact length differs from the original asset metadata.');
  if (hint.kind === 'video') {
    try {
      validateCanvasVideo(bytes, expected);
    } catch {
      throw new TripoError('INVALID_ARTIFACT', 'Downloaded video container is invalid or truncated.');
    }
    return { format: expected, content_validation: 'video_container' };
  }
  if (hint.kind === 'file') {
    if (!bytes.length) throw new TripoError('INVALID_ARTIFACT', 'Downloaded Lab file is empty.');
    return { format: expected, content_validation: 'opaque_file' };
  }
  return { format: detectFormat(bytes, expected === 'animation') };
}
