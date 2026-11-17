/** Client directory conventions are metadata, separate from the managed-file transaction. */
import path from 'node:path';
import { homedir } from 'node:os';
import { TripoError } from '../../studio/contracts/errors.ts';

export type SkillScope = 'project' | 'user';

export interface SkillOptions {
  target?: string;
  scope?: string;
  projectDir?: string;
  dir?: string;
}

export interface SkillDirectoryRule {
  /** Relative to the selected project root or the current OS user's home directory. */
  relative: string;
}

export interface SkillTarget {
  id: string;
  name: string;
  description?: string;
  defaultScope?: SkillScope;
  directories: Partial<Record<SkillScope, SkillDirectoryRule>>;
  documentation: readonly string[];
}

export interface SkillResolutionContext {
  cwd: string;
  home: string;
}

export interface SkillLocation {
  target: string;
  scope: SkillScope | null;
  projectDirectory: string | null;
  requestedParent: string;
}

/** Target-specific conventions are added only after their official documentation is verified. */
export const skillTargets: readonly SkillTarget[] = [
  {
    id: 'codex',
    name: 'Codex',
    directories: { project: { relative: '.agents/skills' }, user: { relative: '.agents/skills' } },
    documentation: ['https://learn.chatgpt.com/docs/build-skills'],
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    directories: { project: { relative: '.claude/skills' }, user: { relative: '.claude/skills' } },
    documentation: ['https://code.claude.com/docs/en/skills'],
  },
  {
    id: 'cursor',
    name: 'Cursor',
    directories: { project: { relative: '.cursor/skills' }, user: { relative: '.cursor/skills' } },
    documentation: ['https://cursor.com/docs/skills'],
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    directories: { project: { relative: '.github/skills' }, user: { relative: '.copilot/skills' } },
    documentation: ['https://code.visualstudio.com/docs/agent-customization/agent-skills'],
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    directories: { project: { relative: '.gemini/skills' }, user: { relative: '.gemini/skills' } },
    documentation: ['https://geminicli.com/docs/cli/skills/'],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    directories: { project: { relative: '.opencode/skills' }, user: { relative: '.config/opencode/skills' } },
    documentation: ['https://opencode.ai/docs/skills/'],
  },
  {
    id: 'golutra-agent',
    name: 'Golutra Agent',
    description: 'Project Skill files discoverable by the golutra-agent TUI workspace scanner.',
    defaultScope: 'project',
    directories: { project: { relative: '.agents/skills' } },
    documentation: ['https://github.com/golutra/golutra-agent'],
  },
  {
    id: 'agents',
    name: 'Shared .agents convention',
    description: 'Recognized by the documented clients; other clients may need their own --dir.',
    directories: { project: { relative: '.agents/skills' }, user: { relative: '.agents/skills' } },
    documentation: [
      'https://learn.chatgpt.com/docs/build-skills',
      'https://cursor.com/docs/skills',
      'https://geminicli.com/docs/cli/skills/',
      'https://opencode.ai/docs/skills/',
    ],
  },
];
export const skillDefaults: { target: string | null; scope: SkillScope } = {
  target: null,
  scope: 'user',
};

function invalid(message: string): never {
  throw new TripoError('INVALID_INPUT', message, 'not_submitted');
}

function inputPath(value: string, label: string): string {
  if (!value.trim() || value.includes('\0')) invalid(`${label} must be a nonempty path.`);
  return value;
}

function relativePath(value: string): string {
  if (
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /[\\:]/.test(value) ||
    value.includes('\0') ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    invalid('The selected Skill target has an unsafe directory rule.');
  return value;
}

function scopeFrom(options: SkillOptions, target: SkillTarget): SkillScope {
  const scope = options.scope ?? target.defaultScope ?? skillDefaults.scope;
  if (scope !== 'project' && scope !== 'user') invalid('Choose --scope project or --scope user.');
  if (options.projectDir !== undefined && scope !== 'project')
    invalid('--project-dir is only valid with project scope.');
  return scope;
}

function customLocation(options: SkillOptions, context: SkillResolutionContext): SkillLocation {
  if (options.target !== undefined || options.scope !== undefined || options.projectDir !== undefined)
    invalid('--dir selects a custom parent; do not combine it with --target, --scope or --project-dir.');
  return {
    target: 'custom',
    scope: null,
    projectDirectory: null,
    requestedParent: path.resolve(context.cwd, inputPath(options.dir!, '--dir')),
  };
}

export function resolveSkillLocation(
  options: SkillOptions,
  context: SkillResolutionContext = { cwd: process.cwd(), home: homedir() },
  registry: readonly SkillTarget[] = skillTargets,
): SkillLocation {
  if (options.dir !== undefined) return customLocation(options, context);
  const id = options.target ?? skillDefaults.target;
  if (!id)
    invalid('Choose a Skill target with --target, or supply --dir. Run skill targets to list choices.');
  const target = registry.find((entry) => entry.id === id);
  if (!target) invalid('Unknown Skill target. Run skill targets, or use --dir for another client.');
  const scope = scopeFrom(options, target);
  const rule = target.directories[scope];
  if (!rule) invalid(`Skill target ${target.id} does not support ${scope} scope; see skill targets.`);
  const projectDirectory =
    scope === 'project'
      ? path.resolve(context.cwd, inputPath(options.projectDir ?? context.cwd, '--project-dir'))
      : null;
  const parent = path.join(projectDirectory ?? context.home, relativePath(rule.relative));
  return {
    target: target.id,
    scope,
    projectDirectory,
    requestedParent: path.resolve(context.cwd, parent),
  };
}

export function listSkillTargets(registry: readonly SkillTarget[] = skillTargets) {
  return {
    schema_version: 1,
    default_target: skillDefaults.target,
    default_scope: skillDefaults.scope,
    targets: registry.map((target) => ({
      id: target.id,
      name: target.name,
      default_scope: target.defaultScope ?? skillDefaults.scope,
      ...(target.description ? { description: target.description } : {}),
      directories: Object.fromEntries(
        Object.entries(target.directories).map(([scope, rule]) => [
          scope,
          {
            parent: `${scope === 'project' ? '<project>' : '~'}/${rule.relative}`,
          },
        ]),
      ),
      documentation: [...target.documentation],
    })),
    custom_directory: { option: '--dir', destination: '<dir>/ai-modeling' },
    project_root: 'Current directory, or the explicit --project-dir; parent repositories are not discovered.',
    configuration_modified: false,
  };
}
