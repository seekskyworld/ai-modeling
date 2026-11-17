/** A projected preflight is bound to the original native merge and cannot replace actual final validation. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { executePlan } from '../cli/compat/runtime.ts';
import { affineOutputKey } from '../cli/core/smartsegment-affine-policy.ts';
import { object } from '../studio/contracts/errors.ts';
import { affineFixture } from './helpers-smartsegment-affine.ts';
const matrix = [1, 0, 0, 0, 0.2, 1, 0, 0, 0.1, 0, 1, 0, 0, 0, 0, 1];

test('general projection and actual merge obligations cannot be removed or relabelled during cached delivery', async () => {
  const f = await affineFixture({ matrix });
  try {
    const result = await executePlan(f.app, f.plan(), f.flags);
    assert.equal(result.status, 'success', JSON.stringify(result));
    const key = affineOutputKey(f.final()),
      original = f.jobs.requestPolicy('test-account', key)!;
    const merge = object(original.merge_geometry),
      projected = object(merge.projected_final_geometry);
    assert.equal(merge.kind, 'general_affine_merge_projected_preflight');
    assert.equal(projected.actual_final_output_verified, false);
    assert.deepEqual(projected, f.stagePolicy('merge').projected_final_geometry);
    assert.deepEqual(object(original.second_native_geometry).transform_matrix, f.prepared.second_matrix);
    const changes: Array<[string, (p: Record<string, unknown>) => void]> = [
      [
        'projection_removed',
        (p) => {
          delete object(p.merge_geometry).projected_final_geometry;
        },
      ],
      [
        'projection_label',
        (p) => {
          object(object(p.merge_geometry).projected_final_geometry).actual_final_output_verified = true;
        },
      ],
      [
        'projection_source',
        (p) => {
          object(object(p.merge_geometry).projected_final_geometry).source_sha256 = '0'.repeat(64);
        },
      ],
      [
        'projection_matrix',
        (p) => {
          object(object(p.merge_geometry).projected_final_geometry).second_matrix = matrix;
        },
      ],
      [
        'projection_corners',
        (p) => {
          object(object(p.merge_geometry).projected_final_geometry).projected_corner_sha256 = '0'.repeat(64);
        },
      ],
      [
        'projection_tolerance',
        (p) => {
          object(object(p.merge_geometry).projected_final_geometry).tolerance = { position: 8e-5 };
        },
      ],
      [
        'physical_merge_removed',
        (p) => {
          delete object(p.merge_geometry).first_native_preserved;
        },
      ],
      [
        'physical_bounds_changed',
        (p) => {
          object(p.merge_geometry).bounds = {};
        },
      ],
      [
        'actual_second_removed',
        (p) => {
          delete p.second_native_geometry;
        },
      ],
      [
        'original_target_changed',
        (p) => {
          p.transform_matrix = f.prepared.second_matrix;
        },
      ],
    ];
    const db = new DatabaseSync(path.join(f.dir, 'jobs.sqlite'));
    try {
      for (const [name, change] of changes) {
        const altered = structuredClone(original);
        change(altered);
        db.prepare('UPDATE request_policies SET policy=? WHERE account_ref=? AND request_id=?').run(
          JSON.stringify(altered),
          'test-account',
          key,
        );
        assert.equal((await f.service.get(f.final().job_id)).state, 'needs_attention', name);
        for (const artifact of ['model', 'semantic-mask']) {
          const target = path.join(f.dir, name + '-' + artifact);
          await assert.rejects(f.service.download(f.final().job_id, artifact, target));
          await assert.rejects(lstat(target), { code: 'ENOENT' });
        }
        assert.equal(f.gateway.posts, 7);
      }
    } finally {
      db.prepare('UPDATE request_policies SET policy=? WHERE account_ref=? AND request_id=?').run(
        JSON.stringify(original),
        'test-account',
        key,
      );
      db.close();
    }
    assert.equal((await f.service.get(f.final().job_id)).state, 'succeeded');
    const recovered = await executePlan(f.app, f.plan(), f.flags);
    assert.equal(recovered.status, 'success');
    assert.equal(recovered.task_id, result.task_id);
    assert.equal(f.gateway.posts, 7);
  } finally {
    await f.close();
  }
});
