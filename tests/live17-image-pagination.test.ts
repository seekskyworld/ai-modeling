/** 图片库页码与任意 CLI offset 映射，验证页边界和账号切换不混入同一结果。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StudioClient } from '../studio/api/client.ts';
import { StudioGateway } from '../studio/api/gateway.ts';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { MemoryLinks } from '../studio/auth/artifact-links.ts';

const original = {
  cookie: 'controlled-cookie',
  deviceId: 'controlled-device',
  accountRef: 'controlled-account',
  importedAt: '2026-11-14T00:00:00Z',
};
const assets = Array.from({ length: 45 }, (_, index) => ({
  asset_id: `controlled-${index}`,
  status: 'success',
  type: 'image',
  create_time: index,
  private_field: 'not returned',
}));

test('arbitrary image offsets return the requested slice across one or two webpage pages', async () => {
  for (const [offset, limit, next] of [
    [0, 20, 20],
    [1, 20, 21],
    [19, 20, 39],
    [20, 20, 40],
    [25, 20, null],
    [30, 20, null],
    [40, 20, null],
    [45, 20, null],
    [46, 20, null],
    [9, 7, 16],
    [0, 100, null],
  ] as const) {
    const pages: number[] = [];
    const client = new StudioClient(new MemoryCredentials(original), async (url, init) => {
      assert.equal(new URL(url).pathname, '/v2/studio/image/image_assets');
      const body = JSON.parse(String(init.body));
      assert.equal(body.page_size, limit);
      pages.push(body.page_num);
      const start = (body.page_num - 1) * body.page_size;
      return Response.json({ code: 0, data: { assets: assets.slice(start, start + body.page_size) } });
    });
    const result = await new StudioGateway(client, [], new MemoryLinks()).assets('image', offset, limit);
    assert.deepEqual(
      (result.assets as typeof assets).map((a) => a.asset_id),
      assets.slice(offset, offset + limit).map((a) => a.asset_id),
    );
    assert.equal(result.next_offset, next);
    assert.ok(pages.length >= 1 && pages.length <= 2);
    assert.equal(pages[0], Math.floor(offset / limit) + 1);
    assert.equal(JSON.stringify(result).includes('private_field'), false);
  }
});

test('image pagination never combines pages after an account change during a response', async () => {
  const store = new MemoryCredentials(original);
  let requests = 0;
  const client = new StudioClient(store, async () => {
    requests++;
    store.save({ ...original, accountRef: 'other-account' });
    return Response.json({ code: 0, data: { assets: assets.slice(0, 20) } });
  });
  await assert.rejects(new StudioGateway(client, [], new MemoryLinks()).assets('image', 1, 20), {
    code: 'ACCOUNT_MISMATCH',
  });
  assert.equal(requests, 1);
});

test('second-page failures remain failures instead of returning a shortened misleading page', async () => {
  let requests = 0;
  const client = new StudioClient(new MemoryCredentials(original), async () => {
    requests++;
    if (requests === 2) throw new Error('Controlled second-page failure');
    return Response.json({ code: 0, data: { assets: assets.slice(0, 20) } });
  });
  await assert.rejects(new StudioGateway(client, [], new MemoryLinks()).assets('image', 1, 20), {
    code: 'NETWORK_ERROR',
  });
  assert.equal(requests, 2);
});
