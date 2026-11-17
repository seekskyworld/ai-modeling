/** 实际回环broker与隔离store验证，严格区分短等待超时和全流程过期。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdtemp,
  realpath,
  readFile,
  lstat,
  rm,
  writeFile,
  rename,
  symlink,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { MemoryCredentials, type Session } from '../studio/auth/credentials.ts';
import { TripoError } from '../studio/contracts/errors.ts';
import type { Config } from '../cli/core/config.ts';
import type { LoginRuntime, BrowserLoginOptions } from '../cli/auth/types.ts';
import { LOGIN_TIMEOUT_MS } from '../cli/auth/types.ts';
import {
  beginLogin,
  ensureLogin,
  readLogin,
  waitLogin,
  cancelLogin,
  logoutLogin,
} from '../cli/auth/coordinator.ts';
import { startLoginBroker, withLoginSignal } from '../cli/auth/broker.ts';
import { loginStateFile, readState } from '../cli/auth/state.ts';
import { manualLogin } from '../cli/auth/manual.ts';
import { fakeLoginSession } from './login-runtime-fixture.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test('pre-aborted verification still consumes a late promise rejection', async () => {
  const signal = new AbortController();
  signal.abort();
  await assert.rejects(withLoginSignal(Promise.reject(Error('controlled late rejection')), signal.signal), {
    code: 'LOGIN_CANCELLED',
  });
});
async function fixture(initial?: Session) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'tripo-login-test-')));
  const config: Config = {
    dataDir: directory,
    keyringAccount: path.basename(directory),
    inputRoots: [],
    outputDir: '',
  };
  const store = new MemoryCredentials(initial),
    calls = { browser: 0, verify: 0 },
    opened = deferred<BrowserLoginOptions>();
  const brokers: Awaited<ReturnType<typeof startLoginBroker>>[] = [];
  const runtime: LoginRuntime = {
    store,
    verify: async (candidate) => {
      calls.verify++;
      return {
        session: typeof candidate === 'string' ? { ...fakeLoginSession } : structuredClone(candidate),
        result: { authenticated: true, balance: 123 },
      };
    },
    browser: async (options) => {
      calls.browser++;
      opened.resolve(options);
      options.onWaiting?.();
      if (!options.signal.aborted)
        await new Promise<void>((resolve) =>
          options.signal.addEventListener('abort', () => resolve(), { once: true }),
        );
    },
  };
  runtime.launch = async (start) => {
    brokers.push(await startLoginBroker(start, runtime));
  };
  const close = async () => {
    await Promise.all(brokers.map((broker) => broker.close()));
    await rm(await loginStateFile(config), { force: true });
    await rm(directory, { recursive: true, force: true });
  };
  return { config, store, calls, opened, runtime, close, directory };
}
test('verified current credentials renew by CAS without opening a window or creating a login flow', async () => {
  const old = { ...fakeLoginSession, cookie: 'old-fake-cookie-01234567890123456789' },
    f = await fixture(old);
  try {
    f.runtime.verify = async (candidate) => {
      assert.deepEqual(candidate, old);
      return { session: { ...old, bearer: 'renewed-test-bearer' }, result: { balance: 5 } };
    };
    const result = await ensureLogin({ config: f.config }, f.runtime);
    assert.equal(result.authenticated, true);
    assert.equal(result.scope, 'verified_session');
    assert.equal(result.credential_store_check, 'verified');
    assert.equal(result.studio_session_check, 'verified');
    assert.equal(result.login_id, undefined);
    assert.equal(result.balance, 5);
    assert.equal(f.store.load()!.bearer, 'renewed-test-bearer');
    assert.equal(f.calls.browser, 0);
    assert.equal(await readState(f.config), undefined);
    assert.ok(!JSON.stringify(result).includes(old.cookie));
  } finally {
    await f.close();
  }
});
test('server AUTH_REQUIRED starts browser login while network and permission failures retain their classification', async () => {
  for (const code of ['AUTH_REQUIRED', 'NETWORK_ERROR', 'STUDIO_FORBIDDEN']) {
    const f = await fixture({ ...fakeLoginSession });
    try {
      const error = new TripoError(code, 'Controlled verification refusal.');
      f.runtime.verify = async () => {
        throw error;
      };
      if (code === 'AUTH_REQUIRED') {
        const result = await ensureLogin({ config: f.config, wait: false, open: true }, f.runtime);
        assert.equal(result.status, 'waiting_for_login');
        assert.equal(f.calls.browser, 1);
      } else {
        await assert.rejects(
          ensureLogin({ config: f.config, wait: false }, f.runtime),
          (value) => value === error,
        );
        assert.equal(f.calls.browser, 0);
      }
    } finally {
      await f.close();
    }
  }
});
test('force skips old validation and accepts a verified same-account browser candidate', async () => {
  const f = await fixture({ ...fakeLoginSession });
  try {
    const first = await ensureLogin({ config: f.config, force: true, wait: false, open: true }, f.runtime);
    assert.equal(f.calls.verify, 0);
    const browser = await f.opened.promise;
    assert.equal(
      await browser.accept({ ...fakeLoginSession, cookie: 'fresh-cookie-01234567890123456789' }),
      true,
    );
    const status = await waitLogin(first.login_id!, { config: f.config });
    assert.equal(status.authenticated, true);
    assert.equal(f.calls.verify, 1);
    assert.equal(f.store.load()!.cookie, 'fresh-cookie-01234567890123456789');
    await logoutLogin({ config: f.config }, f.runtime);
    assert.equal((await readLogin(first.login_id, { config: f.config })).authenticated, false);
    assert.equal(f.store.load(), undefined);
  } finally {
    await f.close();
  }
});
test('no-open exposes a private local button and rejects wrong Host, Origin or control capability', async () => {
  const f = await fixture();
  try {
    const first = await beginLogin(
      { config: f.config, open: false, cdpEndpoint: 'http://127.0.0.1:9222/private-marker' },
      f.runtime,
    );
    assert.equal(f.calls.browser, 0);
    assert.match(first.login_url!, /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}$/);
    const file = await loginStateFile(f.config),
      stored = await readFile(file, 'utf8');
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
    for (const forbidden of [fakeLoginSession.cookie!, 'private-marker', 'Bearer', 'command'])
      assert.ok(!stored.includes(forbidden));
    const page = await fetch(first.login_url!);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /打开登录窗口/);
    const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(first.login_url!, { headers: { Host: 'evil.invalid' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(wrongHost, 403);
    assert.equal(
      (
        await fetch(first.login_url! + '/start', {
          method: 'POST',
          headers: { Origin: 'https://evil.invalid' },
          redirect: 'manual',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(new URL('/control', first.login_url!), {
          method: 'POST',
          headers: { 'x-ai-modeling-login': 'wrong' },
          body: '{}',
        })
      ).status,
      403,
    );
    const origin = new URL(first.login_url!).origin;
    for (let i = 0; i < 2; i++)
      assert.equal(
        (
          await fetch(first.login_url! + '/start', {
            method: 'POST',
            headers: { Origin: origin },
            redirect: 'manual',
          })
        ).status,
        303,
      );
    assert.equal(f.calls.browser, 1);
    assert.equal((await beginLogin({ config: f.config, open: false }, f.runtime)).login_id, first.login_id);
    assert.ok(
      !JSON.stringify(await readLogin(first.login_id, { config: f.config })).includes(
        (await readState(f.config))!.control,
      ),
    );
  } finally {
    await f.close();
  }
});
test('concurrent begin callers share one profile flow and one window', async () => {
  const f = await fixture();
  try {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => beginLogin({ config: f.config, open: true }, f.runtime)),
    );
    assert.equal(new Set(results.map((result) => result.login_id)).size, 1);
    assert.equal(f.calls.browser, 1);
  } finally {
    await f.close();
  }
});
test('short wait timeout preserves the shared flow and its original deadline', async () => {
  const f = await fixture();
  try {
    const started = await beginLogin({ config: f.config, open: false }, f.runtime);
    const waited = await waitLogin(started.login_id!, { config: f.config, timeoutMs: 25 });
    assert.equal(waited.wait_timeout, true);
    assert.equal(waited.status, 'waiting_for_login');
    assert.equal(waited.expires_at, started.expires_at);
    assert.equal((await readLogin(started.login_id, { config: f.config })).status, 'waiting_for_login');
    const cancelled = await cancelLogin(started.login_id, { config: f.config });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(f.store.load(), undefined);
  } finally {
    await f.close();
  }
});
test('entire login expires and larger requested durations are capped at fifteen minutes', async () => {
  const f = await fixture();
  try {
    const capped = await beginLogin(
      { config: f.config, open: false, timeoutMs: LOGIN_TIMEOUT_MS * 2 },
      f.runtime,
    );
    assert.ok(Date.parse(capped.expires_at) - Date.parse(capped.started_at) <= LOGIN_TIMEOUT_MS);
    await cancelLogin(capped.login_id, { config: f.config });
    const short = await beginLogin({ config: f.config, open: false, timeoutMs: 600 }, f.runtime);
    const ended = await waitLogin(short.login_id!, { config: f.config, timeoutMs: 2000 });
    assert.equal(ended.status, 'expired');
    assert.equal(ended.error?.code, 'LOGIN_EXPIRED');
    assert.equal(f.store.load(), undefined);
  } finally {
    await f.close();
  }
});
for (const initial of [undefined, { ...fakeLoginSession }])
  test(`late verified browser candidate cannot undo logout from ${initial ? 'existing' : 'empty'} credentials`, async () => {
    const f = await fixture(initial),
      gate = deferred<void>(),
      verifying = deferred<void>();
    try {
      f.runtime.verify = async () => {
        verifying.resolve();
        await gate.promise;
        return { session: { ...fakeLoginSession }, result: { authenticated: true } };
      };
      const status = await beginLogin({ config: f.config, open: true }, f.runtime),
        browser = await f.opened.promise;
      const acceptance = browser.accept({ ...fakeLoginSession }).catch((error) => error);
      await verifying.promise;
      await logoutLogin({ config: f.config }, f.runtime);
      gate.resolve();
      assert.ok((await acceptance) instanceof Error);
      assert.equal(f.store.load(), undefined);
      assert.equal((await readLogin(status.login_id, { config: f.config })).status, 'cancelled');
    } finally {
      gate.resolve();
      await f.close();
    }
  });
test('browser lifecycle cancellation wins over an in-flight verification before CAS', async () => {
  const f = await fixture(),
    gate = deferred<void>(),
    verifying = deferred<void>(),
    window = new AbortController();
  try {
    f.runtime.verify = async () => {
      verifying.resolve();
      await gate.promise;
      return { session: { ...fakeLoginSession }, result: {} };
    };
    await beginLogin({ config: f.config, open: true }, f.runtime);
    const acceptance = (await f.opened.promise)
      .accept({ ...fakeLoginSession }, window.signal)
      .catch((error) => error);
    await verifying.promise;
    window.abort();
    gate.resolve();
    await acceptance;
    assert.equal(f.store.load(), undefined);
    assert.equal((await readLogin(undefined, { config: f.config })).status, 'cancelled');
  } finally {
    gate.resolve();
    await f.close();
  }
});
test('different accounts and concurrently replaced credentials preserve the original/newer session', async () => {
  const f = await fixture({ ...fakeLoginSession });
  try {
    const start = await beginLogin({ config: f.config, open: true }, f.runtime);
    await assert.rejects(
      (await f.opened.promise).accept({ ...fakeLoginSession, accountRef: 'b'.repeat(24) }),
      { code: 'ACCOUNT_MISMATCH' },
    );
    assert.deepEqual(f.store.load(), fakeLoginSession);
    assert.equal((await readLogin(start.login_id, { config: f.config })).error?.code, 'ACCOUNT_MISMATCH');
  } finally {
    await f.close();
  }
  const second = await fixture({ ...fakeLoginSession }),
    gate = deferred<void>(),
    verifying = deferred<void>();
  try {
    second.runtime.verify = async () => {
      verifying.resolve();
      await gate.promise;
      return { session: { ...fakeLoginSession }, result: {} };
    };
    await beginLogin({ config: second.config, open: true }, second.runtime);
    const accepted = (await second.opened.promise).accept({ ...fakeLoginSession }).catch((error) => error);
    await verifying.promise;
    const newer = { ...fakeLoginSession, cookie: 'newer-realistic-test-cookie-0123456789' };
    second.store.save(newer);
    gate.resolve();
    assert.equal((await accepted).code, 'SESSION_CHANGED');
    assert.deepEqual(second.store.load(), newer);
  } finally {
    gate.resolve();
    await second.close();
  }
});
test('already-aborted login does not inspect credentials, launch a process or create state', async () => {
  const f = await fixture(),
    controller = new AbortController();
  controller.abort();
  try {
    f.store.load = () => {
      throw Error('Must not inspect a cancelled login');
    };
    for (const run of [ensureLogin, beginLogin])
      await assert.rejects(run({ config: f.config, signal: controller.signal }, f.runtime), {
        code: 'LOGIN_CANCELLED',
      });
    assert.deepEqual(await readdir(f.directory), []);
    assert.equal(f.calls.browser, 0);
  } finally {
    await f.close();
  }
});
test('manual import is also revoked by logout while verification is pending', async () => {
  const f = await fixture(),
    gate = deferred<void>(),
    verifying = deferred<void>();
  try {
    f.runtime.verify = async () => {
      verifying.resolve();
      await gate.promise;
      return { session: { ...fakeLoginSession }, result: {} };
    };
    const manual = await manualLogin({ config: f.config }, f.runtime),
      pending = manual.accept('fake credential').catch((error) => error);
    await verifying.promise;
    await logoutLogin({ config: f.config }, f.runtime);
    gate.resolve();
    assert.equal((await pending).code, 'SESSION_CHANGED');
    assert.equal(f.store.load(), undefined);
  } finally {
    gate.resolve();
    await f.close();
  }
});
test('the same manual form accepts a corrected credential and preserves explicit account-switch semantics', async () => {
  const f = await fixture({ ...fakeLoginSession });
  try {
    f.runtime.verify = async (candidate) => {
      if (candidate === 'invalid') throw new TripoError('INVALID_CREDENTIAL', 'A test invalid candidate.');
      return {
        session: { ...fakeLoginSession, accountRef: 'b'.repeat(24) },
        result: { authenticated: true },
      };
    };
    const manual = await manualLogin({ config: f.config }, f.runtime);
    await assert.rejects(manual.accept('invalid'), { code: 'INVALID_CREDENTIAL' });
    assert.equal((await readLogin(undefined, { config: f.config })).status, 'waiting_for_login');
    assert.deepEqual(await manual.accept('corrected'), { authenticated: true });
    assert.equal(f.store.load()!.accountRef, 'b'.repeat(24));
    const state = await readLogin(undefined, { config: f.config });
    assert.equal(state.authenticated, true);
    assert.equal(state.error, undefined);
  } finally {
    await f.close();
  }
});
test('an old login ID cannot cancel a new flow and status never reads a credential store', async () => {
  const f = await fixture();
  try {
    const old = await beginLogin({ config: f.config, open: false }, f.runtime);
    await cancelLogin(old.login_id, { config: f.config });
    const next = await beginLogin({ config: f.config, open: false }, f.runtime);
    assert.notEqual(old.login_id, next.login_id);
    f.store.load = () => {
      throw Error('Status must not read credentials');
    };
    await assert.rejects(cancelLogin(old.login_id, { config: f.config }), { code: 'LOGIN_NOT_FOUND' });
    assert.equal((await readLogin(next.login_id, { config: f.config })).status, 'waiting_for_login');
  } finally {
    await f.close();
  }
});
test('a caller joining an unbound flow must still enforce its own expected account', async () => {
  const f = await fixture();
  try {
    const started = await beginLogin({ config: f.config, open: true }, f.runtime);
    const joined = await beginLogin(
      { config: f.config, open: false, expectedAccountRef: 'b'.repeat(24) },
      f.runtime,
    );
    assert.equal(joined.login_id, started.login_id);
    await (await f.opened.promise).accept({ ...fakeLoginSession });
    await assert.rejects(
      waitLogin(started.login_id!, { config: f.config, expectedAccountRef: 'b'.repeat(24) }),
      { code: 'ACCOUNT_MISMATCH' },
    );
    assert.equal(
      (
        await readLogin(started.login_id, {
          config: f.config,
          expectedAccountRef: fakeLoginSession.accountRef,
        })
      ).authenticated,
      true,
    );
  } finally {
    await f.close();
  }
});
test('the same profile shares one flow and logout revocation across different data directories', async () => {
  const f = await fixture();
  try {
    const other = { ...f.config, dataDir: path.join(f.directory, 'different-database-directory') };
    const first = await beginLogin({ config: f.config, open: true }, f.runtime);
    const joined = await beginLogin({ config: other, open: false }, f.runtime);
    assert.equal(joined.login_id, first.login_id);
    assert.equal(f.calls.browser, 1);
    assert.equal(await loginStateFile(other), await loginStateFile(f.config));
    await logoutLogin({ config: other }, f.runtime);
    await assert.rejects((await f.opened.promise).accept({ ...fakeLoginSession }), {
      code: 'SESSION_CHANGED',
    });
    assert.equal(f.store.load(), undefined);
    assert.equal((await readLogin(first.login_id, { config: f.config })).status, 'cancelled');
  } finally {
    await f.close();
  }
});
test('state rejects symlinks and never follows them to a different file', async () => {
  const f = await fixture();
  try {
    await beginLogin({ config: f.config, open: false }, f.runtime);
    const state = await loginStateFile(f.config),
      outside = path.join(f.directory, 'unrelated.json');
    await writeFile(outside, '{"unrelated":true}', { mode: 0o600 });
    await rename(state, state + '.original');
    await symlink(outside, state);
    await assert.rejects(readLogin(undefined, { config: f.config }), { code: 'LOGIN_STATE_INVALID' });
    assert.equal(await readFile(outside, 'utf8'), '{"unrelated":true}');
  } finally {
    await f.close();
  }
});
