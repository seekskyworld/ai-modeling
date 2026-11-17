/** 网页局部重试沿用原建模面数；没有来源证据时要求显式参数，不任意猜测精度。 */
import type { StudioClient } from './client.ts';
import { object, text, array, TripoError } from '../contracts/errors.ts';
function targetFaces(detail: unknown): number | undefined {
  const operator = object(object(detail).operator);
  for (const key of ['image_to_model', 'multiview_to_model', 'image_prompt_to_model', 'text_to_model']) {
    const faces = object(operator[key]).face_limit;
    if (Number.isInteger(faces) && Number(faces) >= 100) return Number(faces);
  }
  return undefined;
}
export async function localEditBody(
  client: StudioClient,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let faces = input.face_limit;
  if (faces === undefined) {
    const project = encodeURIComponent(text(input.project_id)),
      source = encodeURIComponent(text(input.source_operator_id));
    const detail = object(
      await client.request('GET', `/v2/studio/project/detail/v3/${project}?operator_id=${source}`),
    );
    faces = targetFaces(detail);
    if (faces === undefined) {
      const history = object(await client.request('GET', `/v2/studio/project/history/${project}`));
      const generation = array(history.history)
        .map(object)
        .reverse()
        .find((row) =>
          ['image_to_model', 'multiview_to_model', 'image_prompt_to_model', 'text_to_model'].includes(
            text(row.type),
          ),
        );
      if (generation)
        faces = targetFaces(
          await client.request(
            'GET',
            `/v2/studio/project/detail/v3/${project}?operator_id=${encodeURIComponent(text(generation.operator_id))}`,
          ),
        );
    }
    if (faces === undefined)
      throw new TripoError(
        'FACE_LIMIT_REQUIRED',
        'The original target face count is unavailable; provide --face-limit.',
      );
    faces = Math.min(Number(faces), /\.fbx(?:\?|$)/i.test(text(detail.model_url)) ? 25000 : 50000);
  }
  return {
    project_id: input.project_id,
    source_operator_id: input.source_operator_id,
    bbox: input.bbox,
    face_limit: faces,
  };
}
