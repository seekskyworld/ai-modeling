/** Guidance crosses the real MCP → CLI boundary and never opens an account or task database. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CliBridge } from '../mcp/cli-bridge.ts';
import { array, object, text } from '../studio/contracts/errors.ts';

const sources = {
  usage: '../skills/ai-modeling/references/usage.md',
  commands: '../docs/commands.md',
  pipelines: '../skills/ai-modeling/references/pipelines.md',
};
const main = fileURLToPath(new URL('../cli/main.ts', import.meta.url));
const hook = new URL('./live27-auth-cli-hook.ts', import.meta.url).href;

async function isolated() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-modeling-guides-'));
  const trace = path.join(dir, 'trace.jsonl');
  await writeFile(trace, '');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && !/^(?:AI_MODELING_|TRIPO_|NODE_OPTIONS$)/.test(entry[0]),
    ),
  );
  Object.assign(env, {
    AI_MODELING_DATA_DIR: path.join(dir, 'unused-data'),
    AI_MODELING_PROFILE: 'guides-isolated',
    LIVE27_TRACE: trace,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${hook}`.trim(),
  });
  return {
    dir,
    env,
    async verifyOffline() {
      await assert.rejects(stat(env.AI_MODELING_DATA_DIR!), { code: 'ENOENT' });
      const records = (await readFile(trace, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => object(JSON.parse(line)));
      assert.ok(records.length > 0);
      assert.ok(records.every((row) => row.kind === 'cli-process'));
      return records;
    },
    close: async () => await rm(dir, { recursive: true, force: true }),
  };
}

test('CLI reads the shared guide bytes without account or database access and rejects arbitrary paths', async () => {
  const f = await isolated();
  const bridge = new CliBridge({ command: process.execPath, args: [main], env: f.env });
  try {
    const listed = object(await bridge.run(['guides', 'list']));
    assert.deepEqual(
      array(listed.resources).map((item) => object(item).uri),
      [
        ...Object.keys(sources).map((id) => `ai-modeling://guides/${id}`),
        'ai-modeling://guides/commands/index',
      ],
    );
    for (const [id, file] of Object.entries(sources)) {
      const result = object(await bridge.run(['guides', 'read', id]));
      assert.equal(result.text, await readFile(new URL(file, import.meta.url), 'utf8'));
      assert.equal(result.mimeType, 'text/markdown');
    }
    for (const args of [['read', '../package.json'], ['read', '/etc/passwd'], ['list', 'extra'], ['read']]) {
      const result = object(await bridge.run(['guides', ...args]));
      assert.equal(object(result.error).code, 'INVALID_INPUT');
    }
    await f.verifyOffline();
  } finally {
    bridge.close();
    await f.close();
  }
});

test('an Agent reads the same Skill guidance through the unified MCP command and its packaged CLI bridge', async () => {
  const f = await isolated();
  const client = new Client({ name: 'guidance-test', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [main, 'mcp', '--toolset', 'studio'],
    env: f.env,
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    assert.match(client.getInstructions() ?? '', /bundled CLI internally/);
    assert.deepEqual(
      (await client.listResources()).resources.map((item) => item.uri),
      [
        'ai-modeling://auth/status',
        ...Object.keys(sources).map((id) => `ai-modeling://guides/${id}`),
        'ai-modeling://guides/commands/index',
      ],
    );
    for (const [id, file] of Object.entries(sources)) {
      const result = await client.readResource({ uri: `ai-modeling://guides/${id}` });
      const content = result.contents[0]!;
      assert.equal(text(object(content).text), await readFile(new URL(file, import.meta.url), 'utf8'));
    }
    const templates = await client.listResourceTemplates();
    assert.equal(templates.resourceTemplates[0]?.uriTemplate, 'ai-modeling://guides/commands/{+command}');
    const focused = await client.readResource({ uri: 'ai-modeling://guides/commands/model/convert' });
    const focusedText = text(object(focused.contents[0]).text);
    assert.match(focusedText, /--format/);
    assert.match(focusedText, /Studio backend:/);
    assert.ok(
      focusedText.length < (await readFile(new URL(sources.commands, import.meta.url), 'utf8')).length / 2,
    );
    const index = await client.readResource({ uri: 'ai-modeling://guides/commands/index' });
    assert.match(text(object(index.contents[0]).text), /ai-modeling:\/\/guides\/commands\/model\/convert/);
    const group = await client.readResource({ uri: 'ai-modeling://guides/commands/model' });
    assert.match(text(object(group.contents[0]).text), /guides\/commands\/model\/convert/);
    await assert.rejects(client.readResource({ uri: 'ai-modeling://guides/commands/not-a-command' }), {
      code: -32602,
    });
    await assert.rejects(client.readResource({ uri: 'ai-modeling://guides/../../package.json' }), {
      code: -32602,
      message: /Unknown resource\./,
    });
    await assert.rejects(client.readResource({ uri: 'ai-modeling://guides/missing' }), {
      code: -32602,
      message: /Unknown guide\./,
    });
    const records = await f.verifyOffline();
    for (const args of [
      ['guides', 'list'],
      ['guides', 'templates'],
      ['guides', 'read', 'commands/model/convert'],
      ...Object.keys(sources).map((id) => ['guides', 'read', id]),
    ])
      assert.equal(records.filter((row) => JSON.stringify(row.args) === JSON.stringify(args)).length, 1);
  } finally {
    await client.close();
    await transport.close();
    await f.close();
  }
});
