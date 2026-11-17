/** 从实际命令树生成补全，网页新增子命令无需维护第二份静态列表。 */
import type { Command } from 'commander';
import { TripoError } from '../../studio/contracts/errors.ts';
export function registerCompletion(program: Command): void {
  program
    .command('completion <shell>')
    .description('print a completion script (bash|zsh|fish); e.g. ai-modeling completion zsh >> ~/.zshrc')
    .action((shell: string) => {
      const root = program.commands.map((c) => c.name()).join(' ');
      const subs = program.commands
        .filter((c) => c.commands.length)
        .map((c) => [c.name(), c.commands.map((s) => s.name()).join(' ')]);
      if (shell === 'bash') {
        process.stdout.write(
          `_ai_modeling_complete() {\n local cur="\${COMP_WORDS[COMP_CWORD]}"\n local words="${root}"\n if (( COMP_CWORD > 1 )); then\n case "\${COMP_WORDS[1]}" in\n${subs.map(([name, names]) => `${name}) words="${names}";;`).join('\n')}\n esac\n fi\n COMPREPLY=($(compgen -W "$words" -- "$cur"))\n}\ncomplete -F _ai_modeling_complete ai-modeling\n`,
        );
      } else if (shell === 'zsh') {
        process.stdout.write(
          `#compdef ai-modeling\n(( $+functions[compdef] )) || { autoload -Uz compinit; compinit; }\n_ai_modeling() {\n if (( CURRENT == 2 )); then\n compadd ${root}\n else\n case $words[2] in\n${subs.map(([name, names]) => `${name}) compadd ${names};;`).join('\n')}\n esac\n fi\n}\ncompdef _ai_modeling ai-modeling\n`,
        );
      } else if (shell === 'fish')
        process.stdout.write(
          [
            `complete -c ai-modeling -f -n '__fish_use_subcommand' -a '${root}'`,
            ...subs.map(
              ([name, names]) =>
                `complete -c ai-modeling -f -n '__fish_seen_subcommand_from ${name}' -a '${names}'`,
            ),
          ].join('\n') + '\n',
        );
      else throw new TripoError('INVALID_INPUT', 'supported shells: bash, zsh, fish');
    });
}
