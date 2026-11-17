import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { callTool, toolMetadata, toolRegistry, type StudioReads } from '../cli/commands.ts';
import { generationPlan } from '../cli/compat/planning.ts';
import { fullToolPlan } from '../cli/compat/full-tools.ts';
import { listModels } from '../cli/compat/catalog.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import { Operations } from '../studio/api/operations.ts';
import type { StudioClient } from '../studio/api/client.ts';
import { object } from '../studio/contracts/errors.ts';
import { fixture } from './helpers.ts';

const execute = promisify(execFile);
const main = fileURLToPath(new URL('../cli/main.ts', import.meta.url));
const studio: StudioReads = { assets: async () => ({ assets: [] }), client: { request: async () => ({}) } };
const model = 'gpt_image_2.5_sunburst';

test('standalone image defaults agree across CLI plans, Studio input, full MCP and model discovery', () => {
  assert.equal(normalize('image', { prompt: 'a cube' }).model_version, model);
  for (const name of ['text-to-image', 'image-to-image']) {
    const inputs = name === 'text-to-image' ? ['a cube'] : ['@picture'];
    const plan = generationPlan(name, inputs, { prompt: 'a cube' });
    assert.equal(plan.steps[0]!.parameters.model_version, model);
  }
  assert.equal(
    fullToolPlan('ai_modeling_generate_image', { prompt: 'a cube' }).steps[0]!.parameters.model_version,
    model,
  );
  for (const entry of listModels().filter((item) =>
    ['text-to-image', 'image-to-image'].includes(String(item.capability)),
  ))
    assert.equal(entry.default, model);
  assert.equal(
    generationPlan('text-to-image', ['a cube'], { model: 'banana2' }).steps[0]!.parameters.model_version,
    'gemini_3.1_flash_image_preview',
  );
  const references = Array.from({ length: 16 }, (_, i) => `./reference-${i}.png`);
  assert.equal(
    generationPlan('image-to-image', references, { prompt: 'combine' }).steps[0]!.parameters.model_version,
    model,
  );
});

test('real standalone image CLI commands plan GPT Image 2.5 without login', async () => {
  for (const args of [
    ['generate', 'text-to-image', 'a cube'],
    ['studio', 'image', '--prompt', 'a cube'],
  ]) {
    const { stdout } = await execute(process.execPath, [main, ...args, '--dry-run', '--json']);
    const result = JSON.parse(stdout);
    assert.equal(result.valid, true);
    assert.equal(result.steps[0].parameters.model_version, model);
  }
});

test('default image tool shares Studio schema and submits the requested image controls to the web route', async () => {
  const f = await fixture();
  try {
    const defaultTool = toolMetadata('default').find((tool) => tool.name === 'ai_modeling_image_generate');
    const studioTool = toolMetadata('studio').find((tool) => tool.name === 'ai_modeling_image_generate');
    assert.ok(defaultTool);
    assert.deepEqual(defaultTool, studioTool);
    const output = await callTool(toolRegistry(f.service, studio, 'default'), defaultTool.name, {
      request_id: 'default-image',
      max_estimated_credits: 10,
      parameters: { prompt: 'a cube', amount: 4, scale: '16:9', resolution: '4K' },
    });
    assert.notEqual(output.isError, true);
    const job = f.jobs.get(String(object(output.structuredContent.result).job_id));
    assert.equal(job.input.model_version, model);
    const submission = await new Operations({} as StudioClient, []).build(job);
    assert.equal(submission.route, '/v2/studio/image/gen_image_v2');
    assert.equal(submission.body.model_version, model);
    assert.equal(submission.body.amount, 4);
    assert.equal(submission.body.scale, '16:9');
    assert.equal(submission.body.resolution, '4K');
    assert.equal(f.gateway.posts, 1);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('changing the default preserves existing FLUX jobs and rejects changed request reuse without resubmitting', async () => {
  const f = await fixture();
  try {
    const originalInput = { prompt: 'a cube', model_version: 'flux.1_kontext_pro' };
    const original = await f.service.submit('image', 'original-image', originalInput, 10);
    assert.equal(
      (await f.service.submit('image', 'original-image', originalInput, 10)).job_id,
      original.job_id,
    );
    const conflict = await callTool(
      toolRegistry(f.service, studio, 'default'),
      'ai_modeling_image_generate',
      {
        request_id: 'original-image',
        max_estimated_credits: 10,
        parameters: { prompt: 'a cube' },
      },
    );
    assert.equal(conflict.isError, true);
    assert.equal(object(conflict.structuredContent.error).code, 'IDEMPOTENCY_CONFLICT');
    const queried = await callTool(toolRegistry(f.service, studio, 'default'), 'ai_modeling_task_get', {
      task_id: original.job_id,
    });
    assert.notEqual(queried.isError, true);
    assert.equal(f.jobs.get(String(original.job_id)).input.model_version, originalInput.model_version);
    assert.equal(f.gateway.posts, 1);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('default MCP discovers and executes image generation through CLI and recovers after restart', async () => {
  const f = await fixture();
  const connect = async (): Promise<Client> => {
    const client = new Client({ name: 'default-image-test', version: '1' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['tests/mcp-fixture.ts', f.dir, 'default'],
        stderr: 'pipe',
      }),
    );
    return client;
  };
  let client = await connect();
  try {
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name),
      toolMetadata('default').map((tool) => tool.name),
    );
    const args = {
      request_id: 'mcp-default-image',
      max_estimated_credits: 10,
      parameters: { prompt: 'a cube' },
    };
    const created = await client.callTool({ name: 'ai_modeling_image_generate', arguments: args });
    assert.notEqual(created.isError, true);
    const original = object(created.structuredContent);
    assert.equal(original.state, 'submitted');
    assert.equal(f.jobs.get(String(original.job_id)).input.model_version, model);
    await client.close();
    client = await connect();
    const repeat = await client.callTool({ name: 'ai_modeling_image_generate', arguments: args });
    assert.notEqual(repeat.isError, true);
    assert.equal(object(repeat.structuredContent).job_id, original.job_id);
    const status = await client.callTool({
      name: 'ai_modeling_task_get',
      arguments: { task_id: original.job_id },
    });
    assert.notEqual(status.isError, true);
    assert.equal(object(status.structuredContent).task_id, original.job_id);
  } finally {
    await client.close();
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
