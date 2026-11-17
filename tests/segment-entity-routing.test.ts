/** 用真实 Operations/SQLite 验实体路由、旧请求兼容及组合降级；不接真实账号或远端。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Document } from '@gltf-transform/core';
import { modelIO } from '../cli/local/gltf.ts';
import { JobStore } from '../cli/storage/jobs.ts';
import { prepareSegmentEntitySource } from '../cli/artifacts/segment-entity-source.ts';
import { saveVerifiedOutputCache } from '../cli/artifacts/verified-output-cache.ts';
import { Operations } from '../studio/api/operations.ts';
import type { StudioClient } from '../studio/api/client.ts';
import { segmentResourceFingerprint } from '../studio/api/segment-entity-snapshot.ts';
import type { Quote } from '../studio/contracts/types.ts';
import {
  assertSegmentEntityJob,
  segmentEntityIntent,
  segmentEntityMarker,
  segmentEntityPolicyKey,
  segmentEntitySubmissionOptions,
  withSegmentEntityMarker,
  type SegmentEntityPolicy,
} from '../cli/core/segment-entity-policy.ts';

async function fixture(entities = 1) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'segment-entity-route-'));
  const file = path.join(directory, 'jobs.sqlite'),
    jobs = new JobStore(file);
  const doc = new Document(),
    scene = doc.createScene(),
    buffer = doc.createBuffer();
  const position = doc
    .createAccessor()
    .setBuffer(buffer)
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  for (let i = 0; i < entities; i++)
    scene.addChild(
      doc
        .createNode('part_' + i)
        .setMesh(doc.createMesh().addPrimitive(doc.createPrimitive().setAttribute('POSITION', position))),
    );
  const bytes = Buffer.from(await (await modelIO()).writeBinary(doc));
  const input = {
    project_id: 'project',
    model_version: 'v2.0-20260430',
    segmentation_granularity: 'simple',
    prompt: 'head and body',
  };
  const identity = { account_ref: 'account', project_id: 'project', operator_id: 'operator' };
  const proof = await prepareSegmentEntitySource(bytes, identity, {}),
    request = 'entity-route-test';
  const url = 'https://cdn.example/model.glb?part=original&X-Amz-Signature=first&X-Amz-Date=old';
  const policy: SegmentEntityPolicy = {
    version: 1,
    account_ref: identity.account_ref,
    request_id: request,
    intent: segmentEntityIntent(input),
    proof,
    resource_fingerprint: segmentResourceFingerprint(url),
    cache_data_dir: directory,
  };
  await saveVerifiedOutputCache(
    identity,
    { artifact_id: 'source', kind: 'model', format: 'glb', index: 0 },
    proof,
    bytes,
    directory,
  );
  jobs.bindRequestPolicy(
    identity.account_ref,
    segmentEntityPolicyKey(request),
    policy as unknown as Record<string, unknown>,
  );
  const quote: Quote = {
    known: true,
    hard_limit: false,
    source: 'fixture',
    credits: 0,
    observed_at: '2026-11-15T00:00:00Z',
    expires_at: '2026-11-16T00:00:00Z',
    explanation: 'fixture',
  };
  const job = jobs.prepare(
    identity.account_ref,
    request,
    'segment',
    withSegmentEntityMarker(input, policy),
    quote,
  );
  const detail = {
    id: identity.project_id,
    is_owner: true,
    model_url: url,
    operator: {
      operator_id: identity.operator_id,
      status: 'success',
      is_segmented: entities === 1,
      metadata: proof.metadata,
    },
  };
  const operations = new Operations(
    { request: async () => structuredClone(detail) } as unknown as StudioClient,
    [],
  );
  const mutate = (run: (db: DatabaseSync) => void) => {
    const db = new DatabaseSync(file);
    try {
      run(db);
    } finally {
      db.close();
    }
  };
  return {
    jobs,
    job,
    input,
    policy,
    detail,
    operations,
    request,
    quote,
    mutate,
    close: async () => {
      jobs.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

for (const entities of [1, 2])
  test(`verified ${entities} entities choose the webpage route even when the service flag disagrees`, async () => {
    const f = await fixture(entities);
    try {
      const options = segmentEntitySubmissionOptions(f.jobs, f.job);
      const built = await f.operations.build(f.job, options);
      assert.equal(built.route, '/v2/studio/operation/ai_segmentation' + (entities > 1 ? '/resegment' : ''));
      assert.equal(built.body.operator_id, entities > 1 ? 'operator' : undefined);
      assert.equal(built.body[segmentEntityMarker], undefined);
      assert.equal(f.detail.operator.is_segmented, entities === 1);
    } finally {
      await f.close();
    }
  });
test('old tasks without a marker retain the original route and acquire no new policy', async () => {
  const f = await fixture();
  try {
    const old = f.jobs.prepare('account', 'old-request', 'segment', f.input, f.quote);
    assert.equal(segmentEntitySubmissionOptions(f.jobs, old), undefined);
    assert.equal((await f.operations.build(old)).route, '/v2/studio/operation/ai_segmentation/resegment');
    assert.equal(f.jobs.requestPolicy('account', segmentEntityPolicyKey('old-request')), undefined);
  } finally {
    await f.close();
  }
});
for (const change of ['policy', 'marker', 'both', 'request', 'count'])
  test(`a damaged ${change} cannot downgrade an existing entity route`, async () => {
    const f = await fixture();
    try {
      f.mutate((db) => {
        if (['policy', 'both'].includes(change))
          db.prepare('DELETE FROM request_policies WHERE request_id=?').run(
            segmentEntityPolicyKey(f.request),
          );
        if (['marker', 'both'].includes(change))
          db.prepare('UPDATE jobs SET input=? WHERE job_id=?').run(JSON.stringify(f.input), f.job.job_id);
        if (change === 'request')
          db.prepare('UPDATE jobs SET request_id=? WHERE job_id=?').run('renamed-request', f.job.job_id);
        if (change === 'count') {
          const altered = structuredClone(f.policy);
          altered.proof.inspection.entity_count = 2;
          db.prepare('UPDATE request_policies SET policy=? WHERE request_id=?').run(
            JSON.stringify(altered),
            segmentEntityPolicyKey(f.request),
          );
        }
      });
      assert.throws(
        () => assertSegmentEntityJob(f.jobs, f.jobs.get(f.job.job_id)),
        (error) =>
          ['SEGMENT_ENTITY_POLICY_CHANGED', 'SEGMENT_ENTITY_SOURCE_CHANGED'].includes(
            (error as { code: string }).code,
          ),
      );
      assert.equal(f.jobs.list('account', 20).length, 1);
    } finally {
      await f.close();
    }
  });
test('complete metadata, resource business query and current operator are checked before route construction', async () => {
  for (const variant of ['head', 'metadata', 'resource']) {
    const f = await fixture();
    try {
      const options = segmentEntitySubmissionOptions(f.jobs, f.job);
      if (variant === 'head') f.detail.operator.operator_id = 'another';
      if (variant === 'metadata')
        Object.assign(f.detail.operator.metadata, {
          transform_matrix: [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        });
      if (variant === 'resource')
        f.detail.model_url = f.detail.model_url.replace('part=original', 'part=another');
      await assert.rejects(f.operations.build(f.job, options), { code: 'PROJECT_CHANGED' });
    } finally {
      await f.close();
    }
  }
});
test('temporary signed URL renewal preserves the same native resource', async () => {
  const f = await fixture();
  try {
    const options = segmentEntitySubmissionOptions(f.jobs, f.job);
    f.detail.model_url = f.detail.model_url
      .replace('Signature=first', 'Signature=second')
      .replace('Date=old', 'Date=new');
    assert.equal((await f.operations.build(f.job, options)).route, '/v2/studio/operation/ai_segmentation');
  } finally {
    await f.close();
  }
});
