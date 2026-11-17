import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { VERSION } from '../version.ts';
import type { ProductionLock } from '../scripts/dependency-lock.ts';
import {
  compareConsumerDependencies,
  consumerEnvironment,
  installConsumerRoutes,
  parseConsumerOptions,
  verifyBundledFiles,
} from '../scripts/package-consumer-smoke.ts';

function fixture() {
  const reviewed: ProductionLock = {
    name: '@seekskyworld/ai-modeling',
    version: VERSION,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: '@seekskyworld/ai-modeling', version: VERSION, dependencies: { direct: '1.0.0' } },
      'node_modules/direct': { version: '1.0.0', integrity: 'sha512-direct' },
      'node_modules/transitive': { version: '2.0.0', integrity: 'sha512-transitive' },
      'node_modules/other-platform': { version: '3.0.0', integrity: 'sha512-optional', optional: true },
    },
  };
  const installed = {
    lockfileVersion: 3,
    packages: {
      'node_modules/@seekskyworld/ai-modeling': { version: VERSION, integrity: 'sha512-tgz' },
      'node_modules/direct': { version: '1.0.0', integrity: 'sha512-direct' },
      'node_modules/direct/node_modules/transitive': { version: '2.0.0', integrity: 'sha512-transitive' },
    },
  };
  const graph = {
    dependencies: {
      '@seekskyworld/ai-modeling': {
        version: VERSION,
        dependencies: {
          direct: {
            version: '1.0.0',
            dependencies: { transitive: { version: '2.0.0' }, 'other-platform': {} },
          },
        },
      },
    },
  };
  return { reviewed, installed, graph };
}

test('consumer evidence compares actual identity and integrity independent of npm hoisting', () => {
  const { reviewed, installed, graph } = fixture();
  assert.deepEqual(compareConsumerDependencies(reviewed, installed, graph), {
    matches: true,
    installed_packages: 2,
    mismatches: [],
  });
});

test('a working transitive update is reported as lock drift even when the archived lock is unchanged', () => {
  const { reviewed, installed, graph } = fixture();
  installed.packages['node_modules/direct/node_modules/transitive'].version = '2.0.1';
  graph.dependencies['@seekskyworld/ai-modeling'].dependencies.direct.dependencies.transitive.version =
    '2.0.1';
  const result = compareConsumerDependencies(reviewed, installed, graph);
  assert.equal(result.matches, false);
  assert.deepEqual(result.mismatches, [
    { kind: 'version', name: 'transitive', version: '2.0.1', expected: ['2.0.0'], actual: '2.0.1' },
  ]);
});

test('same-version content changes and missing integrity cannot pass consumer lock checks', () => {
  for (const integrity of ['sha512-changed', '']) {
    const { reviewed, installed, graph } = fixture();
    installed.packages['node_modules/direct'].integrity = integrity;
    const result = compareConsumerDependencies(reviewed, installed, graph);
    assert.equal(result.matches, false);
    assert.equal(result.mismatches[0]?.kind, 'integrity');
  }
});

test('missing installed graphs, direct dependencies and integrity metadata are never evidence of a match', () => {
  const { reviewed, installed, graph } = fixture();
  const empty = compareConsumerDependencies(reviewed, installed, {});
  assert.equal(empty.matches, false);
  assert.ok(empty.mismatches.some((item) => item.kind === 'empty-graph'));
  assert.ok(empty.mismatches.some((item) => item.kind === 'direct-dependency'));
  const metadata = compareConsumerDependencies(reviewed, { lockfileVersion: 3, packages: {} }, graph);
  assert.equal(metadata.matches, false);
  assert.equal(metadata.installed_packages, 0);
  assert.equal(metadata.mismatches.filter((item) => item.kind === 'missing-installed-metadata').length, 2);
  assert.equal(compareConsumerDependencies(reviewed, {}, graph).matches, false);
});

test('consumer installation isolates npm secrets, configuration and application state', () => {
  const directory = path.join(tmpdir(), 'synthetic-consumer');
  const env = consumerEnvironment(directory, {
    PATH: '/user/global/bin',
    HOME: '/private/home',
    CODEX_HOME: '/private/codex',
    NODE_OPTIONS: '--require=private.js',
    NODE_AUTH_TOKEN: 'synthetic-secret',
    NPM_TOKEN: 'synthetic-secret',
    npm_config_userconfig: '/private/.npmrc',
    npm_config_registry: 'https://private.example',
    npm_config_cache: '/private/cache',
    AI_MODELING_DATA_DIR: '/private/state',
    TRIPO_API_KEY: 'synthetic-secret',
    HTTP_PROXY: 'http://127.0.0.1:9',
    LANG: 'C',
  });
  for (const name of ['HOME', 'CODEX_HOME', 'NODE_OPTIONS', 'NODE_AUTH_TOKEN', 'NPM_TOKEN', 'TRIPO_API_KEY'])
    assert.equal(env[name], undefined);
  assert.ok(!env.PATH!.includes('/user/global/bin'));
  assert.equal(env.npm_config_userconfig, path.join(directory, 'user.npmrc'));
  assert.equal(env.npm_config_cache, path.join(directory, 'cache'));
  assert.equal(env.npm_config_registry, 'https://registry.npmjs.org/');
  assert.equal(env.AI_MODELING_DATA_DIR, path.join(directory, 'state'));
  assert.equal(env.npm_config_ignore_scripts, 'true');
  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:9');
});

test('consumer options reject duplicate, unknown and missing values', () => {
  assert.deepEqual(parseConsumerOptions(['--require-locked', '--archive', 'a.tgz', '--report', 'new.json']), {
    archive: 'a.tgz',
    report: 'new.json',
    requireLocked: true,
  });
  for (const args of [
    [],
    ['--archive'],
    ['--archive', '--report'],
    ['a.tgz'],
    ['--archive', 'a.tgz', '--force'],
    ['--archive', 'a.tgz', '--archive', 'b.tgz'],
    ['--archive', 'a.tgz', '--require-locked', '--require-locked'],
  ])
    assert.throws(() => parseConsumerOptions(args));
});

function tarFile(name: string, content: string) {
  const bytes = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(`package/${name}`, 0, 100);
  for (const [offset, length, value] of [
    [100, 8, 0o755],
    [108, 8, 0],
    [116, 8, 0],
    [124, 12, bytes.length],
    [136, 12, 0],
  ] as const)
    header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length);
  header.fill(32, 148, 156);
  header[156] = 48;
  header.write('ustar\0', 257, 6);
  header.write('00', 263, 2);
  header.write(
    header
      .reduce((total, value) => total + value, 0)
      .toString(8)
      .padStart(6, '0') + '\0 ',
    148,
    8,
  );
  return Buffer.concat([header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)]);
}

test(
  'real npm install, npm exec and npx use disposable package installations without running lifecycle scripts',
  { timeout: 120000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-npm-fixture-'));
    try {
      const marker = path.join(directory, 'lifecycle-ran');
      const lifecycle = `node -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.exit(91)`)}`;
      const metadata = {
        name: '@seekskyworld/ai-modeling',
        version: VERSION,
        bin: { 'ai-modeling': 'dist/cli/main.js' },
        scripts: { preinstall: lifecycle, install: lifecycle, postinstall: lifecycle },
      };
      const archive = path.join(directory, 'fixture.tgz');
      await writeFile(
        archive,
        gzipSync(
          Buffer.concat([
            tarFile('package.json', JSON.stringify(metadata)),
            tarFile(
              'dist/cli/main.js',
              `#!/usr/bin/env node\nconsole.log(process.argv.includes('--version') ? ${JSON.stringify(VERSION)} : 'ai-modeling fixture help');\n`,
            ),
            Buffer.alloc(1024),
          ]),
        ),
      );
      const npmCli =
        process.env.npm_execpath ??
        (process.platform === 'win32'
          ? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
          : await realpath(path.join(path.dirname(process.execPath), 'npm')));
      const workspace = path.join(directory, 'isolated');
      await mkdir(workspace);
      const result = await installConsumerRoutes(archive, workspace, npmCli, true);
      assert.notEqual(result.local.directory, result.cached.directory);
      assert.ok(result.cached.directory.startsWith(path.join(workspace, 'cache', '_npx') + path.sep));
      for (const consumer of [result.local, result.cached])
        assert.equal(
          JSON.parse(await readFile(path.join(consumer.installed, 'package.json'), 'utf8')).version,
          VERSION,
        );
      await assert.rejects(access(marker), { code: 'ENOENT' });
      await assert.rejects(access(result.env.AI_MODELING_DATA_DIR!), { code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test('bundled dependency bytes are checked independently of npm integrity metadata', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-modeling-bundle-bytes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = 'node_modules/runtime/index.js';
  const bytes = Buffer.from('export const original = true;');
  await mkdir(path.join(root, 'node_modules/runtime'), { recursive: true });
  await writeFile(path.join(root, file), bytes);
  assert.equal(await verifyBundledFiles(root, [{ path: file, bytes }]), 1);
  await writeFile(path.join(root, file), 'export const original = false;');
  await assert.rejects(verifyBundledFiles(root, [{ path: file, bytes }]), /bundled dependency changed/);
});
