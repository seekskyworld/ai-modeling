import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { diagnose, type DoctorDependencies } from '../cli/doctor.ts';
import { setup, setupExitCode } from '../cli/setup.ts';
import type { Config } from '../cli/core/config.ts';
import type { LoginOptions, LoginStatus } from '../cli/auth/types.ts';
import { TripoError } from '../studio/contracts/errors.ts';
import { installedBrowser } from '../studio/auth/browser-discovery.ts';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-modeling-diagnostics-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config: Config = {
    dataDir: path.join(root, 'absent'),
    outputDir: '',
    inputRoots: [],
    keyringAccount: 'synthetic-diagnostics',
  };
  const dependencies: DoctorDependencies = {
    env: {},
    browser: () => '/synthetic/browser',
    nodeVersion: '24.0.0',
    platform: 'linux',
    home: root,
  };
  return { root, config, dependencies };
}
function loginStatus(authenticated = false): LoginStatus {
  return {
    profile: 'synthetic-diagnostics',
    status: authenticated ? 'authenticated' : 'waiting_for_login',
    authenticated,
    login_required: !authenticated,
    started_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60000).toISOString(),
  };
}

test('offline diagnostics never verify credentials, create state, or execute optional programs', async (t) => {
  const { config, dependencies } = await fixture(t);
  let calls = 0;
  const result = await diagnose(
    config,
    { offline: true },
    {
      ...dependencies,
      verify: async () => {
        calls++;
        throw new Error('forbidden');
      },
      programVersion: async () => {
        calls++;
        throw new Error('forbidden');
      },
    },
  );
  assert.equal(result.authenticated, null);
  assert.equal(result.login_required, false);
  assert.equal(calls, 0);
  await assert.rejects(stat(config.dataDir), { code: 'ENOENT' });
  assert.equal(result.checks.find((check) => check.name === 'credential_backend')?.status, 'not_checked');
});

test('diagnostics distinguish missing authentication, unavailable credentials and network errors', async (t) => {
  const { config, dependencies } = await fixture(t);
  for (const code of ['AUTH_REQUIRED', 'CREDENTIAL_STORE_UNAVAILABLE', 'NETWORK_ERROR']) {
    const result = await diagnose(
      config,
      {},
      {
        ...dependencies,
        verify: async () => {
          throw new TripoError(code, 'fixture');
        },
      },
    );
    assert.equal(result.login_required, code === 'AUTH_REQUIRED');
    assert.equal(result.session_error, code);
    if (code === 'CREDENTIAL_STORE_UNAVAILABLE') {
      assert.match(JSON.stringify(result.next_steps), /Unlock.*allow ai-modeling/);
      assert.equal(result.login_required, false);
    }
    assert.equal(result.authenticated, code === 'AUTH_REQUIRED' ? false : null);
    assert.equal(
      result.checks.find((check) => check.name === 'credential_backend')?.status,
      code === 'CREDENTIAL_STORE_UNAVAILABLE'
        ? 'unavailable'
        : code === 'AUTH_REQUIRED'
          ? 'available'
          : 'not_checked',
    );
  }
});

test('authenticated diagnostics omit account identifiers, credentials and proxy values', async (t) => {
  const { config, dependencies } = await fixture(t);
  const result = await diagnose(
    config,
    {},
    {
      ...dependencies,
      env: { HTTPS_PROXY: 'https://private:password@example.invalid' },
      verify: async () => ({
        authenticated: true,
        account_ref: 'PRIVATE_ID',
        token: 'PRIVATE_TOKEN',
        renewable: true,
      }),
    },
  );
  assert.equal(result.authenticated, true);
  assert.equal(result.login_required, false);
  const serialized = JSON.stringify(result);
  for (const secret of ['PRIVATE_ID', 'PRIVATE_TOKEN', 'private:password'])
    assert.equal(serialized.includes(secret), false);
  assert.ok(serialized.includes('HTTPS_PROXY'));
});

test('CDP diagnostics validate only local addresses and do not claim a live connection', async (t) => {
  const { config, dependencies } = await fixture(t);
  const good = await diagnose(config, { offline: true, cdpEndpoint: 'http://127.0.0.1:9222' }, dependencies);
  assert.equal(good.browser_mode, 'existing-browser');
  assert.equal(good.checks.find((check) => check.name === 'browser')?.status, 'configured_not_connected');
  const bad = await diagnose(
    config,
    { offline: true, cdpEndpoint: 'https://remote.example:9222' },
    dependencies,
  );
  assert.equal(bad.browser_ready, false);
  assert.equal(bad.ok, false);
});

test('feature diagnostics check selected executable builds and return actionable failures', async (t) => {
  const { root, config, dependencies } = await fixture(t);
  const executable = path.join(root, 'fixture-executable');
  await writeFile(executable, 'synthetic', { mode: 0o700 });
  const result = await diagnose(
    config,
    { offline: true, feature: 'video' },
    {
      ...dependencies,
      env: { AI_MODELING_BLENDER: executable, AI_MODELING_FFMPEG: executable },
      programVersion: async (program) =>
        program === 'blender' ? 'Blender 4.4.0' : 'ffmpeg version 8 --enable-libx264',
    },
  );
  assert.equal(result.checks.find((check) => check.name === 'blender')?.status, 'unsupported_build');
  assert.equal(result.checks.find((check) => check.name === 'ffmpeg')?.status, 'version_verified');
  assert.equal(result.ok, false);
});

test('browser discovery refuses directories and accepts only an explicit executable', async (t) => {
  const { root } = await fixture(t);
  assert.throws(() => installedBrowser(root), { code: 'BROWSER_NOT_FOUND' });
  const executable = path.join(root, 'browser');
  await writeFile(executable, 'synthetic', { mode: 0o700 });
  assert.equal(installedBrowser(executable), executable);
});

test('setup with an authenticated session neither prompts nor starts login', async (t) => {
  const { config, dependencies } = await fixture(t);
  const result = await setup(
    config,
    {},
    {
      diagnosticDependencies: { ...dependencies, verify: async () => ({ authenticated: true }) },
      interactive: true,
      ask: async () => assert.fail('unexpected prompt'),
      login: async () => assert.fail('unexpected login'),
    },
  );
  assert.equal(result.authenticated, true);
  assert.equal(result.login_started, false);
  assert.equal(result.login_required, false);
});

test('setup check/offline and non-auth failures never start a login flow', async (t) => {
  const { config, dependencies } = await fixture(t);
  for (const options of [{ check: true }, { offline: true }, {}]) {
    const result = await setup(config, options, {
      diagnosticDependencies: {
        ...dependencies,
        verify: async () => {
          throw new TripoError('NETWORK_ERROR', 'fixture');
        },
      },
      login: async () => assert.fail('unexpected login'),
    });
    assert.equal(result.login_started, false);
  }
});

test('noninteractive setup returns a bounded flow without opening a browser or waiting', async (t) => {
  const { config, dependencies } = await fixture(t);
  let captured: LoginOptions | undefined;
  const result = await setup(
    config,
    { timeoutMs: 1200 },
    {
      env: {},
      interactive: false,
      diagnosticDependencies: {
        ...dependencies,
        verify: async () => {
          throw new TripoError('AUTH_REQUIRED', 'fixture');
        },
      },
      login: async (options) => {
        captured = options;
        return loginStatus();
      },
    },
  );
  assert.equal(result.login_started, true);
  assert.equal(result.setup_status, 'waiting_for_login');
  assert.equal(captured?.open, false);
  assert.equal(captured?.wait, false);
  assert.equal(captured?.timeoutMs, 1200);
});

test('interactive setup selects authorized CDP and prints the login instruction only once', async (t) => {
  const { config, dependencies } = await fixture(t);
  const answers = ['2', 'http://127.0.0.1:9222'];
  let prompts = 0,
    notices = 0;
  const result = await setup(
    config,
    {},
    {
      env: {},
      interactive: true,
      diagnosticDependencies: {
        ...dependencies,
        verify: async () => {
          throw new TripoError('AUTH_REQUIRED', 'fixture');
        },
      },
      ask: async () => {
        prompts++;
        return answers.shift()!;
      },
      announce: () => {
        notices++;
      },
      login: async (options) => {
        assert.equal(options.cdpEndpoint, 'http://127.0.0.1:9222/');
        assert.equal(options.wait, true);
        assert.equal(options.open, true);
        options.onStatus?.(loginStatus());
        options.onStatus?.(loginStatus());
        return loginStatus(true);
      },
    },
  );
  assert.equal(prompts, 2);
  assert.equal(notices, 1);
  assert.equal(result.authenticated, true);
});

test('setup propagates cancellation and removes its process signal listeners after login', async (t) => {
  const { config, dependencies } = await fixture(t),
    abort = new AbortController();
  const before = process.listenerCount('SIGINT');
  await setup(
    config,
    { signal: abort.signal },
    {
      env: {},
      interactive: false,
      diagnosticDependencies: {
        ...dependencies,
        verify: async () => {
          throw new TripoError('AUTH_REQUIRED', 'fixture');
        },
      },
      login: async (options) => {
        abort.abort();
        assert.equal(options.signal?.aborted, true);
        return { ...loginStatus(), status: 'cancelled' };
      },
    },
  );
  assert.equal(process.listenerCount('SIGINT'), before);
});

test('already cancelled setup never reads credentials or prompts', async (t) => {
  const { config } = await fixture(t);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    setup(
      config,
      { signal: abort.signal },
      {
        diagnostics: async () => assert.fail('unexpected diagnostics'),
        ask: async () => assert.fail('unexpected prompt'),
      },
    ),
    { code: 'LOGIN_CANCELLED' },
  );
});

test('setup cancellation during diagnostics prevents subsequent prompts and login', async (t) => {
  const { config, dependencies } = await fixture(t);
  const controller = new AbortController();
  await assert.rejects(
    setup(
      config,
      { signal: controller.signal },
      {
        env: {},
        interactive: true,
        diagnosticDependencies: {
          ...dependencies,
          verify: async () => {
            controller.abort();
            throw new TripoError('AUTH_REQUIRED', 'fixture');
          },
        },
        ask: async () => assert.fail('unexpected prompt'),
        login: async () => assert.fail('unexpected login'),
      },
    ),
    { code: 'LOGIN_CANCELLED' },
  );
});

test('setup cancellation while selecting instructions is not reported as success', async (t) => {
  const { config, dependencies } = await fixture(t);
  const controller = new AbortController();
  await assert.rejects(
    setup(
      config,
      { signal: controller.signal },
      {
        env: {},
        interactive: true,
        diagnosticDependencies: {
          ...dependencies,
          verify: async () => {
            throw new TripoError('AUTH_REQUIRED', 'fixture');
          },
        },
        ask: async () => {
          controller.abort();
          return '3';
        },
        login: async () => assert.fail('unexpected login'),
      },
    ),
    { code: 'LOGIN_CANCELLED' },
  );
});

test('setup exit status distinguishes terminal failures from a pending background handoff', () => {
  for (const setup_status of ['failed', 'expired', 'cancelled', 'blocked', 'needs_configuration'])
    assert.equal(setupExitCode({ setup_status }), 1);
  assert.equal(setupExitCode({ setup_status: 'diagnostics', ok: false }), 1);
  for (const setup_status of ['waiting_for_login', 'verifying', 'ready', 'instructions'])
    assert.equal(setupExitCode({ setup_status }), 0);
});

test('real CLI exposes pricing guides and performs offline setup without creating an application', async (t) => {
  const { config } = await fixture(t);
  const entry = fileURLToPath(new URL('../cli/main.ts', import.meta.url));
  const env = { ...process.env, AI_MODELING_DATA_DIR: config.dataDir };
  const checked = spawnSync(process.execPath, [entry, '--json', 'setup', '--check', '--offline'], {
    env,
    encoding: 'utf8',
  });
  const result = JSON.parse(checked.stdout);
  assert.equal(result.setup_status, 'diagnostics');
  assert.equal(result.login_started, false);
  assert.equal(checked.status, result.ok ? 0 : 1);
  const price = spawnSync(process.execPath, [entry, '--json', 'pricing', 'status'], {
    env,
    encoding: 'utf8',
  });
  assert.equal(price.status, 0, price.stderr);
  assert.equal(JSON.parse(price.stdout).network_used, false);
  const guide = spawnSync(process.execPath, [entry, 'guides', 'read', 'commands/pricing/update'], {
    env,
    encoding: 'utf8',
  });
  assert.equal(guide.status, 0, guide.stderr);
  assert.match(JSON.parse(guide.stdout).text, /--sha256/);
  await assert.rejects(stat(config.dataDir), { code: 'ENOENT' });
});
