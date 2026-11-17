import type { Command } from 'commander';
import { installSkill, statusSkill, uninstallSkill, type SkillOptions } from './skill.ts';
import { listSkillTargets } from './targets.ts';

export function registerSkill(program: Command, emit: (value: unknown) => void): void {
  const group = program
    .command('skill')
    .description('install, inspect or remove bundled Agent Skill guidance');
  group
    .command('targets')
    .description('list supported clients, scopes and documented directories without changing configuration')
    .action(() => {
      emit(listSkillTargets());
    });
  for (const [name, description, run] of [
    ['install', 'install or update bundled guidance while preserving user changes', installSkill],
    ['status', 'verify installed guidance without creating directories or accessing an account', statusSkill],
    ['uninstall', 'remove only an unchanged installation managed by ai-modeling', uninstallSkill],
  ] as const) {
    group
      .command(name)
      .description(description)
      .option('--target <name>', 'client directory convention; see skill targets')
      .option('--scope <scope>', 'project or user scope (default: user; golutra-agent: project)')
      .option(
        '--project-dir <path>',
        'existing project root; defaults to the current directory in project scope',
      )
      .option('--dir <path>', 'custom skills parent directory; installs its ai-modeling subdirectory')
      .action((options: SkillOptions) => {
        emit(run(options));
      });
  }
}
