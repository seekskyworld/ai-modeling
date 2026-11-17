/** RPC与SSE只在已核实读入口恢复登录；不把任意Get名称或写调用当可重放。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioClient } from '../studio/api/client.ts';
import { WebMicroClient } from '../studio/api/micro-client.ts';
import { MemoryCredentials, accountReference, type Session } from '../studio/auth/credentials.ts';

const subject = 'live27-micro-account';
const account = accountReference(subject);
const read = '/tripo.canvas.api.agent.LabService/GetLabJob';
const write = '/tripo.canvas.api.agent.RunService/Run';
const stream = '/tripo.canvas.api.agent.LabService/SubscribeLabEvents';
function session(label = 'original', user = subject): Session {
  return {
    accountRef: accountReference(user),
    cookie: `controlled-micro-${label}`,
    bearer:
      'eyJ0eXAiOiJKV1QifQ.' +
      Buffer.from(JSON.stringify({ sub: user, exp: Date.now() / 1000 + 3600 })).toString('base64url') +
      '.controlled',
    deviceId: label,
    importedAt: '2026-11-16T00:00:00Z',
  };
}
const denied = () => Response.json({ error: { code: 16 } }, { status: 401 });

test('GetLabJob rereads its original request once after same-account login with fresh RPC headers', async () => {
  const store = new MemoryCredentials(session()),
    bodies: unknown[] = [],
    devices: string[] = [];
  let logins = 0;
  const client = new StudioClient(
    store,
    async (_url, init) => {
      const headers = new Headers(init.headers);
      assert.equal(headers.get('x-micro-method'), read);
      assert.equal(headers.has('cookie'), false);
      bodies.push(JSON.parse(String(init.body)));
      devices.push(headers.get('x-deviceid')!);
      return bodies.length === 1 ? denied() : Response.json({ job: { id: 'original-lab-job' } });
    },
    undefined,
    async (context) => {
      logins++;
      assert.equal(context.expectedAccountRef, account);
      assert.equal(context.phase, 'read_rejected');
      store.save(session('restored'));
    },
  );
  const body = { jobId: 'original-lab-job' };
  assert.deepEqual(await new WebMicroClient(client, 'canvas').call(read, body), {
    job: { id: 'original-lab-job' },
  });
  assert.deepEqual(bodies, [body, body]);
  assert.deepEqual(devices, ['original', 'restored']);
  assert.equal(logins, 1);
});

for (const [method, writes] of [
  [write, true],
  ['/tripo.canvas.api.agent.RunService/GetUnverified', false],
  [read, true],
] as const) {
  test(`${method} write=${writes} is never replayed after sent authentication rejection`, async () => {
    let sends = 0,
      logins = 0;
    const client = new StudioClient(
      new MemoryCredentials(session()),
      async () => {
        sends++;
        return denied();
      },
      undefined,
      async () => {
        logins++;
      },
    );
    await assert.rejects(new WebMicroClient(client, 'canvas').call(method, {}, writes), {
      code: 'AUTH_REQUIRED',
    });
    assert.equal(sends, 1);
    assert.equal(logins, 0);
  });
}

test('RPC login account changes reject before sending the original read again', async () => {
  const store = new MemoryCredentials(session());
  let sends = 0,
    logins = 0;
  const client = new StudioClient(
    store,
    async () => {
      sends++;
      return denied();
    },
    undefined,
    async () => {
      logins++;
      store.save(session('other', 'another-account'));
    },
  );
  await assert.rejects(new WebMicroClient(client, 'canvas').call(read, {}), { code: 'ACCOUNT_MISMATCH' });
  assert.equal(sends, 1);
  assert.equal(logins, 1);
});

test('RPC authentication continuation stops at its second rejection', async () => {
  const store = new MemoryCredentials(session());
  let sends = 0,
    logins = 0;
  const client = new StudioClient(
    store,
    async () => {
      sends++;
      return denied();
    },
    undefined,
    async () => {
      logins++;
      store.save(session('restored'));
    },
  );
  await assert.rejects(new WebMicroClient(client, 'canvas').call(read, {}), { code: 'AUTH_REQUIRED' });
  assert.equal(sends, 2);
  assert.equal(logins, 1);
});

test('GetLabJob transport failure keeps the existing no-retry boundary', async () => {
  let sends = 0,
    logins = 0;
  const client = new StudioClient(
    new MemoryCredentials(session()),
    async () => {
      sends++;
      throw Object.assign(new TypeError('controlled failure'), { cause: { code: 'ECONNRESET' } });
    },
    undefined,
    async () => {
      logins++;
    },
  );
  await assert.rejects(new WebMicroClient(client, 'canvas').call(read, {}), { code: 'NETWORK_ERROR' });
  assert.equal(sends, 1);
  assert.equal(logins, 0);
});

test('the fixed Community read inventory can restore a code-16 rejection once', async () => {
  const store = new MemoryCredentials(session());
  let sends = 0,
    logins = 0;
  const client = new StudioClient(
    store,
    async () => {
      sends++;
      return sends === 1
        ? Response.json({ error: { code: 16 } })
        : Response.json({ item: { id: 'same-item' } });
    },
    undefined,
    async () => {
      logins++;
      store.save(session('restored'));
    },
  );
  assert.deepEqual(
    await new WebMicroClient(client, 'community').call(
      '/tripo.community.api.content.ContentService/GetItem',
      { id: 'same-item' },
    ),
    { item: { id: 'same-item' } },
  );
  assert.equal(sends, 2);
  assert.equal(logins, 1);
});

test('SSE retries only the rejected handshake and returns the original requested subscription', async () => {
  const store = new MemoryCredentials(session()),
    bodies: unknown[] = [];
  let logins = 0;
  const client = new StudioClient(
    store,
    async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return bodies.length === 1
        ? denied()
        : new Response('event: update\ndata: {}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    },
    undefined,
    async () => {
      logins++;
      store.save(session('restored'));
    },
  );
  const response = await new WebMicroClient(client, 'canvas').stream(
    stream,
    { jobId: 'original' },
    new AbortController().signal,
  );
  assert.match(await response.text(), /event: update/);
  assert.deepEqual(bodies, [{ jobId: 'original' }, { jobId: 'original' }]);
  assert.equal(logins, 1);
});

test('SSE cancellation while login is pending prevents a second handshake', async () => {
  const store = new MemoryCredentials(session()),
    controller = new AbortController();
  let sends = 0;
  const client = new StudioClient(
    store,
    async () => {
      sends++;
      return denied();
    },
    undefined,
    async () => {
      store.save(session('restored'));
      controller.abort(new Error('controlled cancellation'));
    },
  );
  await assert.rejects(
    new WebMicroClient(client, 'canvas').stream(stream, {}, controller.signal),
    /controlled cancellation/,
  );
  assert.equal(sends, 1);
});
