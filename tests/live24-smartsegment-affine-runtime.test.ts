import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { executePlan, downloadTask } from '../cli/compat/runtime.ts';
import { object, TripoError } from '../studio/contracts/errors.ts';
import { affineOutputKey, affineChildRequest } from '../cli/core/smartsegment-affine-policy.ts';
import { smartSegmentIdentity } from '../cli/compat/smartsegment-scale-plan.ts';
import { affineFixture, affineMatrix, affineRequest } from './helpers-smartsegment-affine.ts';

for (const [family, index, file] of [
  ['xz', 8, false],
  ['xz', 8, true],
  ['yx', 1, false],
  ['yz', 9, false],
  ['zx', 2, false],
  ['zy', 6, false],
] as const)
  test(`native ${family.toUpperCase()} shear ${file ? 'file' : 'task'} keeps its axis through seven steps and original-request recovery`, async () => {
    const matrix = smartSegmentIdentity.map((v, i) => (i === index ? (index % 2 ? -0.2 : 0.2) : v)),
      f = await affineFixture({ matrix, file });
    try {
      const first = await executePlan(f.app, f.plan(), f.flags);
      assert.equal(first.status, 'success', JSON.stringify(first));
      assert.equal(f.gateway.posts, 7);
      assert.equal(object(f.sourcePolicy().preparation).family, family);
      assert.equal(object(f.sourcePolicy().preparation).kind, 'axis_shear_two_native_trs');
      assert.deepEqual(object(first.smartsegment_affine_validation).transform_matrix, matrix);
      assert.equal(object(first.smartsegment_affine_validation).matched_oriented_faces, 4);
      f.service.config.outputDir = '';
      const reentry = await executePlan(f.app, f.plan(), {
        ...f.flags,
        download: true,
        out: path.join(f.dir, 'new-axis-delivery-directory'),
      });
      assert.equal(reentry.status, 'success', JSON.stringify(reentry));
      assert.equal(reentry.task_id, first.task_id);
      assert.equal(reentry.download_error, undefined);
      await assert.rejects(executePlan(f.app, f.plan(affineMatrix), f.flags), {
        code: 'IDEMPOTENCY_CONFLICT',
      });
      assert.equal(f.gateway.posts, 7);
    } finally {
      await f.close();
    }
  });

test('native affine preserves the actual Studio empty root matrix through all seven steps', async () => {
  const f = await affineFixture({ rootTransform: [] });
  try {
    const result = await executePlan(f.app, f.plan(), f.flags);
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(f.gateway.posts, 7);
    for (const policy of [f.sourcePolicy(), f.stagePolicy('first'), f.stagePolicy('merge')])
      assert.deepEqual(object(policy.complete_metadata).transform_matrix, []);
    assert.equal(object(result.smartsegment_affine_validation).status, 'verified');
  } finally {
    await f.close();
  }
});

test('native affine still rejects an unapplied nonidentity root matrix before any native submission', async () => {
  const f = await affineFixture({ rootTransform: affineMatrix });
  try {
    await assert.rejects(executePlan(f.app, f.plan(), f.flags), {
      code: 'SMARTSEGMENT_AFFINE_UNVERIFIED',
    });
    assert.equal(f.gateway.posts, 0);
    assert.equal(f.chain().length, 0);
  } finally {
    await f.close();
  }
});

for (const file of [false, true])
  test(`native affine seven-step ${file ? 'file' : 'task'} verifies original A(P), direct get/list and original-request recovery`, async () => {
    const f = await affineFixture({ file });
    try {
      const result = await executePlan(f.app, f.plan(), f.flags);
      assert.equal(result.status, 'success', JSON.stringify(result));
      assert.equal(f.gateway.posts, 7);
      assert.equal((result.chain as unknown[]).length, 7);
      assert.deepEqual(
        f.chain().map((j) => j.operation),
        [
          file ? 'import_model' : 'copy',
          'project_edit',
          'segment',
          'modification',
          'copy',
          'project_edit',
          'segment',
        ],
      );
      assert.equal(object(result.smartsegment_affine_validation).status, 'verified');
      assert.equal(object(result.smartsegment_affine_validation).matched_oriented_faces, 4);
      assert.deepEqual(object(result.smartsegment_affine_validation).transform_matrix, affineMatrix);
      assert.equal(
        object((await f.service.get(f.final().job_id)).smartsegment_affine_validation).status,
        'verified',
      );
      assert.equal(f.service.summary(f.final()).state, 'succeeded');
      await f.service.download(f.final().job_id, 'model', 'first.glb');
      await f.service.download(f.final().job_id, 'semantic-mask', 'first.png');
      for (const artifact of f.artifacts) await rm(artifact.local_path!);
      await rm(f.input);
      await rm(f.native);
      f.service.config.outputDir = '';
      const resumed = await executePlan(f.app, f.plan(), {
        ...f.flags,
        download: true,
        out: path.join(f.dir, 'arbitrary-other-directory'),
      });
      assert.equal(resumed.status, 'success', JSON.stringify(resumed));
      assert.equal(resumed.task_id, result.task_id);
      assert.equal(resumed.download_error, undefined);
      assert.equal(f.gateway.posts, 7);
      await assert.rejects(executePlan(f.app, f.plan(affineMatrix, 'changed'), f.flags), {
        code: 'IDEMPOTENCY_CONFLICT',
      });
      await assert.rejects(executePlan(f.app, f.plan(smartSegmentIdentity), f.flags), {
        code: 'IDEMPOTENCY_CONFLICT',
      });
      assert.equal(f.gateway.posts, 7);
    } finally {
      await f.close();
    }
  });

test('affine failed and unknown native stages stay on their original request without replaying paid steps', async () => {
  for (const option of [{ failedIndex: 2 }, { unknownIndex: 3 }]) {
    const f = await affineFixture(option);
    try {
      const first = await executePlan(f.app, f.plan(), f.flags),
        posts = f.gateway.posts;
      assert.equal(first.status, option.failedIndex !== undefined ? 'failed' : 'outcome_unknown');
      const again = await executePlan(f.app, f.plan(), f.flags);
      assert.equal(again.task_id, first.task_id);
      assert.equal(f.gateway.posts, posts);
      assert.equal(f.final(), undefined);
    } finally {
      await f.close();
    }
  }
});

test('native first-stage metadata name collision stops before any merge', async () => {
  const f = await affineFixture({ mergeNameCollision: true });
  try {
    const result = await executePlan(f.app, f.plan(), f.flags);
    assert.equal(result.status, 'needs_attention');
    assert.equal(f.gateway.posts, 3);
    assert.equal(f.jobs.find('test-account', affineChildRequest(affineRequest, 3)), undefined);
    await executePlan(f.app, f.plan(), f.flags);
    assert.equal(f.gateway.posts, 3);
  } finally {
    await f.close();
  }
});

test('native final geometry mismatch stays remote succeeded and blocks model and PNG delivery', async () => {
  const f = await affineFixture({ wrongFinal: true });
  try {
    const result = await executePlan(f.app, f.plan(), f.flags);
    assert.equal(result.status, 'needs_attention');
    assert.equal(f.gateway.posts, 7);
    assert.equal(f.final().state, 'succeeded');
    for (const id of ['model', 'semantic-mask'])
      await assert.rejects(
        f.service.download(f.final().job_id, id, id === 'model' ? 'wrong.glb' : 'wrong.png'),
      );
    await executePlan(f.app, f.plan(), f.flags);
    assert.equal(f.gateway.posts, 7);
  } finally {
    await f.close();
  }
});

for (const target of [
  'intent',
  'source-anchor',
  'stage:first',
  'stage-anchor:merge',
  'step',
  'input',
  'scale-intent',
  'proof-intermediate',
])
  test(`affine ${target} corruption cannot fall back to the final three-step result`, async () => {
    const f = await affineFixture();
    try {
      assert.equal((await executePlan(f.app, f.plan(), f.flags)).status, 'success');
      const db = new DatabaseSync(path.join(f.dir, 'jobs.sqlite'));
      try {
        const key =
          target === 'step' || target === 'input'
            ? `smartsegment-affine-${target}:${affineChildRequest(affineRequest, 6)}`
            : target === 'scale-intent'
              ? `smartsegment-scale-intent:${affineRequest}:smartsegment-affine:second`
              : target.startsWith('stage')
                ? `smartsegment-affine-${target.split(':')[0]}:${affineRequest}:${target.split(':')[1]}`
                : `smartsegment-affine-${target}:${affineRequest}`;
        if (target === 'proof-intermediate') {
          const proof = f.jobs.requestPolicy('test-account', affineOutputKey(f.final()))!;
          delete proof.second_native_geometry;
          db.prepare('UPDATE request_policies SET policy=? WHERE account_ref=? AND request_id=?').run(
            JSON.stringify(proof),
            'test-account',
            affineOutputKey(f.final()),
          );
        } else
          db.prepare('DELETE FROM request_policies WHERE account_ref=? AND request_id=?').run(
            'test-account',
            key,
          );
      } finally {
        db.close();
      }
      assert.equal((await f.service.get(f.final().job_id)).state, 'needs_attention');
      assert.equal(f.service.summary(f.final()).state, 'needs_attention');
      for (const [id, suffix] of [
        ['model', 'glb'],
        ['semantic-mask', 'png'],
      ])
        await assert.rejects(f.service.download(f.final().job_id, id!, `blocked.${suffix}`));
      await assert.rejects(
        downloadTask(f.app, f.final() as unknown as Record<string, unknown>, {
          out: path.join(f.dir, 'shortcut'),
          outIsRoot: true,
        }),
      );
      assert.equal(f.gateway.posts, 7);
    } finally {
      await f.close();
    }
  });

test('affine original source cache loss blocks final delivery and no later native step is replayed', async () => {
  const f = await affineFixture();
  try {
    assert.equal((await executePlan(f.app, f.plan(), f.flags)).status, 'success');
    await rm(f.cachePath(f.sourcePolicy()));
    assert.equal((await f.service.get(f.final().job_id)).state, 'needs_attention');
    await assert.rejects(f.service.download(f.final().job_id, 'semantic-mask', 'no-source.png'));
    await assert.rejects(executePlan(f.app, f.plan(), f.flags));
    assert.equal(f.gateway.posts, 7);
  } finally {
    await f.close();
  }
});

test('affine final pre-send recheck refuses a mutated parent without sending the segment', async () => {
  const f = await affineFixture();
  try {
    f.before.submit = (_job, index) => {
      if (index !== 6) return;
      const db = new DatabaseSync(path.join(f.dir, 'jobs.sqlite'));
      db.prepare('DELETE FROM request_policies WHERE account_ref=? AND request_id=?').run(
        'test-account',
        `smartsegment-affine-source-anchor:${affineRequest}`,
      );
      db.close();
    };
    const result = await executePlan(f.app, f.plan(), f.flags);
    assert.equal(result.status, 'failed');
    assert.equal(f.gateway.posts, 6);
    assert.equal(object(f.final().error).certainty, 'not_submitted');
    await assert.rejects(executePlan(f.app, f.plan(), f.flags), (e: unknown) => e instanceof TripoError);
    assert.equal(f.gateway.posts, 6);
  } finally {
    await f.close();
  }
});

for (const removeMarker of [false, true])
  test(`affine final request rename${removeMarker ? ' plus marker deletion' : ''} cannot discard the original obligation`, async () => {
    const f = await affineFixture();
    try {
      assert.equal((await executePlan(f.app, f.plan(), f.flags)).status, 'success');
      const original = f.final(),
        db = new DatabaseSync(path.join(f.dir, 'jobs.sqlite'));
      const input = structuredClone(original.input);
      if (removeMarker) delete input._smartsegment_affine;
      db.prepare('UPDATE jobs SET request_id=?, input=? WHERE job_id=?').run(
        'changed-final-request',
        JSON.stringify(input),
        original.job_id,
      );
      db.close();
      assert.equal((await f.service.get(original.job_id)).state, 'needs_attention');
      assert.equal(f.service.summary(f.jobs.get(original.job_id)).state, 'needs_attention');
      for (const [id, suffix] of [
        ['model', 'glb'],
        ['semantic-mask', 'png'],
      ])
        await assert.rejects(f.service.download(original.job_id, id!, `renamed.${suffix}`));
      assert.equal(f.gateway.posts, 7);
    } finally {
      await f.close();
    }
  });

for (const extra of [{ transform_matrix: affineMatrix }, { user_extra_flag: 'changed' }])
  test(`native affine merge freezes complete metadata across the budget boundary: ${Object.keys(extra)[0]}`, async () => {
    const f = await affineFixture();
    try {
      f.before.submit = (_job, index) => {
        if (index === 3) f.states.set('affine-op-2', { ...f.states.get('affine-op-2'), ...extra });
      };
      const result = await executePlan(f.app, f.plan(), f.flags);
      assert.equal(result.status, 'failed');
      assert.equal(f.gateway.posts, 3);
      assert.equal(object(result.error).code, 'PROJECT_CHANGED');
      assert.equal(f.final(), undefined);
    } finally {
      await f.close();
    }
  });
