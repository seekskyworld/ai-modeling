/** Read-only diagnostics; offline mode never reads credentials, creates state or contacts Studio. */
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Config } from './core/config.ts';
import { environmentValue } from './core/environment.ts';
import { resolveLoginBrowserOptions } from './auth/browser-options.ts';
import { installedBrowser } from '../studio/auth/browser-discovery.ts';
import { loopbackCdpEndpoint } from '../studio/auth/browser-login-cdp.ts';
import { KeyringStore } from '../studio/auth/credentials.ts';
import { verifyCredential } from '../studio/auth/import.ts';
import { networkFetch } from '../studio/api/client.ts';
import { pricingStatus } from '../studio/api/pricing-maintenance.ts';
import { runtimeStatus } from './runtime/assets.ts';
import { TripoError, errorResult, object } from '../studio/contracts/errors.ts';

export type DoctorFeature = 'core' | 'render' | 'video' | 'frontend-export';
export interface DoctorOptions {
  offline?: boolean;
  feature?: DoctorFeature;
  cdpEndpoint?: string;
  executablePath?: string;
}
export interface Check {
  name: string;
  ok: boolean;
  required: boolean;
  status?: string;
  code?: string;
  detail?: unknown;
}
export interface DoctorDependencies {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  nodeVersion?: string;
  verify?: (profile: string) => Promise<Record<string, unknown>>;
  browser?: (explicit?: string) => string;
  programVersion?: (program: 'blender' | 'ffmpeg', executable: string) => Promise<string>;
}

async function verifySavedSession(profile: string) {
  const session = new KeyringStore(profile).load();
  if (!session) throw new TripoError('AUTH_REQUIRED', 'No saved Studio session is available.');
  const signal = AbortSignal.timeout(15000);
  const verified = await verifyCredential(session, (url, init) =>
    networkFetch(url, {
      ...init,
      signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal,
    }),
  );
  return verified.result;
}

async function writableStateDirectory(directory: string): Promise<boolean> {
  let current = directory;
  for (;;) {
    try {
      const info = await stat(current);
      if (!info.isDirectory()) return false;
      await access(current, constants.R_OK | constants.W_OK | constants.X_OK);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      const parent = path.dirname(current);
      if (current === parent) return false;
      current = parent;
    }
  }
}

async function findProgram(name: 'blender' | 'ffmpeg', env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  const explicit = environmentValue(name.toUpperCase(), env);
  const executable = platform === 'win32' ? `${name}.exe` : name;
  const candidates = explicit
    ? [explicit]
    : [
        ...(env.PATH ?? '')
          .split(path.delimiter)
          .filter(Boolean)
          .map((directory) => path.join(directory, executable)),
        ...(name === 'blender' && platform === 'darwin'
          ? ['/Applications/Blender.app/Contents/MacOS/Blender']
          : []),
      ];
  for (const candidate of candidates) {
    try {
      if (path.isAbsolute(candidate) && (await stat(candidate)).isFile()) {
        await access(candidate, constants.X_OK);
        return candidate;
      }
    } catch {
      /* Another configured executable may be available. */
    }
  }
  return undefined;
}

async function programVersion(program: 'blender' | 'ffmpeg', executable: string): Promise<string> {
  const result = await promisify(execFile)(executable, [program === 'blender' ? '--version' : '-version'], {
    timeout: 5000,
    maxBuffer: 65536,
    windowsHide: true,
  });
  return result.stdout;
}

function checkBrowser(
  options: DoctorOptions,
  dependencies: DoctorDependencies,
  checks: Check[],
  next: Set<string>,
) {
  const env = dependencies.env ?? process.env,
    platform = dependencies.platform ?? process.platform;
  let browserReady = false;
  let mode: 'window' | 'existing-browser' = 'window';
  try {
    const selected = resolveLoginBrowserOptions(options, env);
    if (selected.cdpEndpoint) {
      loopbackCdpEndpoint(selected.cdpEndpoint);
      mode = 'existing-browser';
      browserReady = true;
      checks.push({
        name: 'browser',
        ok: true,
        required: false,
        status: 'configured_not_connected',
        detail: { mode },
      });
    } else {
      (
        dependencies.browser ??
        ((explicit) => installedBrowser(explicit, { platform, home: dependencies.home ?? homedir(), env }))
      )(selected.executablePath);
      browserReady = true;
      checks.push({
        name: 'browser',
        ok: true,
        required: false,
        status: 'executable_found',
        detail: { mode },
      });
    }
  } catch (error) {
    const code = String(errorResult(error).code);
    checks.push({ name: 'browser', ok: false, required: code === 'INVALID_INPUT', code });
    next.add(
      'Install Chrome/Edge or select an explicitly authorized local CDP endpoint with setup --cdp-endpoint URL.',
    );
  }
  return { browser_ready: browserReady, browser_mode: mode };
}

async function checkSession(
  config: Config,
  options: DoctorOptions,
  dependencies: DoctorDependencies,
  checks: Check[],
  next: Set<string>,
) {
  let authenticated: boolean | null = null,
    sessionCode: string | undefined;
  if (options.offline)
    checks.push({ name: 'studio_session_network', ok: true, required: false, status: 'not_checked' });
  else {
    try {
      const account = await (dependencies.verify ?? verifySavedSession)(config.keyringAccount);
      if (account.authenticated !== true)
        throw new TripoError('AUTH_REQUIRED', 'No verified Studio session is available.');
      authenticated = true;
      checks.push({
        name: 'studio_session_network',
        ok: authenticated,
        required: true,
        detail: { authenticated, renewable: account.renewable === true },
      });
      const credential = checks.find((check) => check.name === 'credential_backend')!;
      credential.status = 'available';
    } catch (error) {
      sessionCode = String(errorResult(error).code);
      authenticated = sessionCode === 'AUTH_REQUIRED' ? false : null;
      checks.push({ name: 'studio_session_network', ok: false, required: true, code: sessionCode });
      if (sessionCode === 'CREDENTIAL_STORE_UNAVAILABLE') {
        const credential = checks.find((check) => check.name === 'credential_backend')!;
        credential.ok = false;
        credential.required = true;
        credential.status = 'unavailable';
        next.add(
          'Unlock the OS credential store and allow ai-modeling (Node.js) access when prompted; Linux also requires session D-Bus and an unlocked Secret Service.',
        );
      } else if (sessionCode === 'AUTH_REQUIRED') {
        checks.find((check) => check.name === 'credential_backend')!.status = 'available';
        next.add('Run ai-modeling setup to connect your own Studio browser session.');
      } else
        next.add(
          'Check the network/proxy and retry the read-only balance check; this error does not automatically require a new login.',
        );
    }
  }
  return { authenticated, login_required: authenticated === false, session_error: sessionCode };
}

async function checkPrograms(
  feature: DoctorFeature,
  dependencies: DoctorDependencies,
  checks: Check[],
  next: Set<string>,
) {
  const env = dependencies.env ?? process.env,
    platform = dependencies.platform ?? process.platform;
  for (const program of ['blender', 'ffmpeg'] as const) {
    const required = program === 'blender' ? ['render', 'video'].includes(feature) : feature === 'video';
    const executable = await findProgram(program, env, platform);
    let ok = Boolean(executable),
      status = executable ? 'executable_found' : 'missing';
    if (required && executable) {
      try {
        const output = await (dependencies.programVersion ?? programVersion)(program, executable);
        if (program === 'blender') {
          const match = /Blender\s+(\d+)\.(\d+)/i.exec(output);
          ok = Boolean(match && (Number(match[1]) > 4 || (Number(match[1]) === 4 && Number(match[2]) >= 5)));
        } else ok = /ffmpeg version/i.test(output) && /--enable-libx264/.test(output);
        status = ok ? 'version_verified' : 'unsupported_build';
      } catch {
        ok = false;
        status = 'version_check_failed';
      }
    }
    checks.push({ name: program, ok, required, status });
    if (required && !ok)
      next.add(
        program === 'blender'
          ? 'Configure Blender 4.5+ using AI_MODELING_BLENDER.'
          : 'Configure FFmpeg with libx264 using AI_MODELING_FFMPEG.',
      );
  }
}

export async function diagnose(
  config: Config,
  options: DoctorOptions = {},
  dependencies: DoctorDependencies = {},
) {
  const feature = options.feature ?? 'core';
  if (!['core', 'render', 'video', 'frontend-export'].includes(feature))
    throw new TripoError('INVALID_INPUT', 'Unknown diagnostic feature.');
  const env = dependencies.env ?? process.env,
    platform = dependencies.platform ?? process.platform;
  const checks: Check[] = [],
    next = new Set<string>();
  const node = dependencies.nodeVersion ?? process.versions.node;
  checks.push({ name: 'node', ok: Number(node.split('.')[0]) >= 24, required: true, detail: node });
  checks.push({ name: 'state_directory', ok: await writableStateDirectory(config.dataDir), required: true });
  const browser = checkBrowser(options, dependencies, checks, next);
  const backend =
    platform === 'darwin'
      ? 'macOS Keychain'
      : platform === 'win32'
        ? 'Windows Credential Manager'
        : 'Linux Secret Service';
  checks.push({
    name: 'credential_backend',
    ok: true,
    required: false,
    status: 'not_checked',
    detail: backend,
  });
  if (platform === 'linux') {
    checks.push({
      name: 'desktop_session',
      ok: Boolean(env.DISPLAY || env.WAYLAND_DISPLAY),
      required: false,
    });
    checks.push({
      name: 'session_dbus',
      ok: Boolean(env.DBUS_SESSION_BUS_ADDRESS),
      required: false,
      status: 'environment_hint_only',
    });
  }
  const session = await checkSession(config, options, dependencies, checks, next);
  const prices = await pricingStatus(config.dataDir);
  checks.push({
    name: 'pricing',
    ok: prices.usable,
    required: true,
    status: prices.state,
    detail: { expires_at: prices.expires_at, refresh_required: prices.refresh_required },
  });
  if (prices.refresh_required)
    next.add('Run ai-modeling pricing status and install a current reviewed pricing snapshot.');
  await checkPrograms(feature, dependencies, checks, next);
  try {
    const runtime = runtimeStatus(config);
    checks.push({
      name: 'frontend_runtime',
      ok: runtime.ready,
      required: feature === 'frontend-export',
      detail: { files: runtime.files.map((file) => ({ kind: file.kind, state: file.state })) },
    });
    if (feature === 'frontend-export' && !runtime.ready)
      next.add('Run ai-modeling runtime status, then install the pinned official runtime files.');
  } catch (error) {
    checks.push({
      name: 'frontend_runtime',
      ok: false,
      required: feature === 'frontend-export',
      code: String(errorResult(error).code),
    });
  }
  checks.push({
    name: 'terminal',
    ok: true,
    required: false,
    detail: {
      interactive: Boolean(process.stdin.isTTY),
      proxy_variables: ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'].filter((key) =>
        Boolean(env[key]),
      ),
    },
  });
  return {
    ok: checks.every((check) => !check.required || check.ok),
    offline: Boolean(options.offline),
    feature,
    ...session,
    ...browser,
    checks,
    next_steps: [...next],
  };
}

export function diagnosticFailure(error: unknown) {
  const code = object(errorResult(error)).code;
  return {
    ok: false,
    checks: [{ name: 'configuration', ok: false, required: true, code }],
    next_steps: ['Check the configured data directory and settings.json before retrying.'],
  };
}
