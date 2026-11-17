/** 资源操作的完整前置链绑定一个账号；只用受控响应和内存会话。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioClient } from '../studio/api/client.ts';
import { callResource, resources } from '../studio/api/resources.ts';
import { MemoryCredentials, accountReference, type Session } from '../studio/auth/credentials.ts';

function session(user = 'original', bearer = false): Session {
  return {
    accountRef: accountReference(user),
    cookie: `controlled-resource-cookie-${user}`,
    deviceId: user,
    importedAt: '2026-11-16T00:00:00Z',
    ...(bearer
      ? {
          bearer: `eyJ0eXAiOiJKV1QifQ.${Buffer.from(JSON.stringify({ sub: user, exp: Date.now() / 1000 + 3600 })).toString('base64url')}.controlled`,
        }
      : {}),
  };
}
const rename = resources.find((spec) => spec.name === 'project_rename')!;
const input = { project_id: 'controlled-project', name: 'renamed' };

test('resource ownership checks cannot be followed by a write after logout or a different login', async () => {
  for (const logout of [false, true]) {
    const store = new MemoryCredentials(session());
    let reads = 0,
      writes = 0,
      logins = 0;
    const client = new StudioClient(
      store,
      async (_url, init) => {
        if (init.method === 'GET') {
          reads++;
          if (logout) store.clear();
          else store.save(session('different'));
          return Response.json({ code: 0, data: { is_owner: true } });
        }
        writes++;
        return Response.json({ code: 0, data: { updated: true } });
      },
      undefined,
      async () => {
        logins++;
      },
    );
    await assert.rejects(callResource(client, rename, input), { code: 'ACCOUNT_MISMATCH' });
    assert.equal(reads, 1);
    assert.equal(writes, 0);
    assert.equal(logins, 0);
  }
});

test('resource preparation receives the same account-bound client and never carries a changed account into write', async () => {
  const store = new MemoryCredentials(session());
  let writes = 0;
  const client = new StudioClient(store, async (_url, init) => {
    if (init.method === 'POST') writes++;
    return Response.json({ code: 0, data: { is_owner: true } });
  });
  const spec = {
    ...rename,
    prepare: async (bound: StudioClient) => {
      assert.notEqual(bound, client);
      store.save(session('different'));
      await bound.request('GET', '/v2/studio/project/detail/v3/controlled-project');
      return input;
    },
  };
  await assert.rejects(callResource(client, spec, input), { code: 'ACCOUNT_MISMATCH' });
  assert.equal(writes, 0);
});

test('ordinary REST resources keep cookie-only operation and can restore a missing account before freezing it', async () => {
  for (const missing of [false, true]) {
    const store = new MemoryCredentials(missing ? undefined : session());
    let logins = 0;
    const routes: string[] = [];
    const client = new StudioClient(
      store,
      async (url, init) => {
        routes.push(new URL(url).pathname);
        assert.equal(new Headers(init.headers).get('authorization'), null);
        return Response.json({
          code: 0,
          data: init.method === 'GET' ? { is_owner: true } : { updated: true },
        });
      },
      undefined,
      async () => {
        logins++;
        store.save(session());
      },
    );
    assert.deepEqual(await callResource(client, rename, input), { updated: true });
    assert.equal(logins, missing ? 1 : 0);
    assert.deepEqual(routes, [
      '/v2/studio/project/detail/v3/controlled-project',
      '/v2/studio/operation/update_name',
    ]);
  }
});

test('single-request refresh cannot replace the original account snapshot before a paid fetch', async () => {
  for (const logout of [false, true]) {
    const store = new MemoryCredentials(session('original', true));
    const originalLoad = store.load.bind(store);
    let loads = 0,
      sends = 0;
    store.load = () => {
      if (++loads === 2) {
        if (logout) store.clear();
        else store.save(session('different', true));
      }
      return originalLoad();
    };
    const client = new StudioClient(store, async () => {
      sends++;
      return Response.json({ code: 0, data: {} });
    });
    await assert.rejects(client.request('POST', '/v2/studio/operation/export', {}, { paid: true }), {
      code: 'ACCOUNT_MISMATCH',
      certainty: 'not_submitted',
    });
    assert.equal(sends, 0);
  }
});
