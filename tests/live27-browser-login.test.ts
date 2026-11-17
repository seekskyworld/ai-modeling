/** 浏览器全部为注入的模拟对象；不启动本机浏览器，不读取用户会话。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { Browser, BrowserContext, CDPSession, Page } from 'playwright-core';
import { runBrowserLogin } from '../studio/auth/browser-login.ts';
import { createPlaywrightLoginRuntime, type LoginChromium } from '../studio/auth/browser-login-runtime.ts';
import { loopbackCdpEndpoint } from '../studio/auth/browser-login-cdp.ts';
import type {
  BrowserLoginCookie,
  BrowserLoginOptions,
  BrowserLoginRuntime,
  BrowserLoginWindow,
} from '../studio/auth/browser-login-types.ts';
import { studioLoginUrl, studioSessionUrls } from '../studio/auth/browser-login-types.ts';
import { TripoError } from '../studio/contracts/errors.ts';
import type { Session } from '../studio/auth/credentials.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const fakeCookie = (value = 'live27-controlled-cookie-not-a-real-session'): BrowserLoginCookie => ({
  name: 'ory_kratos_session',
  value,
  domain: '.tripo3d.ai',
  path: '/',
  secure: true,
  expires: -1,
});

class FakeWindow implements BrowserLoginWindow {
  closed = false;
  closes = 0;
  reads = 0;
  navigations = 0;
  values: BrowserLoginCookie[] = [fakeCookie()];
  events = new EventEmitter();
  async navigate(): Promise<void> {
    this.navigations++;
  }
  async cookies(): Promise<BrowserLoginCookie[]> {
    this.reads++;
    return this.values;
  }
  isClosed(): boolean {
    return this.closed;
  }
  onClosed(callback: () => void): () => void {
    this.events.on('closed', callback);
    return () => this.events.off('closed', callback);
  }
  async close(): Promise<void> {
    this.closes++;
    this.closed = true;
  }
  userClose(): void {
    this.closed = true;
    this.events.emit('closed');
  }
}

const runtime = (window: BrowserLoginWindow): BrowserLoginRuntime => ({ open: async () => window });
const options = (overrides: Partial<BrowserLoginOptions> = {}): BrowserLoginOptions => ({
  signal: new AbortController().signal,
  timeoutMs: 1000,
  accept: async () => true,
  ...overrides,
});

test('browser login captures only the observed Studio cookie and completes only after accept', async () => {
  const window = new FakeWindow();
  window.values = [
    { ...fakeCookie(), name: 'unrelated_token' },
    { ...fakeCookie(), domain: '.tripo3d.ai.attacker.invalid' },
    { ...fakeCookie(), domain: '.ai' },
    { ...fakeCookie(), path: '/account-only' },
    { ...fakeCookie(), secure: false },
    { ...fakeCookie(), expires: 1 },
    fakeCookie('invalid\r\nheader'),
    fakeCookie(),
  ];
  const pending = deferred<boolean>();
  const seen = deferred<Session>();
  let waiting = 0;
  let finished = false;
  const task = runBrowserLogin(
    options({
      initialSession: { deviceId: 'existing-device', importedAt: 'old', bearer: 'not-forwarded' },
      onWaiting: () => waiting++,
      accept: async (candidate) => {
        seen.resolve(candidate);
        return await pending.promise;
      },
    }),
    runtime(window),
  ).then(() => {
    finished = true;
  });
  const candidate = await seen.promise;
  assert.equal(candidate.cookie, fakeCookie().value);
  assert.equal(candidate.deviceId, 'existing-device');
  assert.equal(candidate.bearer, undefined);
  assert.equal(finished, false);
  assert.equal(window.closes, 0);
  pending.resolve(true);
  await task;
  assert.equal(waiting, 1);
  assert.equal(window.closes, 1);
  assert.equal(window.events.listenerCount('closed'), 0);
});

test('false candidates continue waiting and repeated cookies are not verified in a busy loop', async () => {
  const window = new FakeWindow();
  window.values.push(fakeCookie());
  let accepted = 0;
  await assert.rejects(
    runBrowserLogin(options({ timeoutMs: 80, accept: async () => (++accepted, false) }), runtime(window)),
    { code: 'LOGIN_TIMEOUT' },
  );
  assert.equal(accepted, 1);
  assert.equal(window.closes, 1);
  const changed = new FakeWindow();
  changed.values.push(fakeCookie('changed-controlled-cookie-1234567890'));
  const values: string[] = [];
  await runBrowserLogin(
    options({ accept: async (candidate) => (values.push(candidate.cookie!), values.length === 2) }),
    runtime(changed),
  );
  assert.equal(values.length, 2);
});

test('closing the login window cancels and cannot succeed on a late verification', async () => {
  const window = new FakeWindow();
  const pending = deferred<boolean>();
  const seen = deferred<void>();
  let saved = false;
  const task = runBrowserLogin(
    options({
      accept: async (_candidate, signal) => {
        seen.resolve();
        const accepted = await pending.promise;
        signal.throwIfAborted();
        saved = accepted;
        return accepted;
      },
    }),
    runtime(window),
  );
  const rejected = assert.rejects(task, { code: 'LOGIN_CANCELLED' });
  await seen.promise;
  window.userClose();
  await rejected;
  pending.resolve(true);
  await delay(0);
  assert.equal(window.closes, 1);
  assert.equal(saved, false);
});

test('abort and deadline bound navigation, cookie reads and verification independently', async () => {
  for (const step of ['navigate', 'cookies', 'accept'] as const) {
    const window = new FakeWindow();
    const never = deferred<never>();
    if (step === 'navigate') window.navigate = () => never.promise;
    if (step === 'cookies') window.cookies = () => never.promise;
    const abort = new AbortController();
    const task = runBrowserLogin(
      options({
        signal: abort.signal,
        timeoutMs: 80,
        ...(step === 'accept' ? { accept: () => never.promise } : {}),
      }),
      runtime(window),
    );
    await assert.rejects(task, { code: 'LOGIN_TIMEOUT' });
    assert.equal(window.closes, 1);
    never.reject(new Error('late-raw-cookie-secret'));
    await delay(0);
  }
});

test('already cancelled and late browser startups are cleaned without starting candidate validation', async () => {
  const abort = new AbortController();
  abort.abort('secret-abort-reason');
  let opened = 0;
  await assert.rejects(
    runBrowserLogin(options({ signal: abort.signal }), { open: async () => (++opened, new FakeWindow()) }),
    { code: 'LOGIN_CANCELLED' },
  );
  assert.equal(opened, 0);
  const opening = deferred<BrowserLoginWindow>();
  const late = new FakeWindow();
  await assert.rejects(runBrowserLogin(options({ timeoutMs: 30 }), { open: () => opening.promise }), {
    code: 'LOGIN_TIMEOUT',
  });
  opening.resolve(late);
  await delay(0);
  assert.equal(late.closes, 1);
});

test('external cancellation while waiting closes the owned window and strips arbitrary reasons', async () => {
  const window = new FakeWindow();
  window.values = [];
  const abort = new AbortController();
  const task = runBrowserLogin(options({ signal: abort.signal }), runtime(window));
  const rejected = assert.rejects(task, (error: unknown) => {
    assert.ok(error instanceof TripoError);
    assert.equal(error.code, 'LOGIN_CANCELLED');
    assert.equal(error.message.includes('private-value'), false);
    return true;
  });
  await delay(0);
  abort.abort(new Error('private-value'));
  await rejected;
  assert.equal(window.closes, 1);
});

test('browser and callback failures never expose raw credentials, CDP URLs or error details', async () => {
  for (const failure of [
    new Error('cookie=private-value ws://127.0.0.1/private-value'),
    new TripoError('HTTP_ERROR', 'private-value', 'read', { cookie: 'private-value' }),
  ]) {
    const window = new FakeWindow();
    await assert.rejects(
      runBrowserLogin(
        options({
          accept: async () => {
            throw failure;
          },
        }),
        runtime(window),
      ),
      (error: unknown) => {
        assert.ok(error instanceof TripoError);
        assert.equal(`${error.message}${JSON.stringify(error.details)}`.includes('private-value'), false);
        return true;
      },
    );
    assert.equal(window.closes, 1);
  }
});

test('login options and CDP endpoints reject unsafe inputs before starting a browser', async () => {
  for (const timeoutMs of [0, -1, Infinity, 1.5, 900001]) {
    await assert.rejects(runBrowserLogin(options({ timeoutMs }), runtime(new FakeWindow())), {
      code: 'INVALID_INPUT',
    });
  }
  await assert.rejects(
    runBrowserLogin(options({ cdpEndpoint: 'http://localhost:9222', executablePath: process.execPath })),
    { code: 'INVALID_INPUT' },
  );
  for (const endpoint of [
    'https://remote.invalid:9222',
    'ws://0.0.0.0:9222',
    'file:///private/session',
    'ws://user:secret@localhost:9222',
    'http://127.0.0.1:9222?token=secret',
    'http://127.0.0.1:9222#secret',
    'chrome',
  ])
    assert.throws(() => loopbackCdpEndpoint(endpoint), { code: 'INVALID_INPUT' });
  assert.equal(loopbackCdpEndpoint('http://localhost:9222').hostname, '127.0.0.1');
  assert.equal(loopbackCdpEndpoint('ws://[::1]:9222/devtools/browser/id').hostname, '[::1]');
});

function facade() {
  const calls: { method: string; options?: unknown }[] = [];
  const page = Object.assign(new EventEmitter(), {
    goto: async (_url: string, options: unknown) => {
      calls.push({ method: 'goto', options });
    },
    url: () => studioLoginUrl,
    isClosed: () => false,
    close: async () => {
      calls.push({ method: 'page.close' });
    },
  }) as unknown as Page;
  const context = {
    newPage: async () => page,
    newCDPSession: async () =>
      ({
        send: async (method: string, options: unknown) => {
          calls.push({ method, options });
          return { cookies: [fakeCookie()] };
        },
      }) as unknown as CDPSession,
    addCookies: async (options: unknown) => {
      calls.push({ method: 'addCookies', options });
    },
    close: async () => {
      calls.push({ method: 'context.close' });
    },
  } as unknown as BrowserContext;
  const browser = Object.assign(new EventEmitter(), {
    newContext: async (options: unknown) => {
      calls.push({ method: 'newContext', options });
      return context;
    },
    contexts: () => [context],
    isConnected: () => true,
    close: async () => {
      calls.push({ method: 'browser.close' });
    },
  }) as unknown as Browser;
  const chromium = {
    launch: async (options: unknown) => {
      calls.push({ method: 'launch', options });
      return browser;
    },
    connectOverCDP: async (_transport: unknown, options: unknown) => {
      calls.push({ method: 'connectOverCDP', options });
      return browser;
    },
  } as unknown as LoginChromium;
  const transport = {
    send: (_message: object) => undefined,
    close: () => {
      calls.push({ method: 'transport.close' });
    },
  };
  return { calls, page, context, browser, chromium, transport };
}

test('managed login launches visible isolated context, optionally seeds verified cookie attributes and cleans it', async () => {
  const fake = facade();
  await runBrowserLogin(
    options({
      executablePath: process.execPath,
      initialSession: { cookie: fakeCookie().value, deviceId: 'saved', importedAt: 'saved' },
    }),
    createPlaywrightLoginRuntime(fake.chromium),
  );
  const launch = fake.calls.find((call) => call.method === 'launch')!.options as Record<string, unknown>;
  assert.equal(launch.headless, false);
  assert.equal(launch.executablePath, process.execPath);
  assert.equal('userDataDir' in launch, false);
  assert.deepEqual(fake.calls.find((call) => call.method === 'newContext')!.options, {
    viewport: null,
    acceptDownloads: false,
  });
  assert.deepEqual(fake.calls.find((call) => call.method === 'addCookies')!.options, [
    {
      name: 'ory_kratos_session',
      value: fakeCookie().value,
      domain: '.tripo3d.ai',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  assert.deepEqual(fake.calls.find((call) => call.method === 'Network.getCookies')!.options, {
    urls: studioSessionUrls,
  });
  assert.equal(fake.calls.filter((call) => call.method === 'context.close').length, 1);
  assert.equal(fake.calls.filter((call) => call.method === 'browser.close').length, 1);
});

test('attached login closes only its new page and transport, leaving browser, context and cookies intact', async () => {
  const fake = facade();
  await runBrowserLogin(
    options({
      cdpEndpoint: 'http://127.0.0.1:9222',
      initialSession: { cookie: fakeCookie().value, deviceId: 'saved', importedAt: 'saved' },
    }),
    createPlaywrightLoginRuntime(fake.chromium, async () => fake.transport),
  );
  assert.deepEqual(fake.calls.find((call) => call.method === 'connectOverCDP')!.options, {
    timeout: 1000,
    noDefaults: true,
  });
  for (const forbidden of ['launch', 'newContext', 'addCookies', 'context.close', 'browser.close'])
    assert.equal(
      fake.calls.some((call) => call.method === forbidden),
      false,
      forbidden,
    );
  assert.equal(fake.calls.filter((call) => call.method === 'page.close').length, 1);
  assert.equal(fake.calls.filter((call) => call.method === 'transport.close').length, 1);
});

test('navigation timeout can continue only after the owned page has committed to Studio', async () => {
  for (const url of [studioLoginUrl, 'about:blank', 'https://unrelated.invalid/']) {
    const fake = facade();
    fake.page.goto = async () => {
      const error = new Error('private-timeout-url');
      error.name = 'TimeoutError';
      throw error;
    };
    fake.page.url = () => url;
    const task = runBrowserLogin(
      options({ executablePath: process.execPath }),
      createPlaywrightLoginRuntime(fake.chromium),
    );
    if (url === studioLoginUrl) await task;
    else await assert.rejects(task, { code: 'BROWSER_LOGIN_FAILED' });
    assert.equal(fake.calls.filter((call) => call.method === 'browser.close').length, 1);
  }
});

test('managed and attached startup failures release their owned resources without closing remote browser', async () => {
  for (const attached of [false, true]) {
    const fake = facade();
    fake.context.newCDPSession = async () => {
      throw new Error('raw-private-failure');
    };
    await assert.rejects(
      runBrowserLogin(
        options(attached ? { cdpEndpoint: 'http://localhost:9222' } : { executablePath: process.execPath }),
        createPlaywrightLoginRuntime(fake.chromium, async () => fake.transport),
      ),
      { code: 'BROWSER_LOGIN_FAILED' },
    );
    assert.equal(
      fake.calls.some((call) => call.method === 'browser.close'),
      !attached,
    );
    assert.equal(
      fake.calls.some((call) => call.method === 'context.close'),
      !attached,
    );
    assert.equal(
      fake.calls.some((call) => call.method === 'transport.close'),
      attached,
    );
    assert.equal(
      fake.calls.some((call) => call.method === 'page.close'),
      true,
    );
  }
});

test('late page creation after cancellation still cleans the new page and never closes an attached browser', async () => {
  for (const attached of [false, true]) {
    const fake = facade();
    const page = deferred<Page>();
    fake.context.newPage = () => page.promise;
    await assert.rejects(
      runBrowserLogin(
        options({
          timeoutMs: 30,
          ...(attached ? { cdpEndpoint: 'http://localhost:9222' } : { executablePath: process.execPath }),
        }),
        createPlaywrightLoginRuntime(fake.chromium, async () => fake.transport),
      ),
      { code: 'LOGIN_TIMEOUT' },
    );
    page.resolve(fake.page);
    await delay(0);
    assert.equal(fake.calls.filter((call) => call.method === 'page.close').length, 1);
    assert.equal(fake.calls.filter((call) => call.method === 'browser.close').length, attached ? 0 : 1);
    assert.equal(fake.calls.filter((call) => call.method === 'context.close').length, attached ? 0 : 1);
    assert.equal(fake.calls.filter((call) => call.method === 'transport.close').length, attached ? 1 : 0);
  }
});
