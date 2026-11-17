/** 只使用构造凭据及受控响应；不访问系统真实登录或上游账号。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { MemoryCredentials, accountReference, type Session } from '../studio/auth/credentials.ts';
import { withCredentialLock } from '../studio/auth/credential-lock.ts';
import { StudioClient } from '../studio/api/client.ts';
import { WebMicroClient } from '../studio/api/micro-client.ts';
import { importCredential } from '../studio/auth/import.ts';
import { object } from '../studio/contracts/errors.ts';

const subject = 'controlled-subject';
const fakeJwt = (claims: Record<string, unknown>) =>
  `eyJ0eXAiOiJKV1QifQ.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.controlled`;
const token = (seconds = 3600, sub = subject) => fakeJwt({ sub, exp: Date.now() / 1000 + seconds });
const session = (bearer = token(-30)): Session => ({
  cookie: 'controlled-cookie-original-1234567890',
  bearer,
  accountRef: accountReference(subject),
  deviceId: 'controlled-device',
  importedAt: '2026-11-14T00:00:00Z',
});
const rpc = '/tripo.canvas.api.agent.ProjectService/ListProjects';

test('REST refreshes invalid expiry and the website 60-second margin before one paid submission', async () => {
  for (const bearer of [fakeJwt({ sub: subject }), fakeJwt({ sub: subject, exp: 'invalid' }), token(45)]) {
    const store = new MemoryCredentials(session(bearer));
    let refreshes = 0,
      posts = 0;
    const client = new StudioClient(store, async (url, init) => {
      if (url.includes('/whoami')) {
        refreshes++;
        assert.equal(object(init.headers).authorization, undefined);
        assert.equal(Boolean(object(init.headers).cookie), true);
        return Response.json({ tokenized: token() });
      }
      posts++;
      assert.equal(object(init.headers).authorization === `Bearer ${store.load()!.bearer}`, true);
      return Response.json({ code: 0, data: { accepted: true } });
    });
    await client.request('POST', '/v2/studio/operation/export', {}, { paid: true });
    assert.equal(refreshes, 1);
    assert.equal(posts, 1);
  }
});

test('micro RPC obtains cookie-only authorization and constructs headers without forwarding cookies', async () => {
  const original = session();
  delete original.bearer;
  const store = new MemoryCredentials(original);
  let refreshes = 0,
    calls = 0;
  const client = new StudioClient(store, async (url, init) => {
    if (url.includes('/whoami')) {
      refreshes++;
      return Response.json({ identity: { id: subject }, tokenized: token() });
    }
    calls++;
    const headers = object(init.headers);
    assert.equal(headers.cookie, undefined);
    assert.equal(headers.authorization, undefined);
    assert.equal(headers['x-auth-token'] === store.load()!.bearer, true);
    assert.equal(headers['x-uid'], subject);
    assert.equal(headers['x-deviceid'], original.deviceId);
    assert.equal(headers['x-micro-method'], rpc);
    assert.equal(headers['x-micro-service'], 'tripo.canvas.api.agent');
    return Response.json({ projects: [] });
  });
  await new WebMicroClient(client, 'canvas').call(rpc, {});
  assert.equal(refreshes, 1);
  assert.equal(calls, 1);
});

test('invalid refreshed JWT and different subject stop before any business request', async () => {
  for (const [reply, code] of [
    [{ tokenized: fakeJwt({ sub: subject }) }, 'AUTH_REQUIRED'],
    [{ tokenized: token(-1) }, 'AUTH_REQUIRED'],
    [{ tokenized: token(3600, 'other-subject') }, 'ACCOUNT_MISMATCH'],
    [{ tokenized: token(), identity: { id: 'other-subject' } }, 'ACCOUNT_MISMATCH'],
    [{}, 'AUTH_REQUIRED'],
  ] as const) {
    const old = session();
    const store = new MemoryCredentials(old);
    let posts = 0;
    const client = new StudioClient(store, async (url) => {
      if (url.includes('/whoami')) return Response.json(reply);
      posts++;
      return Response.json({ code: 0, data: {} });
    });
    await assert.rejects(client.request('POST', '/v2/studio/operation/export', {}, { paid: true }), {
      code,
      certainty: 'not_submitted',
    });
    assert.equal(posts, 0);
    assert.equal(store.load(), old);
  }
});

test('expired bearer-only sessions stop locally instead of sending an expired paid request', async () => {
  const original = session();
  delete original.cookie;
  const store = new MemoryCredentials(original);
  let calls = 0;
  const client = new StudioClient(store, async () => {
    calls++;
    return Response.json({});
  });
  await assert.rejects(client.request('POST', '/v2/studio/operation/export', {}, { paid: true }), {
    code: 'AUTH_REQUIRED',
    certainty: 'not_submitted',
  });
  await assert.rejects(new WebMicroClient(client, 'canvas').call(rpc, {}), { code: 'AUTH_REQUIRED' });
  assert.equal(calls, 0);
});

test('whoami network failure is known to precede submission, but a paid request failure remains unknown', async () => {
  let business = 0;
  const store = new MemoryCredentials(session());
  const client = new StudioClient(store, async (url) => {
    if (!url.includes('/whoami')) business++;
    throw new Error('controlled network failure');
  });
  await assert.rejects(client.request('POST', '/v2/studio/operation/export', {}, { paid: true }), {
    code: 'NETWORK_ERROR',
    certainty: 'not_submitted',
  });
  assert.equal(business, 0);
  store.save(session(token()));
  await assert.rejects(client.request('POST', '/v2/studio/operation/export', {}, { paid: true }), {
    code: 'NETWORK_ERROR',
    certainty: 'unknown',
  });
  assert.equal(business, 1);
});

test('an older refresh cannot overwrite newer same-account login credentials', async () => {
  const old = session();
  const store = new MemoryCredentials(old);
  const newer = {
    ...old,
    bearer: token(7200),
    cookie: 'controlled-new-session-cookie',
    deviceId: 'new-device',
    importedAt: '2026-11-14T00:01:00Z',
  };
  let calls = 0;
  const client = new StudioClient(store, async (url, init) => {
    if (url.includes('/whoami')) {
      store.save(newer);
      return Response.json({ tokenized: token() });
    }
    calls++;
    assert.equal(object(init.headers)['x-auth-token'] === newer.bearer, true);
    assert.equal(object(init.headers)['x-deviceid'], 'new-device');
    return Response.json({ projects: [] });
  });
  await new WebMicroClient(client, 'canvas').call(rpc, {});
  assert.equal(store.load(), newer);
  assert.equal(calls, 1);
});

test('account switch or logout during refresh never restores the old session or sends a business call', async () => {
  for (const signedOut of [false, true]) {
    const store = new MemoryCredentials(session());
    let calls = 0;
    const newer = { ...session(token(3600, 'other-subject')), accountRef: accountReference('other-subject') };
    const client = new StudioClient(store, async (url) => {
      if (url.includes('/whoami')) {
        if (signedOut) store.clear();
        else store.save(newer);
        return Response.json({ tokenized: token() });
      }
      calls++;
      return Response.json({ code: 0, data: {} });
    }).forAccount(accountReference(subject));
    await assert.rejects(client.request('POST', '/v2/studio/operation/export', {}, { paid: true }), {
      code: 'ACCOUNT_MISMATCH',
    });
    assert.equal(store.load(), signedOut ? undefined : newer);
    assert.equal(calls, 0);
  }
});

test('newer same-account credentials that need refresh remain intact and ask for the original action again', async () => {
  const store = new MemoryCredentials(session());
  const newer = { ...session(), cookie: 'controlled-new-cookie' };
  let calls = 0;
  const client = new StudioClient(store, async (url) => {
    if (url.includes('/whoami')) {
      store.save(newer);
      return Response.json({ tokenized: token() });
    }
    calls++;
    return Response.json({ code: 0, data: {} });
  });
  await assert.rejects(client.request('POST', '/v2/studio/operation/export', {}, { paid: true }), {
    code: 'SESSION_CHANGED',
    certainty: 'not_submitted',
  });
  assert.equal(store.load(), newer);
  assert.equal(calls, 0);
});

test('credential import verifies the cookie identity before looking up its wallet', async () => {
  const store = new MemoryCredentials(session(token(3600, 'previous-account')));
  const routes: string[] = [];
  const refreshed = token();
  const result = await importCredential(
    JSON.stringify({ cookie: 'c'.repeat(32), bearer: token(3600, 'stale-account') }),
    store,
    async (url, init) => {
      routes.push(new URL(url).pathname);
      if (url.includes('/whoami')) return Response.json({ identity: { id: subject }, tokenized: refreshed });
      assert.equal(object(init.headers).authorization === `Bearer ${refreshed}`, true);
      return Response.json({ code: 0, data: { wallet: { total_credit: 25 } } });
    },
  );
  assert.deepEqual(routes, ['/v2/studio/studio/whoami', '/v2/studio/user/profile/payment']);
  assert.equal(result.account_ref, accountReference(subject));
  assert.equal(result.balance, 25);
});

test('import can refresh an invalid captured expiry and retains the most recent token after verification', async () => {
  const store = new MemoryCredentials();
  const latest = token();
  let whoami = 0;
  await importCredential(
    JSON.stringify({ cookie: 'c'.repeat(32), bearer: fakeJwt({ sub: subject, exp: 1e300 }) }),
    store,
    async (url, init) => {
      if (url.includes('/whoami')) {
        whoami++;
        return Response.json({ identity: { id: subject }, tokenized: whoami === 1 ? token(45) : latest });
      }
      assert.equal(object(init.headers).authorization === `Bearer ${latest}`, true);
      return Response.json({ code: 0, data: { wallet: { total_credit: 25 } } });
    },
  );
  assert.equal(whoami, 2);
  assert.equal(store.load()!.bearer === latest, true);
});

test('credential lock excludes another process without touching the real keychain', async () => {
  const profile = `test-${randomUUID()}`;
  const moduleUrl = new URL('../studio/auth/credential-lock.ts', import.meta.url).href;
  const code = `import { withCredentialLock } from ${JSON.stringify(moduleUrl)}; withCredentialLock(${JSON.stringify(profile)}, () => { process.stdout.write('locked\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400); });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  try {
    await once(child.stdout, 'data');
    assert.throws(() => withCredentialLock(profile, () => assert.fail('entered another process lock')), {
      code: 'CREDENTIAL_STORE_BUSY',
    });
    assert.equal((await closed)[0], 0);
    assert.equal(
      withCredentialLock(profile, () => 'released'),
      'released',
    );
  } finally {
    child.kill();
  }
});
