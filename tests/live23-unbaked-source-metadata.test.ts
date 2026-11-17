/** 网页默认空矩阵不是几何修改；实际矩阵必须完整且有限，提交前拒绝不可恢复为自动重提。 */
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { StudioGateway, type Gateway } from '../studio/api/gateway.ts';
import type { StudioClient } from '../studio/api/client.ts';
import { MemoryLinks } from '../studio/auth/artifact-links.ts';
import type { Job } from '../studio/contracts/types.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import { unbakedSourceKey } from '../cli/core/unbaked-material-policy.ts';
import { fixture } from './helpers.ts';

const identity = Array.from({ length: 16 }, (_, i) => (i % 5 === 0 ? 1 : 0));
const sourceUrl = 'https://cdn.tripo3d.ai/source.glb';
const input = normalize('export', {
  project_id: 'project',
  expected_operator_id: 'source',
  bake: false,
  pivot_to_center_bottom: true,
});
function source(metadata: Record<string, unknown>) {
  let gets = 0;
  const client = {
    forAccount: (account: string) => {
      assert.equal(account, 'test-account');
      return {
        request: async (method: string, route: string) => {
          assert.equal(method, 'GET');
          assert.equal(route, '/v2/studio/project/detail/v3/project?operator_id=source');
          gets++;
          return {
            id: 'project',
            is_owner: true,
            model_url: sourceUrl,
            operator: { operator_id: 'source', status: 'success', is_pbr: true, metadata },
          };
        },
      };
    },
  } as unknown as StudioClient;
  const gateway = new StudioGateway(client, [], new MemoryLinks());
  const job = { account_ref: 'test-account', operation: 'export', input } as Job;
  return { gateway, job, gets: () => gets };
}

test('the observed top-level empty default and complete identity preserve the exact source and factors', async () => {
  for (const transform of [undefined, [], identity]) {
    const metadata = {
      transform_matrix: transform,
      children_transform_matrix: {},
      children_deleted: [],
      children_rename: {},
      material_factor: { metallic: 0, roughness: 0.5 },
    };
    const f = source(metadata);
    assert.deepEqual(await f.gateway.materialSource(f.job), {
      url: sourceUrl,
      material_factors: metadata.material_factor,
    });
    assert.equal(f.gets(), 1);
  }
  const f = source({ transform_matrix: [], children_transform_matrix: { part: identity } });
  assert.equal((await f.gateway.materialSource(f.job)).url, sourceUrl);
});

test('nonempty source transforms stay complete, finite and identity within the existing tolerance', async () => {
  const malformed = [
    null,
    {},
    '[]',
    [1],
    identity.slice(0, 15),
    [...identity, 0],
    identity.map((value, i) => (i === 0 ? 2 : value)),
    identity.map((value, i) => (i === 12 ? 0.001 : value)),
    identity.map((value, i) => (i === 3 ? NaN : value)),
    identity.map((value, i) => (i === 3 ? Infinity : value)),
    identity.map((value, i) => (i === 3 ? '0' : value)),
    new Array(16),
  ];
  for (const transform of malformed) {
    const f = source({ transform_matrix: transform });
    await assert.rejects(f.gateway.materialSource(f.job), {
      code: 'UNBAKED_MATERIAL_UNSUPPORTED',
      certainty: 'not_submitted',
    });
  }
});

test('a valid empty source default cannot hide part transforms or deleted geometry', async () => {
  for (const metadata of [
    ...[[], undefined, null, identity.map((value, i) => (i === 0 ? 2 : value))].map((part) => ({
      children_transform_matrix: { part },
    })),
    { children_deleted: ['part'] },
  ]) {
    const f = source({ transform_matrix: [], ...metadata });
    await assert.rejects(f.gateway.materialSource(f.job), {
      code: 'UNBAKED_MATERIAL_UNSUPPORTED',
      certainty: 'not_submitted',
    });
  }
});

test('source preflight failure records no receipt or proof and the same request stays terminal', async () => {
  const f = await fixture();
  try {
    const read = source({ transform_matrix: [2] });
    (f.gateway as Gateway).materialSource = read.gateway.materialSource.bind(read.gateway);
    const result = await f.service.submit('export', 'preflight-failed', input, 10);
    const job = f.jobs.find('test-account', 'preflight-failed')!;
    assert.equal(result.state, 'failed');
    assert.equal(job.state, 'failed');
    assert.equal(job.error?.code, 'UNBAKED_MATERIAL_UNSUPPORTED');
    assert.equal(job.error?.certainty, 'not_submitted');
    assert.deepEqual(job.remote_ids, {});
    assert.deepEqual(job.artifacts, []);
    assert.equal(f.jobs.requestPolicy(job.account_ref, unbakedSourceKey(job)), undefined);
    assert.equal(f.gateway.posts, 0);
    const again = await f.service.submit('export', 'preflight-failed', input, 10);
    assert.equal(again.job_id, job.job_id);
    assert.equal(again.state, 'failed');
    assert.equal(f.gateway.posts, 0);
    assert.equal(read.gets(), 1);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
