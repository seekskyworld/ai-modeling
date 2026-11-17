/** 分割文件作为不可变请求输入；准备与上传两次摘要校验，防止同 request_id 被改写。 */
import { readBoundedFile } from './files.ts';
import { isDeepStrictEqual } from 'node:util';
import {
  SEGMENTATION_FILE_LIMIT,
  validateSegmentationFile,
  segmentationMetadata,
} from './contracts/segmentation.ts';
import { object, text, TripoError } from './contracts/errors.ts';

export async function readSegmentation(file: string, roots: string[]) {
  const source = await readBoundedFile(file, roots, SEGMENTATION_FILE_LIMIT);
  let value: unknown;
  try {
    value = JSON.parse(source.bytes.toString('utf8'));
  } catch {
    throw new TripoError('SEGMENTATION_INVALID', 'Expected a segmentation state JSON file.');
  }
  return { state: validateSegmentationFile(value), sha256: source.sha256 };
}
/** 文件必须绑定真实目标版本；CLI 使用者不能把旧标签无声写到另一个项目上。 */
export async function segmentationInput(input: Record<string, unknown>, roots: string[]) {
  const loaded = await readSegmentation(text(input.indices_path), roots);
  const binding = loaded.state.binding;
  if (
    !binding ||
    binding.project_id !== input.project_id ||
    (input.expected_operator_id && binding.operator_id !== input.expected_operator_id)
  )
    throw new TripoError('SEGMENTATION_TARGET', 'State must be bound to this project and source operator.');
  const expected = object(input._input_files)[text(input.indices_path)];
  if (expected && expected !== loaded.sha256)
    throw new TripoError('INPUT_CHANGED', 'Segmentation file changed after preparation.', 'not_submitted');
  return { ...loaded, operatorId: binding.operator_id };
}
/** 网页源模型先应用 metadata；同一 operator 下的额外可见性/矩阵变化也必须阻断旧编辑。 */
export async function checkSegmentationMetadata(
  input: Record<string, unknown>,
  current: unknown,
  roots: string[],
): Promise<void> {
  const { state } = await segmentationInput(input, roots);
  const metadata = object(current);
  const expected = segmentationMetadata.parse(
    Object.fromEntries(
      ['children_deleted', 'children_rename', 'children_transform_matrix']
        .filter((key) => metadata[key] !== undefined)
        .map((key) => [key, metadata[key]]),
    ),
  );
  if (!isDeepStrictEqual(state.source_metadata, expected))
    throw new TripoError(
      'SEGMENTATION_METADATA_CHANGED',
      'Use the source project metadata when starting the editor; refresh if it changed.',
      'not_submitted',
    );
}
