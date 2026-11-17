/** 浏览器适配器只交换内存候选，便于隔离测试且不依赖 Agent 宿主浏览器。 */
import type { Session } from './credentials.ts';

export interface BrowserLoginOptions {
  signal: AbortSignal;
  timeoutMs: number;
  onWaiting?: () => void;
  /** 保存前再次检查此 signal；窗口关闭也会取消，不能只检查调用方的原 signal。 */
  accept: (candidate: Session, signal: AbortSignal) => Promise<boolean>;
  executablePath?: string;
  cdpEndpoint?: string;
  initialSession?: Session;
}

export interface BrowserLoginCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  expires: number;
}

export interface BrowserLoginWindow {
  navigate(timeoutMs: number): Promise<void>;
  cookies(): Promise<BrowserLoginCookie[]>;
  isClosed(): boolean;
  onClosed(callback: () => void): () => void;
  close(): Promise<void>;
}

export interface BrowserLoginRuntime {
  open(options: Omit<BrowserLoginOptions, 'accept' | 'onWaiting'>): Promise<BrowserLoginWindow>;
}

export const studioLoginUrl = 'https://studio.tripo3d.ai/';
export const studioSessionUrls = [
  studioLoginUrl,
  'https://api.tripo3d.ai/v2/studio/studio/whoami?tokenizeAs=default_jwt',
];

/** 清理不能令已取消的登录无限等待；迟到的关闭仍由适配器继续完成。 */
export async function boundedCleanup(work: Promise<unknown>, timeoutMs = 2000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
