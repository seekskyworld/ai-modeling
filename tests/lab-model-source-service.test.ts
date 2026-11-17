/** 真实回归：JPEG交付专用get分支不得丢掉提交时已披露的Lab来源。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { labSourceFixture } from './lab-model-source-fixture.ts';
import { fixture, quote } from './helpers.ts';
import {
  prepareLabModelSource,
  bindLabModelSource,
  bindLabModelSourceDelivery,
  labModelSourceSummary,
} from '../cli/compat/lab-model-source.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import { exportJpegPolicyKey } from '../cli/core/export-jpeg-policy.ts';
import { ensureExportJpeg } from '../cli/artifacts/export-jpeg-output.ts';
import { object } from '../studio/contracts/errors.ts';
import { taskResult } from '../cli/compat/runtime.ts';
import { redoPlan } from '../cli/compat/redo.ts';
import { attachLabModelRedoSource } from '../cli/compat/lab-model-redo.ts';

test('JPEG get/list and restarted service retain the full explicit Lab source disclosure', async (t) => {
  const f = await labSourceFixture(t);
  await prepareLabModelSource(f.context, f.job, 'studio_normalized');
  const request = 'source-jpeg-get',
    parameters = bindLabModelSource(f.jobs, f.job, 'export', {}, 'studio_normalized')!.parameters,
    input = normalize('export', { ...parameters, format: 'glb', texture_format: 'JPEG' });
  bindLabModelSourceDelivery(f.jobs, f.job.account_ref, request, 'export', f.job, 'studio_normalized');
  f.jobs.bindRequestPolicy(f.job.account_ref, exportJpegPolicyKey(request), {
    version: 1,
    mode: 'jpeg',
    project_id: parameters.project_id,
    operator_id: parameters.expected_operator_id,
  });
  const prepared = f.jobs.prepare(f.job.account_ref, request, 'export', input, quote),
    job = f.jobs.update(prepared.job_id, 'succeeded', {
      remote_ids: { project_id: 'studio-project', operator_id: 'fresh-export' },
      artifacts: [{ artifact_id: 'model', kind: 'model', format: 'glb', index: 0 }],
    });
  await ensureExportJpeg(job, f.jobs, f.dir, f.gateway, async () => new Response(new Uint8Array(f.original)));
  const expected = labModelSourceSummary(f.jobs, f.jobs.get(job.job_id))!;
  const redo = attachLabModelRedoSource(f.jobs, job, redoPlan(job), {});
  assert.equal(redo.steps[0]!.source, f.job.job_id);
  assert.equal(redo.steps[0]!.sourceRepresentation, 'studio_normalized');
  assert.deepEqual(redo.sourceValidation, { reference: f.job.job_id, chain: [] });
  assert.throws(
    () => attachLabModelRedoSource(f.jobs, job, redoPlan(job), { source_representation: 'raw' }),
    { code: 'INVALID_INPUT' },
  );
  const restarted = await fixture(f.dir);
  t.after(() => restarted.jobs.close());
  for (const service of [f.service, restarted.service]) {
    service.gateway.submit =
      service.gateway.status =
      service.gateway.artifactUrl =
        async () => {
          throw Error('No remote access is required to recover this verified delivery.');
        };
    const got = await service.get(job.job_id),
      listed = service.summary(service.jobs.get(job.job_id));
    for (const result of [got, listed, taskResult(got)]) {
      assert.equal(result.source_representation, expected.source_representation);
      assert.deepEqual(result.lab_model_source, expected.lab_model_source);
      assert.equal(object(result.jpeg_output_validation).status, 'verified');
    }
  }
  assert.equal(f.gateway.posts + restarted.gateway.posts, 0);
});
