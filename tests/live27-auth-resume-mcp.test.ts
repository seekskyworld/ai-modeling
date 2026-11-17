/** 非TTY登录只返回可接续的状态；真实CLI/stdio传输不能提示stdin、泄密或重启提交。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CliBridge } from '../mcp/cli-bridge.ts';
import { object } from '../studio/contracts/errors.ts';
import { loginStateFile, withLoginLock, writeState } from '../cli/auth/state.ts';
import type { Config } from '../cli/core/config.ts';

const loginId = '22222222-2222-4222-8222-222222222222';
async function context(toolset = 'studio', mode = '', experimental = false) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tripo-live27-protocol-'));
  const trace = path.join(dir, 'trace.jsonl');
  await writeFile(trace, '');
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  delete env.AI_MODELING_EXPERIMENTAL_MESH_EDIT;
  Object.assign(env, {
    AI_MODELING_DATA_DIR: dir,
    AI_MODELING_OUTPUT_DIR: path.join(dir, 'out'),
    AI_MODELING_PROFILE: 'live27-isolated',
    LIVE27_TRACE: trace,
    LIVE27_CASE: mode,
    NODE_OPTIONS: process.env.NODE_OPTIONS ?? '',
  });
  if (experimental) env.AI_MODELING_EXPERIMENTAL_MESH_EDIT = '1';
  const client = new Client({ name: 'live27-auth-protocol', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('./live27-auth-mcp-fixture.ts', import.meta.url)), toolset],
    env,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  await client.connect(transport);
  return {
    client,
    env,
    trace,
    stderr: () => stderr,
    records: async () =>
      (await readFile(trace, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => object(JSON.parse(line))),
    close: async () => {
      await client.close();
      await transport.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test(
  'MCP rejects invalid input before login, then returns a prompt-free pending status for one request',
  { timeout: 30000 },
  async () => {
    const f = await context();
    try {
      const invalid = await f.client.callTool({
        name: 'ai_modeling_image_generate',
        arguments: { parameters: { prompt: 'cube' } },
      });
      assert.equal(invalid.isError, true);
      assert.equal(object(object(invalid.structuredContent).error).code, 'INVALID_INPUT');
      assert.equal(
        (await f.records()).some((row) => row.kind === 'ensure-login'),
        false,
      );
      const result = await f.client.callTool({
        name: 'ai_modeling_image_generate',
        arguments: {
          request_id: 'live27-original-request',
          max_estimated_credits: 10,
          parameters: { prompt: 'cube' },
        },
      });
      assert.equal(result.isError, true);
      const error = object(object(result.structuredContent).error),
        details = error;
      assert.equal(error.code, 'AUTH_REQUIRED');
      assert.equal(details.request_id, 'live27-original-request');
      assert.equal(object(details.login).login_id, loginId);
      assert.deepEqual(details.resume, { checkpoint: 'before_request', replay_submitted_writes: false });
      const records = await f.records();
      assert.equal(records.filter((row) => row.kind === 'cli-process').length, 2);
      assert.deepEqual(
        records.filter((row) => row.kind === 'ensure-login').map(({ wait, open }) => ({ wait, open })),
        [{ wait: false, open: false }],
      );
      assert.equal(
        records.some((row) => String(row.kind).startsWith('business-')),
        false,
      );
      assert.equal(f.stderr(), '');
      assert.doesNotMatch(JSON.stringify(result), /controlled login diagnostic|ory_kratos_session|Bearer /);
    } finally {
      await f.close();
    }
  },
);

test(
  'auth tools and status resource route through CLI without constructing a business application',
  { timeout: 30000 },
  async () => {
    const f = await context();
    try {
      assert.deepEqual(
        (await f.client.listResources()).resources.map((row) => row.uri),
        [
          'ai-modeling://auth/status',
          'ai-modeling://guides/usage',
          'ai-modeling://guides/commands',
          'ai-modeling://guides/pipelines',
          'ai-modeling://guides/commands/index',
        ],
      );
      const resource = await f.client.readResource({ uri: 'ai-modeling://auth/status' });
      const content = resource.contents[0]!;
      assert.ok('text' in content);
      const status = object(JSON.parse(content.text));
      assert.equal(status.login_id, loginId);
      assert.equal(status.scope, 'login_flow');
      assert.equal(status.credential_store_check, 'not_checked');
      assert.equal(status.studio_session_check, 'not_checked');
      for (const [name, args] of [
        ['ai_modeling_auth_begin', {}],
        ['ai_modeling_auth_status', { login_id: loginId }],
        ['ai_modeling_auth_wait', { login_id: loginId, timeout_seconds: 1 }],
        ['ai_modeling_auth_cancel', { login_id: loginId }],
      ] as const) {
        const result = await f.client.callTool({ name, arguments: args });
        assert.notEqual(result.isError, true, JSON.stringify(result));
        assert.equal(object(object(result.structuredContent).result).login_id, loginId);
      }
      const records = await f.records();
      assert.equal(
        records.some((row) => row.kind === 'create-application'),
        false,
      );
      assert.equal(records.filter((row) => row.kind === 'cli-process').length, 6);
      assert.equal(
        records.some((row) => row.kind === 'ensure-login'),
        false,
      );
      assert.equal(records.find((row) => row.kind === 'begin-login')?.open, false);
      assert.equal(records.find((row) => row.kind === 'wait-login')?.timeoutMs, 1000);
    } finally {
      await f.close();
    }
  },
);

test(
  'MCP reads a completed historical flow without claiming current credential or session availability',
  { timeout: 30000 },
  async () => {
    const f = await context('default', 'flow_snapshot');
    const config: Config = {
      dataDir: f.env.AI_MODELING_DATA_DIR!,
      credentialProfile: f.env.AI_MODELING_PROFILE!,
      outputDir: '',
      inputRoots: [],
    };
    const file = await loginStateFile(config);
    try {
      // The production coordinator is used here; the loader rejects any real credential/network use.
      for (const sessionExpiresAt of ['2000-01-01T00:00:00Z', '2999-01-01T00:00:00Z']) {
        await withLoginLock(config, () =>
          writeState(config, {
            version: 1,
            profile: config.credentialProfile,
            login_id: loginId,
            status: 'authenticated',
            started_at: '2000-01-01T00:00:00Z',
            expires_at: '2000-01-01T00:15:00Z',
            session_expires_at: sessionExpiresAt,
            pid: process.pid,
            nonce: 'a'.repeat(64),
            control: 'b'.repeat(64),
            account_ref: 'historical-test-account',
            balance: 123,
          }),
        );
        const before = await readFile(file, 'utf8');
        const response = await f.client.readResource({ uri: 'ai-modeling://auth/status' });
        const content = response.contents[0]!;
        assert.ok('text' in content);
        const status = object(JSON.parse(content.text));
        assert.equal(status.login_id, loginId);
        assert.equal(status.status, 'authenticated');
        assert.equal(status.authenticated, true);
        assert.equal(status.login_required, false);
        assert.equal(status.scope, 'login_flow');
        assert.equal(status.credential_store_check, 'not_checked');
        assert.equal(status.studio_session_check, 'not_checked');
        assert.equal(status.session_expires_at, sessionExpiresAt);
        assert.equal(status.balance, 123);
        assert.equal(await readFile(file, 'utf8'), before);
      }
      const records = await f.records();
      assert.equal(records.filter((row) => row.kind === 'cli-process').length, 2);
      assert.equal(
        records.some((row) => row.kind !== 'cli-process'),
        false,
      );
      assert.equal(f.stderr(), '');
    } finally {
      await rm(file, { force: true });
      await f.close();
    }
  },
);

for (const [toolset, experimental, count] of [
  ['default', false, 6],
  ['full', false, 26],
  ['full', true, 27],
  ['studio', false, 176],
] as const) {
  test(
    `MCP ${toolset} experimental=${experimental} preserves its ${count}-tool inventory`,
    { timeout: 30000 },
    async () => {
      const f = await context(toolset, '', experimental);
      try {
        const tools = (await f.client.listTools()).tools;
        assert.equal(tools.length, count);
        if (toolset === 'default') {
          for (const [name, required] of [
            ['ai_modeling_make', ['input']],
            ['ai_modeling_task_get', ['task_id']],
            ['ai_modeling_task_wait', ['task_id']],
            ['ai_modeling_balance', []],
            ['ai_modeling_history', []],
          ] as const) {
            const schema = tools.find((tool) => tool.name === name)!.inputSchema;
            assert.deepEqual(schema.required ?? [], required);
          }
          const make = tools.find((tool) => tool.name === 'ai_modeling_make')!.inputSchema;
          assert.equal(object(make.properties?.pbr).default, false);
          assert.equal(object(make.properties?.timeout).default, 1800);
          assert.equal(object(make.properties?.no_wait).default, false);
          assert.equal(object(make.properties?.no_download).default, false);
        }
        assert.equal(
          tools.filter((row) => row.name.startsWith('ai_modeling_auth_')).length,
          toolset === 'studio' ? 4 : 0,
        );
        assert.equal(
          (await f.records()).some((row) => row.kind === 'ensure-login'),
          false,
        );
      } finally {
        await f.close();
      }
    },
  );
}

for (const toolset of ['default', 'full'] as const) {
  test(
    `${toolset} assigns an omitted request ID before missing-session authentication`,
    { timeout: 30000 },
    async () => {
      const f = await context(toolset);
      try {
        const name = toolset === 'default' ? 'ai_modeling_make' : 'ai_modeling_text_to_3d';
        const args = toolset === 'default' ? { input: 'cube' } : { prompt: 'cube' };
        const result = await f.client.callTool({ name, arguments: args });
        assert.equal(result.isError, true);
        const details = object(object(result.structuredContent).error);
        assert.match(
          String(details.request_id),
          /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
        );
        const repeated = await f.client.callTool({
          name,
          arguments: { ...args, request_id: details.request_id },
        });
        assert.equal(object(object(repeated.structuredContent).error).request_id, details.request_id);
        assert.equal(
          (await f.records()).some((row) => row.kind === 'business-submit'),
          false,
        );
      } finally {
        await f.close();
      }
    },
  );
}

test(
  'default MCP resumes the original image request after browser login through its status resource',
  { timeout: 30000 },
  async () => {
    const f = await context('default', 'resume');
    try {
      const args = {
        request_id: 'first-use-image',
        max_estimated_credits: 10,
        parameters: { prompt: 'a small blue toy robot' },
      };
      const pending = await f.client.callTool({ name: 'ai_modeling_image_generate', arguments: args });
      assert.equal(pending.isError, true);
      const error = object(object(pending.structuredContent).error);
      assert.equal(error.code, 'AUTH_REQUIRED');
      assert.equal(error.request_id, args.request_id);
      assert.equal(error.certainty, 'not_submitted');
      assert.equal(object(error.login).login_url, 'http://127.0.0.1:1/controlled-local-login');
      const readStatus = async () => {
        const resource = await f.client.readResource({ uri: 'ai-modeling://auth/status' });
        const content = resource.contents[0]!;
        assert.ok('text' in content);
        return object(JSON.parse(content.text));
      };
      assert.equal((await readStatus()).authenticated, false);
      assert.equal(
        (await f.records()).some((row) => row.kind === 'business-submit'),
        false,
      );
      // Simulate the user's completed login; no credential or network hook is added to production.
      await writeFile(path.join(f.env.AI_MODELING_DATA_DIR!, 'login-complete'), 'authenticated');
      assert.equal((await readStatus()).authenticated, true);
      const resumed = await f.client.callTool({ name: 'ai_modeling_image_generate', arguments: args });
      assert.notEqual(resumed.isError, true, JSON.stringify(resumed));
      assert.equal(object(resumed.structuredContent).state, 'submitted');
      const repeated = await f.client.callTool({ name: 'ai_modeling_image_generate', arguments: args });
      assert.notEqual(repeated.isError, true, JSON.stringify(repeated));
      assert.equal(object(repeated.structuredContent).job_id, object(resumed.structuredContent).job_id);
      const records = await f.records();
      assert.equal(records.filter((row) => row.kind === 'ensure-login').length, 1);
      assert.equal(records.filter((row) => row.kind === 'business-submit').length, 1);
      assert.equal(f.stderr(), '');
    } finally {
      await f.close();
    }
  },
);

test(
  'a late tool authentication error returns the already fixed request ID without running the tool twice',
  { timeout: 30000 },
  async () => {
    const f = await context('studio', 'late_auth');
    try {
      const result = await f.client.callTool({
        name: 'ai_modeling_image_generate',
        arguments: {
          request_id: 'live27-late-original',
          max_estimated_credits: 10,
          parameters: { prompt: 'cube' },
        },
      });
      assert.equal(result.isError, true);
      assert.equal(object(object(result.structuredContent).error).request_id, 'live27-late-original');
      const records = await f.records();
      assert.equal(records.filter((row) => row.kind === 'business-quote').length, 1);
      assert.equal(records.filter((row) => row.kind === 'cli-process').length, 1);
      assert.equal(
        records.some((row) => row.kind === 'business-submit'),
        false,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'cancelled CLI bridge terminates its original process without spawning a replacement',
  { timeout: 30000 },
  async () => {
    const f = await context('studio', 'hold');
    const bridge = new CliBridge({
      command: process.execPath,
      args: [
        '--import',
        fileURLToPath(new URL('./live27-auth-cli-hook.ts', import.meta.url)),
        fileURLToPath(new URL('../cli/main.ts', import.meta.url)),
      ],
      env: f.env,
    });
    try {
      const controller = new AbortController();
      const result = bridge.call('ai_modeling_account_status', {}, controller.signal);
      const deadline = Date.now() + 10000;
      while (!(await f.records()).some((row) => row.kind === 'business-account')) {
        assert.ok(Date.now() < deadline, 'Original CLI should reach the controlled call');
        await delay(20);
      }
      controller.abort();
      assert.equal(object((await result).error).code, 'CLI_INTERRUPTED_CHECK_JOB');
      assert.equal((await f.records()).filter((row) => row.kind === 'cli-process').length, 1);
      assert.equal((await f.records()).filter((row) => row.kind === 'business-account').length, 1);
    } finally {
      bridge.close();
      await f.close();
    }
  },
);
