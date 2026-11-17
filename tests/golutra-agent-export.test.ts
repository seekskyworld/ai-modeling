import assert from 'node:assert/strict';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { toolMetadata } from '../cli/commands.ts';
import { exportGolutraPlugin } from '../cli/integrations/golutra-agent.ts';
import { writeNewDirectory } from '../cli/integrations/new-directory.ts';
import { VERSION } from '../version.ts';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));

interface Manifest {
  schema_version: number;
  id: string;
  version: string;
  server: { command: string; args: string[]; env: string[] };
  permissions: { workspace_access: string; allow_network: boolean };
  tools: {
    name: string;
    description: string;
    input_schema: unknown;
    output_schema: unknown;
    side_effect_type: string;
  }[];
}

async function manifests(result: Awaited<ReturnType<typeof exportGolutraPlugin>>) {
  return await Promise.all(
    result.plugins.map(async (plugin) => JSON.parse(await readFile(plugin.manifest, 'utf8')) as Manifest),
  );
}

test('native packages preserve exact schemas, stable groups and the same-package absolute launch command', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-golutra-export-'));
  try {
    for (const toolset of ['default', 'full', 'studio']) {
      const result = await exportGolutraPlugin({ out: path.join(directory, toolset), toolset });
      const metadata = toolMetadata(toolset).sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      );
      const exported = await manifests(result);
      assert.equal(result.target, 'golutra-agent');
      assert.equal(result.version, VERSION);
      assert.equal(result.total_tools, metadata.length);
      assert.equal(result.host_compatibility.verified_version, '0.3.9');
      assert.equal(result.host_compatibility.native_tool_execution, 'blocked');
      assert.match(
        result.host_compatibility.reason,
        /is_pi_plus_tool.*provider_contracts, provider_tools_for_turn and tool_profile_rejection_reason/,
      );
      assert.equal(exported.length, Math.ceil(metadata.length / 64));
      assert.deepEqual(
        exported.flatMap((manifest) => manifest.tools.map((tool) => tool.name)),
        metadata.map((tool) => tool.name),
      );
      for (const [index, manifest] of exported.entries()) {
        assert.equal(manifest.schema_version, 1);
        assert.equal(manifest.id, `ai_modeling_${toolset}_${index + 1}`);
        assert.match(manifest.id, /^[a-z][a-z0-9_]{0,63}$/);
        assert.equal(manifest.version, VERSION);
        assert.equal(manifest.server.command, await realpath(process.execPath));
        assert.deepEqual(manifest.server.args, [
          await realpath(path.join(packageRoot, 'cli/main.ts')),
          'mcp',
          '--toolset',
          toolset,
        ]);
        assert.deepEqual(manifest.server.env, []);
        assert.deepEqual(manifest.permissions, { workspace_access: 'read_write', allow_network: true });
        assert.ok(manifest.tools.length > 0 && manifest.tools.length <= 64);
        for (const tool of manifest.tools) {
          const original = metadata.find((item) => item.name === tool.name)!;
          assert.deepEqual(tool.input_schema, original.inputSchema);
          assert.deepEqual(tool.output_schema, original.outputSchema ?? null);
          assert.equal(tool.side_effect_type, 'external_system');
          assert.doesNotMatch(tool.description, /[\0\n\r]/);
          assert.ok(tool.description.length > 0 && [...tool.description].length <= 4096);
        }
        const plugin = result.plugins[index]!;
        assert.deepEqual(await readdir(plugin.directory), ['golutra-agent-plugin.json']);
        if (process.platform !== 'win32') {
          assert.equal((await stat(plugin.directory)).mode & 0o777, 0o700);
          assert.equal((await stat(plugin.manifest)).mode & 0o777, 0o600);
        }
      }
      const guide = await readFile(path.join(result.output, 'README.md'), 'utf8');
      assert.match(guide.split('\n').slice(0, 7).join('\n'), /0\.3\.9: native MCP tool calls are blocked/);
      assert.match(guide, /compatibility with other versions has not been established/);
      assert.match(guide, /plugin stage/);
      assert.match(guide, /plugin review/);
      assert.match(guide, /plugin enable/);
      assert.match(guide, /30-second/);
      assert.match(guide, /absolute input and destination/);
      assert.match(guide, /Windows/);
      assert.match(guide, /resources and prompts are not exposed/);
      const shortened = metadata.filter(
        (tool) => [...tool.description.replace(/[\0\r\n\t]+/g, ' ').trim()].length > 4096,
      );
      assert.deepEqual(
        result.shortened_descriptions,
        shortened.map((tool) => tool.name),
      );
      for (const tool of shortened) {
        assert.ok(guide.includes(tool.description));
        assert.match(
          exported.flatMap((manifest) => manifest.tools).find((item) => item.name === tool.name)!.description,
          /Description shortened/,
        );
      }
    }
    await assert.rejects(access(process.env.AI_MODELING_DATA_DIR!), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('explicit environment names are sorted, allowlisted and exported without their values', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-golutra-env-'));
  const previous = process.env.AI_MODELING_PROFILE;
  process.env.AI_MODELING_PROFILE = 'synthetic-private-profile-value';
  try {
    const result = await exportGolutraPlugin({
      out: path.join(directory, 'valid'),
      env: ['HTTPS_PROXY', 'AI_MODELING_PROFILE'],
    });
    for (const manifest of await manifests(result)) {
      assert.deepEqual(manifest.server.env, ['AI_MODELING_PROFILE', 'HTTPS_PROXY']);
      assert.doesNotMatch(JSON.stringify(manifest), /synthetic-private-profile-value/);
    }
    for (const [index, env] of [
      ['NPM_TOKEN'],
      ['HOME'],
      ['GOLUTRA_AGENT_HOME'],
      ['NODE_OPTIONS'],
      ['AI_MODELING_API_KEY'],
      ['HTTP_PROXY=value'],
      ['AI_MODELING_PROFILE', 'AI_MODELING_PROFILE'],
    ].entries()) {
      const out = path.join(directory, `invalid-${index}`);
      await assert.rejects(exportGolutraPlugin({ out, env }), { code: 'INVALID_INPUT' });
      await assert.rejects(access(out), { code: 'ENOENT' });
    }
    await assert.rejects(exportGolutraPlugin({ out: path.join(directory, 'bad-toolset'), toolset: 'all' }), {
      code: 'INVALID_INPUT',
    });
  } finally {
    if (previous === undefined) delete process.env.AI_MODELING_PROFILE;
    else process.env.AI_MODELING_PROFILE = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('experimental full metadata requires an explicit environment declaration instead of silently drifting', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-golutra-experimental-'));
  const previous = process.env.AI_MODELING_EXPERIMENTAL_MESH_EDIT;
  process.env.AI_MODELING_EXPERIMENTAL_MESH_EDIT = '1';
  try {
    await assert.rejects(exportGolutraPlugin({ out: path.join(directory, 'missing'), toolset: 'full' }), {
      code: 'INVALID_INPUT',
    });
    const result = await exportGolutraPlugin({
      out: path.join(directory, 'explicit'),
      toolset: 'full',
      env: ['AI_MODELING_EXPERIMENTAL_MESH_EDIT'],
    });
    assert.ok(
      (await manifests(result))
        .flatMap((manifest) => manifest.tools)
        .some((tool) => tool.name === 'ai_modeling_mesh_edit'),
    );
  } finally {
    if (previous === undefined) delete process.env.AI_MODELING_EXPERIMENTAL_MESH_EDIT;
    else process.env.AI_MODELING_EXPERIMENTAL_MESH_EDIT = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('export refuses existing files, directories, symlinks, missing parents and paths inside its installation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-golutra-output-'));
  try {
    const occupied = path.join(directory, 'occupied');
    await mkdir(occupied);
    await writeFile(path.join(occupied, 'keep.txt'), 'unrelated');
    const file = path.join(directory, 'file');
    await writeFile(file, 'unrelated');
    const link = path.join(directory, 'link');
    await symlink(occupied, link, process.platform === 'win32' ? 'junction' : 'dir');
    for (const out of [occupied, file, link])
      await assert.rejects(exportGolutraPlugin({ out, toolset: 'default' }), { code: 'OUTPUT_EXISTS' });
    assert.equal(await readFile(file, 'utf8'), 'unrelated');
    assert.equal(await readFile(path.join(occupied, 'keep.txt'), 'utf8'), 'unrelated');
    await assert.rejects(exportGolutraPlugin({ out: path.join(directory, 'missing', 'child') }), {
      code: 'INVALID_OUTPUT',
    });
    const alias = path.join(directory, 'package-alias');
    await symlink(packageRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(exportGolutraPlugin({ out: path.join(alias, 'must-not-be-created') }), {
      code: 'INVALID_OUTPUT',
    });
    await assert.rejects(exportGolutraPlugin({ out: '' }), { code: 'INVALID_INPUT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('concurrent exports cannot overwrite the winning package and failed publication removes only its own files', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-golutra-race-'));
  try {
    const out = path.join(directory, 'winner');
    const results = await Promise.allSettled([
      exportGolutraPlugin({ out, toolset: 'default' }),
      exportGolutraPlugin({ out, toolset: 'default' }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.equal((rejected as PromiseRejectedResult).reason.code, 'OUTPUT_EXISTS');
    const manifest = JSON.parse(
      await readFile(path.join(out, 'ai_modeling_default_1', 'golutra-agent-plugin.json'), 'utf8'),
    ) as Manifest;
    assert.equal(manifest.tools.length, toolMetadata('default').length);
    const failed = path.join(directory, 'failed');
    await assert.rejects(
      writeNewDirectory(
        failed,
        [
          { relative: 'part/golutra-agent-plugin.json', content: 'first owned file' },
          { relative: 'part/golutra-agent-plugin.json', content: 'must not overwrite' },
        ],
        packageRoot,
      ),
      { code: 'OUTPUT_EXISTS' },
    );
    await assert.rejects(access(failed), { code: 'ENOENT' });
    assert.equal(
      (
        JSON.parse(
          await readFile(path.join(out, 'ai_modeling_default_1', 'golutra-agent-plugin.json'), 'utf8'),
        ) as Manifest
      ).tools.length,
      manifest.tools.length,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  'direct MCP launch verifies schemas and an offline tool independently of native Golutra execution',
  { timeout: 30000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-golutra-mcp-'));
    const client = new Client({ name: 'golutra-export-contract', version: '1' });
    let transport: StdioClientTransport | undefined;
    try {
      const result = await exportGolutraPlugin({ out: path.join(directory, 'plugins') });
      const packages = await manifests(result);
      const first = packages[0]!;
      transport = new StdioClientTransport({
        command: first.server.command,
        args: first.server.args,
        cwd: result.plugins[0]!.directory,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
          ),
          PATH: '',
        },
        stderr: 'pipe',
      });
      await client.connect(transport, { timeout: 10000 });
      assert.deepEqual(client.getServerVersion(), { name: 'ai-modeling', version: VERSION });
      const remote = (await client.listTools({}, { timeout: 10000 })).tools;
      assert.equal(remote.length, result.total_tools);
      for (const tool of packages.flatMap((manifest) => manifest.tools)) {
        const actual = remote.find((item) => item.name === tool.name)!;
        assert.deepEqual(tool.input_schema, actual.inputSchema);
        assert.deepEqual(tool.output_schema, actual.outputSchema ?? null);
      }
      const status = await client.callTool({ name: 'ai_modeling_runtime_status', arguments: {} });
      assert.equal(status.isError, undefined);
      await assert.rejects(access(process.env.AI_MODELING_DATA_DIR!), { code: 'ENOENT' });
    } finally {
      await client.close();
      await transport?.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
