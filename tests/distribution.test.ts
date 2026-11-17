import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { exportDistribution, parseExportArgs, publishStaged } from '../scripts/distribution.ts';
import {
  assertPackageFile,
  assertUniquePaths,
  readDistributionFile,
  readPackageMetadata,
  requiredPackageFiles,
  validatePackageInventory,
} from '../scripts/package-validation.ts';

const version = '1.2.3-test.1';
const skillName = `ai-modeling-skill-${version}.zip`;
const runtimeName = `ai-modeling-${version}.tgz`;
const entrypoint = fileURLToPath(new URL('../scripts/export.ts', import.meta.url));

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-distribution-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'source');
  await mkdir(root);
  const metadata = {
    name: '@seekskyworld/ai-modeling',
    version,
    license: 'Apache-2.0',
    private: false,
    type: 'module',
    bin: { 'ai-modeling': 'dist/cli/main.js' },
    files: [
      'dist',
      'npm-shrinkwrap.json',
      'docs',
      'examples',
      'skills/ai-modeling',
      'assets/branding',
      ...requiredPackageFiles.filter((file) => !file.includes('/')),
    ],
    scripts: { build: 'node build-fixture.cjs', prepack: 'node -e "process.exit(91)"' },
  };
  for (const file of requiredPackageFiles) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), file.endsWith('.md') ? '# Fixture\n' : 'fixture\n');
  }
  await writeFile(path.join(root, 'package.json'), JSON.stringify(metadata, null, 2) + '\n');
  await writeFile(
    path.join(root, 'package-lock.json'),
    JSON.stringify({
      name: metadata.name,
      version,
      lockfileVersion: 3,
      requires: true,
      packages: { '': { name: metadata.name, version } },
    }) + '\n',
  );
  await writeFile(path.join(root, 'LICENSE'), 'Apache License\nVersion 2.0, January 2004\n');
  await writeFile(
    path.join(root, 'skills/ai-modeling/SKILL.md'),
    '# Fixture\n\nSee [guide](references/guide.md).\n',
  );
  await mkdir(path.join(root, 'skills/ai-modeling/references'), { recursive: true });
  await writeFile(
    path.join(root, 'skills/ai-modeling/references/guide.md'),
    '# Guide\n\nSynthetic documentation.\n',
  );
  await writeFile(
    path.join(root, 'skills/ai-modeling/references/示例.bin'),
    Buffer.from([0, 255, 128, 10, 13, 0, 42]),
  );
  const config = {
    mcpServers: {
      'ai-modeling': {
        command: 'ai-modeling',
        args: ['mcp', '--toolset', 'studio'],
        env: { AI_MODELING_PROFILE: 'default' },
      },
    },
  };
  await writeFile(path.join(root, 'examples/mcp-installed.json'), JSON.stringify(config, null, 2) + '\n');
  await writeFile(path.join(root, 'examples/mcp.json'), JSON.stringify(config) + '\n');
  await writeFile(
    path.join(root, 'examples/mcp-vscode.json'),
    JSON.stringify({ servers: config.mcpServers }) + '\n',
  );
  await writeFile(
    path.join(root, 'examples/mcp-opencode.json'),
    JSON.stringify({
      mcp: {
        servers: { 'ai-modeling': { type: 'local', command: ['ai-modeling', 'mcp', '--toolset', 'studio'] } },
      },
    }) + '\n',
  );
  await writeFile(
    path.join(root, 'build-fixture.cjs'),
    `const fs = require('node:fs');
fs.mkdirSync('dist/cli/local', {recursive: true});
fs.mkdirSync('dist/cli/artifacts', {recursive: true});
fs.mkdirSync('dist/mcp', {recursive: true});
fs.mkdirSync('dist/studio/api', {recursive: true});
fs.writeFileSync('dist/studio/api/reviewed-prices.json', '{}');
fs.writeFileSync('dist/cli/main.js', '// built fixture\\n');
fs.writeFileSync('dist/version.js', '// version fixture\\n');
fs.writeFileSync('dist/mcp/main.js', '// mcp fixture\\n');
fs.writeFileSync('dist/cli/local/model-worker.py', '# worker fixture\\n');
fs.writeFileSync('dist/cli/artifacts/verified.js', '// legitimate artifact source\\n');
fs.writeFileSync('build-ran', 'yes');
`,
  );
  return { directory, root, out: path.join(directory, 'export') };
}

function checksum(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

/** Independent reader verifies central records, local headers, decoded bytes and CRC. */
function unzip(bytes: Buffer): Map<string, Buffer> {
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  const count = bytes.readUInt16LE(end + 10);
  let cursor = bytes.readUInt32LE(end + 16);
  const start = cursor;
  const result = new Map<string, Buffer>();
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    assert.equal(bytes.readUInt16LE(cursor + 8), 0x800);
    assert.equal(bytes.readUInt16LE(cursor + 10), 8);
    const length = bytes.readUInt16LE(cursor + 28);
    const name = bytes.toString('utf8', cursor + 46, cursor + 46 + length);
    assert.ok(name.startsWith('ai-modeling/') && !name.includes('..'));
    assert.ok(!result.has(name));
    const local = bytes.readUInt32LE(cursor + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    assert.equal(bytes.toString('utf8', local + 30, local + 30 + length), name);
    const data = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const decoded = inflateRawSync(bytes.subarray(data, data + bytes.readUInt32LE(cursor + 20)));
    assert.equal(decoded.length, bytes.readUInt32LE(cursor + 24));
    assert.equal(checksum(decoded), bytes.readUInt32LE(cursor + 16));
    assert.equal(bytes.readUInt32LE(local + 14), checksum(decoded));
    result.set(name, decoded);
    cursor += 46 + length + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
  }
  assert.equal(cursor, end);
  assert.equal(cursor - start, bytes.readUInt32LE(end + 12));
  return result;
}

function untar(bytes: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(bytes);
  const result = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= tar.length && tar[offset] !== 0) {
    const text = (start: number, length: number) =>
      tar.toString('utf8', offset + start, offset + start + length).replace(/\0.*$/s, '');
    const size = Number.parseInt(text(124, 12).trim(), 8);
    const name = text(0, 100);
    const type = text(156, 1);
    if (type === '0' || type === '') result.set(name, tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return result;
}

async function assertChecksums(out: string) {
  const sums = (await readFile(path.join(out, 'SHA256SUMS'), 'utf8')).trim().split('\n');
  const filenames: string[] = [];
  for (const line of sums) {
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
    assert.ok(match);
    filenames.push(match[2]!);
    assert.equal(
      createHash('sha256')
        .update(await readFile(path.join(out, match[2]!)))
        .digest('hex'),
      match[1],
    );
  }
  assert.deepEqual(filenames.sort(), (await readdir(out)).filter((file) => file !== 'SHA256SUMS').sort());
  const manifest = JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, version);
  for (const entry of manifest.artifacts as { path: string; sha256: string; size: number }[]) {
    const bytes = await readFile(path.join(out, entry.path));
    assert.equal(entry.size, bytes.length);
    assert.equal(entry.sha256, createHash('sha256').update(bytes).digest('hex'));
  }
  return manifest;
}

test('Skill export is a readable complete archive with license, Unicode and binary content, without unrelated source', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, '.env'), 'PRIVATE_ENV=synthetic-do-not-export\n');
  await writeFile(path.join(f.root, 'unrelated.txt'), 'synthetic-private-marker');
  const result = await exportDistribution(f.root, { out: f.out, target: 'skill' });
  assert.deepEqual(result.files, ['INSTALL.md', 'SHA256SUMS', skillName, 'manifest.json'].sort());
  const files = unzip(await readFile(path.join(f.out, skillName)));
  assert.deepEqual(
    [...files.keys()].sort(),
    [
      'ai-modeling/LICENSE',
      'ai-modeling/SKILL.md',
      'ai-modeling/references/guide.md',
      'ai-modeling/references/usage.md',
      'ai-modeling/references/pipelines.md',
      'ai-modeling/references/示例.bin',
    ].sort(),
  );
  for (const [name, bytes] of files) {
    const original = name === 'ai-modeling/LICENSE' ? 'LICENSE' : `skills/${name}`;
    assert.deepEqual(bytes, await readFile(path.join(f.root, original)));
    assert.ok(!bytes.includes(Buffer.from('synthetic-private-marker')));
  }
  assert.equal((await assertChecksums(f.out)).target, 'skill');
  assert.equal(await lstat(path.join(f.root, 'build-ran')).catch(() => undefined), undefined);
  assert.deepEqual((await readdir(f.directory)).sort(), ['export', 'source']);
});

test('argument errors and help exit before building, writing output or needing npm', async (t) => {
  const f = await fixture(t);
  for (const args of [
    [],
    ['--out', f.out, '--target', 'bad'],
    ['--out', f.out, '--force'],
    ['--out'],
    ['--out', f.out, '--out', f.out],
  ]) {
    const result = spawnSync(process.execPath, [entrypoint, ...args], {
      cwd: f.directory,
      encoding: 'utf8',
      env: { ...process.env, npm_execpath: path.join(f.directory, 'must-not-run.js') },
    });
    assert.equal(result.status, 1);
    assert.notEqual(result.stderr.trim(), '');
  }
  const help = spawnSync(process.execPath, [entrypoint, '--help'], {
    cwd: f.directory,
    encoding: 'utf8',
    env: { ...process.env, npm_execpath: '' },
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--target/);
  assert.deepEqual(await readdir(f.directory), ['source']);
  assert.deepEqual(parseExportArgs(['--out=./new']), { out: './new', target: 'all' });
});

test('existing files and directories are preserved; missing parents and source-tree output are rejected before build', async (t) => {
  const f = await fixture(t);
  await mkdir(f.out);
  await writeFile(path.join(f.out, 'keep.txt'), 'untouched');
  await assert.rejects(exportDistribution(f.root, { out: f.out, target: 'mcp' }), /already exists/);
  assert.equal(await readFile(path.join(f.out, 'keep.txt'), 'utf8'), 'untouched');
  const file = path.join(f.directory, 'existing-file');
  await writeFile(file, 'original');
  await assert.rejects(exportDistribution(f.root, { out: file, target: 'all' }), /already exists/);
  assert.equal(await readFile(file, 'utf8'), 'original');
  await assert.rejects(
    exportDistribution(f.root, { out: path.join(f.directory, 'missing/child'), target: 'all' }),
    /ENOENT/,
  );
  await assert.rejects(
    exportDistribution(f.root, { out: path.join(f.root, 'docs/export'), target: 'all' }),
    /outside/,
  );
  assert.equal(await lstat(path.join(f.root, 'build-ran')).catch(() => undefined), undefined);
});

test('unsafe Skill inputs and broken archive-local links fail without partial output or staging leftovers', async (t) => {
  const f = await fixture(t);
  const inputs = [
    { name: '.env', content: 'synthetic secret', error: /Private or generated/ },
    {
      name: 'references/leak.md',
      content: ['/', 'Users', '/synthetic-user/private'].join(''),
      error: /private data marker/,
    },
    {
      name: 'references/invalid.md',
      content: '[outside](../../../README.md)\n',
      error: /escapes|missing link/,
    },
  ];
  for (const input of inputs) {
    const file = path.join(f.root, 'skills/ai-modeling', input.name);
    await writeFile(file, input.content);
    await assert.rejects(exportDistribution(f.root, { out: f.out, target: 'skill' }), input.error);
    await rm(file);
    assert.deepEqual(await readdir(f.directory), ['source']);
  }
});

test('Skill and package readers reject symlinks instead of copying outside data', async (t) => {
  const f = await fixture(t);
  const target = path.join(f.directory, 'private.txt');
  await writeFile(target, 'synthetic private file');
  const linked = path.join(f.root, 'skills/ai-modeling/linked.md');
  try {
    await symlink(target, linked);
  } catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM')
      return t.skip('Windows symlink permission unavailable');
    throw error;
  }
  await assert.rejects(exportDistribution(f.root, { out: f.out, target: 'skill' }), /regular file/);
  await assert.rejects(readDistributionFile(f.root, 'skills/ai-modeling/linked.md'), /regular file/);
  assert.equal(await readFile(target, 'utf8'), 'synthetic private file');
  assert.equal(await lstat(f.out).catch(() => undefined), undefined);
  const alias = path.join(f.directory, 'source-alias');
  await symlink(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(
    exportDistribution(f.root, { out: path.join(alias, 'docs/export'), target: 'all' }),
    /outside/,
  );
  const dangling = path.join(f.directory, 'dangling-output');
  await symlink(path.join(f.directory, 'missing-target'), dangling);
  await assert.rejects(exportDistribution(f.root, { out: dangling, target: 'skill' }), /already exists/);
  assert.ok((await lstat(dangling)).isSymbolicLink());
});

test('publication reserves destinations and removes only its own partial files', async (t) => {
  const f = await fixture(t);
  const stage = path.join(f.directory, 'stage');
  await mkdir(stage);
  await writeFile(path.join(stage, 'good.txt'), 'good');
  await assert.rejects(publishStaged(stage, f.out, ['good.txt', 'missing.txt']), /ENOENT/);
  assert.equal(await lstat(f.out).catch(() => undefined), undefined);
  assert.equal(await readFile(path.join(stage, 'good.txt'), 'utf8'), 'good');
  await mkdir(f.out);
  await writeFile(path.join(f.out, 'original.txt'), 'original');
  await assert.rejects(publishStaged(stage, f.out, ['good.txt']), /EEXIST/);
  assert.deepEqual(await readdir(f.out), ['original.txt']);
  await assert.rejects(publishStaged(stage, path.join(f.directory, 'other'), ['../escape']), /Unsafe/);
});

test('shared package guard permits real artifacts modules and rejects private inventories and broken links', async (t) => {
  const f = await fixture(t);
  assert.doesNotThrow(() => assertPackageFile('dist/cli/artifacts/metadata.js'));
  for (const file of [
    'dist/session.sqlite-wal',
    'examples/.env',
    'dist/.git/config',
    'docs/.ai-modeling/context.json',
    'dist/.ai-modeling-auth/session.json',
    'outside.txt',
    '../escape',
  ])
    assert.throws(() => assertPackageFile(file));
  assert.throws(() => assertUniquePaths(['Guide.md', 'guide.md']), /Conflicting/);
  const files = [
    ...requiredPackageFiles,
    'skills/ai-modeling/references/guide.md',
    'skills/ai-modeling/references/示例.bin',
  ];
  const inventory = {
    name: '@seekskyworld/ai-modeling',
    version,
    files: await Promise.all(
      files.map(async (file) => ({ path: file, size: (await lstat(path.join(f.root, file))).size })),
    ),
  };
  await validatePackageInventory(f.root, inventory);
  await writeFile(path.join(f.root, 'README.md'), '[missing](missing.md)\n');
  inventory.files.find((entry) => entry.path === 'README.md')!.size = (
    await lstat(path.join(f.root, 'README.md'))
  ).size;
  await assert.rejects(validatePackageInventory(f.root, inventory), /missing link target/);
});

test('runtime metadata requires the unified package and sole executable before exporting', async (t) => {
  const f = await fixture(t);
  const filename = path.join(f.root, 'package.json');
  const original = JSON.parse(await readFile(filename, 'utf8'));
  for (const changed of [
    { ...original, name: 'legacy-runtime' },
    { ...original, private: true },
    { ...original, bin: { 'ai-modeling': 'dist/mcp/main.js' } },
    { ...original, bin: { ...original.bin, 'other-command': 'dist/mcp/main.js' } },
  ]) {
    await writeFile(filename, JSON.stringify(changed));
    await assert.rejects(readPackageMetadata(f.root), /package must/i);
    await assert.rejects(exportDistribution(f.root, { out: f.out, target: 'skill' }), /package must/i);
    assert.equal(await lstat(f.out).catch(() => undefined), undefined);
  }
});

test(
  'MCP/all export builds current inputs and validates real npm tar contents without invoking prepack',
  { skip: !process.env.npm_execpath },
  async (t) => {
    const f = await fixture(t);
    await rm(path.join(f.root, 'dist'), { recursive: true });
    const result = await exportDistribution(f.root, { out: f.out, target: 'all' }, process.env.npm_execpath);
    assert.ok(
      result.files.includes(skillName) &&
        result.files.includes(runtimeName) &&
        result.files.includes('mcp.json'),
    );
    assert.equal(await readFile(path.join(f.root, 'build-ran'), 'utf8'), 'yes');
    const files = untar(await readFile(path.join(f.out, runtimeName)));
    const metadata = JSON.parse(files.get('package/package.json')!.toString());
    assert.equal(metadata.name, '@seekskyworld/ai-modeling');
    assert.equal(metadata.version, version);
    assert.deepEqual(metadata.bin, { 'ai-modeling': 'dist/cli/main.js' });
    assert.equal(metadata.devDependencies, undefined);
    const shrinkwrap = JSON.parse(files.get('package/npm-shrinkwrap.json')!.toString());
    assert.equal(shrinkwrap.version, version);
    assert.equal(shrinkwrap.lockfileVersion, 3);
    assert.equal(files.get('package/dist/cli/main.js')?.toString(), '// built fixture\n');
    assert.equal(
      files.get('package/dist/cli/artifacts/verified.js')?.toString(),
      '// legitimate artifact source\n',
    );
    assert.ok(!files.has('package/build-ran') && !files.has('package/build-fixture.cjs'));
    assert.deepEqual(
      await readFile(path.join(f.out, 'mcp.json')),
      await readFile(path.join(f.root, 'examples/mcp-installed.json')),
    );
    const config = JSON.parse(await readFile(path.join(f.out, 'mcp.json'), 'utf8'));
    assert.deepEqual(config.mcpServers['ai-modeling'], {
      command: 'ai-modeling',
      args: ['mcp', '--toolset', 'studio'],
      env: { AI_MODELING_PROFILE: 'default' },
    });
    assert.equal((await assertChecksums(f.out)).target, 'all');
    assert.deepEqual((await readdir(f.directory)).sort(), ['export', 'source']);
    const second = path.join(f.directory, 'mcp-only');
    await exportDistribution(f.root, { out: second, target: 'mcp' }, process.env.npm_execpath);
    assert.ok(!(await readdir(second)).includes(skillName));
    assert.equal((await assertChecksums(second)).target, 'mcp');
  },
);

test(
  'export rejects source changes made by the build without publishing a partial candidate',
  { skip: !process.env.npm_execpath },
  async (t) => {
    const f = await fixture(t);
    const build = path.join(f.root, 'build-fixture.cjs');
    await writeFile(
      build,
      (await readFile(build, 'utf8')) + '\nfs.writeFileSync("README.md", "# Changed during build\\n");\n',
    );
    await assert.rejects(exportDistribution(f.root, { out: f.out, target: 'all' }), /provenance changed/);
    assert.equal(await lstat(f.out).catch(() => undefined), undefined);
  },
);
