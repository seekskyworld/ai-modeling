/** Skills and MCP share guidance; only the CLI reads the bundled documents. */
import { readFile } from 'node:fs/promises';
import { TripoError } from '../studio/contracts/errors.ts';
import { buildProgram } from './compat/program.ts';
import type { Command } from 'commander';

const guides = [
  {
    id: 'usage',
    name: 'Usage and recovery',
    description: 'Choose an interface, discover capabilities, sign in, execute and recover original tasks.',
    file: 'skills/ai-modeling/references/usage.md',
  },
  {
    id: 'commands',
    name: 'Command reference',
    description:
      'Find supported CLI operations and options. Read only when the relevant schema is insufficient.',
    file: 'docs/commands.md',
  },
  {
    id: 'pipelines',
    name: 'Examples and pipelines',
    description:
      'Compose reference-to-model, existing-task delivery and independent batch workflows as needed.',
    file: 'skills/ai-modeling/references/pipelines.md',
  },
] as const;

export function listGuides() {
  return {
    resources: [
      ...guides.map(({ id, name, description }) => ({
        uri: `ai-modeling://guides/${id}`,
        name,
        description,
        mimeType: 'text/markdown',
      })),
      {
        uri: 'ai-modeling://guides/commands/index',
        name: 'Command index',
        mimeType: 'text/markdown',
        description: 'Find command-specific guide URIs before loading detailed help.',
      },
    ],
  };
}

export function guideTemplates() {
  return {
    resourceTemplates: [
      {
        uriTemplate: 'ai-modeling://guides/commands/{+command}',
        name: 'Command or group help',
        mimeType: 'text/markdown',
        description:
          'Read one current CLI command or group, for example model/convert. Use commands/index to discover paths.',
      },
    ],
  };
}
function commandIndex(command: Command, prefix = ''): string[] {
  return command.commands.flatMap((child) => {
    const key = [prefix, child.name()].filter(Boolean).join('/');
    return [
      `- [${key.replaceAll('/', ' ')}](ai-modeling://guides/commands/${key})`,
      ...commandIndex(child, key),
    ];
  });
}
function commandGuide(key: string): string {
  const program = buildProgram();
  if (key === 'index')
    return [
      '# Command index',
      '',
      'Read only the command or group needed for the current task.',
      '',
      ...commandIndex(program),
      '',
    ].join('\n');
  if (!/^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(key))
    throw new TripoError('INVALID_INPUT', 'Unknown command guide.');
  let current = program;
  for (const name of key.split('/')) {
    const next = current.commands.find((command) => command.name() === name);
    if (!next) throw new TripoError('INVALID_INPUT', 'Unknown command guide.');
    current = next;
  }
  let help = '';
  current.configureOutput({
    writeOut: (chunk) => {
      help += chunk;
    },
  });
  current.outputHelp();
  return [
    `# ai-modeling ${key.replaceAll('/', ' ')}`,
    '',
    'Use MCP tools when MCP is the selected interface; read their input schema rather than copying CLI flags into JSON.',
    '',
    '```text',
    help.trimEnd(),
    '```',
    '',
    ...commandIndex(current, key),
    '',
  ].join('\n');
}

export async function readGuide(id: string) {
  if (id.startsWith('commands/'))
    return {
      uri: `ai-modeling://guides/${id}`,
      mimeType: 'text/markdown',
      text: commandGuide(id.slice('commands/'.length)),
    };
  const guide = guides.find((entry) => entry.id === id);
  if (!guide) throw new TripoError('INVALID_INPUT', 'Unknown guide; choose usage, commands or pipelines.');
  const root = new URL(import.meta.url.endsWith('.ts') ? '../' : '../../', import.meta.url);
  return {
    uri: `ai-modeling://guides/${guide.id}`,
    mimeType: 'text/markdown',
    text: await readFile(new URL(guide.file, root), 'utf8'),
  };
}

export async function runGuides(args: string[]) {
  if (args.length === 1 && args[0] === 'list') return listGuides();
  if (args.length === 1 && args[0] === 'templates') return guideTemplates();
  if (args.length === 2 && args[0] === 'read') return await readGuide(args[1]!);
  throw new TripoError(
    'INVALID_INPUT',
    'Use ai-modeling guides list, guides templates or guides read usage|commands|pipelines|commands/index|commands/<path>.',
  );
}
