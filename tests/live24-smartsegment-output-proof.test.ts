/** 已持久化的几何验收内容损坏时，get/list和直接下载都不能只凭任务摘要放行。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { executePlan } from '../cli/compat/runtime.ts';
import { scaleOutputKey } from '../cli/core/smartsegment-scale-policy.ts';
import { array, object } from '../studio/contracts/errors.ts';
import { scaleFixture } from './helpers-smartsegment-scale.ts';

for (const changed of [
  'matrix',
  'faces',
  'tolerance',
  'position-error',
  'fitted',
  'modified',
  'parts',
  'source-bytes',
] as const)
  test(`incomplete metadata output proof (${changed}) blocks every result surface`, async () => {
    const f = await scaleFixture();
    try {
      await executePlan(f.app, f.plan(), f.flags);
      f.service.config.outputDir = await realpath(f.service.config.outputDir);
      const job = f.modelJob(),
        artifact = job.artifacts.find((a) => a.kind === 'model')!,
        key = scaleOutputKey(job, artifact),
        proof = f.jobs.requestPolicy(job.account_ref, key)!;
      if (changed === 'matrix') proof.transform_matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      if (changed === 'faces') proof.matched_oriented_faces = 0;
      if (changed === 'tolerance') delete proof.tolerance;
      if (changed === 'position-error') proof.maximum_position_error = 1;
      if (changed === 'fitted') proof.uses_geometry_fit = true;
      if (changed === 'modified') proof.native_result_modified = true;
      if (changed === 'parts') proof.parts = [];
      if (changed === 'source-bytes') proof.source_bytes = Number(proof.source_bytes) + 4;
      const db = new DatabaseSync(path.join(f.dir, 'jobs.sqlite'));
      try {
        db.prepare('UPDATE request_policies SET policy=? WHERE account_ref=? AND request_id=?').run(
          JSON.stringify(proof),
          job.account_ref,
          key,
        );
      } finally {
        db.close();
      }
      assert.equal(object(await f.service.get(job.job_id)).state, 'needs_attention');
      const listed = array(f.service.list(100, 0).jobs)
        .map(object)
        .find((j) => j.job_id === job.job_id)!;
      assert.equal(listed.state, 'needs_attention');
      const target = path.join(f.service.config.outputDir, 'must-not-publish.glb');
      await assert.rejects(f.service.download(job.job_id, 'model', target), {
        code: 'SMARTSEGMENT_SCALE_UNVERIFIED',
      });
      await assert.rejects(lstat(target), { code: 'ENOENT' });
      assert.equal(f.gateway.posts, 3);
    } finally {
      await f.close();
    }
  });
