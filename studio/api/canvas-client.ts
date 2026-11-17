/** Canvas 与资产检索复用网页 RPC 传输，同时保留各自的方法白名单。 */
import type { StudioClient } from './client.ts';
import { WebMicroClient } from './micro-client.ts';
import { TripoError } from '../contracts/errors.ts';
export class CanvasClient extends WebMicroClient {
  constructor(studio: StudioClient) {
    super(studio, 'canvas');
  }
}

/** 多请求的 Canvas 准备/保存链固定起始账号；换号后不能继续使用上一账号的资源。 */
export function bindCanvasAccount(studio: StudioClient): StudioClient {
  const account = studio.credentials.load()?.accountRef;
  if (!account) throw new TripoError('AUTH_REQUIRED', 'A verified Studio account is required for Canvas.');
  return studio.forAccount(account);
}
