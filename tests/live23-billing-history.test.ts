/** 第二页真实账单、翻页期间变动及不完整数据不能被误报成完整金额。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { MemoryLinks } from '../studio/auth/artifact-links.ts';
import { StudioClient } from '../studio/api/client.ts';
import { StudioGateway } from '../studio/api/gateway.ts';
import { transactionHistory } from '../studio/api/transaction-history.ts';
import type { Job } from '../studio/contracts/types.ts';
import { quote } from './helpers.ts';

const session = {
  accountRef: 'bill-account',
  cookie: 'fake-cookie',
  deviceId: 'bill-device',
  importedAt: '2026-11-15T00:00:00Z',
};
const charge = (id: string, amount = 5) => ({
  operator_id: id,
  amount,
  txn_type: 'charge',
  direction: 'sub',
  status: 'fulfilled',
});
function clientFor(read: (page: number, count: number) => unknown) {
  const calls: number[] = [];
  const client = new StudioClient(new MemoryCredentials(session), async (url, init) => {
    assert.equal(init.method, 'GET');
    const page = Number(new URL(url).searchParams.get('page_num'));
    calls.push(page);
    return Response.json({ code: 0, data: read(page, calls.length) });
  });
  return { client, calls };
}
const first = Array.from({ length: 100 }, (_, i) => charge(`unrelated-${i}`));

test('cost finds original exact task charges beyond page one and ignores refunds and pending entries', async () => {
  const second = [
    charge('target', 12),
    { ...charge('target', 90), status: 'pending' },
    { ...charge('target', 8), direction: 'add' },
    charge('target', 3),
  ];
  const { client, calls } = clientFor((page) => ({
    records: page === 1 ? first : second,
    have_more: page === 1,
    total: 104,
  }));
  const job: Job = {
    job_id: 'job',
    account_ref: session.accountRef,
    request_id: 'request',
    input_hash: 'hash',
    operation: 'image',
    input: {},
    contract_version: 'test',
    state: 'succeeded',
    remote_ids: { asset_id: 'target' },
    quote,
    progress: 100,
    artifacts: [],
    created_at: '2026-11-12T00:00:00Z',
    updated_at: '2026-11-12T00:00:00Z',
    lease_until: 0,
  };
  const result = await new StudioGateway(client, [], new MemoryLinks()).cost(job);
  assert.equal(result?.credits, 15);
  assert.equal(result?.status, 'fulfilled');
  assert.deepEqual(calls, [1, 2, 1]);
});

test('a new transaction shifting offset pages prevents a false complete cost', async () => {
  const { client } = clientFor((page, count) => ({
    records: page === 2 ? [charge('target')] : count === 3 ? [charge('new'), ...first.slice(0, 99)] : first,
    have_more: page === 1,
    total: 101,
  }));
  await assert.rejects(transactionHistory(client), { code: 'BILLING_HISTORY_CHANGED' });
});

test('incomplete, repeated or malformed transaction pages never produce a total', async () => {
  for (const [read, code] of [
    [
      (page: number) => ({ records: page === 1 ? first : [], have_more: page === 1, total: 101 }),
      'BILLING_HISTORY_INCOMPLETE',
    ],
    [() => ({ records: first, have_more: true, total: 200 }), 'BILLING_HISTORY_CHANGED'],
    [() => ({ records: [], have_more: 'yes', total: 0 }), 'CONTRACT_CHANGED'],
  ] as const)
    await assert.rejects(transactionHistory(clientFor(read).client), { code });
});

test('an absent charge remains unknown and does not become zero', async () => {
  const { client, calls } = clientFor(() => ({ records: [], have_more: false, total: 0 }));
  assert.deepEqual(await transactionHistory(client), []);
  assert.deepEqual(calls, [1]);
});
