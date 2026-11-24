import assert from 'node:assert/strict';
import { access, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { checkNpmAuthentication, runNpmAuthCheck } from '../scripts/npm-auth-check.ts';
import { exchangeNpmOidcCredential } from '../scripts/npm-oidc-auth.ts';

const repository = 'seekskyworld/ai-modeling';
const ref = 'refs/tags/v0.1.8';
const workflow = `${repository}/.github/workflows/release.yml@${ref}`;
const now = Date.parse('2026-11-25T00:00:00Z');
const requestToken = 'synthetic-auth-check-github-secret';
const packageToken = 'synthetic-auth-check-npm-secret';
const overrideToken = 'synthetic-auth-check-override-secret';
const responseSecret = 'synthetic-auth-check-private-response-body';
const requestUrl =
  'https://pipelines.actions.githubusercontent.com/synthetic/_apis/jobs/job/idtoken?api-version=2.0';
const exchangeUrl =
  'https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/@seekskyworld%2fai-modeling';

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
    CI: 'true',
    NPM_ID_TOKEN: '',
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REPOSITORY: repository,
    GITHUB_REF: ref,
    GITHUB_WORKFLOW_REF: workflow,
    GITHUB_SHA: 'a'.repeat(40),
    ACTIONS_ID_TOKEN_REQUEST_URL: requestUrl,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: requestToken,
    ...changes,
  };
  for (const name of ['NODE_AUTH_TOKEN', 'NPM_TOKEN', 'npm_config_userconfig', 'npm_config_registry'])
    Object.defineProperty(env, name, {
      get() {
        throw new Error('The preflight must not read account credentials or local npm configuration');
      },
    });
  return env;
}

function transport(responses?: (() => Response | Promise<Response>)[]) {
  const calls: { url: string; options: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, options = {}) => {
    const url = String(input);
    calls.push({ url, options });
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.body, undefined);
    if (calls.length === 1) {
      const expected = new URL(requestUrl);
      expected.searchParams.set('audience', 'npm:registry.npmjs.org');
      assert.equal(url, expected.href);
      assert.equal(options.method ?? 'GET', 'GET');
      assert.equal(new Headers(options.headers).get('authorization'), `Bearer ${requestToken}`);
    } else {
      assert.equal(calls.length, 2, 'Authentication must never upload a package or update a dist-tag');
      assert.equal(url, exchangeUrl);
      assert.equal(options.method, 'POST');
    }
    if (responses) return responses[calls.length - 1]!();
    return calls.length === 1
      ? Response.json({ value: identity() })
      : Response.json({ token: packageToken, expires: new Date(now + 300000).toISOString() });
  };
  return { calls, fetcher };
}

function dependencies(fetcher: typeof fetch, env = environment()) {
  return {
    env,
    fetcher,
    now: () => now,
    versions: async () => ({ node: 'v24.22.3', npm: '11.17.0' }),
  };
}

function noSecrets(value: unknown, extra: string[] = []) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [
    requestToken,
    packageToken,
    overrideToken,
    responseSecret,
    requestUrl,
    identity(),
    ...extra,
  ])
    assert.equal(serialized.includes(secret), false, 'Credential-bearing diagnostics must not escape');
  assert.equal(serialized.includes('Bearer '), false);
}

function captureConsole(t: TestContext) {
  const output: unknown[] = [];
  for (const method of ['log', 'error', 'warn', 'info', 'debug'] as const)
    t.mock.method(console, method, (...args: unknown[]) => {
      output.push(args);
    });
  t.after(() => noSecrets(output));
  return output;
}

function safeReport(report: Awaited<ReturnType<typeof checkNpmAuthentication>>) {
  assert.equal(report.schema_version, 1);
  assert.equal(typeof report.success, 'boolean');
  assert.deepEqual(
    Object.keys(report).sort(),
    [
      'schema_version',
      'success',
      'tools',
      'presence',
      'stages',
      ...(report.failure ? ['failure'] : []),
    ].sort(),
  );
  assert.deepEqual(Object.keys(report.tools).sort(), ['node', 'npm']);
  assert.deepEqual(
    Object.keys(report.presence).sort(),
    [
      'github_actions',
      'github_event_name',
      'github_repository',
      'github_ref',
      'github_workflow_ref',
      'github_sha',
      'github_oidc_request_url',
      'github_oidc_request_token',
      'npm_id_token',
      'ci_disabled',
    ].sort(),
  );
  for (const present of Object.values(report.presence)) assert.equal(typeof present, 'boolean');
  for (const stage of report.stages) {
    assert.ok(
      [
        'runtime',
        'npm_environment',
        'workflow_identity',
        'github_oidc',
        'github_claims',
        'npm_exchange',
        'npm_credential',
      ].includes(stage.stage),
    );
    assert.ok(['passed', 'failed'].includes(stage.outcome));
    assert.deepEqual(
      Object.keys(stage).sort(),
      ['stage', 'outcome', ...(stage.http_status === undefined ? [] : ['http_status'])].sort(),
    );
  }
  if (report.failure)
    assert.deepEqual(
      Object.keys(report.failure).sort(),
      ['stage', 'code', ...(report.failure.http_status === undefined ? [] : ['http_status'])].sort(),
    );
  noSecrets(report);
}

async function fixture(t: TestContext) {
  captureConsole(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-auth-preflight-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'report.json');
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    directory,
    output,
    stdout,
    stderr,
    args: ['--repository', repository, '--out', output],
    writers: {
      stdout: (text: string) => {
        stdout.push(text);
      },
      stderr: (text: string) => {
        stderr.push(text);
      },
    },
  };
}

test('authentication obtains an in-memory package credential with exactly one issuer GET and exchange POST', async (t) => {
  const logs = captureConsole(t);
  const network = transport();
  const report = await checkNpmAuthentication({ repository }, dependencies(network.fetcher));
  assert.equal(report.success, true);
  assert.equal(report.failure, undefined);
  assert.deepEqual(report.tools, { node: 'v24.22.3', npm: '11.17.0' });
  safeReport(report);
  assert.equal(network.calls.length, 2);
  assert.equal(new Headers(network.calls[1]!.options.headers).get('authorization'), `Bearer ${identity()}`);
  assert.deepEqual(logs, []);
});

test('GitHub runner opaque endpoint paths retain their query and use the same package exchange', async (t) => {
  const logs = captureConsole(t);
  const endpoint =
    'https://run-actions-3-azure-eastus.actions.githubusercontent.com/synthetic/run/opaque/credential?request=synthetic%2Fopaque&item=one&item=two&audience=previous&api-version=2.0';
  const original = new URL(endpoint);
  let calls = 0;
  const fetcher: typeof fetch = async (input, options = {}) => {
    calls++;
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.body, undefined);
    assert.ok(options.signal instanceof AbortSignal);
    if (calls === 1) {
      const actual = new URL(String(input));
      assert.equal(actual.origin, original.origin);
      assert.equal(actual.pathname, original.pathname);
      assert.deepEqual(actual.searchParams.getAll('audience'), ['npm:registry.npmjs.org']);
      assert.deepEqual(
        [...actual.searchParams].filter(([key]) => key !== 'audience'),
        [...original.searchParams].filter(([key]) => key !== 'audience'),
      );
      assert.equal(options.method ?? 'GET', 'GET');
      assert.equal(new Headers(options.headers).get('authorization'), `Bearer ${requestToken}`);
      return Response.json({ value: identity() });
    }
    assert.equal(calls, 2, 'Opaque endpoints must not add an upload or a channel write');
    assert.equal(String(input), exchangeUrl);
    assert.equal(options.method, 'POST');
    assert.equal(new Headers(options.headers).get('authorization'), `Bearer ${identity()}`);
    return Response.json({ token: packageToken });
  };
  const report = await checkNpmAuthentication(
    { repository },
    dependencies(fetcher, environment({ ACTIONS_ID_TOKEN_REQUEST_URL: endpoint })),
  );
  assert.equal(report.success, true);
  assert.equal(calls, 2);
  safeReport(report);
  noSecrets(report, [endpoint]);
  assert.deepEqual(logs, []);
});

for (const [label, endpoint] of [
  ['HTTP issuer', 'http://run-actions-3-azure-eastus.actions.githubusercontent.com/synthetic/opaque'],
  ['foreign host', 'https://example.com/synthetic/opaque'],
  ['suffix spoof', 'https://run-actions.actions.githubusercontent.com.example.com/synthetic/opaque'],
  ['missing host boundary', 'https://notactions.githubusercontent.com/synthetic/opaque'],
  ['userinfo', 'https://user:synthetic-password@run-actions.actions.githubusercontent.com/synthetic/opaque'],
  ['non-default port', 'https://run-actions.actions.githubusercontent.com:8443/synthetic/opaque'],
  ['fragment', 'https://run-actions.actions.githubusercontent.com/synthetic/opaque#synthetic-fragment'],
] as const)
  test(`an opaque path does not permit ${label} or disclose the rejected endpoint`, async () => {
    const network = transport();
    const report = await checkNpmAuthentication(
      { repository },
      dependencies(network.fetcher, environment({ ACTIONS_ID_TOKEN_REQUEST_URL: endpoint })),
    );
    assert.equal(report.success, false);
    assert.deepEqual(report.failure, { stage: 'workflow_identity', code: 'REQUEST_ENDPOINT' });
    assert.equal(network.calls.length, 0);
    safeReport(report);
    noSecrets(report, [endpoint]);
  });

for (const [changes, code] of [
  [{ CI: 'false' }, 'CI_FALSE'],
  [{ NPM_ID_TOKEN: overrideToken }, 'NPM_ID_TOKEN_OVERRIDE'],
] as const)
  test(`${code} blocks the npm preflight even when the strict exchange itself succeeds`, async () => {
    const env = environment(changes);
    const direct = transport();
    const credential = await exchangeNpmOidcCredential(
      { repository },
      { env, fetcher: direct.fetcher, now: () => now },
    );
    assert.equal(credential, packageToken);
    assert.equal(direct.calls.length, 2);
    const preflight = transport();
    const report = await checkNpmAuthentication({ repository }, dependencies(preflight.fetcher, env));
    assert.equal(report.success, false);
    assert.equal(report.failure?.code, code);
    assert.equal(preflight.calls.length, 0);
    safeReport(report);
  });

for (const [label, changes, code] of [
  ['disabled CI', { CI: 'false' }, 'CI_FALSE'],
  ['overridden identity token', { NPM_ID_TOKEN: overrideToken }, 'NPM_ID_TOKEN_OVERRIDE'],
  ['missing GitHub Actions', { GITHUB_ACTIONS: undefined }, 'WORKFLOW_IDENTITY'],
  ['manual workflow', { GITHUB_EVENT_NAME: 'workflow_dispatch' }, 'WORKFLOW_IDENTITY'],
  ['foreign repository', { GITHUB_REPOSITORY: 'other/project' }, 'WORKFLOW_IDENTITY'],
  [
    'foreign workflow',
    { GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/other.yml@${ref}` },
    'WORKFLOW_IDENTITY',
  ],
  ['branch reference', { GITHUB_REF: 'refs/heads/main' }, 'WORKFLOW_IDENTITY'],
  ['missing source', { GITHUB_SHA: undefined }, 'WORKFLOW_IDENTITY'],
  ['missing issuer URL', { ACTIONS_ID_TOKEN_REQUEST_URL: undefined }, 'REQUEST_ENDPOINT'],
  ['missing issuer credential', { ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined }, 'REQUEST_ENDPOINT'],
  ['untrusted issuer', { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.com/idtoken' }, 'REQUEST_ENDPOINT'],
] as const)
  test(`${label} fails before any exchange even when the synthetic service would accept it`, async () => {
    const network = transport();
    const report = await checkNpmAuthentication(
      { repository },
      dependencies(network.fetcher, environment(changes)),
    );
    assert.equal(report.success, false);
    assert.equal(report.failure?.code, code);
    assert.equal(network.calls.length, 0);
    safeReport(report);
  });

for (const [label, claims] of Object.entries({
  audience: { aud: 'different-registry' },
  repository: { repository: 'other/project' },
  environment: { sub: `repo:${repository}:environment:other` },
  workflow: { workflow_ref: `${repository}/.github/workflows/other.yml@${ref}` },
  tag: { ref: 'refs/tags/v0.1.9' },
  source: { sha: 'b'.repeat(40) },
  issuer: { iss: 'https://example.com' },
  expired: { exp: now / 1000 - 1 },
}))
  test(`a mismatched ${label} claim stops before the package exchange`, async () => {
    const idToken = identity(claims);
    const network = transport([() => Response.json({ value: idToken })]);
    const report = await checkNpmAuthentication({ repository }, dependencies(network.fetcher));
    assert.equal(report.success, false);
    assert.equal(report.failure?.code, 'CLAIMS_INVALID');
    assert.equal(report.failure?.stage, 'github_claims');
    assert.equal(network.calls.length, 1);
    safeReport(report);
    noSecrets(report, [idToken]);
  });

for (const [count, stage] of [
  [1, 'github_oidc'],
  [2, 'npm_exchange'],
] as const)
  test(`HTTP rejection at ${stage} reports status without leaking response content`, async (t) => {
    captureConsole(t);
    const failure = () =>
      new Response(
        JSON.stringify({ message: [responseSecret, requestToken, identity(), packageToken, requestUrl] }),
        { status: 403 },
      );
    const network = transport(
      count === 1 ? [failure] : [() => Response.json({ value: identity() }), failure],
    );
    const report = await checkNpmAuthentication({ repository }, dependencies(network.fetcher));
    assert.equal(report.success, false);
    assert.deepEqual(report.failure, { stage, code: 'HTTP_ERROR', http_status: 403 });
    assert.equal(network.calls.length, count);
    safeReport(report);
  });

for (const [label, exchanged, code] of [
  ['empty credential', { token: '' }, 'CREDENTIAL_INVALID'],
  ['missing credential', {}, 'CREDENTIAL_INVALID'],
  [
    'expired credential',
    { token: packageToken, expires: new Date(now - 1).toISOString() },
    'CREDENTIAL_EXPIRY',
  ],
  [
    'persistent credential',
    { token: packageToken, expires: new Date(now + 86400000).toISOString() },
    'CREDENTIAL_EXPIRY',
  ],
  ['invalid expiry', { token: packageToken, expires: 'invalid' }, 'CREDENTIAL_EXPIRY'],
] as const)
  test(`${label} is rejected without exposing the package token`, async () => {
    const network = transport([() => Response.json({ value: identity() }), () => Response.json(exchanged)]);
    const report = await checkNpmAuthentication({ repository }, dependencies(network.fetcher));
    assert.equal(report.success, false);
    assert.equal(report.failure?.stage, 'npm_credential');
    assert.equal(report.failure?.code, code);
    assert.equal(network.calls.length, 2);
    safeReport(report);
  });

for (const [label, response, code] of [
  ['missing identity token', () => Response.json({ message: responseSecret }), 'IDENTITY_TOKEN_INVALID'],
  ['non-object issuer response', () => Response.json([responseSecret]), 'RESPONSE_INVALID'],
  ['unreadable issuer response', () => new Response(responseSecret), 'RESPONSE_UNREADABLE'],
  ['oversized issuer response', () => new Response(responseSecret.repeat(7000)), 'RESPONSE_OVERSIZED'],
] as const)
  test(`${label} cannot reach an exchange or leak its body`, async () => {
    const network = transport([response]);
    const report = await checkNpmAuthentication({ repository }, dependencies(network.fetcher));
    assert.equal(report.success, false);
    assert.equal(report.failure?.code, code);
    assert.equal(network.calls.length, 1);
    safeReport(report);
  });

test('transport exceptions and version failures are reduced to fixed report codes', async (t) => {
  captureConsole(t);
  const poison = [requestToken, identity(), packageToken, requestUrl, responseSecret].join(' ');
  const network = transport([
    () => {
      throw new Error(poison);
    },
  ]);
  const transportReport = await checkNpmAuthentication({ repository }, dependencies(network.fetcher));
  assert.equal(transportReport.failure?.code, 'REQUEST_FAILED');
  safeReport(transportReport);
  const unused = transport();
  const versionReport = await checkNpmAuthentication(
    { repository },
    {
      ...dependencies(unused.fetcher),
      versions: async () => {
        throw new Error(poison);
      },
    },
  );
  assert.equal(versionReport.failure?.code, 'VERSION_UNAVAILABLE');
  assert.equal(unused.calls.length, 0);
  safeReport(versionReport);
});

test('unsupported runtime stops before network authentication', async () => {
  const network = transport();
  const report = await checkNpmAuthentication(
    { repository },
    {
      ...dependencies(network.fetcher),
      versions: async () => ({ node: 'v20.20.0', npm: '10.9.0' }),
    },
  );
  assert.equal(report.failure?.code, 'UNSUPPORTED_RUNTIME');
  assert.equal(network.calls.length, 0);
  safeReport(report);
});

test('untrusted version output cannot copy credentials into the safe diagnostics', async (t) => {
  captureConsole(t);
  const network = transport();
  const report = await checkNpmAuthentication(
    { repository },
    {
      ...dependencies(network.fetcher),
      versions: async () => ({ node: requestToken, npm: identity() }),
    },
  );
  assert.equal(report.success, false);
  assert.equal(report.failure?.code, 'VERSION_UNAVAILABLE');
  assert.equal(network.calls.length, 0);
  assert.deepEqual(report.tools, { node: null, npm: null });
  safeReport(report);
});

for (const oversized of [false, true])
  test(`rejected body cancellation preserves the ${oversized ? 'size limit' : 'HTTP status'} without leaking its error`, async (t) => {
    captureConsole(t);
    const network = transport([
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              if (oversized) controller.enqueue(new TextEncoder().encode(responseSecret.repeat(7000)));
            },
            cancel() {
              throw new Error([requestToken, identity(), responseSecret, requestUrl].join(' '));
            },
          }),
          { status: oversized ? 200 : 403 },
        ),
    ]);
    const report = await checkNpmAuthentication({ repository }, dependencies(network.fetcher));
    assert.equal(report.success, false);
    assert.equal(report.failure?.code, oversized ? 'RESPONSE_OVERSIZED' : 'HTTP_ERROR');
    if (!oversized) assert.equal(report.failure?.http_status, 403);
    assert.equal(network.calls.length, 1);
    safeReport(report);
  });

test('an unexpected environment exception becomes a fixed internal failure without raw diagnostics', async (t) => {
  captureConsole(t);
  const network = transport();
  const env = environment();
  Object.defineProperty(env, 'GITHUB_REPOSITORY', {
    get() {
      throw new Error([requestToken, identity(), packageToken, requestUrl].join(' '));
    },
  });
  const report = await checkNpmAuthentication({ repository }, dependencies(network.fetcher, env));
  assert.equal(report.success, false);
  assert.equal(report.failure?.code, 'INTERNAL_ERROR');
  assert.equal(network.calls.length, 0);
  safeReport(report);
});

for (const allowed of [true, false])
  test(`CLI ${allowed ? 'success' : 'authentication failure'} persists a safe private report before returning its exit code`, async (t) => {
    const f = await fixture(t);
    const network = transport(allowed ? undefined : [() => new Response(responseSecret, { status: 403 })]);
    const exit = await runNpmAuthCheck(f.args, { ...dependencies(network.fetcher), ...f.writers });
    assert.equal(exit, allowed ? 0 : 1);
    const report = JSON.parse(await readFile(f.output, 'utf8'));
    assert.equal(report.success, allowed);
    safeReport(report);
    if (process.platform !== 'win32') assert.equal((await lstat(f.output)).mode & 0o777, 0o600);
    noSecrets(f.stdout.join('') + f.stderr.join(''));
    assert.equal(network.calls.length, allowed ? 2 : 1);
  });

test('CLI reserves the report before authentication and refuses to overwrite any existing report', async (t) => {
  const f = await fixture(t);
  const network = transport();
  const fetcher: typeof fetch = async (url, options) => {
    await access(f.output);
    return network.fetcher(url, options);
  };
  const deps = { ...dependencies(fetcher), ...f.writers };
  assert.equal(await runNpmAuthCheck(f.args, deps), 0);
  const original = await readFile(f.output);
  assert.equal(await runNpmAuthCheck(f.args, deps), 1);
  assert.deepEqual(await readFile(f.output), original);
  assert.equal(network.calls.length, 2);
  noSecrets(f.stdout.join('') + f.stderr.join(''));
});

test('CLI rejects invalid arguments, absent parent and existing files before network calls', async (t) => {
  const f = await fixture(t);
  await writeFile(f.output, 'keep-original');
  const network = transport();
  const deps = { ...dependencies(network.fetcher), ...f.writers };
  for (const args of [
    [],
    ['--repository', repository],
    ['--repository', repository, '--out', f.output],
    ['--repository', repository, '--out', path.join(f.directory, 'missing', 'report.json')],
    ['--repository', repository, '--out', f.directory],
    ['--repository', repository, '--out', path.join(f.directory, 'unused.json'), '--secret', requestToken],
  ])
    assert.equal(await runNpmAuthCheck(args, deps), 1);
  assert.equal(network.calls.length, 0);
  assert.equal(await readFile(f.output, 'utf8'), 'keep-original');
  await assert.rejects(access(path.join(f.directory, 'unused.json')));
  await assert.rejects(access(path.join(f.directory, 'missing')));
  noSecrets(f.stdout.join('') + f.stderr.join(''));
});
