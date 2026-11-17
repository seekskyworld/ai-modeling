/** 全部使用合成会话及隔离 OS 用户目录，不读取操作人的凭据。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { JsonStore, MemoryCredentials, accountReference, type Session } from '../studio/auth/credentials.ts';
import { importCredential, verifyCredential } from '../studio/auth/import.ts';
import { object } from '../studio/contracts/errors.ts';
import { withCredentialLock } from '../studio/auth/credential-lock.ts';
import { startAuthBridge } from '../studio/auth/bridge.ts';
import { TripoError } from '../studio/contracts/errors.ts';

const subject = 'live27-controlled-account';
const token = (seconds = 3600) =>
  `eyJ0eXAiOiJKV1QifQ.${Buffer.from(JSON.stringify({ sub: subject, exp: Date.now() / 1000 + seconds })).toString('base64url')}.controlled`;
const session = (): Session => ({
  cookie: 'live27-controlled-cookie-not-a-real-login',
  deviceId: 'live27-controlled-device',
  importedAt: '2026-11-16T00:00:00Z',
  accountRef: accountReference(subject),
});

test('verification returns the latest session without saving or mutating the original candidate', async () => {
  const candidate = Object.freeze({ ...session(), bearer: token(-10) });
  const original = { ...candidate };
  const refreshed = token();
  let whoami = 0;
  const routes: string[] = [];
  const verified = await verifyCredential(candidate, async (url, init) => {
    routes.push(new URL(url).pathname);
    if (url.includes('/whoami')) {
      whoami++;
      assert.equal(object(init.headers).authorization, undefined);
      return Response.json({ identity: { id: subject }, tokenized: whoami === 1 ? token(20) : refreshed });
    }
    assert.equal(object(init.headers).authorization, `Bearer ${refreshed}`);
    assert.equal(object(init.headers)['x-tripo-device-id'], original.deviceId);
    return Response.json({ code: 0, data: { wallet: { total_credit: 37 } } });
  });
  assert.deepEqual(candidate, original);
  assert.notEqual(verified.session, candidate);
  assert.equal(verified.session.deviceId, original.deviceId);
  assert.equal(verified.session.importedAt, original.importedAt);
  assert.equal(verified.session.bearer, refreshed);
  assert.equal(verified.result.balance, 37);
  assert.equal(verified.result.renewable, true);
  assert.equal(verified.result.account_ref, accountReference(subject));
  assert.equal(JSON.stringify(verified.result).includes(candidate.cookie!), false);
  assert.equal(JSON.stringify(verified.result).includes(refreshed), false);
  assert.deepEqual(routes, [
    '/v2/studio/studio/whoami',
    '/v2/studio/studio/whoami',
    '/v2/studio/user/profile/payment',
  ]);
});

test('failed candidate verification cannot replace prior credentials and does not misclassify 403', async () => {
  for (const [status, body, expected] of [
    [401, { code: 1002 }, 'AUTH_REQUIRED'],
    [403, {}, 'HTTP_ERROR'],
    [200, { code: 2010 }, 'INSUFFICIENT_CREDITS'],
  ] as const) {
    const original = session();
    const store = new MemoryCredentials(original);
    await assert.rejects(
      importCredential('another-controlled-cookie-1234567890', store, async () =>
        Response.json(body, { status }),
      ),
      { code: expected },
    );
    assert.equal(store.load(), original);
  }
});

test('conflicting Cookie and JWT identities stop before the wallet is queried', async () => {
  let wallets = 0;
  await assert.rejects(
    verifyCredential(session(), async (url) => {
      if (url.includes('/whoami'))
        return Response.json({ identity: { id: 'different-controlled-account' }, tokenized: token() });
      wallets++;
      return Response.json({ code: 0, data: { wallet: { total_credit: 99 } } });
    }),
    { code: 'ACCOUNT_MISMATCH' },
  );
  assert.equal(wallets, 0);
});

test('manual import preserves its public fields and saves only after whoami and wallet verify', async () => {
  const saved = new MemoryCredentials();
  let saves = 0;
  const originalSave = saved.save.bind(saved);
  saved.save = (value) => {
    saves++;
    originalSave(value);
  };
  const result = await importCredential(session().cookie!, saved, async (url) => {
    assert.equal(saves, 0);
    return url.includes('/whoami')
      ? Response.json({ identity: { id: subject }, tokenized: token() })
      : Response.json({ code: 0, data: { wallet: { total_credit: 12 } } });
  });
  assert.equal(saves, 1);
  assert.deepEqual(Object.keys(result).sort(), [
    'account_ref',
    'authenticated',
    'balance',
    'expires_at',
    'renewable',
  ]);
  assert.equal(saved.load()!.accountRef, accountReference(subject));
});

test('empty-snapshot memory CAS allows one login and rejects late overwrites and stale refreshes', () => {
  const store = new MemoryCredentials();
  const first = session();
  const late = { ...first, cookie: 'late-controlled-cookie-1234567890' };
  assert.equal(store.saveIfUnchanged(undefined, first), true);
  assert.equal(store.saveIfUnchanged(undefined, late), false);
  assert.equal(store.load(), first);
  store.clear();
  assert.equal(store.saveIfUnchanged(first, late), false);
  assert.equal(store.load(), undefined);
});

test('JSON empty-snapshot CAS uses the shared profile lock and rejects a late writer', () => {
  const profile = `live27-cas-${randomUUID()}`;
  const store = new JsonStore(profile);
  withCredentialLock(profile, () => {
    assert.throws(() => store.saveIfUnchanged(undefined, session()), {
      code: 'CREDENTIAL_STORE_BUSY',
    });
  });
  assert.equal(store.saveIfUnchanged(undefined, session()), true);
  assert.equal(store.saveIfUnchanged(undefined, { ...session(), deviceId: 'late' }), false);
  assert.deepEqual(store.load(), session());
  store.clear();
});

test('manual bridge delegates saving to the login coordinator and cannot commit a cancelled late form', async () => {
  for (const newLogin of [false, true]) {
    const store = new MemoryCredentials();
    let active = true;
    let finish!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let imported = 0;
    const bridge = await startAuthBridge(
      store,
      () => imported++,
      async (input) => {
        assert.equal(input, session().cookie);
        entered();
        await waiting;
        if (!active || !store.saveIfUnchanged(undefined, session()))
          throw new TripoError('SESSION_CHANGED', 'This login is no longer active.');
        return { authenticated: true };
      },
    );
    try {
      const request = fetch(bridge.url, {
        method: 'POST',
        headers: { origin: new URL(bridge.url).origin, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ credential: session().cookie! }),
      });
      await started;
      const replacement = newLogin ? { ...session(), deviceId: 'newer-login' } : undefined;
      if (replacement) store.save(replacement);
      else store.clear();
      active = false;
      finish();
      const response = await request;
      assert.equal(response.status, 400);
      assert.equal(object(await response.json()).code, 'SESSION_CHANGED');
      assert.equal(imported, 0);
      assert.deepEqual(store.load(), replacement);
    } finally {
      finish();
      await bridge.close();
    }
  }
});
