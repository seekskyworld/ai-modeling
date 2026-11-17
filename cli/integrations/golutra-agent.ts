/** Native manifest export; Golutra Agent 0.3.9 blocks model-facing MCP tool calls. */
import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../../version.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import { toolMetadata } from '../commands.ts';
import { writeNewDirectory } from './new-directory.ts';

export interface GolutraPluginOptions {
  out: string;
  toolset?: string;
  env?: string[];
}

const allowedEnvironment = new Set([
  'AI_MODELING_PROFILE',
  'AI_MODELING_DATA_DIR',
  'AI_MODELING_OUTPUT_DIR',
  'AI_MODELING_INPUT_ROOTS',
  'AI_MODELING_BROWSER_EXECUTABLE',
  'AI_MODELING_BROWSER_CDP_ENDPOINT',
  'AI_MODELING_BLENDER',
  'AI_MODELING_FFMPEG',
  'AI_MODELING_EXPERIMENTAL_MESH_EDIT',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
]);
const maximumTools = 64;
const hostCompatibility = {
  verified_version: '0.3.9',
  native_tool_execution: 'blocked',
  reason:
    'Golutra Agent 0.3.9 applies is_pi_plus_tool filtering in provider_contracts, provider_tools_for_turn and tool_profile_rejection_reason. This excludes mcp__ plugin tools from model-visible contracts and rejects their invocation even after stage, review and enable.',
} as const;

function environmentNames(input: string[] | undefined): string[] {
  if (input === undefined) return [];
  if (
    !Array.isArray(input) ||
    input.some((name) => !allowedEnvironment.has(name)) ||
    new Set(input).size !== input.length
  )
    throw new TripoError(
      'INVALID_INPUT',
      'Choose distinct documented AI_MODELING_* configuration or HTTP proxy variable names; credentials and arbitrary environment names are not accepted.',
      'not_submitted',
    );
  return [...input].sort();
}

function singleLine(value: string, field: string, maximum = 4096): string {
  const text = value.replace(/[\0\r\n\t]+/g, ' ').trim();
  if (!text || [...text].length > maximum)
    throw new TripoError(
      'GOLUTRA_MANIFEST_UNSUPPORTED',
      `${field} exceeds the native plugin text limits.`,
      'not_submitted',
    );
  return text;
}

function toolDescription(value: string, name: string) {
  const normalized = value.replace(/[\0\r\n\t]+/g, ' ').trim();
  if (!normalized) return { description: singleLine(value, `Description for ${name}`) };
  if ([...normalized].length <= 4096) return { description: normalized };
  const suffix =
    ' [Description shortened for Golutra’s 4096-character limit. Read the complete description and restrictions in the export README.md. The input schema is unchanged.]';
  const prefix = [...normalized]
    .slice(0, 4096 - [...suffix].length)
    .join('')
    .replace(/\s+\S*$/u, '');
  return { description: prefix + suffix, complete: value };
}

async function serverLaunch() {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const command = await realpath(process.execPath);
  const entry = await realpath(fileURLToPath(new URL(`../main.${extension}`, import.meta.url)));
  for (const file of [command, entry])
    if (!(await stat(file)).isFile() || /[\0\r\n]/.test(file) || [...file].length > 4096)
      throw new TripoError(
        'GOLUTRA_MANIFEST_UNSUPPORTED',
        'Node and the same-package CLI must be regular files with single-line absolute paths.',
        'not_submitted',
      );
  return { command, entry };
}

function reviewedTools(toolset: string, env: string[]) {
  const metadata = toolMetadata(toolset).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  const names = new Set<string>();
  for (const tool of metadata) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(tool.name) || names.has(tool.name))
      throw new TripoError(
        'GOLUTRA_MANIFEST_UNSUPPORTED',
        'The tool catalogue contains duplicate or unsupported Golutra tool names.',
        'not_submitted',
      );
    names.add(tool.name);
  }
  if (
    toolset === 'full' &&
    names.has('ai_modeling_mesh_edit') &&
    !env.includes('AI_MODELING_EXPERIMENTAL_MESH_EDIT')
  )
    throw new TripoError(
      'INVALID_INPUT',
      'This full toolset includes experimental mesh editing; explicitly forward AI_MODELING_EXPERIMENTAL_MESH_EDIT with --env so the native server can expose the same tool.',
      'not_submitted',
    );
  if (!metadata.length)
    throw new TripoError(
      'GOLUTRA_MANIFEST_UNSUPPORTED',
      'The selected tool catalogue is empty.',
      'not_submitted',
    );
  const descriptions: { name: string; text: string }[] = [];
  const tools = metadata.map((tool) => {
    const projected = toolDescription(tool.description, tool.name);
    if (projected.complete) descriptions.push({ name: tool.name, text: projected.complete });
    return {
      name: tool.name,
      description: projected.description,
      input_schema: tool.inputSchema,
      output_schema: tool.outputSchema ?? null,
      // Golutra uses this declaration for recovery policy; readOnlyHint does not prove absence of local state or network effects.
      side_effect_type: 'external_system' as const,
    };
  });
  return { tools, descriptions };
}

function installationGuide(
  ids: string[],
  toolset: string,
  total: number,
  env: string[],
  descriptions: { name: string; text: string }[],
): string {
  return [
    '# ai-modeling native Golutra Agent plugins',
    '',
    '> **Golutra Agent 0.3.9: native MCP tool calls are blocked.**',
    '>',
    `> ${hostCompatibility.reason}`,
    '>',
    '> This export prepares manifests for integration. Successful stage, review and enable do not establish callable tools. Revalidate model discovery and native execution after a host fix; compatibility with other versions has not been established.',
    '',
    `ai-modeling ${VERSION}; Golutra Agent 0.3.9 manifest schema 1; toolset ${toolset}; ${total} tools in ${ids.length} packages.`,
    '',
    'Each package contains at most 64 tools, sorted by their stable names. Each manifest declares the same installed CLI and a subset intended for the native plugin adapter.',
    'The manifests use absolute Node and CLI paths from this installation. Keep that installation in place. After upgrading, moving it, or changing feature flags, export and review fresh packages so the declared schemas still match the server.',
    '',
    '## Stage, review and enable',
    '',
    'After a host fix and fresh execution verification, use these commands from the export directory for each selected package. Replace REVISION_ID with the revision returned by its stage command, inspect that revision, then review and enable it:',
    '',
    '```sh',
    ...ids.flatMap((id) => [
      `golutra-agent plugin stage ./${id}`,
      `golutra-agent plugin review ${id} REVISION_ID`,
      `golutra-agent plugin enable ${id} REVISION_ID`,
      '',
    ]),
    'golutra-agent plugin list',
    '```',
    '',
    'Golutra names tools mcp__PLUGIN_ID__TOOL_NAME. Native plugin packages are different from mcpServers JSON configuration. Exporting these files does not stage or enable them.',
    'The Golutra Agent 0.3.9 MCP adapter defines tool transport; resources and prompts are not exposed. Model-facing native tool calls remain blocked as described above. Install the project Skill to read shared guidance. After native compatibility is verified, agents selecting MCP should run business operations through MCP tools.',
    '',
    '## Environment and paths',
    '',
    env.length
      ? `Requested environment names: ${env.map((name) => `\`${name}\``).join(', ')}.`
      : 'No environment names are requested by this export.',
    'server.env contains names only. Every listed name must exist in the process environment that launches Golutra; a missing name prevents the plugin from starting. Set values yourself before launching that process. Tokens and cookies belong in the CLI credential store, never in a plugin manifest.',
    'Golutra starts the server in its staged plugin directory, not the active workspace. Use absolute input and destination paths. Before account operations, forward AI_MODELING_DATA_DIR and AI_MODELING_OUTPUT_DIR with --env and set them to absolute paths inside the workspace approved for the plugin; default home/state paths are not guaranteed writable. Forward AI_MODELING_INPUT_ROOTS when restricting input paths. Re-export with the desired --env NAME options instead of adding secrets to generated files.',
    'When forwarding AI_MODELING_EXPERIMENTAL_MESH_EDIT, keep its enabled/disabled value consistent with the exported tool catalogue. The exporter never copies environment values.',
    '',
    '## Native execution limits',
    '',
    'The manifests request read_write workspace access and network access for local deliveries and Studio operations. All tools conservatively declare external_system side effects, including reads; this preserves explicit approval and avoids implicit replay after interruption. Golutra still applies its own approval and OS sandbox.',
    'Golutra 0.3.9 defaults to a 30-second one-shot MCP call. Prefer submitting a task and polling its returned identity in later calls; long generation, local processing or downloads may exceed that host limit. Preserve request_id and reconcile an uncertain submission before retrying.',
    'Windows can manage these plugin packages, but Golutra 0.3.9 requires an OS-enforced sandbox to execute external MCP tools. Plugin staging and schema checks do not prove account access, paid operations or output correctness.',
    '',
    ...(descriptions.length
      ? [
          '## Complete descriptions shortened in manifests',
          '',
          'Golutra limits each manifest description to 4096 characters. The marked excerpts keep the original input and output schemas; review the complete restrictions below before enabling these tools.',
          '',
          ...descriptions.flatMap((entry) => [`### ${entry.name}`, '', entry.text, '']),
        ]
      : []),
  ].join('\n');
}

export async function exportGolutraPlugin(options: GolutraPluginOptions) {
  const toolset = options.toolset ?? 'studio';
  if (!['default', 'full', 'studio'].includes(toolset))
    throw new TripoError('INVALID_INPUT', 'toolset must be default, full or studio.', 'not_submitted');
  const env = environmentNames(options.env);
  const { tools, descriptions } = reviewedTools(toolset, env);
  const launch = await serverLaunch();
  const groups: { id: string; content: string; tool_count: number }[] = [];
  for (let offset = 0; offset < tools.length; offset += maximumTools) {
    const id = `ai_modeling_${toolset}_${groups.length + 1}`;
    const manifest = {
      schema_version: 1,
      id,
      version: singleLine(VERSION, 'Version', 64),
      display_name: `ai-modeling ${toolset} ${groups.length + 1}`,
      description: `Reviewed ${toolset} tools from ai-modeling ${VERSION}; invoke the bundled CLI through MCP.`,
      server: { command: launch.command, args: [launch.entry, 'mcp', '--toolset', toolset], env },
      permissions: { workspace_access: 'read_write', allow_network: true },
      tools: tools.slice(offset, offset + maximumTools),
    };
    const content = JSON.stringify(manifest, null, 2) + '\n';
    if (Buffer.byteLength(content) > 16 * 1024 * 1024)
      throw new TripoError(
        'GOLUTRA_MANIFEST_UNSUPPORTED',
        'A generated manifest exceeds Golutra’s 16 MiB file limit.',
        'not_submitted',
      );
    groups.push({ id, content, tool_count: manifest.tools.length });
  }
  const files = groups.map((group) => ({
    relative: `${group.id}/golutra-agent-plugin.json`,
    content: group.content,
  }));
  files.push({
    relative: 'README.md',
    content: installationGuide(
      groups.map((group) => group.id),
      toolset,
      tools.length,
      env,
      descriptions,
    ),
  });
  const packageRoot = fileURLToPath(
    new URL(import.meta.url.endsWith('.ts') ? '../../' : '../../../', import.meta.url),
  );
  const output = await writeNewDirectory(options.out, files, packageRoot);
  return {
    target: 'golutra-agent',
    version: VERSION,
    output,
    toolset,
    total_tools: tools.length,
    host_compatibility: { ...hostCompatibility },
    shortened_descriptions: descriptions.map((entry) => entry.name),
    plugins: groups.map((group) => ({
      id: group.id,
      directory: path.join(output, group.id),
      manifest: path.join(output, group.id, 'golutra-agent-plugin.json'),
      tool_count: group.tool_count,
      manifest_sha256: createHash('sha256').update(group.content).digest('hex'),
    })),
  };
}
