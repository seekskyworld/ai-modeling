/** Generate a source inventory, never an account capability or live-verification claim. */
import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { PACKAGE_NAME, VERSION } from '../version.ts';
import { toolMetadata } from '../cli/commands.ts';
import { buildProgram } from '../cli/compat/program.ts';
import { fullContract } from '../cli/compat/full-contract.ts';
import { generationNames, processingNames } from '../cli/compat/full-tools.ts';
import { helpContract } from '../cli/compat/help-contract.ts';
import { listModels } from '../cli/compat/catalog.ts';
import { operationDescriptions } from '../cli/core/operation-descriptions.ts';
import { localOperations } from '../cli/local/operations.ts';
import { resources } from '../studio/api/resources.ts';
import { canvasResources } from '../studio/api/canvas.ts';
import { structuredEntryPointNames } from '../cli/structured-input.ts';

export const capabilityRoot = fileURLToPath(new URL('../', import.meta.url));
export type MappingCategory =
  'studio_endpoint' | 'web_frontend_local' | 'local_helper' | 'unsupported' | 'mixed' | 'unconfirmed';
interface Mapping {
  category: MappingCategory;
  basis: string;
  source_refs: string[];
  declared_rpc?: string;
  declared_http_method?: string;
}
type Metadata = ReturnType<typeof toolMetadata>[number];
interface Route {
  command: string;
  tool?: string;
  mapping: Mapping;
}
interface TestSourceReference {
  file: string;
  sha256: string;
  matches: { line: number; identifier: string }[];
}
type TestIndex = Map<string, TestSourceReference[]>;
const structuredInputs: Record<
  (typeof structuredEntryPointNames)[number],
  {
    grammar: string[];
    input_modes: string[];
    source_refs: string[];
    note: string;
  }
> = {
  auth: {
    grammar: [
      'auth login [login-options]',
      'auth begin|wait|cancel [id] [login-options]',
      'auth session [status|begin|wait|cancel] [id] [login-options]',
      'auth import --stdin',
      'auth import --file <private-file>',
      'auth status',
      'auth logout',
    ],
    input_modes: ['arguments', 'credential_stdin', 'private_credential_file'],
    source_refs: ['cli/main.ts', 'cli/auth.ts'],
    note: 'login-options include --no-open/--no-wait/--wait/--force/--timeout/--browser-executable/--cdp-endpoint. login also accepts --paste or --form. Passwords and verification are completed in the browser; tokens are not command-line arguments.',
  },
  call: {
    grammar: [
      'call <TOOL> [--input <JSON> | --input-stdin] [--toolset default|full|studio] [--profile <name>]',
    ],
    input_modes: ['json_argument', 'json_stdin'],
    source_refs: ['cli/main.ts', 'cli/structured-input.ts'],
    note: 'JSON object, at most 1 MiB; omitted input is {}. Options are order-independent and accept --flag=value. Default toolset is studio.',
  },
  tools: {
    grammar: ['tools [--toolset default|full|studio] [--profile <name>]'],
    input_modes: ['arguments'],
    source_refs: ['cli/main.ts', 'cli/structured-input.ts', 'cli/commands.ts'],
    note: 'Pure JSON metadata discovery; default toolset is studio. --help/-h also work for call/tools.',
  },
  guides: {
    grammar: [
      'guides list',
      'guides templates',
      'guides read usage|commands|pipelines|commands/index|commands/<path>',
    ],
    input_modes: ['arguments'],
    source_refs: ['cli/main.ts', 'cli/guides.ts'],
    note: 'Offline JSON guidance and command help; command paths use slash separators.',
  },
  serve: {
    grammar: ['serve [--toolset default|full|studio]'],
    input_modes: ['mcp_stdio'],
    source_refs: ['cli/main.ts', 'cli/compat/launch.ts'],
    note: 'Existing direct MCP dispatcher; default toolset is studio. The documented public entry point is ai-modeling mcp.',
  },
};
const docs = {
  basic: 'docs/compatibility.md#基本合同',
  official: 'docs/compatibility.md#官方-cli-差异矩阵',
  web: 'docs/compatibility.md#网页覆盖矩阵',
  generation: 'docs/compatibility.md#生成图片与导入',
  mesh: 'docs/compatibility.md#分割uv-与编辑',
  lab: 'docs/compatibility.md#lab-参考编辑与后续模型',
  exporting: 'docs/compatibility.md#导出材料与动画',
  canvas: 'docs/compatibility.md#canvaslab-会话与模板',
  local: 'docs/compatibility.md#本地对应交接与恢复',
};
const mapping = (category: MappingCategory, source: string, basis: string): Mapping => ({
  category,
  basis,
  source_refs: [source],
});
const unconfirmed = () =>
  mapping('unconfirmed', 'cli/compat/program.ts#buildProgram', 'No reviewed mapping rule in this inventory.');

/** Discovery is synchronous; restore the caller's setting even if registry validation throws. */
export function capabilityToolsets() {
  const previous = process.env.AI_MODELING_EXPERIMENTAL_MESH_EDIT;
  try {
    delete process.env.AI_MODELING_EXPERIMENTAL_MESH_EDIT;
    const standard = {
      default: toolMetadata('default'),
      full: toolMetadata('full'),
      studio: toolMetadata('studio'),
    };
    process.env.AI_MODELING_EXPERIMENTAL_MESH_EDIT = '1';
    return { ...standard, 'full-experimental': toolMetadata('full') };
  } finally {
    if (previous === undefined) delete process.env.AI_MODELING_EXPERIMENTAL_MESH_EDIT;
    else process.env.AI_MODELING_EXPERIMENTAL_MESH_EDIT = previous;
  }
}

function studioRoutes(studioTools: Metadata[]): Route[] {
  return [
    ...Object.entries(operationDescriptions).map(([name, description]) => ({
      command: `studio ${name.replaceAll('_', '-')}`,
      tool: studioTools.find((tool) => tool.description.startsWith(`${description}. Uses your Studio`))?.name,
      mapping: mapping(
        name === 'modification' ? 'mixed' : 'studio_endpoint',
        `cli/core/operation-descriptions.ts#${name}`,
        'Registered Studio operation; upload, preparation and result validation may add steps.',
      ),
    })),
    ...resources.map((spec) => ({
      command: `studio ${spec.name.replaceAll('_', '-')}`,
      tool: `ai_modeling_${spec.name}`,
      mapping: {
        ...mapping('studio_endpoint', `studio/api/resources.ts#${spec.name}`, 'Studio resource registry.'),
        declared_http_method: spec.method,
      },
    })),
    ...canvasResources.map((spec) => ({
      command: `canvas ${spec.name.replaceAll('_', '-')}`,
      tool: `ai_modeling_canvas_${spec.name}`,
      mapping: {
        ...mapping(
          /(?:_plan|_inputs)$/.test(spec.name) ||
            ['texture_reference', 'review', 'save', 'template_create'].includes(spec.name)
            ? 'mixed'
            : 'studio_endpoint',
          `studio/api/canvas.ts#${spec.name}`,
          'Canvas registry; the declared RPC may be one step of a checked preparation or save chain.',
        ),
        declared_rpc: spec.method,
      },
    })),
    ...localOperations.map((spec) => ({
      command: `${spec.group === 'canvas' ? 'canvas' : 'studio'} ${
        spec.group === 'canvas' ? spec.name.replace(/^canvas_/, '') : spec.name
      }`.replaceAll('_', '-'),
      tool: `ai_modeling_${spec.name}`,
      mapping: mapping(
        /^(?:dcc_|local_convert$|model_inspect$|share_templates$)/.test(spec.name)
          ? 'local_helper'
          : 'web_frontend_local',
        `cli/local/operations.ts#${spec.name}`,
        'Local operation registry; frontend equivalents are bounded implementations, not pixel or behavior parity claims.',
      ),
    })),
    {
      command: 'studio frontend-export',
      tool: 'ai_modeling_frontend_export',
      mapping: mapping(
        'mixed',
        'cli/core/frontend-export.ts',
        'Pinned webpage conversion engine plus Studio export-lite authorization.',
      ),
    },
  ];
}

function commandHelp(command: Command): string {
  let help = '';
  command.configureOutput({
    writeOut: (chunk) => {
      help += chunk;
    },
  });
  command.outputHelp();
  return help.trimEnd();
}

function commandTree(command: Command, prefix = '') {
  const entries: { path: string; command: Command }[] = [];
  for (const child of command.commands) {
    const key = [prefix, child.name()].filter(Boolean).join(' ');
    entries.push({ path: key, command: child }, ...commandTree(child, key));
  }
  return entries;
}

function commandMapping(key: string, help: string, routes: Route[]): Mapping {
  const registered = routes.find((route) => route.command === key);
  if (registered) return registered.mapping;
  if (key === 'mcp export')
    return mapping(
      'local_helper',
      'cli/integrations/golutra-agent.ts',
      'Export reviewed-schema MCP plugin files for Golutra Agent; does not register a client, access credentials or call Studio.',
    );
  if (/^skill(?: |$)/.test(key))
    return mapping(
      'local_helper',
      'cli/install/commands.ts#registerSkill',
      'Manage bundled Skill guidance in a client directory; no credentials, Studio requests or business state.',
    );
  if (/^assets(?: |$)/.test(key))
    return mapping(
      'studio_endpoint',
      'cli/assets/list.ts',
      'Read paginated model or image assets from the authenticated Studio account; not local task history.',
    );
  if (help.includes('Unavailable: no Studio splat generation flow'))
    return mapping(
      'unsupported',
      'cli/compat/help.ts',
      'Help explicitly rejects this command before submission.',
    );
  if (/^(?:generate |model |mesh |anim |make$|redo$|batch run$|task |files upload$)/.test(key))
    return mapping(
      'mixed',
      'cli/compat/program.ts',
      'CLI planning, local state and Studio requests; exact steps depend on validated inputs.',
    );
  if (/^(?:balance|usage|whoami)$/.test(key))
    return mapping('studio_endpoint', 'cli/compat/program.ts', 'Studio account or transaction read.');
  if (['studio motion-presets', 'update'].includes(key))
    return mapping(
      'local_helper',
      'cli/compat/program.ts',
      'Offline catalogue or package-update check; this is not a remote update or generation endpoint.',
    );
  if (
    /^(?:models$|history$|config(?: |$)|use$|logout$|completion(?: |$)|mcp$|topup$|docs$|pricing(?: |$)|runtime(?: |$))/.test(
      key,
    )
  )
    return mapping(
      'local_helper',
      'cli/compat/program.ts',
      'Local configuration, catalogue, guidance or runtime helper; may open external documentation or fetch explicit runtime resources.',
    );
  if (
    /^(?:login$|setup$|doctor$|print(?: |$)|view$|ai(?: |$)|canvas (?:watch|upload)$|studio asset-download$)/.test(
      key,
    )
  )
    return mapping(
      'mixed',
      'cli/compat/program.ts',
      'Combines local coordination with optional browser, Studio or other runtime work.',
    );
  return unconfirmed();
}

function docRefs(key: string, category: MappingCategory): string[] {
  const refs = [docs.basic];
  if (/^(?:generate |make$|model import$)/.test(key)) refs.push(docs.generation);
  if (/^(?:mesh |studio (?:uv-|segment|resegment|modification))/.test(key)) refs.push(docs.mesh);
  if (/^(?:canvas |studio canvas-)/.test(key)) refs.push(docs.canvas);
  if (/convert|export|texture|rig|animate|retarget/.test(key)) refs.push(docs.exporting);
  if (/mesh edit|lab/.test(key)) refs.push(docs.lab);
  if (['local_helper', 'web_frontend_local'].includes(category)) refs.push(docs.local);
  if (category === 'unsupported') refs.push(docs.official);
  if (refs.length === 1) refs.push(docs.web);
  return [...new Set(refs)];
}

async function testSources(root: string): Promise<TestIndex> {
  const files = (await readdir(path.join(root, 'tests'))).filter((file) => file.endsWith('.test.ts')).sort();
  const index: TestIndex = new Map();
  const sources = await Promise.all(
    files.map(async (name) => {
      const file = `tests/${name}`;
      const source = await readFile(path.join(root, file), 'utf8');
      return { file, sha256: createHash('sha256').update(source).digest('hex'), lines: source.split('\n') };
    }),
  );
  for (const source of sources) {
    const identifiers = new Map<string, TestSourceReference['matches']>();
    source.lines.forEach((line, lineIndex) => {
      for (const match of line.matchAll(/(['"])([a-z][a-z0-9_ -]{7,})\1/g)) {
        const key = match[2]!;
        const matches = identifiers.get(key) ?? [];
        matches.push({ line: lineIndex + 1, identifier: key });
        identifiers.set(key, matches);
      }
    });
    for (const [key, matches] of identifiers) {
      const references = index.get(key) ?? [];
      references.push({ file: source.file, sha256: source.sha256, matches });
      index.set(key, references);
    }
  }
  return index;
}

function verification(keys: string[], sources: TestIndex) {
  const references = new Map<string, TestSourceReference>();
  for (const key of new Set(keys))
    for (const source of sources.get(key) ?? []) {
      const previous = references.get(source.file);
      references.set(source.file, { ...source, matches: [...(previous?.matches ?? []), ...source.matches] });
    }
  return {
    offline: 'not_verified',
    live: 'not_verified',
    website_parity: 'not_verified',
    last_verified_at: null,
    test_source_refs: [...references.values()].sort((a, b) => a.file.localeCompare(b.file)),
  };
}

function support(category: MappingCategory, experimental = false, group = false) {
  return {
    status: group
      ? 'command_group'
      : category === 'unsupported'
        ? 'unsupported'
        : experimental
          ? 'experimental'
          : category === 'unconfirmed'
            ? 'unconfirmed'
            : 'conditional',
    registration: 'present',
    execution: 'not_verified',
  };
}

function relatedFullCommands(name: string, paths: string[]): string[] {
  if (generationNames[name]) return [`generate ${generationNames[name]}`];
  if (processingNames[name])
    return paths.filter(
      (key) => /^(model|mesh|anim) /.test(key) && key.split(' ')[1] === processingNames[name],
    );
  const direct: Record<string, string[]> = {
    ai_modeling_generate_image: ['generate text-to-image', 'generate image-to-image'],
    ai_modeling_balance: ['balance'],
    ai_modeling_usage: ['usage'],
    ai_modeling_rig_check: ['anim check'],
    ai_modeling_task_status: ['task get'],
    ai_modeling_task_wait: ['task watch'],
    ai_modeling_task_list: ['task list'],
    ai_modeling_download: ['task get', 'task watch'],
    ai_modeling_upload_image: ['files upload'],
  };
  return direct[name] ?? [];
}

function toolMapping(
  tool: Metadata,
  full: boolean,
  routes: Route[],
  paths: string[],
  help: Map<string, string>,
) {
  if (full) {
    const commands = relatedFullCommands(tool.name, paths);
    if (tool.name === 'ai_modeling_usage')
      return {
        commands,
        mapping: mapping(
          'mixed',
          'cli/compat/usage.ts',
          'Per-local-job accounting or grouped Studio ledger pagination; related CLI usage has a different input/output contract.',
        ),
      };
    if (tool.name === 'ai_modeling_plan')
      return {
        commands,
        mapping: mapping(
          'local_helper',
          'cli/compat/full-tools.ts#advisory',
          'Local advisory plan; no generation submission.',
        ),
      };
    if (commands.length)
      return { commands, mapping: commandMapping(commands[0]!, help.get(commands[0]!) ?? '', routes) };
    return { commands, mapping: unconfirmed() };
  }
  const route = routes.find((item) => item.tool === tool.name);
  if (route) return { commands: [route.command], mapping: route.mapping };
  const direct = coreToolMapping(tool.name);
  if (direct) return direct;
  const candidate = tool.name.replace(/^ai_modeling_/, '').replaceAll('_', ' ');
  const commands = paths.includes(candidate) ? [candidate] : [];
  if (commands.length)
    return { commands, mapping: commandMapping(candidate, help.get(candidate) ?? '', routes) };
  return {
    commands,
    mapping: mapping(
      'unconfirmed',
      'cli/commands.ts#toolRegistry',
      'Registered tool; no reviewed mapping rule in this inventory.',
    ),
  };
}

function coreToolMapping(name: string) {
  const key = name.replace(/^ai_modeling_/, '');
  if (['auth_begin', 'auth_status', 'auth_wait', 'auth_cancel'].includes(key))
    return {
      commands: [],
      mapping: mapping(
        key === 'auth_begin' ? 'mixed' : 'local_helper',
        'cli/auth/tools.ts',
        'Browser login coordinator; read/wait/cancel manage the existing local flow, not an account-settings API.',
      ),
    };
  const categories: Partial<Record<string, MappingCategory>> = {
    motion_presets: 'local_helper',
    quote: 'local_helper',
    jobs_list: 'local_helper',
    account_status: 'studio_endpoint',
    assets_list: 'studio_endpoint',
    asset_download: 'mixed',
    capabilities: 'mixed',
    job_get: 'mixed',
    artifact_download: 'mixed',
    job_reconcile: 'mixed',
    task_wait: 'mixed',
  };
  const category = categories[key];
  if (!category) return undefined;
  const related: Record<string, string[]> = {
    motion_presets: ['studio motion-presets'],
    asset_download: ['studio asset-download'],
    account_status: ['whoami'],
    task_wait: ['task watch'],
  };
  return {
    commands: related[key] ?? [],
    mapping: mapping(
      category,
      'cli/commands.ts#toolRegistry',
      'Explicit CLI tool registration; task identity, authorization, source checks and local delivery remain part of its contract.',
    ),
  };
}

export async function generateCapabilities(root = capabilityRoot) {
  const program = buildProgram();
  const tree = commandTree(program);
  const toolsets = capabilityToolsets();
  const routes = studioRoutes(toolsets.studio);
  const sources = await testSources(root);
  const paths = tree.map((entry) => entry.path);
  const helps = new Map(tree.map((entry) => [entry.path, commandHelp(entry.command)]));
  const compatibility = await readFile(path.join(root, 'docs/compatibility.md'), 'utf8');
  const commands = tree.map(({ path: key, command }) => {
    const help = helps.get(key)!;
    const mapped = commandMapping(key, help, routes);
    return {
      path: key,
      aliases: command.aliases(),
      description: command.description(),
      arguments: command.registeredArguments.map((argument) => ({
        name: argument.name(),
        description: argument.description,
        required: argument.required,
        variadic: argument.variadic,
        default: argument.defaultValue,
      })),
      options: command.options.map((option) => ({
        flags: option.flags,
        description: option.description,
        required: option.required,
        optional: option.optional,
        variadic: option.variadic,
        negate: option.negate,
        default: option.defaultValue,
        choices: option.argChoices,
      })),
      help,
      mapping: mapped,
      support: support(mapped.category, false, command.commands.length > 0),
      official_help_contract: Object.hasOwn(helpContract, key),
      semantic_limitations: {
        documentation: docRefs(key, mapped.category),
        help_note: help.split('Studio backend: ')[1]?.trim() ?? null,
      },
      guide_uri: `ai-modeling://guides/commands/${key.replaceAll(' ', '/')}`,
      verification: verification(
        [
          key,
          ...routes
            .filter((route) => route.command === key)
            .flatMap((route) => (route.tool ? [route.tool] : [])),
        ],
        sources,
      ),
    };
  });
  return {
    schema_version: 1,
    package: { name: PACKAGE_NAME, version: VERSION },
    root_command: {
      name: program.name(),
      description: program.description(),
      help: commandHelp(program),
      options: program.options.map((option) => ({ flags: option.flags, description: option.description })),
    },
    official_baseline: /`(tripo-cli [^`]+)`/.exec(compatibility)?.[1] ?? null,
    scope: {
      commands:
        'All descendants of buildProgram; structured_entry_points separately lists the dispatch grammar shared with main.ts.',
      toolsets:
        'Three public toolsets plus full with its explicit experimental flag; not four public toolset names.',
      test_source_refs:
        'Exact quoted identifier references in current test source, not assertions of coverage or a passing test run.',
      verification:
        'No tests or live requests run by this generator. No per-capability verification receipt is imported; not_verified and null dates are intentional.',
      mapping:
        'Categories describe declared implementation routes. Conditional and present do not certify every input, account permission, platform or website equivalence.',
    },
    structured_entry_points: structuredEntryPointNames.map((name) => ({
      path: name,
      ...structuredInputs[name],
      support: { status: 'registered', execution: 'not_verified' },
      verification: verification([name], sources),
    })),
    commands,
    toolsets: Object.fromEntries(
      Object.entries(toolsets).map(([name, entries]) => {
        const full = name.startsWith('full');
        return [
          name,
          {
            cli_toolset: full ? 'full' : name,
            environment: name === 'full-experimental' ? { AI_MODELING_EXPERIMENTAL_MESH_EDIT: '1' } : {},
            tools: entries.map((tool) => {
              const mapped = toolMapping(tool, full, routes, paths, helps);
              return {
                ...tool,
                related_cli_commands: mapped.commands,
                mapping: mapped.mapping,
                support: support(
                  mapped.mapping.category,
                  full && fullContract.some((spec) => spec.name === tool.name && spec.experimental),
                ),
                semantic_limitations: {
                  documentation: [
                    ...new Set(
                      (mapped.commands.length ? mapped.commands : ['']).flatMap((key) =>
                        docRefs(key, mapped.mapping.category),
                      ),
                    ),
                  ],
                  description: tool.description,
                  help_notes: mapped.commands.flatMap(
                    (key) => commands.find((item) => item.path === key)?.semantic_limitations.help_note ?? [],
                  ),
                },
                verification: verification([tool.name, ...mapped.commands], sources),
              };
            }),
          },
        ];
      }),
    ),
    model_catalog: listModels(),
  };
}

export async function writeCapabilities(output: string, data: unknown, root = capabilityRoot) {
  const target = path.resolve(output);
  const parent = await realpath(path.dirname(target));
  const source = await realpath(root);
  const relative = path.relative(source, parent);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)))
    throw new Error('Capability output must be outside the source tree.');
  await writeFile(path.join(parent, path.basename(target)), JSON.stringify(data, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
}

async function main(args: string[]) {
  if (args.length && (args.length !== 2 || args[0] !== '--out' || !args[1]))
    throw new Error(
      'Use npm run --silent capabilities [-- --out /existing/external/directory/capabilities.json].',
    );
  const data = await generateCapabilities();
  if (args[1]) await writeCapabilities(args[1], data);
  else process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write((error instanceof Error ? error.message : 'Capability inventory failed.') + '\n');
    process.exitCode = 1;
  });
