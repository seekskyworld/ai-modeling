/** Filesystem behavior: preserve unrelated/user-edited content and install the complete bundled guidance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { lockSync } from 'proper-lockfile';
import { registerSkill } from '../cli/install/commands.ts';
import { installSkill, statusSkill, uninstallSkill } from '../cli/install/skill.ts';
import { VERSION } from '../version.ts';

const manifestName = '.ai-modeling-install.json';
const root = fileURLToPath(new URL('../', import.meta.url));

function fixture(t: test.TestContext) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'ai-modeling-skill-test-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const parent = path.join(directory, 'skills');
  return { directory, parent, installed: path.join(parent, 'ai-modeling') };
}

function tree(directory: string, prefix = ''): Record<string, string> {
  const output: Record<string, string> = {};
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(output, tree(path.join(directory, entry.name), relative + '/'));
    else
      output[relative] = createHash('sha256')
        .update(fs.readFileSync(path.join(directory, entry.name)))
        .digest('hex');
  }
  return output;
}

function olderInstallation(directory: string) {
  const manifestFile = path.join(directory, manifestName);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as {
    version: string;
    files: { path: string; sha256: string; bytes: number }[];
  };
  manifest.version = '0.0.1';
  const previous = Buffer.from('An earlier installed Skill.\n');
  fs.writeFileSync(path.join(directory, 'SKILL.md'), previous);
  const file = manifest.files.find((entry) => entry.path === 'SKILL.md')!;
  file.sha256 = createHash('sha256').update(previous).digest('hex');
  file.bytes = previous.length;
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
}

test('status is read-only, and conflicting target flags fail before filesystem work', (t) => {
  const f = fixture(t);
  assert.equal(statusSkill({ dir: f.parent }).status, 'not_installed');
  assert.equal(fs.existsSync(f.parent), false);
  for (const run of [installSkill, statusSkill, uninstallSkill]) {
    assert.throws(() => run({ target: 'codex', dir: f.parent }), { code: 'INVALID_INPUT' });
    assert.throws(() => run({ target: 'other' }), { code: 'INVALID_INPUT' });
    assert.throws(() => run({ dir: ' ' }), { code: 'INVALID_INPUT' });
  }
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('install copies all references and license, repeats without rewriting, then removes only its directory', (t) => {
  const f = fixture(t);
  const installed = installSkill({ dir: f.parent });
  assert.equal(installed.status, 'installed');
  assert.equal(installed.installed_version, VERSION);
  assert.equal(installed.file_count, 6);
  const expected: Record<string, string> = {
    ...tree(path.join(root, 'skills', 'ai-modeling')),
    LICENSE: createHash('sha256')
      .update(fs.readFileSync(path.join(root, 'LICENSE')))
      .digest('hex'),
  };
  const actual = tree(f.installed);
  delete actual[manifestName];
  assert.deepEqual(actual, expected);
  assert.ok(actual['references/usage.md']);
  assert.ok(actual['references/pipelines.md']);
  const before = fs.statSync(path.join(f.installed, 'SKILL.md'), { bigint: true });
  const manifestBefore = fs.readFileSync(path.join(f.installed, manifestName));
  assert.equal(installSkill({ dir: f.parent }).status, 'current');
  assert.equal(fs.statSync(path.join(f.installed, 'SKILL.md'), { bigint: true }).mtimeNs, before.mtimeNs);
  assert.deepEqual(fs.readFileSync(path.join(f.installed, manifestName)), manifestBefore);
  assert.equal(statusSkill({ dir: f.parent }).status, 'installed');
  fs.mkdirSync(path.join(f.parent, 'another-skill'));
  fs.writeFileSync(path.join(f.parent, 'another-skill', 'keep.md'), 'user content');
  assert.equal(uninstallSkill({ dir: f.parent }).status, 'uninstalled');
  assert.equal(uninstallSkill({ dir: f.parent }).status, 'not_installed');
  assert.equal(fs.readFileSync(path.join(f.parent, 'another-skill', 'keep.md'), 'utf8'), 'user content');
  assert.deepEqual(fs.readdirSync(f.parent), ['another-skill']);
});

test('omitting a client fails before installation and explicit custom paths remain independent', (t) => {
  const f = fixture(t);
  for (const run of [installSkill, statusSkill, uninstallSkill])
    assert.throws(() => run(), { code: 'INVALID_INPUT', message: /skill targets/ });
  assert.deepEqual(fs.readdirSync(f.directory), []);
  assert.equal(installSkill({ dir: f.parent }).directory, f.installed);
  uninstallSkill({ dir: f.parent });
  assert.deepEqual(fs.readdirSync(f.directory), ['skills']);
});

test('an earlier unchanged managed installation upgrades without leaving a backup', (t) => {
  const f = fixture(t);
  installSkill({ dir: f.parent });
  olderInstallation(f.installed);
  assert.equal(statusSkill({ dir: f.parent }).installed_version, '0.0.1');
  assert.equal(installSkill({ dir: f.parent }).status, 'updated');
  assert.equal(statusSkill({ dir: f.parent }).installed_version, VERSION);
  assert.deepEqual(
    fs.readFileSync(path.join(f.installed, 'SKILL.md')),
    fs.readFileSync(path.join(root, 'skills', 'ai-modeling', 'SKILL.md')),
  );
  assert.deepEqual(fs.readdirSync(f.parent), ['ai-modeling']);
});

test('unmanaged destinations are never overwritten or uninstalled, including empty directories', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.installed, { recursive: true });
  assert.equal(statusSkill({ dir: f.parent }).status, 'unmanaged');
  for (const run of [installSkill, uninstallSkill])
    assert.throws(() => run({ dir: f.parent }), { code: 'SKILL_INSTALL_CONFLICT' });
  fs.writeFileSync(path.join(f.installed, 'SKILL.md'), 'manual installation');
  for (const run of [installSkill, uninstallSkill])
    assert.throws(() => run({ dir: f.parent }), { code: 'SKILL_INSTALL_CONFLICT' });
  assert.equal(fs.readFileSync(path.join(f.installed, 'SKILL.md'), 'utf8'), 'manual installation');
  assert.deepEqual(fs.readdirSync(f.parent), ['ai-modeling']);
});

for (const modification of ['changed', 'added', 'missing', 'empty-directory'] as const) {
  test(`install and uninstall preserve ${modification} content`, (t) => {
    const f = fixture(t);
    installSkill({ dir: f.parent });
    if (modification === 'changed')
      fs.appendFileSync(path.join(f.installed, 'SKILL.md'), '\nUser customization.\n');
    if (modification === 'added') fs.writeFileSync(path.join(f.installed, 'private-notes.md'), 'user notes');
    if (modification === 'missing') fs.unlinkSync(path.join(f.installed, 'references', 'usage.md'));
    if (modification === 'empty-directory') fs.mkdirSync(path.join(f.installed, 'personal'));
    const before = tree(f.installed);
    const state = statusSkill({ dir: f.parent });
    assert.equal(state.status, 'modified');
    assert.ok(state.conflicts.length > 0);
    for (const run of [installSkill, uninstallSkill])
      assert.throws(() => run({ dir: f.parent }), { code: 'SKILL_INSTALL_CONFLICT' });
    assert.deepEqual(tree(f.installed), before);
    assert.deepEqual(fs.readdirSync(f.parent), ['ai-modeling']);
  });
}

test('manifest traversal, malformed metadata and duplicate aliases fail without touching outside files', (t) => {
  const f = fixture(t);
  installSkill({ dir: f.parent });
  const manifestFile = path.join(f.installed, manifestName);
  const original = fs.readFileSync(manifestFile, 'utf8');
  const outside = path.join(f.parent, 'keep.txt');
  fs.writeFileSync(outside, 'outside content');
  for (const entry of [
    '../keep.txt',
    '/absolute.txt',
    'references/../../keep.txt',
    'references\\escape.md',
    'C:/escape.md',
    'SKILL.md',
  ]) {
    const manifest = JSON.parse(original);
    manifest.files.push({ path: entry, sha256: '0'.repeat(64), bytes: 0 });
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    assert.equal(statusSkill({ dir: f.parent }).status, 'modified');
    assert.throws(() => uninstallSkill({ dir: f.parent }), { code: 'SKILL_INSTALL_CONFLICT' });
    assert.throws(() => installSkill({ dir: f.parent }), { code: 'SKILL_INSTALL_CONFLICT' });
  }
  fs.writeFileSync(manifestFile, '{broken');
  assert.equal(statusSkill({ dir: f.parent }).status, 'modified');
  assert.throws(() => uninstallSkill({ dir: f.parent }), { code: 'SKILL_INSTALL_CONFLICT' });
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside content');
});

test('symlink destinations, parents and nested files are rejected and their targets survive', (t) => {
  const f = fixture(t);
  const outside = path.join(f.directory, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.md'), 'outside');
  fs.mkdirSync(f.parent);
  fs.symlinkSync(outside, f.installed, 'junction');
  for (const run of [installSkill, uninstallSkill])
    assert.throws(() => run({ dir: f.parent }), { code: 'SKILL_INSTALL_CONFLICT' });
  assert.equal(statusSkill({ dir: f.parent }).status, 'modified');
  fs.unlinkSync(f.installed);
  const alias = path.join(f.directory, 'alias');
  fs.symlinkSync(f.parent, alias, 'junction');
  for (const run of [installSkill, statusSkill, uninstallSkill])
    assert.throws(() => run({ dir: alias }), { code: 'SKILL_INSTALL_CONFLICT' });
  installSkill({ dir: f.parent });
  fs.rmSync(path.join(f.installed, 'references'), { recursive: true });
  fs.symlinkSync(outside, path.join(f.installed, 'references'), 'junction');
  for (const run of [installSkill, uninstallSkill])
    assert.throws(() => run({ dir: f.parent }), { code: 'SKILL_INSTALL_CONFLICT' });
  assert.equal(fs.readFileSync(path.join(outside, 'keep.md'), 'utf8'), 'outside');
});

test('the shared filesystem lock rejects concurrent writes but status remains read-only', (t) => {
  const f = fixture(t);
  installSkill({ dir: f.parent });
  const release = lockSync(f.installed, {
    realpath: false,
    lockfilePath: path.join(f.parent, '.ai-modeling-skill.lock'),
  });
  try {
    assert.equal(statusSkill({ dir: f.parent }).status, 'installed');
    for (const run of [installSkill, uninstallSkill])
      assert.throws(() => run({ dir: f.parent }), { code: 'SKILL_INSTALL_BUSY' });
  } finally {
    release();
  }
  assert.deepEqual(fs.readdirSync(f.parent), ['ai-modeling']);
});

test('a failed replacement restores the previous directory and cleans transaction files', (t) => {
  const f = fixture(t);
  installSkill({ dir: f.parent });
  olderInstallation(f.installed);
  const before = tree(f.installed);
  const rename = fs.renameSync;
  const mock = t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (String(from).endsWith(`${path.sep}next`) && to === f.installed)
      throw Object.assign(new Error('Simulated filesystem rename failure'), { code: 'EACCES' });
    return rename(from, to);
  });
  assert.throws(() => installSkill({ dir: f.parent }), { code: 'EACCES' });
  mock.mock.restore();
  assert.deepEqual(tree(f.installed), before);
  assert.equal(statusSkill({ dir: f.parent }).installed_version, '0.0.1');
  assert.deepEqual(fs.readdirSync(f.parent), ['ai-modeling']);
});

test('command registration keeps explicit target/dir conflicts and emits structured results', async (t) => {
  const f = fixture(t);
  const output: unknown[] = [];
  const command = () => {
    const program = new Command().exitOverride();
    registerSkill(program, (value) => output.push(value));
    return program;
  };
  await command().parseAsync(['skill', 'install', '--dir', f.parent], { from: 'user' });
  assert.equal((output[0] as { status: string }).status, 'installed');
  await assert.rejects(
    command().parseAsync(['skill', 'status', '--dir', f.parent, '--target', 'codex'], { from: 'user' }),
    { code: 'INVALID_INPUT' },
  );
  await command().parseAsync(['skill', 'uninstall', '--dir', f.parent], { from: 'user' });
  assert.equal((output[1] as { status: string }).status, 'uninstalled');
});

test('independent CLI processes share the installation lock and leave one complete installation', async (t) => {
  const f = fixture(t);
  const moduleUrl = new URL('../cli/install/skill.ts', import.meta.url).href;
  const code = `import { installSkill } from ${JSON.stringify(moduleUrl)}; try { console.log(JSON.stringify(installSkill({dir:process.argv[1]}))); } catch (error) { console.log(JSON.stringify({code:error.code})); if(error.code !== 'SKILL_INSTALL_BUSY') process.exitCode=1; }`;
  const run = () =>
    new Promise<{ status?: string; code?: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code, f.parent], {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '',
        error = '';
      child.stdout.on('data', (value) => {
        output += value;
      });
      child.stderr.on('data', (value) => {
        error += value;
      });
      child.on('error', reject);
      child.on('exit', (status) =>
        status === 0 ? resolve(JSON.parse(output)) : reject(new Error(error || output)),
      );
    });
  const results = await Promise.all([run(), run(), run()]);
  assert.ok(results.some((result) => result.status === 'installed'));
  assert.ok(
    results.every(
      (result) =>
        result.status === 'installed' || result.status === 'current' || result.code === 'SKILL_INSTALL_BUSY',
    ),
  );
  assert.equal(statusSkill({ dir: f.parent }).status, 'installed');
  assert.deepEqual(fs.readdirSync(f.parent), ['ai-modeling']);
});

test('real CLI Skill commands emit JSON without constructing account services or task state', (t) => {
  const f = fixture(t);
  const trace = path.join(f.directory, 'trace.jsonl');
  const data = path.join(f.directory, 'unused-account-data');
  fs.writeFileSync(trace, '');
  const hook = new URL('./live27-auth-cli-hook.ts', import.meta.url).href;
  const env = {
    ...process.env,
    AI_MODELING_DATA_DIR: data,
    AI_MODELING_PROFILE: 'skill-install-offline',
    LIVE27_TRACE: trace,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${hook}`.trim(),
  };
  const main = fileURLToPath(new URL('../cli/main.ts', import.meta.url));
  const run = (args: string[], cwd?: string) => {
    const executed = spawnSync(process.execPath, [main, ...args], { env, cwd, encoding: 'utf8' });
    assert.equal(executed.status, 0, executed.stderr || executed.stdout);
    return JSON.parse(executed.stdout) as { status: string; directory: string; scope: string | null };
  };
  assert.equal(run(['--json', 'skill', 'status', '--dir', f.parent]).status, 'not_installed');
  assert.equal(fs.existsSync(f.parent), false);
  const listed = spawnSync(process.execPath, [main, 'skill', 'targets', '--json'], { env, encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).default_target, null);
  assert.equal(fs.existsSync(f.parent), false);
  const unselected = spawnSync(process.execPath, [main, 'skill', 'install', '--json'], {
    env,
    encoding: 'utf8',
  });
  assert.equal(unselected.status, 2);
  assert.match(unselected.stdout, /INVALID_INPUT/);
  assert.equal(fs.existsSync(f.parent), false);
  assert.equal(run(['skill', 'install', '--dir', f.parent, '--json']).status, 'installed');
  assert.equal(run(['skill', 'status', '--dir', f.parent, '--json']).directory, f.installed);
  assert.equal(run(['skill', 'uninstall', '--dir', f.parent, '--json']).status, 'uninstalled');
  const projectFlags = ['--target', 'cursor', '--scope', 'project', '--project-dir', f.directory, '--json'];
  const projectInstall = run(['skill', 'install', ...projectFlags]);
  assert.equal(projectInstall.directory, path.join(f.directory, '.cursor', 'skills', 'ai-modeling'));
  assert.equal(projectInstall.scope, 'project');
  assert.equal(run(['skill', 'status', ...projectFlags]).status, 'installed');
  assert.equal(run(['skill', 'uninstall', ...projectFlags]).status, 'uninstalled');
  const userStatus = run(['skill', 'status', '--target', 'opencode', '--json']);
  assert.equal(userStatus.scope, 'user');
  assert.equal(userStatus.status, 'not_installed');
  assert.ok(userStatus.directory.endsWith(path.join('.config', 'opencode', 'skills', 'ai-modeling')));
  const golutraFlags = ['--target', 'golutra-agent', '--json'];
  const golutraInstall = run(['skill', 'install', ...golutraFlags], f.directory);
  assert.equal(golutraInstall.scope, 'project');
  assert.equal(golutraInstall.directory, path.join(f.directory, '.agents', 'skills', 'ai-modeling'));
  assert.equal(run(['skill', 'status', ...golutraFlags], f.directory).status, 'installed');
  assert.equal(run(['skill', 'uninstall', ...golutraFlags], f.directory).status, 'uninstalled');
  const unsupported = spawnSync(
    process.execPath,
    [main, 'skill', 'install', '--target', 'golutra-agent', '--scope', 'user', '--json'],
    { env, cwd: f.directory, encoding: 'utf8' },
  );
  assert.equal(unsupported.status, 2);
  assert.match(unsupported.stdout, /does not support user scope/);
  assert.equal(fs.existsSync(data), false);
  const calls = fs
    .readFileSync(trace, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { kind: string });
  assert.equal(calls.length, 14);
  assert.ok(calls.every((call) => call.kind === 'cli-process'));
});
