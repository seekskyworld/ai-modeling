import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { labSourceFixture, labSourceModel } from './lab-model-source-fixture.ts';
import { quote } from './helpers.ts';
import { array, object } from '../studio/contracts/errors.ts';
import { StudioClient } from '../studio/api/client.ts';
import { processingPlan } from '../cli/compat/planning.ts';
import { fullToolPlan } from '../cli/compat/full-tools.ts';
import { validateCompatibilityChain } from '../cli/compat/chain-policy.ts';
import { redoPlan } from '../cli/compat/redo.ts';
import { attachLabModelRedoSource } from '../cli/compat/lab-model-redo.ts';
import { labReferenceProofKey } from '../cli/compat/lab-reference-edit-policy.ts';
import { verifyLabModelPartitionGeometry } from '../cli/compat/lab-model-partition-geometry.ts';
import {
  prepareLabModelSource,
  labModelSourceProof,
  labModelSourceDisclosure,
  bindLabModelSource,
  bindLabModelSourceDelivery,
  labModelSourceSummary,
  freezeLabModelSourceSelection,
  freezeLabModelIsolationLayout,
  prepareLabModelIsolationCopy,
  assertLabModelSourceSubmission,
} from '../cli/compat/lab-model-source.ts';
const expected = { groups: ['mask_186ee6', 'mask_e04138'], faces: { mask_186ee6: 1, mask_e04138: 1 } };

test('projected normalized geometry freezes each named oriented-face group independently of node order', async () => {
  const original = await labSourceModel({ partition: true }),
    studio = await labSourceModel({ partition: true, normalized: true, reorderGroups: true });
  const proof = await verifyLabModelPartitionGeometry(original, studio, expected);
  assert.equal(proof.version, 2);
  assert.equal(proof.partition.matched_groups, 2);
  assert.equal(proof.partition.wrong_group_faces, 0);
  assert.deepEqual(
    proof.partition.groups.map((group) => [group.name, group.faces]),
    [
      ['mask_186ee6', 1],
      ['mask_e04138', 1],
    ],
  );
  for (const group of proof.partition.groups)
    for (const key of [
      'original_oriented_faces_sha256',
      'studio_oriented_faces_sha256',
      'correspondence_sha256',
    ] as const)
      assert.match(group[key], /^[a-f0-9]{64}$/);
  assert.notEqual(
    proof.partition.groups[0]!.original_oriented_faces_sha256,
    proof.partition.groups[1]!.original_oriented_faces_sha256,
  );
  assert.equal(proof.original_normal_precision_preserved, false);
});
for (const change of ['swapGroups', 'renameGroup', 'merge'] as const)
  test(`projected source rejects ${change} even when total geometry and face counts are unchanged`, async () => {
    const original = await labSourceModel({ partition: true }),
      studio = await labSourceModel({
        normalized: true,
        partition: change !== 'merge',
        ...(change === 'merge' ? {} : { [change]: true }),
      });
    await assert.rejects(verifyLabModelPartitionGeometry(original, studio, expected), {
      code: 'LAB_MODEL_PARTITION_UNVERIFIED',
    });
  });
test('projected source gets a distinct v2 type/proof while its original mask and precision proof remain unchanged', async (t) => {
  const f = await labSourceFixture(t, 'projected_segment'),
    originalProof = f.jobs.requestPolicy(f.job.account_ref, labReferenceProofKey(f.job));
  const source = await prepareLabModelSource(f.context, f.job, 'studio_normalized');
  assert.equal(source.version, 2);
  assert.equal(source.task_type, 'mesh_segmentation');
  assert.equal(source.geometry.version, 2);
  assert.deepEqual(f.jobs.requestPolicy(f.job.account_ref, labReferenceProofKey(f.job)), originalProof);
  assert.equal(object(originalProof!.validation).normal_tolerance_radians, 0.002);
  const disclosure = labModelSourceDisclosure(source);
  assert.equal(disclosure.source_kind, 'projected_segment');
  assert.equal(object(disclosure.partition).matched_groups, 2);
  assert.equal(disclosure.normal_tolerance, 0.007);
  const plan = processingPlan('convert', f.job.job_id, {
    param: { source_representation: 'studio_normalized' },
  });
  validateCompatibilityChain(plan.sourceValidation!.chain, source.task_type);
  assert(
    fullToolPlan('ai_modeling_convert', {
      input: f.job.job_id,
      format: 'GLTF',
      source_representation: 'studio_normalized',
    }).steps.some((step) => step.sourceRepresentation === 'studio_normalized'),
  );
  assert.deepEqual(
    await prepareLabModelSource({ ...f.context, checkTargetCurrent: false }, f.job, 'studio_normalized'),
    source,
  );
  assert.equal(f.calls.length, 8);
  assert.equal(f.downloads(), 1);
});
for (const change of ['relaxed precision', 'changed mask counts'] as const)
  test(`a projected original cannot use ${change} as its original proof`, async (t) => {
    const f = await labSourceFixture(t, 'projected_segment'),
      proof = f.jobs.requestPolicy(f.job.account_ref, labReferenceProofKey(f.job))!,
      validation = object(proof.validation);
    if (change === 'relaxed precision') validation.normal_tolerance_radians = 0.007;
    else object(validation.actual_group_faces).mask_186ee6 = 2;
    const db = new DatabaseSync(path.join(f.dir, 'jobs.sqlite'));
    try {
      db.prepare('UPDATE request_policies SET policy=? WHERE account_ref=? AND request_id=?').run(
        JSON.stringify(proof),
        f.job.account_ref,
        labReferenceProofKey(f.job),
      );
    } finally {
      db.close();
    }
    await assert.rejects(prepareLabModelSource(f.context, f.job, 'studio_normalized'), {
      code: 'LAB_MODEL_PARTITION_UNVERIFIED',
    });
    assert.equal(f.calls.length, 0);
  });
test('projected alias selection and source bytes stay frozen across reentry and cache corruption', async (t) => {
  const f = await labSourceFixture(t, 'projected_segment'),
    plan = processingPlan('convert', '@partition', { param: { source_representation: 'studio_normalized' } });
  const first = freezeLabModelSourceSelection(
    f.jobs,
    f.job.account_ref,
    'partition-selected',
    plan.steps,
    () => f.job,
  );
  assert.deepEqual(
    freezeLabModelSourceSelection(f.jobs, f.job.account_ref, 'partition-selected', plan.steps, () => {
      throw Error('do not resolve alias again');
    }),
    first,
  );
  const proof = await prepareLabModelSource(f.context, f.job, 'studio_normalized'),
    bucket = createHash('sha256').update(f.job.account_ref).digest('hex');
  await writeFile(
    path.join(f.dir, 'verified-output-cache', bucket, proof.geometry.studio.sha256 + '.glb'),
    Buffer.alloc(proof.geometry.studio.bytes),
  );
  await assert.rejects(
    prepareLabModelSource({ ...f.context, checkTargetCurrent: false }, f.job, 'studio_normalized'),
    { code: 'LAB_MODEL_SOURCE_UNVERIFIED' },
  );
  assert.equal(f.calls.length, 8);
});
test('projected sources use the same verified isolation, lineage and redo flow without reducing group obligations', async (t) => {
  const f = await labSourceFixture(t, 'projected_segment');
  await prepareLabModelSource(f.context, f.job, 'studio_normalized');
  const plan = freezeLabModelIsolationLayout(
    f.jobs,
    f.job.account_ref,
    'partition-isolated',
    processingPlan('convert', f.job.job_id, { param: { source_representation: 'studio_normalized' } }),
  );
  const copyInput = bindLabModelSource(
    f.jobs,
    f.job,
    'copy',
    plan.steps[0]!.parameters,
    'studio_normalized',
  )!.parameters;
  bindLabModelSourceDelivery(
    f.jobs,
    f.job.account_ref,
    'partition-isolated-0',
    'copy',
    f.job,
    'studio_normalized',
    copyInput,
  );
  const prepared = f.jobs.prepare(f.job.account_ref, 'partition-isolated-0', 'copy', copyInput, quote),
    copy = f.jobs.update(prepared.job_id, 'succeeded', {
      remote_ids: { project_id: 'partition-copy', operator_id: 'partition-copy-op' },
    });
  const client = new StudioClient(f.credentials, async (_url, init) => {
    assert.equal(init.method, 'GET');
    return Response.json({
      code: 0,
      data: {
        id: 'partition-copy',
        is_owner: true,
        model_url: 'https://tripo-data.rg1.data.tripo3d.com/tripo-studio/partition-copy-op/model.glb',
        operator: { operator_id: 'partition-copy-op', status: 'success', is_pbr: false, metadata: {} },
      },
    });
  });
  await prepareLabModelIsolationCopy({ ...f.context, client }, copy);
  const input: Record<string, unknown> = { project_id: 'partition-copy', format: 'glb' };
  bindLabModelSourceDelivery(
    f.jobs,
    f.job.account_ref,
    'partition-isolated-1',
    'export',
    copy,
    undefined,
    input,
  );
  const created = f.jobs.prepare(f.job.account_ref, 'partition-isolated-1', 'export', input, quote),
    output = f.jobs.update(created.job_id, 'succeeded', {
      remote_ids: { project_id: 'partition-copy', operator_id: 'partition-export' },
    });
  const summary = labModelSourceSummary(f.jobs, output)!,
    disclosure = object(summary.lab_model_source);
  assert.equal(disclosure.source_kind, 'projected_segment');
  assert.equal(object(disclosure.partition).matched_groups, 2);
  assert.equal(array(disclosure.processing_lineage).length, 2);
  const redo = attachLabModelRedoSource(f.jobs, output, redoPlan(output), {});
  assert.equal(redo.steps[0]!.source, copy.job_id);
  assert.equal(redo.steps[0]!.sourceRepresentation, undefined);
  bindLabModelSourceDelivery(
    f.jobs,
    f.job.account_ref,
    'partition-redo-0',
    'export',
    copy,
    undefined,
    redo.steps[0]!.parameters,
  );
  assertLabModelSourceSubmission(
    f.jobs,
    f.job.account_ref,
    'partition-redo-0',
    'export',
    redo.steps[0]!.parameters,
  );
  assert.equal(labModelSourceProof(f.jobs, f.job)!.version, 2);
});
