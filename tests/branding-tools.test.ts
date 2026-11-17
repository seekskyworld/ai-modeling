/** 品牌边界通过真实注册表、CLI 子进程与 MCP SDK 验证；所有上游与凭据均为隔离替身。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { callTool, toolRegistry, type StudioReads } from '../cli/commands.ts';
import { fullToolPlan } from '../cli/compat/full-tools.ts';
import { buildProgram } from '../cli/compat/program.ts';
import { taskNextAction } from '../cli/compat/execution-policy.ts';
import { CliBridge } from '../mcp/cli-bridge.ts';
import { array, object } from '../studio/contracts/errors.ts';
import { VERSION } from '../version.ts';
import { fixture } from './helpers.ts';

const execute = promisify(execFile);
const studio: StudioReads = {
  assets: async () => ({ assets: [] }),
  client: { request: async () => ({}) },
};
const main = fileURLToPath(new URL('../cli/main.ts', import.meta.url));
const hook = fileURLToPath(new URL('./live27-auth-cli-hook.ts', import.meta.url));
const loginId = '22222222-2222-4222-8222-222222222222';
const defaultNames = [
  'ai_modeling_make',
  'ai_modeling_task_get',
  'ai_modeling_task_wait',
  'ai_modeling_balance',
  'ai_modeling_history',
  'ai_modeling_image_generate',
];

async function isolatedCli() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-modeling-brand-tools-'));
  const trace = path.join(dir, 'trace.jsonl');
  await writeFile(trace, '');
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && !/^(?:AI_MODELING_|TRIPO_)/.test(entry[0]),
    ),
  );
  Object.assign(env, {
    AI_MODELING_DATA_DIR: dir,
    AI_MODELING_PROFILE: 'branding-isolated',
    AI_MODELING_EXPERIMENTAL_MESH_EDIT: '',
    LIVE27_TRACE: trace,
    NODE_OPTIONS: process.env.NODE_OPTIONS ?? '',
  });
  const args = ['--import', hook, main];
  const bridge = new CliBridge({ command: process.execPath, args, env });
  return {
    dir,
    env,
    bridge,
    text: async (argv: string[]) =>
      (await execute(process.execPath, [...args, ...argv], { env, timeout: 30000 })).stdout,
    records: async () =>
      (await readFile(trace, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => object(JSON.parse(line))),
    close: async () => {
      bridge.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('tool discovery exposes one new name per capability in all three toolsets', async () => {
  const f = await fixture();
  try {
    for (const toolset of ['default', 'full', 'studio']) {
      const tools = toolRegistry(f.service, studio, toolset);
      assert.ok(tools.length > 0);
      assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length);
      assert.ok(tools.every((tool) => tool.name.startsWith('ai_modeling_')));
      assert.ok(tools.every((tool) => !tool.name.startsWith('tripo_')));
      if (toolset === 'default')
        assert.deepEqual(
          tools.map((tool) => tool.name),
          defaultNames,
        );
    }
    const names = toolRegistry(f.service, studio).map((tool) => tool.name);
    for (const name of [
      'ai_modeling_auth_begin',
      'ai_modeling_auth_status',
      'ai_modeling_runtime_status',
      'ai_modeling_canvas_turn',
      'ai_modeling_project_history',
      'ai_modeling_print_plan',
    ])
      assert.ok(names.includes(name), name);
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('new tool calls execute existing behavior and old tool names are rejected before execution', async () => {
  const f = await fixture();
  try {
    let calls = 0;
    f.gateway.account = async () => ({ balance: ++calls });
    const definitions = toolRegistry(f.service, studio);
    const result = await callTool(definitions, 'ai_modeling_account_status', {});
    assert.equal(object(result.structuredContent.result).balance, 1);
    for (const name of ['tripo_account_status', 'tripo_auth_begin', 'tripo_runtime_status']) {
      const rejected = await callTool(definitions, name, {});
      assert.equal(rejected.isError, true);
      assert.equal(object(rejected.structuredContent.error).code, 'UNKNOWN_TOOL');
    }
    assert.equal(calls, 1);
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('full plan inputs use the new tool namespace while preserving provider model identifiers', async () => {
  const f = await fixture();
  try {
    const definitions = toolRegistry(f.service, studio, 'full');
    const plan = await callTool(definitions, 'ai_modeling_plan', {
      goal: 'plan a model',
      steps: [{ tool: 'ai_modeling_text_to_3d', purpose: 'generate a model' }],
    });
    assert.notEqual(plan.isError, true);
    assert.equal(object(array(object(plan.structuredContent.result).steps)[0]).billed, true);
    const rejected = await callTool(definitions, 'ai_modeling_plan', {
      goal: 'plan a model',
      steps: [{ tool: 'tripo_text_to_3d', purpose: 'old name must not be accepted' }],
    });
    assert.equal(rejected.isError, true);
    assert.equal(object(rejected.structuredContent.error).code, 'INVALID_INPUT');
    const planned = fullToolPlan('ai_modeling_text_to_3d', {
      prompt: 'a toy robot',
      model: 'tripo-v3.1',
    });
    assert.equal(planned.steps[0]?.parameters.model_version, 'v3.1-20260211');
    assert.throws(() => fullToolPlan('tripo_text_to_3d', { prompt: 'a toy robot' }), /Not a task tool/);
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('new authentication and runtime names retain the CLI shortcut without business initialization', async () => {
  const f = await isolatedCli();
  try {
    for (const [name, input] of [
      ['ai_modeling_auth_begin', {}],
      ['ai_modeling_auth_status', { login_id: loginId }],
      ['ai_modeling_auth_wait', { login_id: loginId, timeout_seconds: 1 }],
      ['ai_modeling_auth_cancel', { login_id: loginId }],
    ] as const) {
      const result = await f.bridge.call(name, input);
      assert.equal(object(result.result).login_id, loginId);
      assert.equal(result.error, undefined);
    }
    const status = await f.bridge.call('ai_modeling_runtime_status', {});
    assert.equal(object(status.result).ready, false);
    assert.equal(status.error, undefined);
    const install = await f.bridge.call('ai_modeling_runtime_install', {});
    assert.equal(object(install.error).code, 'INVALID_INPUT');
    const records = await f.records();
    assert.equal(
      records.some((entry) => entry.kind === 'create-application'),
      false,
    );
    assert.equal(
      records.some((entry) => entry.kind === 'ensure-login'),
      false,
    );
    assert.equal(
      records.some((entry) => String(entry.kind).startsWith('business-')),
      false,
    );
  } finally {
    await f.close();
  }
});

test('MCP SDK discovers only the new resource and rejects the old URI and tool namespace', async () => {
  const f = await isolatedCli();
  try {
    for (const toolset of ['default', 'full', 'studio']) {
      const client = new Client({ name: 'branding-tools-test', version: '1' });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL('./live27-auth-mcp-fixture.ts', import.meta.url)), toolset],
        env: f.env,
        stderr: 'pipe',
      });
      try {
        await client.connect(transport);
        assert.deepEqual(client.getServerVersion(), { name: 'ai-modeling', version: VERSION });
        assert.deepEqual(
          (await client.listResources()).resources.map((resource) => resource.uri),
          [
            'ai-modeling://auth/status',
            'ai-modeling://guides/usage',
            'ai-modeling://guides/commands',
            'ai-modeling://guides/pipelines',
            'ai-modeling://guides/commands/index',
          ],
        );
        const resource = await client.readResource({ uri: 'ai-modeling://auth/status' });
        assert.equal(resource.contents[0]?.uri, 'ai-modeling://auth/status');
        await assert.rejects(client.readResource({ uri: 'tripo://auth/status' }), /Unknown resource/);
        const names = (await client.listTools()).tools.map((tool) => tool.name);
        assert.ok(names.length > 0 && names.every((name) => name.startsWith('ai_modeling_')));
        if (toolset === 'default') assert.deepEqual(names, defaultNames);
        if (toolset === 'studio') {
          const current = await client.callTool({ name: 'ai_modeling_auth_status', arguments: {} });
          assert.notEqual(current.isError, true);
        }
        const old = await client.callTool({ name: 'tripo_auth_status', arguments: {} });
        assert.equal(old.isError, true);
        assert.equal(object(object(old.structuredContent).error).code, 'UNKNOWN_TOOL');
      } finally {
        await client.close();
        await transport.close();
      }
    }
    assert.equal(
      (await f.records()).some((entry) => String(entry.kind).startsWith('business-')),
      false,
    );
  } finally {
    await f.close();
  }
});

test('the public CLI, version and shell completion consistently use ai-modeling', async () => {
  const f = await isolatedCli();
  try {
    const program = buildProgram();
    assert.equal(program.name(), 'ai-modeling');
    assert.equal(program.version(), VERSION);
    assert.match(await f.text(['--help']), /Usage: ai-modeling/);
    assert.equal((await f.text(['--version'])).trim(), VERSION);
    assert.match(await f.text(['completion', 'bash']), /complete -F _ai_modeling_complete ai-modeling/);
    assert.match(await f.text(['completion', 'zsh']), /compdef _ai_modeling ai-modeling/);
    assert.match(await f.text(['completion', 'fish']), /complete -c ai-modeling/);
    assert.match(await f.text(['docs', '--topic', 'commands/make']), /ai-modeling make/);
    assert.equal(taskNextAction({ status: 'success' }), 'call ai_modeling_download');
    assert.equal(taskNextAction({ status: 'running' }), 'call ai_modeling_task_wait');
  } finally {
    await f.close();
  }
});
