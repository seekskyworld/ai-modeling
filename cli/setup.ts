/** Guided connection uses the existing login coordinator; it never asks for a token. */
import { createInterface } from 'node:readline/promises';
import type { Config } from './core/config.ts';
import { diagnose, type DoctorDependencies, type DoctorOptions } from './doctor.ts';
import { ensureLogin } from './auth/coordinator.ts';
import type { LoginOptions, LoginStatus } from './auth/types.ts';
import { resolveLoginBrowserOptions } from './auth/browser-options.ts';
import { installedBrowser } from '../studio/auth/browser-discovery.ts';
import { loopbackCdpEndpoint } from '../studio/auth/browser-login-cdp.ts';
import { TripoError } from '../studio/contracts/errors.ts';

export interface SetupOptions extends DoctorOptions {
  check?: boolean;
  wait?: boolean;
  open?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface SetupDependencies {
  diagnostics?: (config: Config, options: DoctorOptions) => ReturnType<typeof diagnose>;
  diagnosticDependencies?: DoctorDependencies;
  login?: (options: LoginOptions) => Promise<LoginStatus>;
  interactive?: boolean;
  ask?: (question: string) => Promise<string>;
  announce?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
}

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new TripoError('LOGIN_CANCELLED', 'Setup was cancelled.', 'not_submitted');
}

async function selectBrowser(options: SetupOptions, dependencies: SetupDependencies, interactive: boolean) {
  let browser = resolveLoginBrowserOptions(options, dependencies.env ?? process.env);
  let prompt: ReturnType<typeof createInterface> | undefined;
  const ask =
    dependencies.ask ??
    (async (question: string) => {
      prompt ??= createInterface({ input: process.stdin, output: process.stderr });
      return await prompt.question(question, { signal: options.signal });
    });
  try {
    if (interactive && !browser.cdpEndpoint && !browser.executablePath) {
      const choice =
        (
          await ask(
            'Connect Studio: 1) open a dedicated Chrome/Edge window  2) connect an authorized local browser endpoint  3) show instructions only [1]: ',
          )
        ).trim() || '1';
      assertActive(options.signal);
      if (choice === '3') return null;
      if (choice === '2') {
        const endpoint = (await ask('Local CDP endpoint (for example http://127.0.0.1:9222): ')).trim();
        assertActive(options.signal);
        browser = { cdpEndpoint: loopbackCdpEndpoint(endpoint).href };
      } else if (choice === '1')
        browser = { executablePath: (dependencies.diagnosticDependencies?.browser ?? installedBrowser)() };
      else throw new TripoError('INVALID_INPUT', 'Choose setup option 1, 2 or 3.');
    }
  } catch (error) {
    assertActive(options.signal);
    throw error;
  } finally {
    prompt?.close();
  }
  if (browser.cdpEndpoint) loopbackCdpEndpoint(browser.cdpEndpoint);
  return browser;
}

async function connect(
  config: Config,
  options: SetupOptions,
  dependencies: SetupDependencies,
  interactive: boolean,
  browser: NonNullable<Awaited<ReturnType<typeof selectBrowser>>>,
) {
  let announced = false;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  let login: LoginStatus;
  try {
    login = await (dependencies.login ?? ensureLogin)({
      ...browser,
      config,
      open: options.open ?? interactive,
      wait: options.wait ?? interactive,
      timeoutMs: options.timeoutMs,
      signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal,
      onStatus: (status) => {
        if (!interactive || announced || status.authenticated) return;
        announced = true;
        const message =
          'Complete sign-in in the Studio window. This command continues automatically.\n' +
          (status.login_url ? status.login_url + '\n' : '');
        (dependencies.announce ?? ((value) => process.stderr.write(value)))(message);
      },
    });
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
  return login;
}

export async function setup(
  config: Config,
  options: SetupOptions = {},
  dependencies: SetupDependencies = {},
) {
  assertActive(options.signal);
  resolveLoginBrowserOptions(options, dependencies.env ?? process.env);
  const report = await (
    dependencies.diagnostics ??
    ((current, selected) => diagnose(current, selected, dependencies.diagnosticDependencies))
  )(config, options);
  assertActive(options.signal);
  if (options.check || options.offline)
    return { ...report, setup_status: 'diagnostics', login_started: false };
  if (report.authenticated)
    return {
      ...report,
      setup_status: report.ok ? 'ready' : 'needs_configuration',
      authenticated: true,
      login_required: false,
      login_started: false,
    };
  if (report.session_error !== 'AUTH_REQUIRED')
    return { ...report, setup_status: 'blocked', login_started: false };
  const interactive = dependencies.interactive ?? Boolean(process.stdin.isTTY && process.stderr.isTTY);
  const browser = await selectBrowser(options, dependencies, interactive);
  assertActive(options.signal);
  if (!browser) return { ...report, setup_status: 'instructions', login_started: false };
  const login = await connect(config, options, dependencies, interactive, browser);
  const prerequisites = report.checks.every(
    (check) => !check.required || check.ok || check.name === 'studio_session_network',
  );
  return {
    ok: login.authenticated && prerequisites,
    setup_status: login.authenticated ? (prerequisites ? 'ready' : 'needs_configuration') : login.status,
    authenticated: login.authenticated,
    login_required: login.login_required,
    login_started: true,
    login,
    checks: report.checks.filter((check) => check.name !== 'studio_session_network'),
    next_steps: login.authenticated
      ? [
          ...report.next_steps.filter((step) => !step.startsWith('Run ai-modeling setup')),
          'Run ai-modeling balance or connect your MCP client using ai-modeling mcp.',
        ]
      : ['Complete the returned login flow and reuse the original request or task identity.'],
  };
}

/** Pending background flows are successful handoffs; terminal failures are not. */
export function setupExitCode(result: { setup_status: string; ok?: boolean }): number {
  if (['blocked', 'failed', 'expired', 'cancelled', 'needs_configuration'].includes(result.setup_status))
    return 1;
  if (result.setup_status === 'diagnostics' && !result.ok) return 1;
  return 0;
}
