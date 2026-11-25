import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { callTool, toolRegistry } from '../cli/commands.ts';
import { fixture, quote, tinyGlb } from './helpers.ts';

test('native import tools preserve absent budgets and require explicit unquoted consent', async () => {
  const f = await fixture();
  try {
    const model = path.join(f.dir, 'input.glb');
    await writeFile(model, tinyGlb());
    f.service.pricing.quote = async () => ({
      ...quote,
      known: false,
      variable: true,
      credits: undefined,
      source: 'Synthetic current reviewed unquoted operation',
    });
    const definitions = toolRegistry(f.service, {
      assets: async () => ({}),
      client: { request: async () => ({}) },
    });
    const parameters = { model_path: model, name: 'Import test', accept_variable_cost: true };
    const absentConsent = await callTool(definitions, 'ai_modeling_import_model', {
      request_id: 'no-consent',
      parameters: { model_path: model, name: 'Import test' },
    });
    assert.equal(absentConsent.isError, true);
    assert.equal((absentConsent.structuredContent.error as { code: string }).code, 'PRICE_UNKNOWN');
    for (const maximum of [0, 10]) {
      const capped = await callTool(definitions, 'ai_modeling_import_model', {
        request_id: `capped-${maximum}`,
        parameters,
        max_estimated_credits: maximum,
      });
      assert.equal(capped.isError, true);
      assert.equal((capped.structuredContent.error as { code: string }).code, 'UNQUOTED_BUDGET_UNSUPPORTED');
    }
    assert.equal(f.gateway.posts, 0);
    const accepted = await callTool(definitions, 'ai_modeling_import_model', {
      request_id: 'unquoted-import',
      parameters,
    });
    assert.notEqual(accepted.isError, true);
    assert.equal(f.gateway.posts, 1);

    f.service.pricing.quote = async () => quote;
    const missingFixedBudget = await callTool(definitions, 'ai_modeling_import_model', {
      request_id: 'fixed-missing-budget',
      parameters,
    });
    assert.equal(missingFixedBudget.isError, true);
    assert.equal((missingFixedBudget.structuredContent.error as { code: string }).code, 'INVALID_INPUT');
    assert.equal(f.gateway.posts, 1);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
