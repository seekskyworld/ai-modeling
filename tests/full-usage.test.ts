/** Public full usage results are validated against their published output schema, using synthetic ledgers. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { z } from 'zod';
import { callTool, toolMetadata } from '../cli/commands.ts';
import { fullTools } from '../cli/compat/full-tools.ts';
import { fullContract } from '../cli/compat/full-contract.ts';
import { StudioClient } from '../studio/api/client.ts';
import { object, TripoError } from '../studio/contracts/errors.ts';
import { fixture, quote } from './helpers.ts';

const schema = z.fromJSONSchema(
  fullContract.find((tool) => tool.name === 'ai_modeling_usage')!.outputSchema!,
);
const charge = (id: string, amount: unknown = 1) => ({
  operator_id: id,
  amount,
  txn_type: 'charge',
  direction: 'sub',
  status: 'fulfilled',
});
async function setup(rows: Record<string, unknown>[] = []) {
  const f = await fixture();
  const pages: number[] = [];
  const client = new StudioClient(f.service.credentials, async (url) => {
    const page = Number(new URL(url).searchParams.get('page_num'));
    pages.push(page);
    return Response.json({
      code: 0,
      data: {
        records: rows.slice((page - 1) * 100, page * 100),
        total: rows.length,
        have_more: page * 100 < rows.length,
      },
    });
  });
  const tools = fullTools(f.service, { assets: async () => ({ assets: [] }), client });
  return {
    ...f,
    pages,
    async call(input: Record<string, unknown>) {
      const result = await callTool(tools, 'ai_modeling_usage', input);
      assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
      schema.parse(result.structuredContent.result);
      return object(result.structuredContent.result);
    },
    async close() {
      f.jobs.close();
      await rm(f.dir, { recursive: true, force: true });
    },
  };
}
test('usage preserves successful entries, missing IDs, errors and unknown costs without double counting', async () => {
  const f = await setup();
  try {
    const known = f.jobs.prepare('test-account', 'known', 'model', {}, quote);
    const unknown = f.jobs.prepare('test-account', 'unknown', 'model', {}, quote);
    const failed = f.jobs.prepare('test-account', 'failed-read', 'model', {}, quote);
    f.service.get = async (id) => {
      if (id === failed.job_id) throw new TripoError('RATE_LIMITED', 'Try the read later.');
      return {
        ...f.jobs.get(id),
        ...(id === known.job_id ? { observed_cost: { status: 'fulfilled', credits: 0 } } : {}),
      };
    };
    const result = await f.call({
      task_ids: [known.job_id, known.job_id, unknown.job_id, failed.job_id, 'missing'],
    });
    assert.equal(result.total_entries, 4);
    assert.equal(result.returned_entries, 2);
    assert.equal(result.total_credits, null);
    assert.equal(result.complete, false);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.missed, ['missing']);
    assert.deepEqual(result.unknown, [unknown.job_id]);
    assert.equal(object((result.errors as unknown[])[0]).task_id, failed.job_id);
    assert.equal((await f.call({ task_ids: [known.job_id, known.job_id] })).total_credits, 0);
    assert.equal(f.pages.length, 0);
  } finally {
    await f.close();
  }
});
test('ledger usage reads all verified pages, honors limits above 100 and reports truncation', async () => {
  const rows = Array.from({ length: 325 }, (_, index) => charge(`operator-${index}`));
  rows.push({ ...charge('refund', 50), direction: 'add' });
  const f = await setup(rows);
  try {
    const all = await f.call({ limit: 500 });
    assert.equal(all.total_entries, 325);
    assert.equal(all.returned_entries, 325);
    assert.equal(all.total_credits, 325);
    assert.equal(all.complete, true);
    assert.equal(all.task_id_namespace, 'studio_operator');
    assert.deepEqual(f.pages, [1, 2, 3, 4, 1]);
    const limited = await f.call({ limit: 101 });
    assert.equal(limited.returned_entries, 101);
    assert.equal(limited.total_credits, 101);
    assert.equal(limited.truncated, true);
    assert.equal(limited.complete, false);
    assert.ok(toolMetadata('full').find((tool) => tool.name === 'ai_modeling_usage')?.outputSchema);
  } finally {
    await f.close();
  }
});
test('pending or malformed charge amounts remain unknown and grouped fulfilled charges are summed', async () => {
  const f = await setup([
    charge('same', 2),
    charge('same', 3),
    charge('invalid', '5'),
    { ...charge('pending'), status: 'pending' },
  ]);
  try {
    const result = await f.call({});
    assert.equal(result.total_entries, 3);
    assert.equal(result.total_credits, null);
    assert.equal(object((result.usage as unknown[])[0]).credits_consumed, 5);
    assert.deepEqual(result.unknown, ['invalid', 'pending']);
  } finally {
    await f.close();
  }
});
