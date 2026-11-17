/** P2 工作台在已审核主图上做有界对称性预检；它不是官方 convert.force_symmetry。 */
import type { StudioClient } from './client.ts';
import { array, object, text, TripoError } from '../contracts/errors.ts';

const symmetryWaitMs = 1500;

/** 只用于领取成功后的新提交；已有任务恢复不重新计算自动参数或重发生成请求。 */
export async function applyModelSymmetry(
  client: StudioClient,
  input: Record<string, unknown>,
  body: Record<string, unknown>,
): Promise<void> {
  if (input.model_version !== 'Nexus-v2.0-20260801' || input.symmetry !== undefined) return;
  // CLI 的四槽输入固定 front/left/back/right；没有页面主视图状态时采用 front。
  // 文字和批量模式没有选中的主图，不从其他任务或历史页面借用图片。
  const image = object(
    input.mode === 'image' ? body.image : input.mode === 'multiview' ? array(body.image)[0] : undefined,
  );
  if (!text(image.bucket) || !text(image.key)) {
    body.symmetry = false;
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    body.symmetry = await Promise.race([
      client
        .request(
          'POST',
          '/v2/studio/operation/symmetry_check',
          { image: { bucket: image.bucket, key: image.key } },
          { timeoutMs: symmetryWaitMs },
        )
        .then((result) => object(result).symmetry === true)
        .catch((error: unknown) => {
          // 网页普通预检故障回退 false；身份失效必须在付费前停止，不能换账号继续。
          if (
            error instanceof TripoError &&
            ['AUTH_REQUIRED', 'ACCOUNT_MISMATCH', 'CREDENTIAL_STORE_UNAVAILABLE'].includes(error.code)
          )
            throw error;
          return false;
        }),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), symmetryWaitMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
