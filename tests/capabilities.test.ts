/** Generated registration, mapping and test references cannot imply live parity. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProgram } from '../cli/compat/program.ts';
import { toolMetadata } from '../cli/commands.ts';
import { fullContract } from '../cli/compat/full-contract.ts';
import { localOperations } from '../cli/local/operations.ts';
import { resources } from '../studio/api/resources.ts';
import { canvasResources } from '../studio/api/canvas.ts';
import { generateCapabilities, capabilityRoot, writeCapabilities } from '../scripts/capabilities.ts';
import type { Command } from 'commander';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parseStructuredArgs, structuredEntryPointNames } from '../cli/structured-input.ts';

const execute = promisify(execFile);
const inventory = await generateCapabilities();
function paths(command: Command, prefix = ''): string[] {
  return command.commands.flatMap((child) => {
    const key = [prefix, child.name()].filter(Boolean).join(' ');
    return [key, ...paths(child, key)];
  });
}
const get = (name: string) => inventory.commands.find((command) => command.path === name)!;

test('non-Commander entry points share the actual dispatcher names and describe structured JSON input', () => {
  assert.deepEqual(
    inventory.structured_entry_points.map((entry) => entry.path),
    structuredEntryPointNames,
  );
  for (const entry of inventory.structured_entry_points) {
    assert.ok(entry.grammar.length > 0);
    assert.ok(entry.input_modes.length > 0);
    assert.ok(entry.source_refs.includes('cli/main.ts'));
  }
  assert.equal(
    parseStructuredArgs(['call', '--toolset', 'full', 'ai_modeling_balance', '--input-stdin']).source,
    'stdin',
  );
  assert.equal(parseStructuredArgs(['tools', '--toolset=default']).toolset, 'default');
  assert.ok(
    inventory.structured_entry_points
      .find((entry) => entry.path === 'call')!
      .input_modes.includes('json_stdin'),
  );
});

test('default MCP exposes exactly the default CLI metadata instead of silently filtering registered tools', async () => {
  const client = new Client({ name: 'capability-drift', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../cli/main.ts', import.meta.url)), 'mcp'],
    env: Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    ),
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools, toolMetadata('default'));
    assert.equal(inventory.toolsets.default!.tools.length, 6);
    assert.ok(inventory.toolsets.default!.tools.some((tool) => tool.name === 'ai_modeling_image_generate'));
  } finally {
    await client.close();
    await transport.close();
  }
});

test('capability inventory includes current commands/options/help and all four toolset configurations without schema drift', () => {
  assert.ok(inventory.root_command.options.some((option) => option.flags === '-v, --version'));
  assert.match(inventory.root_command.help, /Backend: your Tripo Studio/);
  assert.deepEqual(
    inventory.commands.map((command) => command.path),
    paths(buildProgram()),
  );
  assert.equal(new Set(inventory.commands.map((command) => command.path)).size, inventory.commands.length);
  assert.ok(get('model convert').options.some((option) => option.flags === '--format <format>'));
  assert.match(get('model convert').help, /Studio backend:/);
  assert.match(get('model convert').semantic_limitations.help_note ?? '', /export-lite/);
  const previous = process.env.AI_MODELING_EXPERIMENTAL_MESH_EDIT;
  try {
    for (const [name, set] of Object.entries(inventory.toolsets)) {
      if (name === 'full-experimental') process.env.AI_MODELING_EXPERIMENTAL_MESH_EDIT = '1';
      else delete process.env.AI_MODELING_EXPERIMENTAL_MESH_EDIT;
      const metadata = toolMetadata(set.cli_toolset);
      assert.deepEqual(
        set.tools.map(({ name, description, inputSchema, outputSchema, annotations }) => ({
          name,
          description,
          inputSchema,
          ...(outputSchema ? { outputSchema } : {}),
          annotations,
        })),
        metadata,
      );
    }
  } finally {
    if (previous === undefined) delete process.env.AI_MODELING_EXPERIMENTAL_MESH_EDIT;
    else process.env.AI_MODELING_EXPERIMENTAL_MESH_EDIT = previous;
  }
  const experimental = inventory.toolsets['full-experimental']!.tools.filter(
    (tool) => tool.support.status === 'experimental',
  );
  assert.deepEqual(
    experimental.map((tool) => tool.name),
    fullContract.filter((tool) => tool.experimental).map((tool) => tool.name),
  );
});

test('declared routes distinguish unsupported, Studio, webpage-local and mixed behavior without assuming efficacy', () => {
  assert.equal(get('generate image-to-splat').mapping.category, 'unsupported');
  assert.equal(get('generate image-to-splat').support.status, 'unsupported');
  assert.equal(
    inventory.toolsets.full!.tools.find((tool) => tool.name === 'ai_modeling_image_to_splat')!.support.status,
    'unsupported',
  );
  assert.equal(get('studio export-lite').mapping.category, 'studio_endpoint');
  assert.match(get('studio export-lite').description, /creates no file/);
  assert.equal(get('studio frontend-export').mapping.category, 'mixed');
  assert.equal(get('studio image-crop').mapping.category, 'web_frontend_local');
  assert.equal(get('studio dcc-send').mapping.category, 'local_helper');
  assert.equal(get('assets list').mapping.category, 'studio_endpoint');
  assert.equal(get('skill targets').mapping.category, 'local_helper');
  for (const spec of [...resources, ...canvasResources]) {
    const name = resources.includes(spec as (typeof resources)[number])
      ? `ai_modeling_${spec.name}`
      : `ai_modeling_canvas_${spec.name}`;
    const tool = inventory.toolsets.studio!.tools.find((tool) => tool.name === name)!;
    assert.ok(tool, name);
    assert.ok(['studio_endpoint', 'mixed'].includes(tool.mapping.category), name);
  }
  for (const spec of localOperations) {
    const tool = inventory.toolsets.studio!.tools.find((tool) => tool.name === `ai_modeling_${spec.name}`)!;
    assert.ok(['web_frontend_local', 'local_helper'].includes(tool.mapping.category), spec.name);
  }
  for (const item of [
    ...inventory.commands,
    ...Object.values(inventory.toolsets).flatMap((set) => set.tools),
  ]) {
    assert.equal(item.support.execution, 'not_verified');
    assert.equal(item.verification.offline, 'not_verified');
    assert.equal(item.verification.live, 'not_verified');
    assert.equal(item.verification.website_parity, 'not_verified');
    assert.equal(item.verification.last_verified_at, null);
  }
});

test('semantic documentation links and test-source evidence identify existing exact content, never a passing run', async () => {
  const items = [...inventory.commands, ...Object.values(inventory.toolsets).flatMap((set) => set.tools)];
  const references = new Map(
    items.flatMap((item) => item.verification.test_source_refs).map((ref) => [ref.file, ref]),
  );
  assert.ok(references.size > 0);
  for (const reference of references.values()) {
    const content = await readFile(path.join(capabilityRoot, reference.file), 'utf8');
    assert.equal(createHash('sha256').update(content).digest('hex'), reference.sha256);
    const lines = content.split('\n');
    for (const match of reference.matches) assert.ok(lines[match.line - 1]!.includes(match.identifier));
  }
  const doc = await readFile(path.join(capabilityRoot, 'docs/compatibility.md'), 'utf8');
  const headings = [...doc.matchAll(/^## (.+)$/gm)].map((match) =>
    match[1]!
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_ -]/gu, '')
      .replaceAll(' ', '-'),
  );
  for (const link of new Set(items.flatMap((item) => item.semantic_limitations.documentation))) {
    assert.equal(link.split('#')[0], 'docs/compatibility.md');
    assert.ok(headings.includes(link.split('#')[1]!), link);
  }
  assert.match(inventory.scope.test_source_refs, /not assertions/);
});

test('standalone generation is metadata-only, deterministic and restores experimental settings', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-capabilities-'));
  const sentinel = path.join(directory, 'data-is-file');
  await writeFile(sentinel, 'unchanged');
  try {
    const env = { ...process.env, AI_MODELING_DATA_DIR: sentinel, AI_MODELING_EXPERIMENTAL_MESH_EDIT: '1' };
    const script = fileURLToPath(new URL('../scripts/capabilities.ts', import.meta.url));
    const { stdout, stderr } = await execute(process.execPath, [script], {
      env,
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(stderr, '');
    assert.deepEqual(JSON.parse(stdout), JSON.parse(JSON.stringify(inventory)));
    assert.equal(await readFile(sentinel, 'utf8'), 'unchanged');
    assert.ok((await stat(sentinel)).isFile());
    const previous = process.env.AI_MODELING_EXPERIMENTAL_MESH_EDIT;
    try {
      process.env.AI_MODELING_EXPERIMENTAL_MESH_EDIT = 'sentinel';
      await generateCapabilities();
      assert.equal(process.env.AI_MODELING_EXPERIMENTAL_MESH_EDIT, 'sentinel');
    } finally {
      if (previous === undefined) delete process.env.AI_MODELING_EXPERIMENTAL_MESH_EDIT;
      else process.env.AI_MODELING_EXPERIMENTAL_MESH_EDIT = previous;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('inventory file output only creates a new file outside the source root and rejects symlink aliases', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-capabilities-output-'));
  const target = path.join(directory, 'capabilities.json');
  try {
    await writeCapabilities(target, { sample: true });
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { sample: true });
    await assert.rejects(writeCapabilities(target, { overwrite: true }), { code: 'EEXIST' });
    await assert.rejects(
      writeCapabilities(path.join(capabilityRoot, 'capabilities.json'), {}),
      /outside the source tree/,
    );
    const alias = path.join(directory, 'source-alias');
    await symlink(capabilityRoot, alias, 'junction');
    await assert.rejects(
      writeCapabilities(path.join(alias, 'capabilities.json'), {}),
      /outside the source tree/,
    );
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { sample: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
