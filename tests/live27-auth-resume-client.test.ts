/** 登录接续仅用内存凭据与受控HTTP；不打开真实浏览器、凭据文件或生产任务库。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioClient, type AuthenticationHandler } from '../studio/api/client.ts';
import { MemoryCredentials, accountReference, type Session } from '../studio/auth/credentials.ts';
import { TripoError } from '../studio/contracts/errors.ts';

const subject = 'live27-auth-resume-account';
const account = accountReference(subject);
const origin = 'https://api.tripo3d.ai';
const readRoute = '/v2/studio/user/profile/payment';
const writeRoute = '/v2/studio/operation/export';
const token = (seconds = 3600) =>
  'eyJ0eXAiOiJKV1QifQ.' +
  Buffer.from(JSON.stringify({ sub: subject, exp: Date.now() / 1000 + seconds })).toString('base64url') +
  '.controlled';
function session(label = 'original', bearer?: string): Session {
  return {
    accountRef: account,
    cookie: `controlled-live27-cookie-${label}`,
    deviceId: `controlled-device-${label}`,
    importedAt: '2026-11-16T00:00:00Z',
    ...(bearer ? { bearer } : {}),
  };
}
const accepted = () => Response.json({ code: 0, data: { accepted: true } });
const rejected = () => Response.json({ code: 1002 }, { status: 401 });

test('missing credentials invoke login before one paid request and preserve its final submission guard', async () => {
  const store = new MemoryCredentials(),
    events: string[] = [];
  const login: AuthenticationHandler = async (context) => {
    assert.equal(context.phase, 'before_request');
    assert.equal(context.error.code, 'AUTH_REQUIRED');
    assert.equal(context.expectedAccountRef, undefined);
    events.push('login');
    store.save(session('restored'));
  };
  const client = new StudioClient(
    store,
    async (_url, init) => {
      events.push('paid-post');
      assert.equal(init.method, 'POST');
      assert.equal(new Headers(init.headers).get('x-tripo-device-id'), 'controlled-device-restored');
      return accepted();
    },
    origin,
    login,
  );
  assert.deepEqual(
    await client.request(
      'POST',
      writeRoute,
      { marker: 'same-input' },
      {
        paid: true,
        beforeSend: () => events.push('final-guard'),
      },
    ),
    { accepted: true },
  );
  assert.deepEqual(events, ['login', 'final-guard', 'paid-post']);
});

test('expired-session whoami rejection calls login once outside refresh CAS before the original paid operation', async () => {
  const store = new MemoryCredentials(session('expired', token(-60)));
  let logins = 0,
    whoami = 0,
    paid = 0;
  const client = new StudioClient(
    store,
    async (url, init) => {
      if (url.includes('/whoami')) {
        whoami++;
        return rejected();
      }
      paid++;
      assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${store.load()!.bearer}`);
      assert.equal(new Headers(init.headers).get('x-tripo-device-id'), 'controlled-device-restored');
      return accepted();
    },
    origin,
    async (context) => {
      logins++;
      assert.equal(context.phase, 'before_request');
      assert.equal(context.expectedAccountRef, account);
      store.save(session('restored', token()));
    },
  );
  await client.request('POST', writeRoute, {}, { paid: true });
  assert.equal(logins, 1);
  assert.equal(whoami, 1);
  assert.equal(paid, 1);
});

test('a missing bound account may restore only that account before the original request', async () => {
  const store = new MemoryCredentials();
  let logins = 0,
    requests = 0;
  const client = new StudioClient(
    store,
    async () => {
      requests++;
      return accepted();
    },
    origin,
    async (context) => {
      logins++;
      assert.equal(context.expectedAccountRef, account);
      store.save(session('restored'));
    },
  ).forAccount(account);
  await client.request('GET', readRoute);
  assert.equal(logins, 1);
  assert.equal(requests, 1);
});

test('an already different bound account is rejected without replacing its session or starting login', async () => {
  const other = { ...session(), accountRef: accountReference('other-account') };
  const store = new MemoryCredentials(other);
  let logins = 0,
    requests = 0;
  const client = new StudioClient(
    store,
    async () => {
      requests++;
      return accepted();
    },
    origin,
    async () => {
      logins++;
    },
  ).forAccount(account);
  await assert.rejects(client.request('GET', readRoute), { code: 'ACCOUNT_MISMATCH' });
  assert.equal(logins, 0);
  assert.equal(requests, 0);
  assert.deepEqual(store.load(), other);
});

test('a protected GET rejection is reread once with fresh headers and the frozen account', async () => {
  const store = new MemoryCredentials(session());
  const devices: (string | null)[] = [];
  let logins = 0,
    guards = 0;
  const client = new StudioClient(
    store,
    async (_url, init) => {
      devices.push(new Headers(init.headers).get('x-tripo-device-id'));
      return devices.length === 1 ? rejected() : accepted();
    },
    origin,
    async (context) => {
      logins++;
      assert.equal(context.phase, 'read_rejected');
      assert.equal(context.expectedAccountRef, account);
      store.save(session('restored'));
    },
  );
  await client.request('GET', readRoute, undefined, {
    beforeSend: () => {
      guards++;
    },
  });
  assert.equal(logins, 1);
  assert.equal(guards, 2);
  assert.deepEqual(devices, ['controlled-device-original', 'controlled-device-restored']);
});

test('the admitted download-link POST may reread its exact original body after authentication', async () => {
  const store = new MemoryCredentials(session());
  const bodies: unknown[] = [];
  let logins = 0;
  const client = new StudioClient(
    store,
    async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return bodies.length === 1 ? rejected() : accepted();
    },
    origin,
    async (context) => {
      logins++;
      assert.equal(context.phase, 'read_rejected');
      store.save(session('restored'));
    },
  );
  const body = { project_id: 'original-project', operator_id: 'original-operator' };
  await client.request('POST', '/v2/studio/operation/download_with_name', body);
  assert.equal(logins, 1);
  assert.deepEqual(bodies, [body, body]);
});

for (const [method, paid] of [
  ['POST', true],
  ['POST', false],
  ['DELETE', false],
] as const)
  test(`${method} paid=${paid} authentication rejection never replays a sent write`, async () => {
    const store = new MemoryCredentials(session());
    let requests = 0,
      logins = 0;
    const client = new StudioClient(
      store,
      async () => {
        requests++;
        return rejected();
      },
      origin,
      async () => {
        logins++;
      },
    );
    await assert.rejects(client.request(method, writeRoute, {}, { paid }), { code: 'AUTH_REQUIRED' });
    assert.equal(requests, 1);
    assert.equal(logins, 0);
  });

test('a second protected-read authentication rejection stops after one login and retains AUTH_REQUIRED', async () => {
  const store = new MemoryCredentials(session());
  let requests = 0,
    logins = 0;
  const client = new StudioClient(
    store,
    async () => {
      requests++;
      return rejected();
    },
    origin,
    async () => {
      logins++;
      store.save(session('restored'));
    },
  );
  await assert.rejects(client.request('GET', readRoute), { code: 'AUTH_REQUIRED' });
  assert.equal(requests, 2);
  assert.equal(logins, 1);
});

test('read continuation refuses a different account produced while login was pending', async () => {
  const store = new MemoryCredentials(session());
  let requests = 0;
  const client = new StudioClient(
    store,
    async () => {
      requests++;
      return rejected();
    },
    origin,
    async (context) => {
      assert.equal(context.expectedAccountRef, account);
      store.save({ ...session('different'), accountRef: accountReference('other-account') });
    },
  );
  await assert.rejects(client.request('GET', readRoute), { code: 'ACCOUNT_MISMATCH' });
  assert.equal(requests, 1);
});

test('login cancellation and unresolved credentials do not spin or send the business request', async () => {
  for (const cancel of [false, true]) {
    const store = new MemoryCredentials();
    let requests = 0,
      logins = 0;
    const client = new StudioClient(
      store,
      async () => {
        requests++;
        return accepted();
      },
      origin,
      async () => {
        logins++;
        if (cancel) throw new TripoError('AUTH_REQUIRED', 'Controlled login cancellation.', 'not_submitted');
      },
    );
    await assert.rejects(client.request('POST', writeRoute, {}, { paid: true }), { code: 'AUTH_REQUIRED' });
    assert.equal(logins, 1);
    assert.equal(requests, 0);
  }
});

test('the final business guard is re-evaluated after login before any paid fetch', async () => {
  const store = new MemoryCredentials();
  let requests = 0,
    guards = 0;
  const client = new StudioClient(
    store,
    async () => {
      requests++;
      return accepted();
    },
    origin,
    async () => {
      store.save(session());
    },
  );
  await assert.rejects(
    client.request(
      'POST',
      writeRoute,
      {},
      {
        paid: true,
        beforeSend: () => {
          guards++;
          throw new TripoError('SUBMISSION_IDENTITY_CHANGED', 'Controlled changed claim.', 'not_submitted');
        },
      },
    ),
    { code: 'SUBMISSION_IDENTITY_CHANGED', certainty: 'not_submitted' },
  );
  assert.equal(guards, 1);
  assert.equal(requests, 0);
});

test('an unknown paid transport outcome does not invoke login or replay its request', async () => {
  const store = new MemoryCredentials(session());
  let requests = 0,
    logins = 0;
  const client = new StudioClient(
    store,
    async () => {
      requests++;
      throw Error('Controlled lost receipt');
    },
    origin,
    async () => {
      logins++;
    },
  );
  await assert.rejects(client.request('POST', writeRoute, {}, { paid: true }), {
    code: 'NETWORK_ERROR',
    certainty: 'unknown',
  });
  assert.equal(requests, 1);
  assert.equal(logins, 0);
});

test('non-auth rejection and unreadable non-auth responses do not start login', async () => {
  for (const response of [
    Response.json({ code: 403 }, { status: 403 }),
    new Response('<html>unavailable</html>', { status: 503 }),
  ]) {
    const store = new MemoryCredentials(session());
    let logins = 0,
      requests = 0;
    const client = new StudioClient(
      store,
      async () => {
        requests++;
        return response;
      },
      origin,
      async () => {
        logins++;
      },
    );
    await assert.rejects(client.request('GET', readRoute), {
      code: response.status === 403 ? 'STUDIO_REJECTED' : 'UPSTREAM_ERROR',
    });
    assert.equal(requests, 1);
    assert.equal(logins, 0);
  }
});

test('direct bearer-session preparation can restore credentials without issuing a business request', async () => {
  const store = new MemoryCredentials();
  let requests = 0,
    logins = 0;
  const client = new StudioClient(
    store,
    async () => {
      requests++;
      return accepted();
    },
    origin,
    async (context) => {
      logins++;
      assert.equal(context.phase, 'before_request');
      store.save(session('restored', token()));
    },
  );
  const restored = await client.session(true);
  assert.equal(restored?.accountRef, account);
  assert.equal(logins, 1);
  assert.equal(requests, 0);
});

test('logout during an existing refresh never starts a new login or restores the revoked session', async () => {
  const store = new MemoryCredentials(session('expired', token(-60)));
  let requests = 0;
  let logins = 0;
  const client = new StudioClient(
    store,
    async (url) => {
      if (url.includes('/whoami')) {
        store.clear();
        return Response.json({ identity: { id: subject }, tokenized: token() });
      }
      requests++;
      return accepted();
    },
    origin,
    async () => {
      logins++;
      store.save(session('unexpected-restoration', token()));
    },
  ).forAccount(account);
  await assert.rejects(client.request('POST', writeRoute, {}, { paid: true }), {
    code: 'ACCOUNT_MISMATCH',
  });
  assert.equal(logins, 0);
  assert.equal(requests, 0);
  assert.equal(store.load(), undefined);
});
