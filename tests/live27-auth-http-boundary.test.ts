/** HTTP认证状态先于响应格式判定；全部使用构造响应，不触碰真实账号。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioClient } from '../studio/api/client.ts';
import { WebMicroClient } from '../studio/api/micro-client.ts';
import { MemoryCredentials, accountReference, type Session } from '../studio/auth/credentials.ts';
import { TripoError } from '../studio/contracts/errors.ts';

const subject = 'live27-http-boundary';
const session = (): Session => ({
  accountRef: accountReference(subject),
  cookie: 'controlled-http-boundary-cookie-not-real',
  bearer: `eyJ0eXAiOiJKV1QifQ.${Buffer.from(JSON.stringify({ sub: subject, exp: Date.now() / 1000 + 3600 })).toString('base64url')}.controlled`,
  deviceId: 'controlled',
  importedAt: '2026-11-16T00:00:00Z',
});
const route = '/v2/studio/user/profile/payment';
const rpc = '/tripo.canvas.api.agent.LabService/GetLabJob';

function fixture(first: () => Response, micro = false) {
  const store = new MemoryCredentials(session());
  const calls = { sends: 0, logins: 0 };
  const client = new StudioClient(
    store,
    async () => {
      calls.sends++;
      return calls.sends === 1
        ? first()
        : Response.json(micro ? { restored: true } : { code: 0, data: { restored: true } });
    },
    undefined,
    async () => {
      calls.logins++;
      store.save({ ...session(), deviceId: 'restored' });
    },
  );
  return { client, calls, micro: new WebMicroClient(client, 'canvas') };
}

for (const micro of [false, true]) {
  test(`${micro ? 'RPC' : 'REST'} non-JSON HTTP 401 restores only the original read once`, async () => {
    for (const body of ['', '<html>private-response-marker</html>', '{bad-json']) {
      const f = fixture(() => new Response(body, { status: 401 }), micro);
      const result = micro
        ? await f.micro.call(rpc, { jobId: 'original' })
        : await f.client.request('GET', route);
      assert.deepEqual(result, { restored: true });
      assert.deepEqual(f.calls, { sends: 2, logins: 1 });
      assert.equal(JSON.stringify(result).includes('private-response-marker'), false);
    }
  });
  test(`${micro ? 'RPC' : 'REST'} forbidden and server errors cannot turn a body authentication code into login`, async () => {
    for (const status of [400, 403, 429, 500]) {
      const body = micro ? { error: { code: 16 } } : { code: 1002 };
      const f = fixture(() => Response.json(body, { status }), micro);
      await assert.rejects(
        micro ? f.micro.call(rpc, {}) : f.client.request('GET', route),
        (error: unknown) => {
          assert.ok(error instanceof TripoError);
          assert.notEqual(error.code, 'AUTH_REQUIRED');
          return true;
        },
      );
      assert.deepEqual(f.calls, { sends: 1, logins: 0 });
    }
  });
  test(`${micro ? 'RPC' : 'REST'} already sent writes with plain HTTP 401 are never replayed`, async () => {
    const f = fixture(() => new Response('private-auth-rejection', { status: 401 }), micro);
    await assert.rejects(
      micro
        ? f.micro.call('/tripo.canvas.api.agent.RunService/Run', { original: true }, true)
        : f.client.request('POST', '/v2/studio/operation/generate', { original: true }, { paid: true }),
      {
        code: 'AUTH_REQUIRED',
        certainty: 'not_submitted',
      },
    );
    assert.deepEqual(f.calls, { sends: 1, logins: 0 });
  });
  test(`${micro ? 'RPC' : 'REST'} non-JSON HTTP 403 remains a permission error without opening login`, async () => {
    const f = fixture(() => new Response('private-access-denied', { status: 403 }), micro);
    await assert.rejects(micro ? f.micro.call(rpc, {}) : f.client.request('GET', route), {
      code: micro ? 'STUDIO_REJECTED' : 'HTTP_ERROR',
    });
    assert.deepEqual(f.calls, { sends: 1, logins: 0 });
  });
}

test('SSE non-JSON 401 retries the original read handshake once after login', async () => {
  const store = new MemoryCredentials(session());
  let sends = 0,
    logins = 0;
  const bodies: string[] = [];
  const client = new StudioClient(
    store,
    async (_url, init) => {
      sends++;
      bodies.push(String(init.body));
      return sends === 1
        ? new Response('', { status: 401 })
        : new Response('data: {}\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          });
    },
    undefined,
    async () => {
      logins++;
      store.save(session());
    },
  );
  const response = await new WebMicroClient(client, 'canvas').stream(
    '/tripo.canvas.api.agent.LabService/SubscribeLabEvents',
    { jobId: 'original' },
    new AbortController().signal,
  );
  assert.equal(await response.text(), 'data: {}\n\n');
  assert.equal(logins, 1);
  assert.deepEqual(bodies, ['{"jobId":"original"}', '{"jobId":"original"}']);
});
