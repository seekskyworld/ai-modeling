/** Default MCP keeps generation PBR separate from imports and preserves the real CLI billing boundary. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { compatibleTools } from '../cli/compat/tools.ts';
import { callTool } from '../cli/commands.ts';
import { object } from '../studio/contracts/errors.ts';
import { fixture } from './helpers.ts';
import { uvImportFixture } from './uv-import-fixture.ts';
import sharp from '../cli/runtime/sharp.ts';

test('default make keeps image/text default PBR false and explicit true while rejecting irrelevant consent', async () => {
  const f = await fixture();
  try {
    const image = path.join(f.dir, 'input.png');
    await writeFile(
      image,
      await sharp({ create: { width: 2, height: 2, channels: 4, background: '#e0e0e0' } })
        .png()
        .toBuffer(),
    );
    const tools = compatibleTools(f.service, {
      assets: async () => ({}),
      client: {
        request: async () => {
          throw Error('No Studio reads required.');
        },
      },
    });
    for (const [kind, input] of [
      ['text', 'a blue cube'],
      ['image', image],
    ]) {
      for (const pbr of [undefined, true]) {
        const request = `generation-${kind}-${pbr === true ? 'pbr' : 'default'}`;
        const result = await callTool(tools, 'ai_modeling_make', {
          input,
          model: 'v3.1',
          ...(pbr ? { pbr } : {}),
          request_id: request,
          no_wait: true,
          no_download: true,
        });
        assert.notEqual(result.isError, true, JSON.stringify(result));
        const job = f.jobs.find('test-account', `${request}-0`)!;
        assert.equal(job.operation, 'model');
        assert.equal(job.input.pbr, pbr === true);
        assert.equal(job.input.texture, true);
        assert.equal(job.input.accept_variable_cost, undefined);
      }
      const rejected = await callTool(tools, 'ai_modeling_make', {
        input,
        accept_variable_cost: true,
        no_download: true,
      });
      assert.equal(object(rejected.structuredContent.error).code, 'STUDIO_CAPABILITY_UNAVAILABLE');
    }
    const rejected = await callTool(tools, 'ai_modeling_make', {
      input: './source.glb',
      pbr: true,
      accept_variable_cost: true,
      no_download: true,
    });
    assert.equal(object(rejected.structuredContent.error).code, 'STUDIO_CAPABILITY_UNAVAILABLE');
    assert.match(String(object(rejected.structuredContent.error).message), /texture:pbr=true/);
    assert.equal(f.gateway.posts, 4);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test(
  'real default MCP imports model files without generation-only fields and explicitly consents to a later UV step',
  { timeout: 60000 },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ai-modeling-default-unquoted-'));
    const trace = path.join(dir, 'trace.jsonl'),
      model = path.join(dir, 'model.glb');
    await writeFile(trace, '');
    await writeFile(model, await uvImportFixture(false));
    const env = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
    Object.assign(env, {
      AI_MODELING_DATA_DIR: dir,
      AI_MODELING_OUTPUT_DIR: path.join(dir, 'output'),
      AI_MODELING_PROFILE: 'default-unquoted-test',
      UNQUOTED_FULL_TRACE: trace,
    });
    const client = new Client({ name: 'default-unquoted-protocol', version: '1' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('./full-unquoted-mcp-fixture.ts', import.meta.url)), 'default'],
      env,
      stderr: 'pipe',
    });
    const records = async () =>
      (await readFile(trace, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => object(JSON.parse(line)));
    const input = {
      input: model,
      request_id: 'default-import',
      accept_variable_cost: true,
      no_download: true,
    };
    try {
      await client.connect(transport);
      const spec = (await client.listTools()).tools.find((entry) => entry.name === 'ai_modeling_make')!;
      assert.equal(object(object(spec.inputSchema.properties).accept_variable_cost).const, true);
      for (const maximum of [0, 10]) {
        const result = await client.callTool({
          name: spec.name,
          arguments: { ...input, max_estimated_credits: maximum },
        });
        assert.equal(object(object(result.structuredContent).error).code, 'UNQUOTED_BUDGET_UNSUPPORTED');
      }
      assert.equal(
        (await records()).some((row) =>
          ['quote', 'remote-account', 'remote-submit'].includes(String(row.kind)),
        ),
        false,
      );
      const missing = await client.callTool({
        name: spec.name,
        arguments: { input: model, request_id: 'default-no-consent', no_download: true },
      });
      assert.equal(object(object(missing.structuredContent).error).code, 'PRICE_UNKNOWN');
      const imported = await client.callTool({ name: spec.name, arguments: input });
      assert.notEqual(imported.isError, true, JSON.stringify(imported));
      assert.equal(object(imported.structuredContent).status, 'success');
      const first = (await records()).find((row) => row.kind === 'service-submit')!;
      assert.equal(first.operation, 'import_model');
      assert.equal(first.maximum_absent, true);
      assert.equal(object(first.parameters).accept_variable_cost, true);
      assert.equal(object(first.parameters).pbr, undefined);
      assert.equal(object(first.parameters).texture, undefined);
      const recovered = await client.callTool({ name: spec.name, arguments: input });
      assert.equal(object(recovered.structuredContent).task_id, object(imported.structuredContent).task_id);
      assert.equal((await records()).filter((row) => row.kind === 'remote-submit').length, 1);
      const chain = {
        input: '@unquoted-source',
        then: 'uv:bake=false;compress=geometry;accept_variable_cost=true',
        request_id: 'default-uv-tail',
        no_download: true,
      };
      const rejected = await client.callTool({
        name: spec.name,
        arguments: { ...chain, accept_variable_cost: true },
      });
      assert.equal(object(object(rejected.structuredContent).error).code, 'STUDIO_CAPABILITY_UNAVAILABLE');
      const uv = await client.callTool({ name: spec.name, arguments: chain });
      assert.notEqual(uv.isError, true, JSON.stringify(uv));
      assert.equal(object(object(uv.structuredContent).uv_compression_validation).status, 'verified');
      const submitted = (await records()).filter((row) => row.kind === 'remote-submit');
      assert.deepEqual(
        submitted.map((row) => row.operation),
        ['import_model', 'uv_generate', 'uv_commit', 'import_model'],
      );
      const importCalls = (await records()).filter(
        (row) => row.kind === 'service-submit' && row.operation === 'import_model',
      );
      assert(importCalls.every((row) => row.maximum_absent === true));
    } finally {
      await client.close();
      await transport.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
