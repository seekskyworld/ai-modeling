/** Credential-free diagnostics before a release claims its single npm submission. */
import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  exchangeNpmOidcCredential,
  NpmOidcError,
  type NpmOidcFailureCode,
  type NpmOidcStage,
} from './npm-oidc-auth.ts';

type AuthStage = 'runtime' | 'npm_environment' | NpmOidcStage;
type AuthFailureCode =
  | NpmOidcFailureCode
  | 'CI_FALSE'
  | 'NPM_ID_TOKEN_OVERRIDE'
  | 'VERSION_UNAVAILABLE'
  | 'UNSUPPORTED_RUNTIME'
  | 'INTERNAL_ERROR';
export interface NpmAuthReport {
  schema_version: 1;
  success: boolean;
  tools: { node: string | null; npm: string | null };
  presence: {
    github_actions: boolean;
    github_event_name: boolean;
    github_repository: boolean;
    github_ref: boolean;
    github_workflow_ref: boolean;
    github_sha: boolean;
    github_oidc_request_url: boolean;
    github_oidc_request_token: boolean;
    npm_id_token: boolean;
    ci_disabled: boolean;
  };
  stages: { stage: AuthStage; outcome: 'passed' | 'failed'; http_status?: number }[];
  failure?: { stage: AuthStage; code: AuthFailureCode; http_status?: number };
}
export interface NpmAuthCheckDependencies {
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
  now?: () => number;
  versions?: () => Promise<{ node: string; npm: string }>;
}

async function toolVersions(): Promise<{ node: string; npm: string }> {
  const windows = process.platform === 'win32';
  const { stdout } = await promisify(execFile)(
    windows ? 'cmd.exe' : 'npm',
    windows ? ['/d', '/s', '/c', 'npm.cmd --version'] : ['--version'],
    { timeout: 10000, maxBuffer: 1024, windowsHide: true },
  );
  return { node: process.version, npm: stdout.trim() };
}

function safeVersion(value: unknown): string | null {
  return typeof value === 'string' && /^v?\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value) ? value : null;
}

export async function checkNpmAuthentication(
  input: { repository: string },
  dependencies: NpmAuthCheckDependencies = {},
): Promise<NpmAuthReport> {
  const report: NpmAuthReport = {
    schema_version: 1,
    success: false,
    tools: { node: null, npm: null },
    presence: {
      github_actions: false,
      github_event_name: false,
      github_repository: false,
      github_ref: false,
      github_workflow_ref: false,
      github_sha: false,
      github_oidc_request_url: false,
      github_oidc_request_token: false,
      npm_id_token: false,
      ci_disabled: false,
    },
    stages: [],
  };
  const fail = (stage: AuthStage, code: AuthFailureCode, httpStatus?: number) => {
    const status = httpStatus === undefined ? {} : { http_status: httpStatus };
    report.stages.push({ stage, outcome: 'failed', ...status });
    report.failure = { stage, code, ...status };
    return report;
  };
  let stage: AuthStage = 'npm_environment';
  try {
    const env = dependencies.env ?? process.env;
    report.presence = {
      github_actions: Boolean(env.GITHUB_ACTIONS),
      github_event_name: Boolean(env.GITHUB_EVENT_NAME),
      github_repository: Boolean(env.GITHUB_REPOSITORY),
      github_ref: Boolean(env.GITHUB_REF),
      github_workflow_ref: Boolean(env.GITHUB_WORKFLOW_REF),
      github_sha: Boolean(env.GITHUB_SHA),
      github_oidc_request_url: Boolean(env.ACTIONS_ID_TOKEN_REQUEST_URL),
      github_oidc_request_token: Boolean(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN),
      npm_id_token: Boolean(env.NPM_ID_TOKEN),
      ci_disabled: env.CI === 'false',
    };
    stage = 'runtime';
    let versions: { node: string; npm: string };
    try {
      versions = await (dependencies.versions ?? toolVersions)();
    } catch {
      return fail(stage, 'VERSION_UNAVAILABLE');
    }
    report.tools = { node: safeVersion(versions.node), npm: safeVersion(versions.npm) };
    if (!report.tools.node || !report.tools.npm) return fail(stage, 'VERSION_UNAVAILABLE');
    if (Number(report.tools.node.replace(/^v/, '').split('.')[0]) < 24 || report.tools.npm !== '11.17.0')
      return fail(stage, 'UNSUPPORTED_RUNTIME');
    report.stages.push({ stage, outcome: 'passed' });
    stage = 'npm_environment';
    // npm's ci-info disables GitHub detection for CI=false; NPM_ID_TOKEN bypasses its GitHub issuer request.
    if (report.presence.ci_disabled) return fail(stage, 'CI_FALSE');
    if (report.presence.npm_id_token) return fail(stage, 'NPM_ID_TOKEN_OVERRIDE');
    report.stages.push({ stage, outcome: 'passed' });
    stage = 'workflow_identity';
    await exchangeNpmOidcCredential(input, {
      env,
      fetcher: dependencies.fetcher,
      now: dependencies.now,
      observe: (progress) => {
        stage = progress.stage;
        report.stages.push(progress);
      },
    });
    // The short-lived result is deliberately discarded, never written to disk or npm configuration.
    report.success = true;
    return report;
  } catch (error) {
    return error instanceof NpmOidcError
      ? fail(error.stage, error.code, error.httpStatus)
      : fail(stage, 'INTERNAL_ERROR');
  }
}

export async function runNpmAuthCheck(
  args: string[],
  dependencies: NpmAuthCheckDependencies & {
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
  } = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = dependencies.stderr ?? ((text: string) => process.stderr.write(text));
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const name = args[index]!;
    const value = args[++index];
    if (!['--repository', '--out'].includes(name) || values.has(name) || !value || value.startsWith('-')) {
      stderr('npm authentication preflight failed: INVALID_ARGUMENTS.\n');
      return 1;
    }
    values.set(name, value);
  }
  if (values.size !== 2) {
    stderr('npm authentication preflight failed: INVALID_ARGUMENTS.\n');
    return 1;
  }
  let output;
  try {
    output = await open(path.resolve(values.get('--out')!), 'wx', 0o600);
  } catch {
    stderr('npm authentication preflight failed: REPORT_UNAVAILABLE.\n');
    return 1;
  }
  try {
    const report = await checkNpmAuthentication({ repository: values.get('--repository')! }, dependencies);
    await output.writeFile(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await output.sync();
    stdout(`npm authentication preflight ${report.success ? 'passed' : 'failed'}.\n`);
    return report.success ? 0 : 1;
  } catch {
    stderr('npm authentication preflight failed: REPORT_WRITE_FAILED.\n');
    return 1;
  } finally {
    await output.close().catch(() => {});
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url))
  runNpmAuthCheck(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.stderr.write('npm authentication preflight failed: INTERNAL_ERROR.\n');
      process.exitCode = 1;
    });
