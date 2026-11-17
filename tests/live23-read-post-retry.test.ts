/** 仅两个精确已证只读POST可传输重试；其它动作及响应/会话变化绝不重放。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { StudioClient, type Fetcher } from '../studio/api/client.ts';
import { WebMicroClient } from '../studio/api/micro-client.ts';
import { MemoryCredentials, accountReference, type Session } from '../studio/auth/credentials.ts';
import { object, TripoError } from '../studio/contracts/errors.ts';

const download = '/v2/studio/operation/download_with_name';
const canvas = '/tripo.canvas.api.agent.CanvasService/GetCanvas';
const subject = 'controlled-read-post-account';
const jwt = (seconds = 3600, sub = subject): string =>
  `header.${Buffer.from(JSON.stringify({ sub, exp: Date.now() / 1000 + seconds })).toString('base64url')}.fixture`;
const saved = (): Session => ({
  cookie: 'controlled-read-post-cookie',
  bearer: jwt(),
  accountRef: accountReference(subject),
  deviceId: 'controlled-read-post-device',
  importedAt: '2026-11-15T00:00:00Z',
});
const transportFailure = () => new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
const kinds = ['rest', 'rpc'] as const;
type Kind = (typeof kinds)[number];
function client(kind: Kind, fetcher: Fetcher, store = new MemoryCredentials(saved())) {
  const studio = new StudioClient(store, fetcher);
  const micro = new WebMicroClient(studio, 'canvas');
  const body =
    kind === 'rest'
      ? { project_id: 'exact-project', operator_id: 'exact-operator', format: 'glb' }
      : { canvasId: 'exact-canvas' };
  return {
    store,
    body,
    studio,
    micro,
    call: () => (kind === 'rest' ? studio.request('POST', download, body) : micro.call(canvas, body)),
  };
}
const success = (kind: Kind) =>
  kind === 'rest'
    ? Response.json({ code: 0, data: { url: 'https://example.invalid/exact-original' } })
    : Response.json({ error: { code: 0 }, canvas: { canvasId: 'exact-canvas', revision: '7' } });

for (const kind of kinds) {
  test(`${kind}: the exact readonly POST recovers third attempt with frozen payload, headers and timeout`, async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = client(kind, async (url, init) => {
      calls.push({ url, init });
      if (calls.length === 1) Object.assign(f.body, { changed_after_serialization: true });
      if (calls.length < 3) throw transportFailure();
      return success(kind);
    });
    const result = object(await f.call());
    assert.ok(kind === 'rest' ? result.url : result.canvas);
    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.equal(
        call.url,
        kind === 'rest' ? 'https://api.tripo3d.ai' + download : 'https://msapi.tripo3d.ai/ms/web/api',
      );
      assert.equal(call.init.method, 'POST');
      assert.equal(call.init.redirect, 'error');
      assert.equal(call.init.body, calls[0]!.init.body);
      assert.equal(JSON.parse(String(call.init.body)).changed_after_serialization, undefined);
      assert.deepEqual(call.init.headers, calls[0]!.init.headers);
      assert.equal(call.init.signal, calls[0]!.init.signal);
      if (kind === 'rpc') assert.equal(object(call.init.headers)['x-micro-method'], canvas);
    }
  });

  test(`${kind}: a persistent transport failure stops after three readonly attempts`, async () => {
    let calls = 0;
    const f = client(kind, async () => {
      calls++;
      throw transportFailure();
    });
    await assert.rejects(f.call(), { code: 'NETWORK_ERROR', certainty: 'read' });
    assert.equal(calls, 3);
  });

  test(`${kind}: redirect, unknown, local and mixed transport/business exceptions are not retried`, async () => {
    const errors = [
      new TypeError('fetch failed'),
      new TypeError('fetch failed', { cause: new Error('unexpected redirect') }),
      new Error('HTTP exception', { cause: { code: 'ECONNRESET', statusCode: 503 } }),
      new TypeError('Invalid URL', { cause: { code: 'ERR_INVALID_URL' } }),
      new TripoError('ACCOUNT_MISMATCH', 'changed identity'),
      new AggregateError([transportFailure(), new Error('business failure')]),
      new DOMException('abort', 'AbortError'),
    ];
    for (const error of errors) {
      let calls = 0;
      const f = client(kind, async () => {
        calls++;
        throw error;
      });
      await assert.rejects(f.call(), { code: 'NETWORK_ERROR', certainty: 'read' });
      assert.equal(calls, 1);
    }
  });

  test(`${kind}: every obtained HTTP response is decoded once without retrying status or body errors`, async () => {
    const responses = [
      () => Response.json({}, { status: 401 }),
      () => Response.json({}, { status: 403 }),
      () => Response.json({}, { status: 429 }),
      () => Response.json({}, { status: 500 }),
      () => Response.json({}, { status: 503 }),
      () => Response.json(kind === 'rest' ? { code: 2010 } : { error: { code: 5411 } }),
      () => new Response('not-json', { status: 200 }),
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(transportFailure());
            },
          }),
        ),
    ];
    for (const response of responses) {
      let calls = 0;
      const f = client(kind, async () => {
        calls++;
        return response();
      });
      await assert.rejects(f.call());
      assert.equal(calls, 1);
    }
    let calls = 0;
    const f = client(kind, async () => {
      if (++calls === 1) throw transportFailure();
      return Response.json({}, { status: 503 });
    });
    await assert.rejects(f.call(), { code: 'UPSTREAM_ERROR', certainty: 'read' });
    assert.equal(calls, 2);
  });

  test(`${kind}: account, logout, cookie, token and device replacements abort before a retry`, async () => {
    for (const replacement of ['account', 'logout', 'cookie', 'bearer', 'device', 'in-place'] as const) {
      const original = saved(),
        store = new MemoryCredentials(original);
      let calls = 0;
      const f = client(
        kind,
        async () => {
          calls++;
          if (replacement === 'logout') store.clear();
          else if (replacement === 'in-place') store.load()!.cookie = 'changed-in-place';
          else
            store.save({
              ...original,
              ...(replacement === 'account' ? { accountRef: 'other-account' } : {}),
              ...(replacement === 'cookie' ? { cookie: 'other-cookie' } : {}),
              ...(replacement === 'bearer' ? { bearer: jwt(7200) } : {}),
              ...(replacement === 'device' ? { deviceId: 'other-device' } : {}),
            });
          throw transportFailure();
        },
        store,
      );
      await assert.rejects(f.call(), {
        code: ['account', 'logout'].includes(replacement) ? 'ACCOUNT_MISMATCH' : 'SESSION_CHANGED',
      });
      assert.equal(calls, 1);
    }
  });

  test(`${kind}: credential refresh happens once before bounded business retries`, async () => {
    const store = new MemoryCredentials({ ...saved(), bearer: jwt(-30) });
    let refreshes = 0,
      business = 0;
    const f = client(
      kind,
      async (url, init) => {
        if (url.includes('/whoami')) {
          refreshes++;
          return Response.json({ tokenized: jwt() });
        }
        business++;
        const headers = object(init.headers);
        assert.equal(
          kind === 'rest' ? headers.authorization : headers['x-auth-token'],
          (kind === 'rest' ? 'Bearer ' : '') + store.load()!.bearer,
        );
        if (business === 1) throw transportFailure();
        return success(kind);
      },
      store,
    );
    await f.call();
    assert.equal(refreshes, 1);
    assert.equal(business, 2);
  });
}

test('REST permission is an exact method/path pair and never permits paid or other POST requests', async () => {
  const cases = [
    { method: 'POST', route: download, paid: true },
    { method: 'DELETE', route: download, paid: false },
    { method: 'POST', route: download + '/', paid: false },
    { method: 'POST', route: download + '?mode=other', paid: false },
    { method: 'POST', route: '/v2/studio/operation/export', paid: false },
    { method: 'POST', route: '/v2/studio/operation/export_lite', paid: false },
    { method: 'POST', route: '/v2/studio/image/get_image_asset', paid: false },
    { method: 'POST', route: '/v2/studio/operation/download_with_name_extra', paid: false },
  ] as const;
  for (const row of cases) {
    let calls = 0;
    const studio = new StudioClient(new MemoryCredentials(saved()), async () => {
      calls++;
      throw transportFailure();
    });
    await assert.rejects(studio.request(row.method, row.route, {}, { paid: row.paid }), {
      code: 'NETWORK_ERROR',
      certainty: row.paid ? 'unknown' : 'read',
    });
    assert.equal(calls, 1, row.route);
  }
});

test('RPC permission is exact CanvasService/GetCanvas, not Get prefix, write=false or community reads', async () => {
  const cases = [
    { namespace: 'canvas', method: canvas, write: true },
    { namespace: 'canvas', method: '/tripo.canvas.api.agent.CanvasService/GetCanvasDetail', write: false },
    { namespace: 'canvas', method: '/tripo.canvas.api.agent.OtherService/GetCanvas', write: false },
    { namespace: 'canvas', method: '/tripo.canvas.api.agent.CanvasService/SaveCanvas', write: false },
    { namespace: 'canvas', method: '/tripo.canvas.api.agent.CanvasService/RunAgent', write: false },
    { namespace: 'canvas', method: '/tripo.canvas.api.agent.LabService/RunLab', write: true },
    { namespace: 'canvas', method: '/tripo.canvas.api.agent.CanvasService/ListNodesAssets', write: false },
    { namespace: 'community', method: '/tripo.community.api.content.ContentService/GetItem', write: false },
  ] as const;
  for (const row of cases) {
    let calls = 0;
    const studio = new StudioClient(new MemoryCredentials(saved()), async () => {
      calls++;
      throw transportFailure();
    });
    await assert.rejects(new WebMicroClient(studio, row.namespace).call(row.method, {}, row.write), {
      code: 'NETWORK_ERROR',
      certainty: row.write ? 'unknown' : 'read',
    });
    assert.equal(calls, 1, row.method);
  }
});

test('REST readonly POST attempts share the original total timeout and stop during its second transfer', async () => {
  const signals: AbortSignal[] = [];
  const f = client('rest', async (_url, init) => {
    signals.push(init.signal!);
    if (signals.length === 1) throw transportFailure();
    await delay(3000, undefined, { signal: init.signal! });
    assert.fail('Original total timeout must end the second transfer');
  });
  const start = performance.now();
  await assert.rejects(f.studio.request('POST', download, f.body, { timeoutMs: 230 }), {
    code: 'NETWORK_ERROR',
    certainty: 'read',
  });
  assert.equal(signals.length, 2);
  assert.equal(signals[0], signals[1]);
  assert.equal(signals[1]!.aborted, true);
  assert.ok(performance.now() - start < 1000);
});

test('RPC readonly POST keeps one 65000ms signal budget instead of renewing it on each attempt', async (t) => {
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal),
    budgets: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    budgets.push(ms);
    return nativeTimeout(230);
  });
  const signals: AbortSignal[] = [];
  const f = client('rpc', async (_url, init) => {
    signals.push(init.signal!);
    if (signals.length === 1) throw transportFailure();
    await delay(3000, undefined, { signal: init.signal! });
    assert.fail('The same original signal must cancel the second attempt');
  });
  await assert.rejects(f.call(), { code: 'NETWORK_ERROR', certainty: 'read' });
  assert.deepEqual(budgets, [65000]);
  assert.equal(signals.length, 2);
  assert.equal(signals[0], signals[1]);
  assert.equal(signals[1]!.aborted, true);
});

test('RPC event subscriptions are never included in automatic readonly retries', async () => {
  let calls = 0;
  const studio = new StudioClient(new MemoryCredentials(saved()), async () => {
    calls++;
    throw transportFailure();
  });
  const rpc = new WebMicroClient(studio, 'canvas');
  await assert.rejects(
    rpc.stream('/tripo.canvas.api.agent.CanvasService/SubscribeAgentEvents', {}, AbortSignal.timeout(1000)),
    {
      code: 'NETWORK_ERROR',
      certainty: 'read',
    },
  );
  assert.equal(calls, 1);
});

test('RPC credential replacement before its first request is known not submitted, including writes', async () => {
  for (const write of [false, true]) {
    const store = new MemoryCredentials(saved()),
      load = store.load.bind(store);
    let loads = 0,
      requests = 0;
    store.load = () => {
      if (++loads === 3) store.save({ ...load()!, cookie: 'replaced-before-first-request' });
      return load();
    };
    const f = client(
      'rpc',
      async () => {
        requests++;
        return success('rpc');
      },
      store,
    );
    await assert.rejects(
      f.micro.call(write ? '/tripo.canvas.api.agent.CanvasService/SaveCanvas' : canvas, f.body, write),
      {
        code: 'SESSION_CHANGED',
        certainty: 'not_submitted',
      },
    );
    assert.equal(requests, 0);
  }
});
