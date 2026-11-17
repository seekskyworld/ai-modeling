/** 独立可见 Chrome/Edge 为默认入口；既有浏览器只通过显式 loopback CDP 连接。 */
import type { Browser, BrowserContext, CDPSession, ConnectOverCDPTransport, Page } from 'playwright-core';
import { parseCredential } from './credentials.ts';
import { connectLocalCdpTransport, loopbackCdpEndpoint } from './browser-login-cdp.ts';
import { installedBrowser } from './browser-discovery.ts';
import {
  boundedCleanup,
  studioLoginUrl,
  studioSessionUrls,
  type BrowserLoginRuntime,
  type BrowserLoginWindow,
} from './browser-login-types.ts';

/** 种入仅在内存中的自有上下文；属性对应 Studio 的会话 Cookie。 */
async function seedOwnedContext(
  context: BrowserContext,
  options: Parameters<BrowserLoginRuntime['open']>[0],
) {
  if (!options.initialSession?.cookie) return;
  const parsed = parseCredential(JSON.stringify({ cookie: options.initialSession.cookie }));
  await context.addCookies([
    {
      name: 'ory_kratos_session',
      value: parsed.cookie!,
      domain: '.tripo3d.ai',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
}

/** 可注入 Playwright facade，测试清理协议时无需启动真实用户浏览器。 */
export type LoginChromium = Pick<(typeof import('playwright-core'))['chromium'], 'launch' | 'connectOverCDP'>;
export function createPlaywrightLoginRuntime(
  chromium?: LoginChromium,
  transportFactory = connectLocalCdpTransport,
): BrowserLoginRuntime {
  return {
    open: async (options): Promise<BrowserLoginWindow> => {
      if (options.cdpEndpoint) loopbackCdpEndpoint(options.cdpEndpoint);
      const owned = !options.cdpEndpoint;
      const engine = chromium ?? (await import('playwright-core')).chromium;
      let browser: Browser | undefined;
      let context: BrowserContext | undefined;
      let page: Page | undefined;
      let transport: ConnectOverCDPTransport | undefined;
      const cleanup = async () => {
        const resources = { browser, context, page, transport };
        browser = undefined;
        context = undefined;
        page = undefined;
        transport = undefined;
        if (owned) {
          if (resources.page)
            await boundedCleanup(
              Promise.resolve().then(() => resources.page!.close()),
              500,
            );
          if (resources.context)
            await boundedCleanup(
              Promise.resolve().then(() => resources.context!.close()),
              500,
            );
          if (resources.browser)
            await boundedCleanup(
              Promise.resolve().then(() => resources.browser!.close()),
              1000,
            );
        } else {
          // 只关闭本次 newPage，禁止 context.close / browser.close 影响用户页面。
          try {
            if (resources.page)
              await boundedCleanup(
                Promise.resolve().then(() => resources.page!.close()),
                500,
              );
          } finally {
            try {
              resources.transport?.close();
            } catch {
              /* 连接已经断开时，无需重试终止用户的浏览器。 */
            }
          }
        }
      };
      const aborted = () => void cleanup().catch(() => undefined);
      options.signal.addEventListener('abort', aborted, { once: true });
      try {
        options.signal.throwIfAborted();
        if (owned) {
          browser = await engine.launch({
            executablePath: installedBrowser(options.executablePath),
            headless: false,
            timeout: Math.min(options.timeoutMs, 30000),
            handleSIGINT: false,
            handleSIGHUP: false,
            handleSIGTERM: false,
          });
          options.signal.throwIfAborted();
          context = await browser.newContext({ viewport: null, acceptDownloads: false });
          options.signal.throwIfAborted();
          await seedOwnedContext(context, options);
        } else {
          transport = await transportFactory(options.cdpEndpoint!, options.signal, options.timeoutMs);
          options.signal.throwIfAborted();
          browser = await engine.connectOverCDP(transport, {
            timeout: Math.min(options.timeoutMs, 30000),
            noDefaults: true,
          });
          options.signal.throwIfAborted();
          context = browser.contexts()[0];
          if (!context) throw new Error('The attached browser has no default context.');
        }
        options.signal.throwIfAborted();
        page = await context.newPage();
        options.signal.throwIfAborted();
        const connection = await context.newCDPSession(page);
        options.signal.throwIfAborted();
        return windowHandle(browser, page, connection, async () => {
          options.signal.removeEventListener('abort', aborted);
          await cleanup();
        });
      } catch (error) {
        options.signal.removeEventListener('abort', aborted);
        await cleanup();
        throw error;
      }
    },
  };
}

function windowHandle(
  browser: Browser,
  page: Page,
  session: CDPSession,
  close: () => Promise<void>,
): BrowserLoginWindow {
  return {
    navigate: async (timeoutMs) => {
      try {
        await page.goto(studioLoginUrl, { waitUntil: 'commit', timeout: timeoutMs });
      } catch (error) {
        // 广告/静态资源未加载完成不等于登录失败；只有已提交到本站的页面才可继续等候。
        if (
          !(error instanceof Error && error.name === 'TimeoutError') ||
          page.isClosed() ||
          new URL(page.url()).origin !== new URL(studioLoginUrl).origin
        )
          throw error;
      }
    },
    // Network.getCookies 带确切 URL，不能改成读取整个用户浏览器的 storageState/getAllCookies。
    cookies: async () => (await session.send('Network.getCookies', { urls: studioSessionUrls })).cookies,
    isClosed: () => page.isClosed() || !browser.isConnected(),
    onClosed: (callback) => {
      page.on('close', callback);
      browser.on('disconnected', callback);
      return () => {
        page.off('close', callback);
        browser.off('disconnected', callback);
      };
    },
    close,
  };
}

export const playwrightLoginRuntime = createPlaywrightLoginRuntime();
