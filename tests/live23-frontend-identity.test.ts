/** 真实原动画任务保存单位矩阵；允许无效果元数据，同时拒绝近似/不完整/有编辑的变体。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { StudioClient } from '../studio/api/client.ts';
import { frontendExportSource } from '../studio/api/frontend-export-source.ts';

const session = {
  accountRef: 'live23-identity-account',
  cookie: 'not-a-real-cookie',
  deviceId: 'identity-device',
  importedAt: '2026-11-15T00:00:00.000Z',
};
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

async function read(metadata: Record<string, unknown>) {
  let calls = 0;
  const client = new StudioClient(new MemoryCredentials(session), async (_url, init) => {
    assert.equal(init.method, 'GET');
    calls++;
    return Response.json({
      code: 0,
      data: {
        id: 'identity-project',
        is_owner: true,
        model_url: 'https://cdn.tripo3d.ai/exact-source.glb',
        operator: { operator_id: 'identity-operator', status: 'success', metadata },
      },
    });
  });
  const source = await frontendExportSource(
    client,
    session.accountRef,
    'identity-project',
    'identity-operator',
  );
  assert.equal(calls, 1);
  return source;
}

test('frontend accepts an exact identity while preserving all original metadata for source binding', async () => {
  const metadata = {
    transform_matrix: identity,
    children_transform_matrix: {},
    children_deleted: [],
    children_rename: {},
    material_factor: { metallic: 0, roughness: 0.5 },
  };
  const result = await read(metadata);
  assert.deepEqual(result.metadata, metadata);
  assert.equal(result.url, 'https://cdn.tripo3d.ai/exact-source.glb');
});

test('frontend rejects malformed editor metadata while deferring valid geometry effects to exact-source verification', async () => {
  for (const transform of [
    identity.slice(0, 15),
    [...identity, 0],
    identity.map((value, index) => (index === 2 ? NaN : value)),
    identity.map((value, index) => (index === 6 ? Infinity : value)),
    identity.map(String),
  ])
    await assert.rejects(read({ transform_matrix: transform }), {
      code: 'FRONTEND_SOURCE_UNSUPPORTED',
      certainty: 'not_submitted',
    });
  for (const edited of [
    { children_transform_matrix: { mesh: identity.slice(0, 15) } },
    { children_deleted: [1] },
    { children_rename: { mesh: '' } },
    { children_rename: { mesh: 1 } },
    { material_factor: { metallic: -0.1, roughness: 0.5 } },
  ])
    await assert.rejects(read({ transform_matrix: identity, ...edited }), {
      code: 'FRONTEND_SOURCE_UNSUPPORTED',
      certainty: 'not_submitted',
    });
  for (const edited of [
    { transform_matrix: identity.map((value, index) => (index === 12 ? 0.000000001 : value)) },
    { transform_matrix: identity.map((value, index) => (index === 5 ? 0.999999999 : value)) },
    { children_transform_matrix: { mesh: identity } },
    { children_deleted: ['mesh'] },
    { children_rename: { mesh: 'renamed' } },
  ])
    assert.deepEqual((await read(edited)).metadata, edited);
});
