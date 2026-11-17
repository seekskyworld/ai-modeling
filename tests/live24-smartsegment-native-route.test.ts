import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { modelIO } from '../cli/local/gltf.ts';
import { scaleFixture, scaleMatrix, scaleModel } from './helpers-smartsegment-scale.ts';
import { executePlan } from '../cli/compat/runtime.ts';
import { smartSegmentIdentity } from '../cli/compat/smartsegment-scale-plan.ts';
import { scaleIntentKey, scaleRouteKey, scaleSourceKey } from '../cli/core/smartsegment-scale-policy.ts';
import { fingerprint } from '../cli/core/fingerprint.ts';
import { Operations } from '../studio/api/operations.ts';
import type { StudioClient } from '../studio/api/client.ts';
import type { Gateway } from '../studio/api/gateway.ts';
import type { SubmissionOptions } from '../studio/api/segment-route.ts';
import { object, TripoError } from '../studio/contracts/errors.ts';

async function twoRootModel(matrix = smartSegmentIdentity, dropAppearance = false): Promise<Buffer> {
  const io = await modelIO(),
    d = await io.readBinary(await scaleModel(matrix)),
    r = d.getRoot(),
    node = r.listNodes()[0]!,
    mesh = node.getMesh()!,
    primitive = mesh.listPrimitives()[0]!,
    scene = r.listScenes()[0]!,
    originalIndices = primitive.getIndices()!.getArray()!;
  for (let i = 0; i < 2; i++) {
    const part = primitive.clone().setIndices(
      d
        .createAccessor()
        .setType('SCALAR')
        .setBuffer(r.listBuffers()[0]!)
        .setArray(new Uint16Array(originalIndices.slice(i * 6, i * 6 + 6))),
    );
    if (dropAppearance) part.setAttribute('TEXCOORD_0', null).setMaterial(null);
    scene.addChild(d.createNode(`part-${i}`).setMesh(d.createMesh().addPrimitive(part)));
  }
  scene.removeChild(node);
  node.dispose();
  mesh.dispose();
  primitive.dispose();
  return Buffer.from(await io.writeBinary(d));
}
async function multiFixture(reference = true, wrongOutput = false) {
  return await scaleFixture({
    reference,
    sourceBytes: await twoRootModel(),
    outputBytes: await twoRootModel(wrongOutput ? smartSegmentIdentity : scaleMatrix, true),
  });
}

for (const independent of [false, true])
  test(`${independent ? 'independent roots' : 'one actual entity with sticky segmented flag'} freeze ordinary route and all names without a reentry POST`, async () => {
    const f = independent ? await multiFixture() : await scaleFixture({ reference: true });
    try {
      const gateway: Gateway = f.gateway,
        submit = gateway.submit.bind(gateway),
        routes: string[] = [],
        optionsSeen: (SubmissionOptions | undefined)[] = [];
      gateway.submit = async (job, before, options) => {
        before?.();
        optionsSeen.push(options);
        if (job.operation === 'segment') {
          const client = {
            request: async (method: string, route: string) => {
              const detail = await f.client.request(method, route);
              return { ...detail, operator: { ...detail.operator, is_segmented: true } };
            },
          } as unknown as StudioClient;
          const built = await new Operations(client, []).build(job, options);
          routes.push(built.route);
          assert.equal(built.body.operator_id, undefined);
          assert.deepEqual(built.body, {
            project_id: job.input.project_id,
            model_version: 'v2.0-20260430',
            segmentation_granularity: 'simple',
            prompt: 'head',
          });
        }
        before?.();
        return await submit(job);
      };
      const result = await executePlan(f.app, f.plan(), f.flags);
      assert.equal(result.status, 'success');
      assert.equal(object(result.smartsegment_transform_validation).status, 'verified');
      assert.deepEqual(routes, ['/v2/studio/operation/ai_segmentation']);
      assert.equal(optionsSeen[0], undefined);
      assert.equal(optionsSeen[1], undefined);
      assert.equal(optionsSeen[2]?.segmentRoute?.strategy, 'ordinary');
      const source = f.jobs.requestPolicy('test-account', scaleSourceKey('metadata-scale'))!;
      assert.equal(source.version, 2);
      assert.equal(object(source.inspection).version, independent ? 2 : 1);
      assert.equal(source.segmentation_strategy, 'ordinary');
      assert.deepEqual(
        f.submissions[1]!.input.children_transform_matrix,
        independent ? { 'part-0': scaleMatrix, 'part-1': scaleMatrix } : { 'editable-mesh': scaleMatrix },
      );
      const saved = f.jobs.requestPolicy('test-account', scaleRouteKey('metadata-scale'))!;
      assert.equal(saved.strategy, 'ordinary');
      assert.equal(saved.expected_operator_id, 'edit-one');
      f.setCurrent('different-head-after-success');
      assert.equal((await executePlan(f.app, f.plan(), f.flags)).task_id, result.task_id);
      assert.equal(f.gateway.posts, 3);
    } finally {
      await f.close();
    }
  });

test('old single-root source retains no native route policy or submission override', async () => {
  const f = await scaleFixture({ reference: true });
  try {
    // 真正旧完整意图没有路由义务；恢复从此已存在意图准备，不篡改新版源伪装成旧数据。
    const plan = f.plan();
    f.jobs.bindRequestPolicy('test-account', scaleIntentKey('metadata-scale'), {
      version: 1,
      matrix: plan.smartSegmentScale!.matrix,
      first_operation: 'copy',
      layout: fingerprint(
        plan.steps.map(({ operation, parameters, source }) => ({ operation, parameters, source })),
      ),
    });
    const gateway: Gateway = f.gateway,
      submit = gateway.submit.bind(gateway);
    gateway.submit = async (job, before, options) => {
      assert.equal(options, undefined);
      before?.();
      return await submit(job);
    };
    assert.equal((await executePlan(f.app, f.plan(), f.flags)).status, 'success');
    assert.equal(f.jobs.requestPolicy('test-account', scaleRouteKey('metadata-scale')), undefined);
  } finally {
    await f.close();
  }
});

test('new single-entity strategy cannot disappear or change inspection type before the first copy', async () => {
  for (const change of ['missing-strategy', 'coerced-inspection', 'file-kind', 'legacy-downgrade']) {
    const f = await scaleFixture({ reference: true });
    try {
      const account = f.gateway.account.bind(f.gateway);
      f.gateway.account = async () => {
        const key = scaleSourceKey('metadata-scale'),
          source = f.jobs.requestPolicy('test-account', key)!;
        assert.equal(source.version, 2);
        if (change === 'missing-strategy') delete source.segmentation_strategy;
        if (change === 'legacy-downgrade') {
          source.version = 1;
          delete source.segmentation_strategy;
        }
        if (change === 'coerced-inspection') object(source.inspection).version = '1';
        if (change === 'file-kind') source.kind = 'file';
        const db = new DatabaseSync(path.join(f.dir, 'jobs.sqlite'));
        try {
          db.prepare('UPDATE request_policies SET policy=? WHERE account_ref=? AND request_id=?').run(
            JSON.stringify(source),
            'test-account',
            key,
          );
        } finally {
          db.close();
        }
        return await account();
      };
      await assert.rejects(executePlan(f.app, f.plan(), f.flags), { code: 'SMARTSEGMENT_SCALE_UNVERIFIED' });
      assert.equal(f.gateway.posts, 0);
      assert.equal(f.jobs.find('test-account', 'metadata-scale-0'), undefined);
    } finally {
      await f.close();
    }
  }
});

test('independent-root file input remains rejected before any native submission', async () => {
  const f = await multiFixture(false);
  try {
    await assert.rejects(executePlan(f.app, f.plan(), f.flags), {
      code: 'SMARTSEGMENT_TRANSFORM_UNVERIFIED',
    });
    assert.equal(f.gateway.posts, 0);
  } finally {
    await f.close();
  }
});

test('ordinary-route success without requested world transform stays unverified and never resubmits', async () => {
  const f = await multiFixture(true, true);
  try {
    const result = await executePlan(f.app, f.plan(), f.flags);
    assert.equal(result.status, 'needs_attention');
    assert.equal(result.remote_state, 'succeeded');
    assert.equal((await executePlan(f.app, f.plan(), f.flags)).task_id, result.task_id);
    assert.equal(f.gateway.posts, 3);
  } finally {
    await f.close();
  }
});

test('ordinary route rejects exact-head metadata drift while preserving is_segmented=true', async () => {
  const job = {
    operation: 'segment',
    input: { project_id: 'p', expected_operator_id: 'h', model_version: 'v2.0-20260430' },
  } as unknown as Parameters<Operations['build']>[0];
  const expected = {
      children_deleted: [],
      children_rename: {},
      children_transform_matrix: {},
      material_factor: {},
    },
    detail = {
      id: 'p',
      is_owner: true,
      operator: { operator_id: 'h', status: 'success', is_segmented: true, metadata: expected },
    },
    client = { request: async () => detail } as unknown as StudioClient,
    operations = new Operations(client, []),
    options: SubmissionOptions = {
      segmentRoute: {
        strategy: 'ordinary',
        project_id: 'p',
        expected_operator_id: 'h',
        metadata: structuredClone(expected),
      },
    };
  assert.equal((await operations.build(job)).route, '/v2/studio/operation/ai_segmentation/resegment');
  assert.equal((await operations.build(job, options)).route, '/v2/studio/operation/ai_segmentation');
  detail.operator.metadata.children_rename = { part: 'changed' } as never;
  await assert.rejects(
    operations.build(job, options),
    (error: unknown) => error instanceof TripoError && error.code === 'PROJECT_CHANGED',
  );
});
