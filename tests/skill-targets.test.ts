import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { installSkill, statusSkill, uninstallSkill } from '../cli/install/skill.ts';
import {
  listSkillTargets,
  resolveSkillLocation,
  type SkillResolutionContext,
  type SkillTarget,
} from '../cli/install/targets.ts';

const context: SkillResolutionContext = {
  cwd: path.resolve('synthetic-project', 'nested'),
  home: path.resolve('synthetic-home'),
};
const fixtures: readonly SkillTarget[] = [
  {
    id: 'synthetic-client',
    name: 'Synthetic client',
    directories: {
      project: { relative: '.synthetic/skills' },
      user: { relative: '.synthetic/skills' },
    },
    documentation: ['https://example.invalid/synthetic-directory-contract'],
  },
  {
    id: 'project-only',
    name: 'Project only fixture',
    defaultScope: 'project',
    directories: { project: { relative: '.project-skills' } },
    documentation: [],
  },
];

test('target metadata lists directory conventions without expanding or reading the local environment', () => {
  const result = listSkillTargets(fixtures);
  assert.equal(result.default_target, null);
  assert.equal(result.default_scope, 'user');
  assert.equal(result.targets[0]?.default_scope, 'user');
  assert.equal(result.targets[1]?.default_scope, 'project');
  assert.equal(result.configuration_modified, false);
  assert.equal(result.targets[0]?.directories.project?.parent, '<project>/.synthetic/skills');
  assert.equal(result.targets[0]?.directories.user?.parent, '~/.synthetic/skills');
  assert.deepEqual(result.custom_directory, { option: '--dir', destination: '<dir>/ai-modeling' });
  assert.ok(!JSON.stringify(result).includes(context.home));
});

test('project scope uses the explicit root or current directory without inferring an ancestor repository', () => {
  const selected = resolveSkillLocation({ target: 'synthetic-client', scope: 'project' }, context, fixtures);
  assert.equal(selected.requestedParent, path.join(context.cwd, '.synthetic/skills'));
  assert.equal(selected.projectDirectory, context.cwd);
  const explicit = resolveSkillLocation(
    { target: 'synthetic-client', scope: 'project', projectDir: '../other-project' },
    context,
    fixtures,
  );
  assert.equal(explicit.projectDirectory, path.resolve(context.cwd, '../other-project'));
  assert.equal(explicit.requestedParent, path.resolve(context.cwd, '../other-project/.synthetic/skills'));
});

test('user scope uses the supplied OS home and preserves the caller context', () => {
  const original = { ...context };
  const selected = resolveSkillLocation({ target: 'synthetic-client', scope: 'user' }, context, fixtures);
  assert.equal(selected.projectDirectory, null);
  assert.deepEqual(context, original);
  assert.equal(
    resolveSkillLocation({ target: 'synthetic-client', scope: 'user' }, context, fixtures).requestedParent,
    path.join(context.home, '.synthetic/skills'),
  );
});

test('custom parents remain client-neutral and ambiguous or unsupported selections fail', () => {
  const selected = resolveSkillLocation({ dir: '../shared-skills' }, context, fixtures);
  assert.equal(selected.target, 'custom');
  assert.equal(selected.scope, null);
  assert.equal(selected.requestedParent, path.resolve(context.cwd, '../shared-skills'));
  for (const options of [
    {},
    { target: 'unknown' },
    { target: 'synthetic-client', scope: 'system' },
    { dir: 'skills', target: 'synthetic-client' },
    { dir: 'skills', scope: 'project' },
    { dir: 'skills', projectDir: 'project' },
    { dir: ' ' },
    { target: 'project-only', scope: 'user' },
    { target: 'synthetic-client', scope: 'user', projectDir: 'project' },
  ])
    assert.throws(() => resolveSkillLocation(options, context, fixtures), { code: 'INVALID_INPUT' });
});

test('registered directory rules cannot escape the selected scope or inject another drive', () => {
  for (const relative of [
    '../outside',
    '/absolute',
    'C:/drive',
    'path\\escape',
    'skills/../../outside',
    '',
  ]) {
    const registry: SkillTarget[] = [
      { id: 'unsafe', name: 'Unsafe fixture', directories: { project: { relative } }, documentation: [] },
    ];
    assert.throws(() => resolveSkillLocation({ target: 'unsafe', scope: 'project' }, context, registry), {
      code: 'INVALID_INPUT',
    });
  }
});

const verifiedConventions: { target: string; project: string; user?: string }[] = [
  { target: 'codex', project: '.agents/skills', user: '.agents/skills' },
  { target: 'claude-code', project: '.claude/skills', user: '.claude/skills' },
  { target: 'cursor', project: '.cursor/skills', user: '.cursor/skills' },
  { target: 'copilot', project: '.github/skills', user: '.copilot/skills' },
  { target: 'gemini-cli', project: '.gemini/skills', user: '.gemini/skills' },
  { target: 'opencode', project: '.opencode/skills', user: '.config/opencode/skills' },
  { target: 'golutra-agent', project: '.agents/skills' },
  { target: 'agents', project: '.agents/skills', user: '.agents/skills' },
];

test('officially checked clients resolve distinct project/user conventions and expose their documentation', () => {
  const listed = listSkillTargets();
  assert.deepEqual(
    listed.targets.map((target) => target.id),
    verifiedConventions.map((target) => target.target),
  );
  for (const target of verifiedConventions) {
    const project = resolveSkillLocation({ target: target.target, scope: 'project' }, context);
    const defaulted = resolveSkillLocation({ target: target.target }, context);
    assert.equal(project.requestedParent, path.join(context.cwd, target.project));
    assert.equal(
      defaulted.requestedParent,
      path.join(target.user ? context.home : context.cwd, target.user ?? target.project),
    );
    assert.equal(defaulted.scope, target.user ? 'user' : 'project');
    assert.ok(
      listed.targets
        .find((item) => item.id === target.target)
        ?.documentation.every((url) => url.startsWith('https://')),
    );
  }
});

test('golutra-agent defaults to workspace project discovery and rejects user scope before filesystem work', () => {
  const listed = listSkillTargets();
  const target = listed.targets.find((entry) => entry.id === 'golutra-agent')!;
  assert.equal(listed.default_scope, 'user');
  assert.equal(target.default_scope, 'project');
  assert.deepEqual(Object.keys(target.directories), ['project']);
  assert.equal(target.directories.project?.parent, '<project>/.agents/skills');
  assert.match(target.description ?? '', /TUI workspace scanner/);
  const selected = resolveSkillLocation({ target: 'golutra-agent' }, context);
  assert.equal(selected.scope, 'project');
  assert.equal(selected.projectDirectory, context.cwd);
  assert.equal(selected.requestedParent, path.join(context.cwd, '.agents/skills'));
  const explicit = resolveSkillLocation({ target: 'golutra-agent', projectDir: '../selected' }, context);
  assert.equal(explicit.requestedParent, path.resolve(context.cwd, '../selected/.agents/skills'));
  for (const run of [installSkill, statusSkill, uninstallSkill])
    assert.throws(() => run({ target: 'golutra-agent', scope: 'user' }), {
      code: 'INVALID_INPUT',
      message: /does not support user scope/,
    });
});

test('Codex uses the documented .agents convention from the supplied synthetic OS home', () => {
  const selected = resolveSkillLocation({ target: 'codex' }, context);
  assert.equal(selected.requestedParent, path.join(context.home, '.agents/skills'));
});

test('each documented project target uses the same guarded lifecycle and preserves neighboring client configuration', (t) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'ai-modeling-target-lifecycle-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const target of verifiedConventions) {
    const parent = path.join(directory, target.project);
    fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(path.join(parent, 'keep-client-config.json'), '{"user":"unchanged"}\n');
    const options = { target: target.target, scope: 'project', projectDir: directory };
    const first = installSkill(options);
    assert.equal(first.directory, path.join(parent, 'ai-modeling'));
    assert.equal(first.scope, 'project');
    assert.equal(first.project_directory, directory);
    assert.equal(first.file_count, 6);
    assert.equal(statusSkill(options).status, 'installed');
    fs.writeFileSync(path.join(first.directory, 'user-notes.txt'), 'keep user notes');
    assert.throws(() => uninstallSkill(options), { code: 'SKILL_INSTALL_CONFLICT' });
    fs.unlinkSync(path.join(first.directory, 'user-notes.txt'));
    assert.equal(uninstallSkill(options).status, 'uninstalled');
    assert.deepEqual(fs.readdirSync(parent), ['keep-client-config.json']);
    assert.equal(
      fs.readFileSync(path.join(parent, 'keep-client-config.json'), 'utf8'),
      '{"user":"unchanged"}\n',
    );
  }
});

test('project scope refuses a missing or symlink project root without creating a new project', (t) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'ai-modeling-target-roots-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const absent = path.join(directory, 'absent-project');
  const linked = path.join(directory, 'linked-project');
  fs.symlinkSync(directory, linked, 'junction');
  for (const projectDir of [absent, linked]) {
    for (const run of [installSkill, statusSkill, uninstallSkill])
      assert.throws(() => run({ target: 'claude-code', scope: 'project', projectDir }), {
        code: 'SKILL_INSTALL_CONFLICT',
      });
  }
  assert.equal(fs.existsSync(absent), false);
  assert.deepEqual(fs.readdirSync(directory), ['linked-project']);
});
