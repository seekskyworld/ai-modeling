/** 工作区元数据的增量编辑/快照恢复；先核对当前版本，避免覆盖已观察到的他人改动。 */
import { isDeepStrictEqual } from 'node:util';
import { object, array, text, TripoError } from '../contracts/errors.ts';
import type { StudioClient } from './client.ts';
import { metadataFields as fields } from '../contracts/metadata.ts';
export { metadataSchema } from '../contracts/metadata.ts';
type Input = Record<string, unknown>;
export async function metadataBody(client: StudioClient, input: Input): Promise<Input> {
  const detail = object(await client.request('GET', `/v2/studio/project/detail/v3/${input.project_id}`));
  const operator = object(detail.operator),
    metadata = object(operator.metadata);
  const current = Object.fromEntries(
    Object.keys(fields).map((key) => [key, metadata[key] ?? (key === 'children_deleted' ? [] : {})]),
  );
  if (
    operator.operator_id !== input.expected_operator_id ||
    (input.expected_metadata && !isDeepStrictEqual(input.expected_metadata, current))
  )
    throw new TripoError(
      'PROJECT_CHANGED',
      'Refresh project metadata before applying edits.',
      'not_submitted',
    );
  const deleted = new Set(array(input.children_deleted ?? current.children_deleted).map(text));
  for (const [name, visible] of Object.entries(object(input.children_visibility)))
    if (visible) deleted.delete(name);
    else deleted.add(name);
  const result: Input = { project_id: input.project_id, children_deleted: [...deleted] };
  for (const key of ['children_rename', 'children_transform_matrix', 'material_factor'])
    result[key] =
      input.replace && input[key] !== undefined
        ? input[key]
        : { ...object(current[key]), ...object(input[key]) };
  return result;
}
