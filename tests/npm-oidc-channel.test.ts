import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setNpmChannelWithOidc, NpmOidcChannelError } from '../scripts/npm-oidc-channel.ts';
import { RemotePromotionBackend } from '../scripts/release-promotion.ts';

const now = Date.parse('2026-11-19T00:00:00Z');
const repository = 'seekskyworld/ai-modeling';
const ref = 'refs/tags/v0.1.4';
const workflow = `${repository}/.github/workflows/release.yml@${ref}`;
const requestToken = 'synthetic-github-request-secret';
const packageToken = 'synthetic-npm-package-short-token';
function identity(changes: object = {}) {
  const claims = {
    iss: 'https://token.actions.githubusercontent.com',
    aud: 'npm:registry.npmjs.org',
    repository,
    ref,
    workflow_ref: workflow,
    sha: 'a'.repeat(40),
    sub: `repo:${repository}:environment:npm`,
    iat: now / 1000,
    exp: now / 1000 + 300,
    ...changes,
  };
  return `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic-signature`;
}
function environment(changes: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REPOSITORY: repository,
    GITHUB_REF: ref,
    GITHUB_WORKFLOW_REF: workflow,
    GITHUB_SHA: 'a'.repeat(40),
    ACTIONS_ID_TOKEN_REQUEST_URL:
      'https://pipelines.actions.githubusercontent.com/synthetic/_apis/jobs/job/idtoken?api-version=2.0',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: requestToken,
    ...changes,
  };
  for (const name of [
    'NPM_TOKEN',
    'NODE_AUTH_TOKEN',
    'NPM_ID_TOKEN',
    'npm_config_userconfig',
    'npm_config_registry',
  ])
    Object.defineProperty(env, name, {
      get() {
        throw new Error('Long-lived credentials and local npm configuration must not be read');
      },
    });
  return env;
}
const input = { repository, channel: 'latest' as const, version: '0.1.4' };

test('channel update follows the official GitHub audience and package-level exchange protocol only', async () => {
  const idToken = identity();
  const calls: { url: string; options: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    if (calls.length === 1) return Response.json({ value: idToken });
    if (calls.length === 2)
      return Response.json({
        token: packageToken,
        token_type: 'oidc',
        expires: new Date(now + 300000).toISOString(),
      });
    return new Response(null, { status: 204 });
  };
  await setNpmChannelWithOidc(input, { env: environment(), fetcher, now: () => now });
  assert.equal(calls.length, 3);
  assert.equal(new URL(calls[0]!.url).searchParams.get('audience'), 'npm:registry.npmjs.org');
  assert.equal(new Headers(calls[0]!.options.headers).get('authorization'), `Bearer ${requestToken}`);
  assert.equal(
    calls[1]!.url,
    'https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/@seekskyworld%2fai-modeling',
  );
  assert.equal(calls[1]!.options.method, 'POST');
  assert.equal(new Headers(calls[1]!.options.headers).get('authorization'), `Bearer ${idToken}`);
  assert.equal(
    calls[2]!.url,
    'https://registry.npmjs.org/-/package/@seekskyworld%2fai-modeling/dist-tags/latest',
  );
  assert.equal(calls[2]!.options.method, 'PUT');
  assert.equal(calls[2]!.options.body, '"0.1.4"');
  assert.equal(new Headers(calls[2]!.options.headers).get('authorization'), `Bearer ${packageToken}`);
});

for (const [label, changes] of Object.entries({
  'local process': { GITHUB_ACTIONS: 'false' },
  'manual event': { GITHUB_EVENT_NAME: 'workflow_dispatch' },
  'another repository': { GITHUB_REPOSITORY: 'another/ai-modeling' },
  'another workflow': { GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/other.yml@${ref}` },
  branch: { GITHUB_REF: 'refs/heads/main' },
  'unexpected issuer host': { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.com/idtoken' },
  'redirectable HTTP issuer': {
    ACTIONS_ID_TOKEN_REQUEST_URL: 'http://pipelines.actions.githubusercontent.com/idtoken',
  },
  'issuer URL credentials': {
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://user:secret@pipelines.actions.githubusercontent.com/idtoken',
  },
}))
  test(`OIDC channel authentication rejects ${label} before sending any credential`, async () => {
    let calls = 0;
    await assert.rejects(
      setNpmChannelWithOidc(input, {
        env: environment(changes),
        now: () => now,
        fetcher: async () => {
          calls++;
          throw new Error('must not request');
        },
      }),
      NpmOidcChannelError,
    );
    assert.equal(calls, 0);
  });

for (const [label, changes] of Object.entries({
  environment: { sub: `repo:${repository}:environment:other` },
  repository: { repository: 'other/project' },
  workflow: { workflow_ref: `${repository}/.github/workflows/other.yml@${ref}` },
  tag: { ref: 'refs/tags/v0.1.5' },
  commit: { sha: 'b'.repeat(40) },
  audience: { aud: 'other-registry' },
  expiry: { exp: now / 1000 - 1 },
  issuer: { iss: 'https://example.com' },
}))
  test(`mismatched OIDC ${label} claim prevents npm exchange`, async () => {
    let calls = 0;
    await assert.rejects(
      setNpmChannelWithOidc(input, {
        env: environment(),
        now: () => now,
        fetcher: async () => {
          calls++;
          return Response.json({ value: identity(changes) });
        },
      }),
      /claims do not match/,
    );
    assert.equal(calls, 1);
  });

for (const stage of [1, 2, 3])
  test(`authentication stage ${stage} failures never leak response secrets or fall back to account tokens`, async () => {
    let calls = 0;
    const idToken = identity();
    const fetcher: typeof fetch = async () => {
      calls++;
      if (calls === stage)
        return new Response(JSON.stringify({ message: [requestToken, idToken, packageToken] }), {
          status: 403,
        });
      if (calls === 1) return Response.json({ value: idToken });
      return Response.json({ token: packageToken });
    };
    await assert.rejects(
      setNpmChannelWithOidc(input, { env: environment(), fetcher, now: () => now }),
      (error: unknown) => {
        assert.ok(error instanceof NpmOidcChannelError);
        for (const secret of [requestToken, idToken, packageToken])
          assert.equal(String(error).includes(secret), false);
        assert.match(error.message, /HTTP 403/);
        return true;
      },
    );
    assert.equal(calls, stage);
  });

test('network and redirect errors are sanitized even when transport exceptions contain credentials', async () => {
  await assert.rejects(
    setNpmChannelWithOidc(input, {
      env: environment(),
      now: () => now,
      fetcher: async () => {
        throw new Error(`request failed: ${requestToken}`);
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof NpmOidcChannelError);
      assert.equal(error.message.includes(requestToken), false);
      return true;
    },
  );
});

test('expired or persistent exchange credentials cannot reach the dist-tag mutation', async () => {
  for (const expires of [
    new Date(now - 1).toISOString(),
    new Date(now + 86400000).toISOString(),
    'invalid',
  ]) {
    let calls = 0;
    await assert.rejects(
      setNpmChannelWithOidc(input, {
        env: environment(),
        now: () => now,
        fetcher: async () => {
          calls++;
          return calls === 1
            ? Response.json({ value: identity() })
            : Response.json({ token: packageToken, expires });
        },
      }),
      /short-lived expiry/,
    );
    assert.equal(calls, 2);
  }
});

test('credential expiry is assessed after each network response using the current clock', async () => {
  let clock = now;
  let calls = 0;
  const checks: number[] = [];
  await setNpmChannelWithOidc(input, {
    env: environment(),
    now: () => {
      checks.push(clock);
      return clock;
    },
    fetcher: async () => {
      calls++;
      clock += 25000;
      if (calls === 1) return Response.json({ value: identity() });
      if (calls === 2)
        return Response.json({ token: packageToken, expires: new Date(clock + 3600000).toISOString() });
      return new Response(null, { status: 204 });
    },
  });
  assert.deepEqual(checks, [now + 25000, now + 50000]);
  assert.equal(calls, 3);
});

test('identity token that becomes too close to expiry during transport is rejected', async () => {
  let clock = now;
  let calls = 0;
  await assert.rejects(
    setNpmChannelWithOidc(input, {
      env: environment(),
      now: () => clock,
      fetcher: async () => {
        calls++;
        clock += 25000;
        return Response.json({ value: identity({ exp: now / 1000 + 30 }) });
      },
    }),
    /claims do not match/,
  );
  assert.equal(calls, 1);
});

test('remote backend performs explicit in-memory OIDC instead of an unauthenticated npm subprocess', async (t) => {
  t.mock.method(Date, 'now', () => now);
  const requests: string[] = [];
  const backend = new RemotePromotionBackend(
    repository,
    '.',
    '.',
    async (url, options = {}) => {
      requests.push(String(url));
      if (requests.length === 1) return Response.json({ value: identity() });
      if (requests.length === 2) return Response.json({ token: packageToken });
      assert.equal(new Headers(options.headers).get('authorization'), `Bearer ${packageToken}`);
      assert.equal(options.method, 'PUT');
      assert.equal(options.body, '"0.1.4"');
      return new Response(null, { status: 204 });
    },
    'synthetic-unused-github-token',
    environment(),
  );
  await backend.npmTag('latest', '0.1.4');
  assert.equal(requests.length, 3);
  assert.ok(requests[2]!.endsWith('/dist-tags/latest'));
});
