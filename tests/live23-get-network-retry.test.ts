/** 幂等读取短暂断网可恢复；所有写入、HTTP错误和原账号边界仍只接受原语义。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { MemoryCredentials, accountReference, type Session } from '../studio/auth/credentials.ts';
import { StudioClient, type RequestOptions } from '../studio/api/client.ts';
import { object, TripoError } from '../studio/contracts/errors.ts';

const route = '/v2/studio/project/detail/v3/exact-project?operator_id=exact-version';
const session = (): Session => ({
  cookie: 'controlled-read-retry-cookie',
  accountRef: 'controlled-read-retry-account',
  deviceId: 'controlled-read-retry-device',
  importedAt: '2026-11-15T00:00:00Z',
});
const networkFailure = () => new TypeError('controlled fetch failure', { cause: { code: 'ECONNRESET' } });

test('an exact GET recovers on its third transport attempt with the same headers and timeout signal', async () => {
  const store = new MemoryCredentials(session()),
    calls: Array<{ url: string; init: RequestInit }> = [];
  const client = new StudioClient(store, async (url, init) => {
    calls.push({ url, init });
    if (calls.length < 3) throw networkFailure();
    return Response.json({ code: 0, data: { project: 'exact-project', operator: 'exact-version' } });
  });
  assert.deepEqual(await client.request('GET', route), {
    project: 'exact-project',
    operator: 'exact-version',
  });
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.url, 'https://api.tripo3d.ai' + route);
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.body, undefined);
    assert.deepEqual(call.init.headers, calls[0]!.init.headers);
    assert.equal(call.init.signal, calls[0]!.init.signal);
  }
});

test('persistent GET transport failure stops after three attempts with the original read certainty', async () => {
  let calls = 0;
  const client = new StudioClient(new MemoryCredentials(session()), async () => {
    calls++;
    throw networkFailure();
  });
  await assert.rejects(client.request('GET', route), { code: 'NETWORK_ERROR', certainty: 'read' });
  assert.equal(calls, 3);
});

test('transport aggregates retry, while unknown, redirect, local, HTTP and business rejections do not', async () => {
  const errors = [
    { error: new TypeError('fetch failed'), attempts: 1 },
    { error: new TypeError('fetch failed', { cause: new Error('unexpected redirect') }), attempts: 1 },
    { error: new TypeError('Invalid URL', { cause: { code: 'ERR_INVALID_URL' } }), attempts: 1 },
    { error: new DOMException('The request was aborted', 'AbortError'), attempts: 1 },
    { error: new TripoError('ACCOUNT_MISMATCH', 'changed identity'), attempts: 1 },
    { error: new Error('fetch failed', { cause: { code: 'ECONNRESET', statusCode: 502 } }), attempts: 1 },
    { error: new AggregateError([networkFailure(), new Error('local failure')]), attempts: 1 },
    { error: new AggregateError([], 'empty aggregate'), attempts: 1 },
    {
      error: new TypeError('fetch failed', {
        cause: new AggregateError([networkFailure(), networkFailure()]),
      }),
      attempts: 3,
    },
  ];
  for (const row of errors) {
    let calls = 0;
    const client = new StudioClient(new MemoryCredentials(session()), async () => {
      calls++;
      throw row.error;
    });
    await assert.rejects(client.request('GET', route), { code: 'NETWORK_ERROR', certainty: 'read' });
    assert.equal(calls, row.attempts, row.error.message);
  }
});

test('POST, DELETE and any paid request never retry a transport failure', async () => {
  const cases: Array<{ method: 'GET' | 'POST' | 'DELETE'; options: RequestOptions }> = [
    { method: 'POST', options: {} },
    { method: 'DELETE', options: {} },
    { method: 'POST', options: { paid: true } },
    { method: 'DELETE', options: { paid: true } },
    { method: 'GET', options: { paid: true } },
  ];
  for (const row of cases) {
    let calls = 0;
    const client = new StudioClient(new MemoryCredentials(session()), async () => {
      calls++;
      throw networkFailure();
    });
    await assert.rejects(client.request(row.method, route, undefined, row.options), {
      code: 'NETWORK_ERROR',
      certainty: row.options.paid ? 'unknown' : 'read',
    });
    assert.equal(calls, 1);
  }
});

test('HTTP auth, permission, rate, server and contract errors are not transport retries', async () => {
  const cases = [
    { status: 401, body: { code: 1002 }, code: 'AUTH_REQUIRED' },
    { status: 403, body: { code: 6102 }, code: 'PLAN_REQUIRED' },
    { status: 403, body: {}, code: 'HTTP_ERROR' },
    { status: 429, body: {}, code: 'RATE_LIMITED' },
    { status: 500, body: {}, code: 'UPSTREAM_ERROR' },
    { status: 503, body: {}, code: 'UPSTREAM_ERROR' },
    { status: 200, body: { code: 2010 }, code: 'INSUFFICIENT_CREDITS' },
  ];
  for (const row of cases) {
    let calls = 0;
    const client = new StudioClient(new MemoryCredentials(session()), async () => {
      calls++;
      return Response.json(row.body, { status: row.status });
    });
    await assert.rejects(client.request('GET', route), { code: row.code });
    assert.equal(calls, 1);
  }
});

test('malformed JSON and a failed response body are not retried after HTTP headers arrive', async () => {
  for (const response of [
    () => new Response('<html>not JSON</html>', { status: 200 }),
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(networkFailure());
          },
        }),
      ),
  ]) {
    let calls = 0;
    const client = new StudioClient(new MemoryCredentials(session()), async () => {
      calls++;
      return response();
    });
    await assert.rejects(client.request('GET', route), { code: 'CONTRACT_CHANGED', certainty: 'read' });
    assert.equal(calls, 1);
  }
});

test('a recovered transport followed by HTTP 429 stops at that response', async () => {
  let calls = 0;
  const client = new StudioClient(new MemoryCredentials(session()), async () => {
    if (++calls === 1) throw networkFailure();
    return Response.json({}, { status: 429 });
  });
  await assert.rejects(client.request('GET', route), { code: 'RATE_LIMITED', certainty: 'read' });
  assert.equal(calls, 2);
});

test('all attempts share the original total timeout, including backoff and the next transfer', async () => {
  const signals: AbortSignal[] = [];
  const client = new StudioClient(new MemoryCredentials(session()), async (_url, init) => {
    signals.push(init.signal!);
    if (signals.length === 1) throw networkFailure();
    await delay(3000, undefined, { signal: init.signal! });
    assert.fail('Shared timeout should cancel the second transfer');
  });
  const before = performance.now();
  await assert.rejects(client.request('GET', route, undefined, { timeoutMs: 230 }), {
    code: 'NETWORK_ERROR',
    certainty: 'read',
  });
  const elapsed = performance.now() - before;
  assert.equal(signals.length, 2);
  assert.equal(signals[0], signals[1]);
  assert.equal(signals[1]!.aborted, true);
  assert.ok(elapsed >= 200 && elapsed < 1000);
});

test('an exhausted first-transfer budget and an insufficient backoff budget do not start another GET', async () => {
  for (const exhaust of [false, true]) {
    let calls = 0;
    const client = new StudioClient(new MemoryCredentials(session()), async (_url, init) => {
      calls++;
      if (exhaust) await delay(3000, undefined, { signal: init.signal! });
      throw networkFailure();
    });
    await assert.rejects(client.request('GET', route, undefined, { timeoutMs: 60 }), {
      code: 'NETWORK_ERROR',
      certainty: 'read',
    });
    assert.equal(calls, 1);
  }
});

test('account changes, logout and replacement credentials stop before a retry with stale headers', async () => {
  for (const action of ['account', 'logout', 'cookie', 'mutate-cookie'] as const) {
    const original = session(),
      store = new MemoryCredentials(original);
    let calls = 0;
    const client = new StudioClient(store, async () => {
      calls++;
      if (action === 'logout') store.clear();
      else if (action === 'mutate-cookie') store.load()!.cookie = 'changed-in-place';
      else
        store.save({
          ...original,
          ...(action === 'account' ? { accountRef: 'another-account' } : { cookie: 'new-session-cookie' }),
        });
      throw networkFailure();
    });
    await assert.rejects(client.request('GET', route), {
      code: ['account', 'logout'].includes(action) ? 'ACCOUNT_MISMATCH' : 'SESSION_CHANGED',
    });
    assert.equal(calls, 1);
  }
});

test('bearer refresh occurs once before business GET retries; paid submission still happens once', async () => {
  const subject = 'retry-subject';
  const jwt = (seconds: number) =>
    `header.${Buffer.from(JSON.stringify({ sub: subject, exp: Date.now() / 1000 + seconds })).toString('base64url')}.fixture`;
  for (const paid of [false, true]) {
    const store = new MemoryCredentials({
      ...session(),
      accountRef: accountReference(subject),
      bearer: jwt(-30),
    });
    let refreshes = 0,
      business = 0;
    const client = new StudioClient(store, async (url, init) => {
      if (url.includes('/whoami')) {
        refreshes++;
        return Response.json({ tokenized: jwt(3600) });
      }
      business++;
      assert.equal(object(init.headers).authorization, `Bearer ${store.load()!.bearer}`);
      if (business < 2) throw networkFailure();
      return Response.json({ code: 0, data: { okay: true } });
    });
    if (paid)
      await assert.rejects(client.request('POST', route, {}, { paid: true }), {
        code: 'NETWORK_ERROR',
        certainty: 'unknown',
      });
    else assert.deepEqual(await client.request('GET', route), { okay: true });
    assert.equal(refreshes, 1);
    assert.equal(business, paid ? 1 : 2);
  }
});
