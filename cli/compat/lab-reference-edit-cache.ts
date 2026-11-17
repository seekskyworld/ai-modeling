/** 仅恢复已冻结的原输入；输出查询不能初始化 CLI 执行器或账号凭据。 */
import { readImageCache } from '../artifacts/image-cache.ts';
import { readVerifiedOutputCache } from '../artifacts/verified-output-cache.ts';
import { labReferenceFailure, type LabReferenceSource } from './lab-reference-edit-policy.ts';

export async function readLabReferenceCache(
  account: string,
  source: LabReferenceSource,
): Promise<{ model: Buffer; image: Buffer }> {
  const model = await readVerifiedOutputCache(account, source.model, source.model.cache_data_dir);
  const image = readImageCache(
    source.image.cache_data_dir,
    'lab-reference-cache',
    source.image.cache_path,
    source.image,
  );
  if (!model || !image)
    return labReferenceFailure(
      'An original Lab input cache is missing or changed. Recover these exact bytes; do not create another Canvas or Lab job.',
    );
  return { model, image };
}
