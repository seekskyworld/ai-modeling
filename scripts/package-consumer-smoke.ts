/** Exercise ordinary TGZ consumption separately from the strict extracted npm-ci installation. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PACKAGE_NAME, VERSION } from '../version.ts';
import { archiveEntries, snapshotArchive } from './archive-input.ts';
import { productionLock, type ProductionLock } from './dependency-lock.ts';
import { readDistributionFile } from './package-validation.ts';
import { npmDiagnosticFiles, readNpmDiagnostics } from './npm-consumer-diagnostics.ts';
import {
  installGlobalConsumer,
  probeGlobalCredentialStore,
  probeGlobalNativeRuntime,
  verifyGlobalDependencies,
} from './global-consumer.ts';

interface PackageMetadata {
  name: string;
  version: string;
  bin: Record<string, string>;
  dependencies?: Record<string, string>;
  [key: string]: unknown;
}

interface Dependency {
  version?: string;
  dependencies?: Record<string, Dependency>;
}

interface ConsumerLock {
  lockfileVersion?: number;
  packages?: Record<string, { name?: string; version?: string; integrity?: string; link?: boolean }>;
}

interface LockMismatch {
  kind: string;
  name: string;
  version?: string;
  expected?: string[];
  actual?: string;
}

const installationTimeoutMs = 300000;
const startupTimeoutMs = 30000;
// npm reopens and extracts local TGZ metadata even when its npx installation is cached.
const fileSpecTimeoutMs = 600000;
type ConsumerStage =
  | 'local_install'
  | 'local_cli_version'
  | 'local_cli_help'
  | 'local_npm_exec'
  | 'npx_cache_install'
  | 'npx_cached_help'
  | 'local_mcp'
  | 'global_mcp'
  | 'npx_mcp'
  | 'global_install'
  | 'global_native_runtime'
  | 'global_json_credentials';

/** Fixed stage names and bounded metadata only; never log command arguments, paths or child output. */
async function consumerStage<T>(stage: ConsumerStage, action: () => T | Promise<T>): Promise<T> {
  const started = performance.now();
  const report = (outcome: 'started' | 'completed' | 'failed', error?: unknown) => {
    const failure = error as { code?: unknown; status?: unknown; signal?: unknown } | undefined;
    process.stderr.write(
      JSON.stringify({
        diagnostic: 'package_consumer',
        stage,
        outcome,
        elapsed_ms: Math.round(performance.now() - started),
        ...(outcome === 'failed'
          ? {
              error_code:
                typeof failure?.code === 'string' && /^[A-Z_]{2,64}$/.test(failure.code)
                  ? failure.code
                  : null,
              exit_code: Number.isInteger(failure?.status) ? failure!.status : null,
              signal:
                typeof failure?.signal === 'string' && /^SIG[A-Z]{1,16}$/.test(failure.signal)
                  ? failure.signal
                  : null,
            }
          : {}),
      }) + '\n',
    );
  };
  report('started');
  try {
    const result = await action();
    report('completed');
    return result;
  } catch (error) {
    report('failed', error);
    throw error;
  }
}

type NpxFileSpecStage = 'npx_cache_install' | 'npx_cached_help' | 'npx_mcp';

/** A failed npx invocation may still be extracting metadata; report disposable cache presence only. */
async function reportNpxCacheState(directory: string, stage: NpxFileSpecStage): Promise<void> {
  const diagnostic = { diagnostic: 'package_consumer_cache', stage };
  try {
    const cache = path.join(directory, 'cache', '_npx');
    const roots = (await readdir(cache, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    const present = (file: string) =>
      access(file).then(
        () => true,
        () => false,
      );
    const states = await Promise.all(
      roots.slice(0, 8).map(async (root) => {
        const modules = path.join(cache, root.name, 'node_modules');
        const installed = path.join(modules, ...PACKAGE_NAME.split('/'));
        return {
          package: await present(path.join(installed, 'package.json')),
          entry: await present(path.join(installed, 'dist/cli/main.js')),
          shim: await present(
            path.join(modules, '.bin', process.platform === 'win32' ? 'ai-modeling.cmd' : 'ai-modeling'),
          ),
        };
      }),
    );
    process.stderr.write(
      JSON.stringify({
        ...diagnostic,
        cache_directories: roots.length,
        inspected_directories: states.length,
        package_metadata_present: states.some((state) => state.package),
        cli_entry_present: states.some((state) => state.entry),
        bin_shim_present: states.some((state) => state.shim),
      }) + '\n',
    );
  } catch {
    process.stderr.write(JSON.stringify({ ...diagnostic, inspection: 'unavailable' }) + '\n');
  }
}

async function npxFileSpecStage<T>(
  stage: NpxFileSpecStage,
  directory: string,
  action: () => T | Promise<T>,
): Promise<T> {
  const previousNpmLogs = await npmDiagnosticFiles(directory);
  try {
    return await consumerStage(stage, action);
  } catch (error) {
    await reportNpxCacheState(directory, stage);
    throw error;
  } finally {
    process.stderr.write(
      JSON.stringify({
        diagnostic: 'package_consumer_npm',
        stage,
        ...(await readNpmDiagnostics(directory, previousNpmLogs)),
      }) + '\n',
    );
  }
}

function packageName(location: string, name?: string) {
  return name ?? location.split('node_modules/').at(-1)!;
}

function reviewedPackageIndex(reviewed: ProductionLock) {
  const expected = new Map<string, Map<string, Set<string>>>();
  for (const [location, item] of Object.entries(reviewed.packages)) {
    if (!location) continue;
    const name = packageName(location, item.name);
    const versions = expected.get(name) ?? new Map<string, Set<string>>();
    const integrities = versions.get(item.version!) ?? new Set<string>();
    integrities.add(item.integrity!);
    versions.set(item.version!, integrities);
    expected.set(name, versions);
  }
  return expected;
}

function consumerGraph(reviewed: ProductionLock, graph: Dependency, mismatches: LockMismatch[]) {
  const root = graph.dependencies?.[reviewed.name];
  if (root?.version !== reviewed.version)
    mismatches.push({
      kind: 'package-identity',
      name: reviewed.name,
      expected: [reviewed.version],
      actual: root?.version,
    });
  for (const [name, version] of Object.entries(reviewed.packages['']?.dependencies ?? {})) {
    if (root?.dependencies?.[name]?.version !== version)
      mismatches.push({
        kind: 'direct-dependency',
        name,
        expected: [version],
        actual: root?.dependencies?.[name]?.version,
      });
  }
  const graphPackages = new Set<string>();
  const visit = (dependencies: Record<string, Dependency> = {}) => {
    for (const [name, item] of Object.entries(dependencies)) {
      // npm ls emits empty objects for optional packages that are unavailable on this platform.
      if (!item.version) continue;
      graphPackages.add(`${name}@${item.version}`);
      visit(item.dependencies);
    }
  };
  visit(root?.dependencies);
  if (!graphPackages.size) mismatches.push({ kind: 'empty-graph', name: reviewed.name });
  return graphPackages;
}

function compareInstalledPackage(
  name: string,
  item: { version: string; integrity?: string },
  expected: ReturnType<typeof reviewedPackageIndex>,
  mismatches: LockMismatch[],
) {
  const versions = expected.get(name);
  if (!versions) mismatches.push({ kind: 'unreviewed-package', name, version: item.version });
  else if (!versions.has(item.version))
    mismatches.push({
      kind: 'version',
      name,
      version: item.version,
      expected: [...versions.keys()].sort(),
      actual: item.version,
    });
  else if (!item.integrity || !versions.get(item.version)!.has(item.integrity))
    mismatches.push({
      kind: 'integrity',
      name,
      version: item.version,
      expected: [...versions.get(item.version)!].sort(),
      actual: item.integrity,
    });
}

/** Compare the installed tree and its integrity metadata, allowing absent platform optional packages. */
export function compareConsumerDependencies(
  reviewed: ProductionLock,
  installed: ConsumerLock,
  graph: Dependency,
) {
  const mismatches: LockMismatch[] = [];
  const expected = reviewedPackageIndex(reviewed);
  const graphPackages = consumerGraph(reviewed, graph, mismatches);
  if (installed.lockfileVersion !== 3 || !installed.packages)
    mismatches.push({ kind: 'missing-installed-lock', name: reviewed.name });
  const installedPackages = new Set<string>();
  for (const [location, item] of Object.entries(installed.packages ?? {})) {
    if (!location || location === `node_modules/${reviewed.name}`) continue;
    const name = packageName(location, item.name);
    if (!location.startsWith('node_modules/') || item.link || !item.version) {
      mismatches.push({ kind: 'invalid-installed-package', name, version: item.version });
      continue;
    }
    const identity = `${name}@${item.version}`;
    installedPackages.add(identity);
    if (!graphPackages.has(identity))
      mismatches.push({ kind: 'outside-installed-graph', name, version: item.version });
    compareInstalledPackage(name, { ...item, version: item.version }, expected, mismatches);
  }
  for (const identity of graphPackages)
    if (!installedPackages.has(identity))
      mismatches.push({ kind: 'missing-installed-metadata', name: identity });
  return { matches: mismatches.length === 0, installed_packages: installedPackages.size, mismatches };
}

/** Bind installed bundled code to the inspected archive, in addition to npm's dependency metadata. */
export async function verifyBundledFiles(
  root: string,
  entries: { path: string; bytes: Buffer }[],
): Promise<number> {
  const bundled = entries.filter((entry) => entry.path.startsWith('node_modules/'));
  for (const entry of bundled)
    assert.deepEqual(
      await readDistributionFile(root, entry.path, true),
      entry.bytes,
      `Installed bundled dependency changed: ${entry.path}`,
    );
  return bundled.length;
}

/** Never inherit npm authentication, user configuration, application settings or Node injection flags. */
export function consumerEnvironment(directory: string, source = process.env): Record<string, string> {
  const operational =
    /^(?:TMPDIR|TMP|TEMP|SystemRoot|WINDIR|ComSpec|PATHEXT|LANG|LC_ALL|LC_CTYPE|TZ|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i;
  const env = Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && operational.test(entry[0]),
    ),
  );
  const systemPaths =
    process.platform === 'win32'
      ? [path.join(source.SystemRoot ?? 'C:\\Windows', 'System32'), source.SystemRoot ?? 'C:\\Windows']
      : ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  env.PATH = [path.dirname(process.execPath), ...systemPaths].join(path.delimiter);
  return {
    ...env,
    npm_config_cache: path.join(directory, 'cache'),
    npm_config_userconfig: path.join(directory, 'user.npmrc'),
    npm_config_globalconfig: path.join(directory, 'global.npmrc'),
    npm_config_prefix: path.join(directory, 'global-prefix'),
    npm_config_global: 'false',
    npm_config_registry: 'https://registry.npmjs.org/',
    npm_config_ignore_scripts: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    AI_MODELING_PROFILE: 'npm-consumer-smoke',
    AI_MODELING_DATA_DIR: path.join(directory, 'state'),
    AI_MODELING_INPUT_ROOTS: directory,
    AI_MODELING_OUTPUT_DIR: path.join(directory, 'output'),
  };
}

function offlineEnvironment(env: Record<string, string>): Record<string, string> {
  return {
    ...env,
    HTTPS_PROXY: 'http://127.0.0.1:9',
    HTTP_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: 'localhost,127.0.0.1,::1',
    https_proxy: 'http://127.0.0.1:9',
    http_proxy: 'http://127.0.0.1:9',
    all_proxy: 'http://127.0.0.1:9',
    no_proxy: 'localhost,127.0.0.1,::1',
  };
}

function execute(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  timeout = startupTimeoutMs,
) {
  return execFileSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function inspectConsumer(directory: string) {
  const installed = path.join(directory, 'node_modules', ...PACKAGE_NAME.split('/'));
  const metadata = JSON.parse(
    await readFile(path.join(installed, 'package.json'), 'utf8'),
  ) as PackageMetadata;
  assert.equal(metadata.name, PACKAGE_NAME);
  assert.equal(metadata.version, VERSION);
  assert.deepEqual(metadata.bin, { 'ai-modeling': 'dist/cli/main.js' });
  const entry = path.join(installed, 'dist/cli/main.js');
  const shim = path.join(
    directory,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'ai-modeling.cmd' : 'ai-modeling',
  );
  await access(shim);
  if (process.platform === 'win32')
    assert.match(await readFile(shim, 'utf8'), /ai-modeling[\\/]dist[\\/]cli[\\/]main\.js/);
  else assert.equal(await realpath(shim), await realpath(entry));
  return { directory, installed, entry, shim, metadata };
}

/** The caller supplies a private archive snapshot and a disposable, newly created directory. */
export async function installConsumerRoutes(
  archive: string,
  directory: string,
  npmCli: string,
  offlineInstall = false,
) {
  const npmPath = await realpath(npmCli);
  const npxPath = path.join(path.dirname(npmPath), 'npx-cli.js');
  await access(npxPath);
  await writeFile(path.join(directory, 'user.npmrc'), '', { mode: 0o600, flag: 'wx' });
  await writeFile(path.join(directory, 'global.npmrc'), '', { mode: 0o600, flag: 'wx' });
  const env = consumerEnvironment(directory);
  const offlineEnv = offlineEnvironment(env);
  const consumer = path.join(directory, 'consumer');
  const empty = path.join(directory, 'npx-run');
  await mkdir(consumer, { mode: 0o700 });
  await mkdir(empty, { mode: 0o700 });
  await writeFile(
    path.join(consumer, 'package.json'),
    JSON.stringify({ name: 'ai-modeling-consumer', version: '1.0.0', private: true }) + '\n',
    { flag: 'wx' },
  );
  await consumerStage('local_install', () =>
    execute(
      process.execPath,
      [
        npmPath,
        'install',
        '--prefix',
        consumer,
        '--ignore-scripts',
        '--omit=dev',
        '--no-audit',
        '--no-fund',
        ...(offlineInstall ? ['--offline'] : []),
        archive,
      ],
      directory,
      env,
      installationTimeoutMs,
    ),
  );
  const local = await inspectConsumer(consumer);
  const installedVersion = await consumerStage('local_cli_version', () =>
    process.platform === 'win32'
      ? (() => {
          const result = spawnSync(
            env.ComSpec ?? 'cmd.exe',
            ['/d', '/s', '/c', '""%AI_MODELING_SMOKE_BIN%" --version"'],
            {
              cwd: directory,
              env: { ...offlineEnv, AI_MODELING_SMOKE_BIN: local.shim },
              encoding: 'utf8',
              timeout: startupTimeoutMs,
              windowsVerbatimArguments: true,
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          );
          if (result.error) throw result.error;
          assert.equal(result.status, 0, result.stderr);
          return result.stdout;
        })()
      : execute(local.shim, ['--version'], directory, offlineEnv),
  );
  assert.equal(installedVersion.trim(), VERSION);
  assert.match(
    await consumerStage('local_cli_help', () =>
      execute(process.execPath, [local.entry, '--help'], directory, offlineEnv),
    ),
    /ai-modeling/,
  );
  assert.equal(
    (
      await consumerStage('local_npm_exec', () =>
        execute(
          process.execPath,
          [
            npmPath,
            'exec',
            '--offline',
            '--ignore-scripts',
            '--prefix',
            consumer,
            '--',
            'ai-modeling',
            '--version',
          ],
          directory,
          offlineEnv,
        ),
      )
    ).trim(),
    VERSION,
  );
  const packageArgs = [
    '--timing',
    '--offline',
    '--ignore-scripts',
    '--yes',
    '--package',
    archive,
    '--',
    'ai-modeling',
  ];
  assert.equal(
    (
      await npxFileSpecStage('npx_cache_install', directory, () =>
        execute(
          process.execPath,
          [npmPath, 'exec', ...packageArgs, '--version'],
          empty,
          offlineEnv,
          fileSpecTimeoutMs,
        ),
      )
    ).trim(),
    VERSION,
  );
  assert.match(
    await npxFileSpecStage('npx_cached_help', directory, () =>
      execute(process.execPath, [npxPath, ...packageArgs, '--help'], empty, offlineEnv, fileSpecTimeoutMs),
    ),
    /ai-modeling/,
  );
  const cache = path.join(directory, 'cache', '_npx');
  const cacheRoots = (await readdir(cache, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  assert.equal(cacheRoots.length, 1, 'Expected one package-specific npx cache installation.');
  const cached = await inspectConsumer(path.join(cache, cacheRoots[0]!.name));
  return { local, cached, npmPath, npxPath, packageArgs, empty, env: offlineEnv, installEnv: env };
}

async function checkInstalledSkill(
  cli: (args: string[]) => string,
  selection: string[],
  destination: string,
  entries: ReturnType<typeof archiveEntries>,
) {
  const skill = (action: string) => JSON.parse(cli(['skill', action, ...selection, '--json']));
  assert.equal(skill('install').status, 'installed');
  const status = skill('status');
  assert.equal(status.status, 'installed');
  assert.equal(status.managed, true);
  assert.equal(status.installed_version, VERSION);
  assert.equal(status.directory, destination);
  for (const entry of entries.filter((item) => item.path.startsWith('skills/ai-modeling/')))
    assert.deepEqual(
      await readFile(path.join(destination, entry.path.slice('skills/ai-modeling/'.length))),
      entry.bytes,
    );
  assert.deepEqual(
    await readFile(path.join(destination, 'LICENSE')),
    entries.find((entry) => entry.path === 'LICENSE')?.bytes,
  );
  assert.equal(skill('uninstall').status, 'uninstalled');
  await assert.rejects(access(destination), { code: 'ENOENT' });
}

async function checkSkillClientTargets(
  cli: (args: string[]) => string,
  directory: string,
  entries: ReturnType<typeof archiveEntries>,
) {
  const expected = {
    agents: '.agents/skills',
    codex: '.agents/skills',
    'claude-code': '.claude/skills',
    cursor: '.cursor/skills',
    copilot: '.github/skills',
    'gemini-cli': '.gemini/skills',
    opencode: '.opencode/skills',
    'golutra-agent': '.agents/skills',
  };
  const targets = JSON.parse(cli(['skill', 'targets', '--json']));
  assert.equal(targets.default_target, null);
  assert.equal(targets.default_scope, 'user');
  assert.deepEqual(
    targets.targets.map((target: { id: string }) => target.id).sort(),
    Object.keys(expected).sort(),
  );
  const golutra = targets.targets.find((target: { id: string }) => target.id === 'golutra-agent');
  assert.equal(golutra.default_scope, 'project');
  assert.equal(golutra.directories.user, undefined);
  const results = [];
  for (const [target, relative] of Object.entries(expected)) {
    const project = path.join(directory, 'skill-projects', target);
    await mkdir(project, { recursive: true });
    await checkInstalledSkill(
      cli,
      [
        '--target',
        target,
        ...(target === 'golutra-agent' ? [] : ['--scope', 'project']),
        '--project-dir',
        project,
      ],
      path.join(project, relative, 'ai-modeling'),
      entries,
    );
    results.push({ target, scope: 'project', installed_files_verified: true, client_loaded: false });
  }
  return results;
}

async function checkGolutraExport(
  cli: (args: string[]) => string,
  directory: string,
  entry: string,
  definitions: { name: string; inputSchema?: unknown; outputSchema?: unknown }[],
) {
  const exported = JSON.parse(
    cli(['mcp', 'export', '--target', 'golutra-agent', '--out', path.join(directory, 'golutra-plugins')]),
  );
  assert.equal(exported.target, 'golutra-agent');
  assert.equal(exported.total_tools, definitions.length);
  const names: string[] = [];
  for (const plugin of exported.plugins) {
    const manifest = JSON.parse(await readFile(plugin.manifest, 'utf8'));
    assert.equal(manifest.server.command, await realpath(process.execPath));
    assert.deepEqual(manifest.server.args, [await realpath(entry), 'mcp', '--toolset', 'studio']);
    assert.deepEqual(manifest.server.env, []);
    assert.ok(manifest.tools.length > 0 && manifest.tools.length <= 64);
    for (const tool of manifest.tools) {
      const original = definitions.find((definition) => definition.name === tool.name);
      assert.ok(original);
      assert.deepEqual(tool.input_schema, original.inputSchema);
      assert.deepEqual(tool.output_schema, original.outputSchema ?? null);
      names.push(tool.name);
    }
  }
  assert.deepEqual(names.sort(), definitions.map((tool) => tool.name).sort());
  return { packages: exported.plugins.length, tools: names.length, client_loaded: false };
}

async function checkMcpConsumerRoute(
  route: { args: string[]; cwd: string },
  env: Record<string, string>,
  definitions: { name: string }[],
  connectTimeoutMs: number,
) {
  const client = new Client({ name: 'npm-consumer-smoke', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    ...route,
    env,
    stderr: 'pipe',
  });
  // npm timing text is captured in its disposable logs; draining avoids blocking the stdio server.
  transport.stderr?.on('data', () => undefined);
  try {
    await client.connect(transport, { timeout: connectTimeoutMs });
    assert.deepEqual(client.getServerVersion(), { name: 'ai-modeling', version: VERSION });
    assert.deepEqual(
      (await client.listTools({}, { timeout: startupTimeoutMs })).tools.map((tool) => tool.name).sort(),
      definitions.map((tool) => tool.name).sort(),
    );
  } finally {
    await client.close();
    await transport.close();
  }
}

export async function smokePackageConsumer(archive: string, npmCli = process.env.npm_execpath) {
  if (!npmCli) throw new Error('Run package:consumer-smoke through npm run so npm_execpath is available.');
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'ai-modeling-consumer-smoke-')));
  let verificationError: unknown;
  try {
    const snapshot = await snapshotArchive(archive, directory);
    const entries = archiveEntries(await readFile(snapshot.filename));
    const metadataEntry = entries.find((item) => item.path === 'package.json');
    const lockEntry = entries.find((item) => item.path === 'npm-shrinkwrap.json');
    assert.ok(
      metadataEntry && lockEntry,
      'Consumer archive must include package metadata and production shrinkwrap.',
    );
    const metadata = JSON.parse(metadataEntry.bytes.toString('utf8')) as PackageMetadata;
    assert.equal(metadata.name, PACKAGE_NAME);
    assert.equal(metadata.version, VERSION);
    assert.deepEqual(metadata.bin, { 'ai-modeling': 'dist/cli/main.js' });
    const reviewed = productionLock(metadata, JSON.parse(lockEntry.bytes.toString('utf8')));
    const installed = await installConsumerRoutes(snapshot.filename, directory, npmCli);
    const global = await consumerStage('global_install', () =>
      installGlobalConsumer(snapshot.filename, directory, installed.npmPath, installed.installEnv),
    );
    const nativeRuntime = await consumerStage('global_native_runtime', () =>
      probeGlobalNativeRuntime(global.entry, directory, installed.env),
    );
    const credentialStore = await consumerStage('global_json_credentials', () =>
      probeGlobalCredentialStore(global.entry, directory, installed.env),
    );
    const cli = (args: string[]) =>
      execute(process.execPath, [installed.local.entry, ...args], directory, installed.env);
    const definitions = JSON.parse(cli(['tools', '--toolset', 'studio'])) as { name: string }[];
    assert.ok(Array.isArray(definitions) && definitions.length > 0);
    assert.ok(definitions.some((tool) => tool.name === 'ai_modeling_assets_list'));
    assert.match(cli(['assets', 'list', '--help']), /--kind <kind>/);
    assert.match(cli(['guides', 'read', 'commands/assets/list']), /next_offset/);
    for (const { stage, timeout, ...route } of [
      {
        stage: 'local_mcp' as const,
        timeout: startupTimeoutMs,
        args: [installed.local.entry, 'mcp', '--toolset', 'studio'],
        cwd: directory,
      },
      {
        stage: 'global_mcp' as const,
        timeout: startupTimeoutMs,
        args: [global.entry, 'mcp', '--toolset', 'studio'],
        cwd: directory,
      },
      {
        stage: 'npx_mcp' as const,
        timeout: fileSpecTimeoutMs,
        args: [installed.npxPath, ...installed.packageArgs, 'mcp', '--toolset', 'studio'],
        cwd: installed.empty,
      },
    ]) {
      const check = () => checkMcpConsumerRoute(route, installed.env, definitions, timeout);
      if (stage === 'npx_mcp') await npxFileSpecStage(stage, directory, check);
      else await consumerStage(stage, check);
    }
    const skillParent = path.join(directory, 'skills');
    await checkInstalledSkill(cli, ['--dir', skillParent], path.join(skillParent, 'ai-modeling'), entries);
    const globalCli = (args: string[]) =>
      execute(process.execPath, [global.entry, ...args], directory, installed.env);
    const globalSkillParent = path.join(directory, 'global-skills');
    await checkInstalledSkill(
      globalCli,
      ['--dir', globalSkillParent],
      path.join(globalSkillParent, 'ai-modeling'),
      entries,
    );
    const skillTargets = await checkSkillClientTargets(cli, directory, entries);
    const golutraExport = await checkGolutraExport(cli, directory, installed.local.entry, definitions);
    await assert.rejects(access(installed.env.AI_MODELING_DATA_DIR!), { code: 'ENOENT' });

    const routes = [];
    for (const [route, consumer] of [
      ['npm-install', installed.local],
      ['npx-cache', installed.cached],
    ] as const) {
      assert.deepEqual(
        await readFile(path.join(consumer.installed, 'npm-shrinkwrap.json')),
        lockEntry.bytes,
        'npm consumption changed the shipped shrinkwrap.',
      );
      const graph = JSON.parse(
        execute(
          process.execPath,
          [installed.npmPath, 'ls', '--prefix', consumer.directory, '--omit=dev', '--all', '--json'],
          directory,
          installed.env,
        ),
      ) as Dependency;
      // The hidden lock describes packages actually installed; the root lock also lists absent optional platforms.
      const actual = JSON.parse(
        await readFile(path.join(consumer.directory, 'node_modules', '.package-lock.json'), 'utf8'),
      ) as ConsumerLock;
      routes.push({
        route,
        ...compareConsumerDependencies(reviewed, actual, graph),
        bundled_files_verified: await verifyBundledFiles(consumer.installed, entries),
      });
    }
    assert.ok(
      routes.every((route) => route.matches),
      'Global comparison requires a fully reviewed local dependency tree.',
    );
    const globalDependencies = await verifyGlobalDependencies(
      global,
      installed.local.directory,
      installed.npmPath,
      directory,
      installed.env,
    );
    const globalBundledFiles = await verifyBundledFiles(global.installed, entries);
    return {
      schema_version: 1,
      install_method: 'npm-install-tgz-and-npx-offline',
      name: PACKAGE_NAME,
      version: VERSION,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      npm: execute(process.execPath, [installed.npmPath, '--version'], directory, installed.env).trim(),
      archive_sha256: snapshot.sha256,
      checks: [
        'installed-bin',
        'version',
        'help',
        'npm-exec-offline',
        'npx-offline',
        'mcp-initialize',
        'static-tool-discovery',
        'asset-command-discovery',
        'skill-install',
        'skill-status',
        'skill-uninstall',
        'skill-targets',
        'skill-project-target-installs',
        'golutra-native-plugin-export',
        'no-runtime-state',
        'dependency-inspection',
        'bundled-file-integrity',
        'global-install',
        'global-bin',
        'global-native-runtime',
        'global-json-credentials',
        'global-mcp',
        'global-skill-management',
        'global-dependency-bytes',
      ],
      functional_passed: true,
      skill_targets: skillTargets,
      golutra_export: golutraExport,
      global_installation: {
        functional_passed: true,
        native_runtime: nativeRuntime,
        credential_store: credentialStore,
        dependency_lock: globalDependencies,
        bundled_files_verified: globalBundledFiles,
      },
      dependency_lock: {
        matches: routes.every((route) => route.matches),
        production_lock_sha256: createHash('sha256').update(lockEntry.bytes).digest('hex'),
        comparison: 'name-version-integrity',
        routes,
      },
      live_services: false,
    };
  } catch (error) {
    verificationError = error;
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      (cleanupError) => {
        if (verificationError !== undefined)
          throw new AggregateError(
            [verificationError, cleanupError],
            'Consumer verification and temporary-directory cleanup both failed.',
            { cause: cleanupError },
          );
        throw cleanupError;
      },
    );
  }
}

export function parseConsumerOptions(args: string[]) {
  const options: { archive?: string; report?: string; requireLocked: boolean } = { requireLocked: false };
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (option === '--require-locked' && !options.requireLocked) options.requireLocked = true;
    else if (
      (option === '--archive' || option === '--report') &&
      args[index + 1] &&
      !args[index + 1]!.startsWith('--')
    ) {
      const field = option === '--archive' ? 'archive' : 'report';
      if (options[field]) throw new Error(`Duplicate option: ${option}`);
      options[field] = args[++index];
    } else
      throw new Error(
        'Usage: npm run package:consumer-smoke -- --archive FILE.tgz [--report NEW_FILE.json] [--require-locked]',
      );
  }
  if (!options.archive) throw new Error('--archive is required.');
  return { ...options, archive: options.archive };
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const options = parseConsumerOptions(process.argv.slice(2));
  const result = await smokePackageConsumer(options.archive);
  const json = JSON.stringify(result, null, 2) + '\n';
  if (options.report) await writeFile(path.resolve(options.report), json, { flag: 'wx', mode: 0o600 });
  process.stdout.write(json);
  if (!result.dependency_lock.matches) {
    process.stderr.write(
      'Functional npm/npx checks passed, but dependency versions or integrity differ from the shipped lock. Use extracted npm ci for the reviewed dependency graph.\n',
    );
    if (options.requireLocked) process.exitCode = 1;
  }
}
