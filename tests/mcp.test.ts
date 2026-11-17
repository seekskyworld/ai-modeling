/** 官方客户端实际执行 initialize/list/call，再重启服务验证任务身份保持。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { object } from '../studio/contracts/errors.ts';

test('MCP SDK initializes, calls validated tools and recovers after a subprocess restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tripo-mcp-protocol-'));
  const connect = async (): Promise<Client> => {
    const client = new Client({ name: 'integration-test', version: '1.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['tests/mcp-fixture.ts', dir],
        stderr: 'pipe',
      }),
    );
    return client;
  };
  let client = await connect();
  try {
    const tools = await client.listTools();
    assert.ok(tools.tools.some((t) => t.name === 'ai_modeling_image_generate'));
    assert.ok(tools.tools.some((t) => t.name === 'ai_modeling_project_history'));
    assert.ok(tools.tools.some((t) => t.name === 'ai_modeling_motion'));
    const invalid = await client.callTool({
      name: 'ai_modeling_image_generate',
      arguments: { parameters: { prompt: 'x' } },
    });
    assert.equal(invalid.isError, true);
    const created = await client.callTool({
      name: 'ai_modeling_image_generate',
      arguments: { request_id: 'mcp-once', max_estimated_credits: 10, parameters: { prompt: 'toy robot' } },
    });
    assert.notEqual(created.isError, true);
    const original = object(object(created.structuredContent).result);
    assert.equal(original.state, 'submitted');
    await client.close();
    client = await connect();
    const status = await client.callTool({
      name: 'ai_modeling_job_get',
      arguments: { job_id: original.job_id },
    });
    assert.equal(object(object(status.structuredContent).result).state, 'succeeded');
    const repeat = await client.callTool({
      name: 'ai_modeling_image_generate',
      arguments: { request_id: 'mcp-once', max_estimated_credits: 10, parameters: { prompt: 'toy robot' } },
    });
    assert.equal(object(object(repeat.structuredContent).result).job_id, original.job_id);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
