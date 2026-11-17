/** Install a real tarball into an isolated npm prefix and exercise only offline entrypoints. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PACKAGE_NAME, VERSION } from '../version.ts';
import { extractArchive, snapshotArchive } from './archive-input.ts';

interface InstalledDependency {
  version?: string;
  dependencies?: Record<string, InstalledDependency>;
}

function installationEnvironment() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && !/^(?:AI_MODELING_|TRIPO_|NODE_OPTIONS$)/.test(entry[0]),
    ),
  );
  const inheritedPath = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = [path.dirname(process.execPath), inheritedPath].join(path.delimiter);
  return env;
}

export async function smokePackage(archive: string, npmCli = process.env.npm_execpath) {
  if (!npmCli) throw new Error('Run package:smoke through npm run so npm_execpath is available.');
  const selected = path.resolve(archive);
  if (!selected.endsWith('.tgz')) throw new Error('--archive must name a .tgz file.');
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-install-smoke-'));
  let snapshot: Awaited<ReturnType<typeof snapshotArchive>>;
  try {
    snapshot = await snapshotArchive(selected, directory);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const archiveSha256 = snapshot.sha256;
  const prefix = path.join(directory, 'prefix');
  const userConfig = path.join(directory, 'user.npmrc');
  const globalConfig = path.join(directory, 'global.npmrc');
  await writeFile(userConfig, '', { mode: 0o600 });
  await writeFile(globalConfig, '', { mode: 0o600 });
  const cleanEnv = installationEnvironment();
  const installEnv = {
    ...cleanEnv,
    npm_config_cache: path.join(directory, 'cache'),
    npm_config_userconfig: userConfig,
    npm_config_globalconfig: globalConfig,
    npm_config_prefix: prefix,
    npm_config_global: 'false',
  };
  const npm = (args: string[], cwd = directory) =>
    execFileSync(process.execPath, [npmCli, ...args], {
      cwd,
      env: installEnv,
      encoding: 'utf8',
      timeout: 300000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  try {
    const runtime = path.join(directory, 'runtime');
    await extractArchive(snapshot.filename, runtime);
    const originalLock = await readFile(path.join(runtime, 'npm-shrinkwrap.json'));
    npm(['ci', '--omit=dev', '--no-audit', '--no-fund'], runtime);
    const graphBeforeLink = JSON.parse(npm(['ls', '--omit=dev', '--all', '--json'], runtime));
    npm(['link', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], runtime);
    const modules = npm(['root', '--global', '--prefix', prefix]).trim();
    const installed = path.join(modules, ...PACKAGE_NAME.split('/'));
    const metadata = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));
    assert.equal(metadata.name, PACKAGE_NAME);
    assert.equal(metadata.version, VERSION);
    assert.deepEqual(metadata.bin, { 'ai-modeling': 'dist/cli/main.js' });
    const entry = path.join(installed, 'dist/cli/main.js');
    const shim =
      process.platform === 'win32'
        ? path.join(prefix, 'ai-modeling.cmd')
        : path.join(prefix, 'bin/ai-modeling');
    await access(shim);
    if (process.platform !== 'win32') assert.equal(await realpath(shim), await realpath(entry));
    else assert.match(await readFile(shim, 'utf8'), /dist[\\/]cli[\\/]main\.js/);
    const env = {
      ...cleanEnv,
      AI_MODELING_PROFILE: 'package-smoke',
      AI_MODELING_DATA_DIR: path.join(directory, 'state'),
      AI_MODELING_INPUT_ROOTS: directory,
      AI_MODELING_OUTPUT_DIR: path.join(directory, 'output'),
      HTTPS_PROXY: 'http://127.0.0.1:9',
      HTTP_PROXY: 'http://127.0.0.1:9',
      NO_PROXY: 'localhost,127.0.0.1,::1',
      https_proxy: 'http://127.0.0.1:9',
      http_proxy: 'http://127.0.0.1:9',
      no_proxy: 'localhost,127.0.0.1,::1',
    };
    const shimOptions = {
      cwd: directory,
      env,
      encoding: 'utf8' as const,
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
    };
    const installedVersion = (() => {
      if (process.platform !== 'win32') return execFileSync(shim, ['--version'], shimOptions);
      const result = spawnSync(
        process.env.ComSpec ?? 'cmd.exe',
        ['/d', '/s', '/c', '""%AI_MODELING_SMOKE_BIN%" --version"'],
        { ...shimOptions, env: { ...env, AI_MODELING_SMOKE_BIN: shim }, windowsVerbatimArguments: true },
      );
      if (result.error) throw result.error;
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    })();
    assert.equal(installedVersion.trim(), VERSION);
    const cli = (args: string[], extraEnv: Record<string, string> = {}) =>
      execFileSync(process.execPath, [entry, ...args], {
        cwd: directory,
        env: { ...env, ...extraEnv },
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 8 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    assert.match(cli(['--help']), /ai-modeling/);
    const sources = {
      usage: 'skills/ai-modeling/references/usage.md',
      commands: 'docs/commands.md',
      pipelines: 'skills/ai-modeling/references/pipelines.md',
    };
    const listed = JSON.parse(cli(['guides', 'list']));
    for (const id of Object.keys(sources))
      assert.ok(
        listed.resources.some((resource: { uri: string }) => resource.uri === `ai-modeling://guides/${id}`),
      );
    const client = new Client({ name: 'package-smoke', version: '1' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry, 'mcp', '--toolset', 'studio'],
      cwd: directory,
      env,
      stderr: 'pipe',
    });
    try {
      await client.connect(transport);
      assert.deepEqual(client.getServerVersion(), { name: 'ai-modeling', version: VERSION });
      for (const [id, source] of Object.entries(sources)) {
        const expected = await readFile(path.join(installed, source), 'utf8');
        assert.equal(JSON.parse(cli(['guides', 'read', id])).text, expected);
        const result = await client.readResource({ uri: `ai-modeling://guides/${id}` });
        assert.equal((result.contents[0] as { text?: string }).text, expected);
      }
      const templates = await client.listResourceTemplates();
      assert.ok(
        templates.resourceTemplates.some(
          (item) => item.uriTemplate === 'ai-modeling://guides/commands/{+command}',
        ),
      );
      for (const id of ['commands/index', 'commands/model/convert']) {
        const expected = JSON.parse(cli(['guides', 'read', id])).text;
        const result = await client.readResource({ uri: `ai-modeling://guides/${id}` });
        assert.equal((result.contents[0] as { text?: string }).text, expected);
        assert.match(expected, id === 'commands/index' ? /guides\/commands\/model\/convert/ : /--format/);
      }
    } finally {
      await client.close();
      await transport.close();
    }

    for (const [toolset, experimental] of [
      ['default', false],
      ['full', false],
      ['studio', false],
      ['full', true],
    ] as const) {
      const extraEnv: Record<string, string> = experimental
        ? { AI_MODELING_EXPERIMENTAL_MESH_EDIT: '1' }
        : {};
      const definitions = JSON.parse(cli(['tools', '--toolset', toolset], extraEnv)) as { name: string }[];
      assert.ok(Array.isArray(definitions) && definitions.length > 0);
      if (toolset === 'full')
        assert.equal(
          definitions.some((item) => item.name === 'ai_modeling_mesh_edit'),
          experimental,
        );
      const discovery = new Client({ name: 'package-discovery-smoke', version: '1' });
      const discoveryTransport = new StdioClientTransport({
        command: process.execPath,
        args: [entry, 'mcp', '--toolset', toolset],
        cwd: directory,
        env: { ...env, ...extraEnv },
        stderr: 'pipe',
      });
      try {
        await discovery.connect(discoveryTransport);
        assert.deepEqual(
          (await discovery.listTools()).tools.map((item) => item.name).sort(),
          definitions.map((item) => item.name).sort(),
        );
      } finally {
        await discovery.close();
        await discoveryTransport.close();
      }
    }
    await assert.rejects(access(env.AI_MODELING_DATA_DIR), { code: 'ENOENT' });

    const installedLock = await readFile(path.join(installed, 'npm-shrinkwrap.json'));
    assert.deepEqual(installedLock, originalLock, 'Installation or linking changed the production lock.');
    const lock = JSON.parse(installedLock.toString('utf8'));
    const allowed = new Set(
      Object.entries(lock.packages as Record<string, { version?: string }>)
        .filter(([location]) => location)
        .map(([location, item]) => `${location.split('node_modules/').at(-1)}@${item.version}`),
    );
    const graph = JSON.parse(npm(['ls', '--omit=dev', '--all', '--json'], runtime));
    assert.deepEqual(
      graph.dependencies,
      graphBeforeLink.dependencies,
      'Linking changed the installed dependency graph.',
    );
    assert.ok(
      Object.keys(graph.dependencies ?? {}).length > 0,
      'Installed production dependency graph is empty.',
    );
    for (const [name, version] of Object.entries(metadata.dependencies as Record<string, string>))
      assert.equal(
        graph.dependencies[name]?.version,
        version,
        `Missing or changed direct dependency: ${name}`,
      );
    const installedPackages = new Set<string>();
    const visit = (dependencies: Record<string, InstalledDependency> = {}) => {
      for (const [name, dependency] of Object.entries(dependencies)) {
        if (!dependency.version) continue; // Optional packages for another platform are absent.
        if (name !== PACKAGE_NAME) {
          assert.ok(
            allowed.has(`${name}@${dependency.version}`),
            `Installed dependency is outside the reviewed lock: ${name}@${dependency.version}`,
          );
          installedPackages.add(`${name}@${dependency.version}`);
        }
        visit(dependency.dependencies);
      }
    };
    visit(graph.dependencies);
    return {
      schema_version: 1,
      install_method: 'extracted-tgz-npm-ci-link',
      name: PACKAGE_NAME,
      version: VERSION,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      npm: npm(['--version']).trim(),
      archive_sha256: archiveSha256,
      production_lock_sha256: createHash('sha256').update(originalLock).digest('hex'),
      checks: [
        'installed-bin',
        'version',
        'help',
        'cli-guides',
        'mcp-initialize',
        'mcp-guides',
        'production-lock',
        'static-tool-discovery',
        'focused-command-guides',
        'no-runtime-state',
      ],
      dependencies: [...installedPackages].sort(),
      live_services: false,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (
    args[0] !== '--archive' ||
    !args[1] ||
    (args.length !== 2 && !(args.length === 4 && args[2] === '--report'))
  )
    throw new Error('Usage: npm run package:smoke -- --archive FILE.tgz [--report NEW_FILE.json]');
  const result = await smokePackage(args[1]);
  const json = JSON.stringify(result, null, 2) + '\n';
  if (args[3]) await writeFile(path.resolve(args[3]), json, { flag: 'wx' });
  process.stdout.write(json);
}
