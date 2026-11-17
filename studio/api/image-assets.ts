/** 网页图片库按页读取；CLI 公开 offset 允许非整页位置，因此至多拼接两页后切片。 */
import { array, object, TripoError } from '../contracts/errors.ts';
import type { StudioClient } from './client.ts';
import { imageAssetSummary } from './asset-summary.ts';

export async function imageAssets(
  client: StudioClient,
  offset: number,
  limit: number,
): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new TripoError(
      'INVALID_INPUT',
      'Image pagination requires a nonnegative offset and a limit from 1 to 100.',
    );
  const account = client.credentials.load()?.accountRef;
  if (!account) throw new TripoError('AUTH_REQUIRED', 'Sign in to Studio first.');
  const bound = client.forAccount(account);
  const read = async (page: number) => {
    const data = object(
      await bound.request('POST', '/v2/studio/image/image_assets', {
        page_num: page,
        page_size: limit,
      }),
    );
    bound.credentials.load();
    return array(data.assets).map(object);
  };
  const page = Math.floor(offset / limit) + 1;
  const skip = offset % limit;
  const first = await read(page);
  const last = skip > 0 && first.length === limit ? await read(page + 1) : first;
  const combined = first === last ? first : [...first, ...last];
  const assets = combined.slice(skip, skip + limit).map(imageAssetSummary);
  const more = combined.length > skip + limit || last.length === limit;
  return { assets, next_offset: assets.length > 0 && more ? offset + assets.length : null };
}
