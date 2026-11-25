/** Full MCP contract and real stdio/CLI execution preserve explicit unquoted billing consent. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fullContract } from '../cli/compat/full-contract.ts';
import { fullToolPlan } from '../cli/compat/full-tools.ts';
import { object } from '../studio/contracts/errors.ts';
import { CliBridge } from '../mcp/cli-bridge.ts';
import { executePlan } from '../cli/compat/runtime.ts';
import { quote } from './helpers.ts';
import { transferFixture, transferMatrix } from './helpers-smartsegment-transfer.ts';
import { affineFixture } from './helpers-smartsegment-affine.ts';

const relevant = [
  'ai_modeling_import_model',
  'ai_modeling_texture',
  'ai_modeling_rig_check',
  'ai_modeling_rig',
  'ai_modeling_convert',
  'ai_modeling_decimate',
  'ai_modeling_smart_uv',
  'ai_modeling_segment',
  'ai_modeling_mesh_edit',
  'ai_modeling_smart_segment',
];
test('full schemas expose consent/budget only on model-processing tools with actual import paths', () => {
  for (const spec of fullContract) {
    const properties = object(spec.inputSchema.properties);
    assert.equal(Object.hasOwn(properties, 'accept_variable_cost'), relevant.includes(spec.name), spec.name);
    assert.equal(Object.hasOwn(properties, 'max_estimated_credits'), relevant.includes(spec.name), spec.name);
  }
  for (const name of relevant) {
    const spec = fullContract.find((entry) => entry.name === name)!;
    const input = {
      input: 'model.glb',
      accept_variable_cost: true,
      ...(name === 'ai_modeling_convert' ? { format: 'GLTF' } : {}),
      ...(name === 'ai_modeling_mesh_edit'
        ? {
            bbox: [
              [0, 0, 0],
              [1, 1, 1],
            ],
          }
        : {}),
    };
    const schema = z.fromJSONSchema(spec.inputSchema);
    assert.equal(schema.safeParse(input).success, true, name);
    assert.equal(object(schema.parse(input)).max_estimated_credits, undefined);
    for (const maximum of [-1, '0', null])
      assert.equal(schema.safeParse({ ...input, max_estimated_credits: maximum }).success, false);
  }
});

test('full processing plans scope consent to actual imports and preserve separate Lab selection', () => {
  for (const name of relevant.filter((name) => name !== 'ai_modeling_rig_check')) {
    const input = {
      input: './source.glb',
      accept_variable_cost: true,
      max_estimated_credits: 25,
      ...(name === 'ai_modeling_convert' ? { format: 'GLTF' } : {}),
      ...(name === 'ai_modeling_mesh_edit'
        ? {
            bbox: [
              [0, 0, 0],
              [1, 1, 1],
            ],
          }
        : {}),
      ...(name === 'ai_modeling_smart_uv' ? { bake: false, compress: 'geometry' } : {}),
    };
    const plan = fullToolPlan(name, input);
    assert(
      plan.steps.some((step) => step.operation === 'import_model'),
      name,
    );
    for (const step of plan.steps) {
      assert.equal(
        step.parameters.accept_variable_cost,
        step.operation === 'import_model' ? true : undefined,
        name,
      );
      assert.equal(step.parameters.max_estimated_credits, undefined, name);
    }
  }
  const uv = fullToolPlan('ai_modeling_smart_uv', {
    input: '@source',
    bake: false,
    compress: 'geometry',
    accept_variable_cost: true,
  });
  assert.deepEqual(
    uv.steps.map((step) => step.parameters.accept_variable_cost),
    [undefined, undefined, true],
  );
  for (const input of [{ input: '@source' }, { input: 'image.png', seg_type: 'image' }])
    assert.throws(() => fullToolPlan('ai_modeling_smart_segment', { ...input, accept_variable_cost: true }), {
      code: 'STUDIO_CAPABILITY_UNAVAILABLE',
    });
  const lab = fullToolPlan('ai_modeling_mesh_edit', {
    input: './source.glb',
    ref_image: './reference.png',
    bbox: [
      [0, 0, 0],
      [1, 1, 1],
    ],
    accept_variable_cost: true,
  });
  assert.equal(lab.labReferenceEdit?.accept_variable_cost, true);
  assert.equal(lab.steps[0]!.operation, 'canvas_lab');
});

for (const file of [false, true])
  test(`full affine ${file ? 'file' : 'owned reference'} retains consent through exact-source preparation and recovery`, async () => {
    const f = await transferFixture({ file });
    try {
      const plan = fullToolPlan('ai_modeling_smart_segment', {
        input: f.source,
        transform: transferMatrix,
        granularity: 'coarse',
        hint: 'head',
        accept_variable_cost: true,
      });
      f.service.pricing.quote = async (operation) =>
        operation === 'import_model' ? { ...quote, known: false, variable: true, credits: undefined } : quote;
      const flags = { ...f.flags, maxCredits: undefined };
      const result = await executePlan(f.app, plan, flags);
      assert.equal(result.status, 'success', JSON.stringify(result));
      assert.equal(f.submissions[0]!.input.accept_variable_cost, true);
      assert(f.submissions.slice(1).every((job) => job.input.accept_variable_cost === undefined));
      f.service.pricing.quote = async () => {
        throw Error('Original completed receipts do not need new quotes.');
      };
      assert.equal((await executePlan(f.app, plan, flags)).task_id, result.task_id);
      assert.equal(f.gateway.posts, 3);
      await assert.rejects(executePlan(f.app, f.plan(), flags), { code: 'IDEMPOTENCY_CONFLICT' });
      assert.equal(f.gateway.posts, 3);
    } finally {
      await f.close();
    }
  });

test('unknown affine import and historical seven-step receipts retain original IDs without new quote or submit', async () => {
  const transfer = await transferFixture({ unknownIndex: 0 });
  try {
    const first = await executePlan(transfer.app, transfer.plan(), transfer.flags);
    assert.equal(first.status, 'outcome_unknown');
    transfer.service.pricing.quote = async () => {
      throw Error('Unknown submissions must only recover.');
    };
    const recovered = await executePlan(transfer.app, transfer.plan(), transfer.flags);
    assert.equal(recovered.task_id, first.task_id);
    assert.equal(recovered.status, 'outcome_unknown');
    assert.equal(transfer.gateway.posts, 1);
  } finally {
    await transfer.close();
  }
  const legacy = await affineFixture();
  try {
    const first = await executePlan(legacy.app, legacy.plan(), legacy.flags);
    assert.equal(first.status, 'success', JSON.stringify(first));
    legacy.service.pricing.quote = async () => {
      throw Error('Frozen seven-step receipts do not need new quotes.');
    };
    const recovered = await executePlan(legacy.app, legacy.plan(), legacy.flags);
    assert.equal(recovered.task_id, first.task_id);
    assert.equal(legacy.gateway.posts, 7);
  } finally {
    await legacy.close();
  }
});

test(
  'real full MCP/CLI bridge submits UV with absent maximum, rejects numeric budgets early, and recovers without reposting',
  { timeout: 60000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-full-unquoted-'));
    const trace = path.join(directory, 'trace.jsonl');
    await writeFile(trace, '');
    const env = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
    Object.assign(env, {
      AI_MODELING_DATA_DIR: directory,
      AI_MODELING_OUTPUT_DIR: path.join(directory, 'output'),
      AI_MODELING_PROFILE: 'full-unquoted-test',
      UNQUOTED_FULL_TRACE: trace,
    });
    const client = new Client({ name: 'full-unquoted-protocol', version: '1' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('./full-unquoted-mcp-fixture.ts', import.meta.url))],
      env,
      stderr: 'pipe',
    });
    const bridge = new CliBridge({
      command: process.execPath,
      args: [
        '--import',
        fileURLToPath(new URL('./full-unquoted-cli-hook.ts', import.meta.url)),
        fileURLToPath(new URL('../cli/main.ts', import.meta.url)),
      ],
      env,
    });
    const records = async () =>
      (await readFile(trace, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => object(JSON.parse(line)));
    const input = {
      input: '@unquoted-source',
      bake: false,
      compress: 'geometry',
      accept_variable_cost: true,
      request_id: 'full-uv-protocol',
    };
    try {
      await client.connect(transport);
      const spec = (await client.listTools()).tools.find((tool) => tool.name === 'ai_modeling_smart_uv')!;
      assert.equal(object(object(spec.inputSchema.properties).accept_variable_cost).const, true);
      for (const maximum of [0, 10]) {
        const response = await client.callTool({
          name: spec.name,
          arguments: { ...input, max_estimated_credits: maximum },
        });
        assert.equal(response.isError, true);
        assert.equal(object(object(response.structuredContent).error).code, 'UNQUOTED_BUDGET_UNSUPPORTED');
      }
      assert.equal(
        (await records()).some((row) =>
          ['quote', 'remote-account', 'remote-submit'].includes(String(row.kind)),
        ),
        false,
      );
      const withoutConsent: Record<string, unknown> = { ...input };
      delete withoutConsent.accept_variable_cost;
      const missing = await client.callTool({ name: spec.name, arguments: withoutConsent });
      assert.equal(object(object(missing.structuredContent).error).code, 'PRICE_UNKNOWN');
      assert.equal((await records()).filter((row) => row.kind === 'remote-submit').length, 0);
      const response = await client.callTool({ name: spec.name, arguments: input });
      assert.notEqual(response.isError, true, JSON.stringify(response));
      const result = object(response.structuredContent);
      assert.equal(result.status, 'success', JSON.stringify(result));
      assert.equal(object(result.uv_compression_validation).status, 'verified');
      const imported = (await records()).filter(
        (row) => row.kind === 'service-submit' && row.operation === 'import_model',
      );
      assert.equal(imported.length, 1);
      assert.equal(imported[0]!.maximum_absent, true);
      assert.equal(imported[0]!.maximum, undefined);
      assert.equal(object(imported[0]!.parameters).accept_variable_cost, true);
      const recovered = await bridge.call(spec.name, input, undefined, 'full');
      assert.equal(object(recovered.result).task_id, result.task_id);
      const final = await records();
      assert.equal(final.filter((row) => row.kind === 'remote-submit').length, 3);
      assert(
        final.some(
          (row) => row.kind === 'cli-process' && (row.arguments as string[]).includes('--input-stdin'),
        ),
      );
    } finally {
      bridge.close();
      await client.close();
      await transport.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
