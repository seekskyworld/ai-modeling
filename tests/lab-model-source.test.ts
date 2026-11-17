import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { labSourceFixture, labSourceModel } from './lab-model-source-fixture.ts';
import { quote } from './helpers.ts';
import { resolveLabModelSource } from '../studio/api/lab-model-source.ts';
import { verifyLabModelGeometry } from '../cli/compat/lab-model-geometry.ts';
import {
  prepareLabModelSource,
  labModelSourceProof,
  labModelSourceKey,
  bindLabModelSource,
  freezeLabModelSourceSelection,
  bindLabModelSourceDelivery,
  assertLabModelSourceSubmission,
  labModelSourceSummary,
} from '../cli/compat/lab-model-source.ts';
import { processingPlan } from '../cli/compat/planning.ts';
import { fullToolPlan } from '../cli/compat/full-tools.ts';
import { object } from '../studio/contracts/errors.ts';
import type { LabModelSourceStep } from '../cli/compat/lab-model-source-selection.ts';

test('direct CLI and full MCP extract the explicit representation without changing ordinary plans or remote parameters', () => {
  const id = '4205f530-a706-47e8-a17e-3246520c92ef';
  const ordinary = processingPlan('convert', id, {}),
    selected = processingPlan('convert', id, { param: { source_representation: 'studio_normalized' } });
  assert(selected.steps.some((step) => step.sourceRepresentation === 'studio_normalized'));
  assert(selected.steps.every((step) => step.parameters.source_representation === undefined));
  assert.deepEqual(
    selected.steps.map(({ sourceRepresentation: _ignored, ...step }) => step),
    ordinary.steps,
  );
  assert(ordinary.steps.every((step) => step.sourceRepresentation === undefined));
  const full = fullToolPlan('ai_modeling_convert', {
    input: id,
    format: 'GLTF',
    source_representation: 'studio_normalized',
  });
  assert(full.steps.some((step) => step.sourceRepresentation === 'studio_normalized'));
  assert(full.steps.every((step) => step.parameters.source_representation === undefined));
  for (const source of ['/input.glb', 'https://example.test/model.glb', 'upstream'])
    assert.throws(
      () => processingPlan('convert', source, { param: { source_representation: 'studio_normalized' } }),
      { code: 'INVALID_INPUT' },
    );
  for (const value of [true, 'original', 'STUDIO_NORMALIZED'])
    assert.throws(() => processingPlan('convert', id, { param: { source_representation: value } }), {
      code: 'INVALID_INPUT',
    });
});

test('independent source geometry admits only disclosed unit-bounds correspondence and measured normal quantization', async () => {
  const proof = await verifyLabModelGeometry(
    await labSourceModel(),
    await labSourceModel({ normalized: true }),
  );
  assert.deepEqual(proof.normalization, { center: [3, -2, 5], scale: 0.25 });
  assert.equal(proof.matched_oriented_faces, 2);
  assert.equal(proof.maximum_vertex_error, 0);
  assert(proof.maximum_normal_angle > 0);
  assert.equal(proof.original_coordinates_preserved, false);
  assert.equal(proof.original_normal_precision_preserved, false);
});
for (const mutation of ['moved', 'reversed', 'normalChanged', 'materialChanged'] as const)
  test(`normalized representation rejects ${mutation}`, async () => {
    await assert.rejects(
      verifyLabModelGeometry(
        await labSourceModel(),
        await labSourceModel({ normalized: true, [mutation]: true }),
      ),
      { code: 'LAB_MODEL_GEOMETRY_UNVERIFIED' },
    );
  });

test('Lab artifact, saved node asset and Studio operation are separate verified identities', async (t) => {
  const f = await labSourceFixture(t),
    result = await resolveLabModelSource(f.context.client, f.job, f.artifact);
  assert.equal(f.calls.length, 7);
  assert.equal(result.target.artifact_id, 'lab-artifact');
  assert.equal(result.target.node_asset_id, 'node-asset');
  assert.equal(result.target.operator_id, 'studio-operator');
  assert.equal(result.target.lab_job_id, 'lab-remote');
  assert.equal(JSON.stringify(result.target).includes('Signature'), false);
  assert.match(result.target.resource_identity, /^[a-f0-9]{64}$/);
  assert(f.calls.every((call) => /GetLabJob|ListNodesAssets|GetNodeAssetDetail|project\/detail/.test(call)));
});
for (const mutation of [
  'wrong-artifact',
  'missing-node-asset',
  'wrong-node',
  'not-ready',
  'not-owner',
  'metadata',
  'business-query',
  'later-asset',
] as const)
  test(`exact Lab source resolution rejects ${mutation}`, async (t) => {
    const f = await labSourceFixture(t);
    if (mutation === 'wrong-artifact') f.state.lab.artifacts[0]!.artifactId = 'other';
    if (mutation === 'missing-node-asset') f.state.lab.artifacts[0]!.nodeAssetId = '';
    if (mutation === 'wrong-node') f.state.listed.nodes[0]!.assets[0]!.nodeId = 'other-node';
    if (mutation === 'not-ready') f.state.lab.artifacts[0]!.studioState = 'STUDIO_ASSET_STATE_PROCESSING';
    if (mutation === 'not-owner') f.state.detail.detail.is_owner = false;
    if (mutation === 'metadata') f.state.project.operator.metadata.material_factor.roughness = 0.8;
    if (mutation === 'business-query') f.state.project.model_url += '&variant=different';
    if (mutation === 'later-asset') {
      let count = 0;
      f.state.onRead = (method) => {
        if (method.endsWith('/GetLabJob') && ++count === 2)
          f.state.lab.artifacts[0]!.nodeAssetId = 'later-asset';
      };
    }
    await assert.rejects(resolveLabModelSource(f.context.client, f.job, f.artifact), {
      code: 'LAB_MODEL_SOURCE_UNVERIFIED',
    });
  });

test('source preparation freezes real hashes and metadata, restores offline, and checks mutable metadata for a new request', async (t) => {
  const f = await labSourceFixture(t),
    remoteBefore = structuredClone(f.job.remote_ids);
  const proof = await prepareLabModelSource(f.context, f.job, 'studio_normalized');
  assert.equal(f.calls.length, 8);
  assert.equal(f.downloads(), 1);
  assert.deepEqual(labModelSourceProof(f.jobs, f.job), proof);
  assert.deepEqual(f.jobs.get(f.job.job_id).remote_ids, remoteBefore);
  f.state.detail.detail.metadata.material_factor.roughness = 0.7;
  const old = await prepareLabModelSource(
    { ...f.context, checkTargetCurrent: false },
    f.job,
    'studio_normalized',
  );
  assert.deepEqual(old, proof);
  assert.equal(f.calls.length, 8);
  await assert.rejects(prepareLabModelSource(f.context, f.job, 'studio_normalized'), {
    code: 'LAB_MODEL_SOURCE_UNVERIFIED',
  });
  assert.equal(f.calls.length, 9);
  assert.equal(f.downloads(), 1);
});

test('cache corruption and source mutation cannot reselect a new representation', async (t) => {
  const f = await labSourceFixture(t),
    proof = await prepareLabModelSource(f.context, f.job, 'studio_normalized');
  const bucket = createHash('sha256').update(f.job.account_ref).digest('hex');
  await writeFile(
    path.join(f.dir, 'verified-output-cache', bucket, proof.geometry.studio.sha256 + '.glb'),
    Buffer.alloc(proof.geometry.studio.bytes),
  );
  const reads = f.calls.length;
  await assert.rejects(
    prepareLabModelSource({ ...f.context, checkTargetCurrent: false }, f.job, 'studio_normalized'),
    { code: 'LAB_MODEL_SOURCE_UNVERIFIED' },
  );
  assert.equal(f.calls.length, reads);
  assert.equal(f.downloads(), 1);
  const changed = { ...f.job, remote_ids: { task_id: 'different-lab' } };
  assert.throws(() => labModelSourceProof(f.jobs, changed));
});

test('account changes during a final read do not acquire a frozen representation', async (t) => {
  const f = await labSourceFixture(t);
  let count = 0;
  f.state.onRead = (method) => {
    if (method.endsWith('/GetNodeAssetDetail') && ++count === 3)
      f.credentials.save({ ...f.credentials.load()!, accountRef: 'other-account' });
  };
  await assert.rejects(prepareLabModelSource(f.context, f.job, 'studio_normalized'), {
    code: 'ACCOUNT_MISMATCH',
  });
  assert.equal(f.jobs.requestPolicy(f.job.account_ref, labModelSourceKey(f.job)), undefined);
});

test('explicit source selection freezes aliases and rejects later selection changes or retroactive obligations', async (t) => {
  const f = await labSourceFixture(t);
  const selected = [
    { operation: 'export' as const, source: '@named', sourceRepresentation: 'studio_normalized' as const },
  ];
  const first = freezeLabModelSourceSelection(f.jobs, f.job.account_ref, 'downstream', selected, () => f.job);
  assert.equal(first[0]!.source, f.job.job_id);
  const restored = freezeLabModelSourceSelection(f.jobs, f.job.account_ref, 'downstream', selected, () => {
    throw Error('must not resolve alias again');
  });
  assert.deepEqual(restored, first);
  const changedSteps: LabModelSourceStep[][] = [
    [{ operation: 'export', source: '@named' }],
    [{ ...selected[0]!, source: '@different' }],
    [{ ...selected[0]!, operation: 'texture' }],
  ];
  for (const steps of changedSteps)
    assert.throws(
      () => freezeLabModelSourceSelection(f.jobs, f.job.account_ref, 'downstream', steps, () => f.job),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
  const ordinary = [{ operation: 'export' as const, source: f.job.job_id }];
  f.jobs.prepare(f.job.account_ref, 'old-0', 'export', { project_id: 'old-project' }, quote);
  assert.deepEqual(
    freezeLabModelSourceSelection(f.jobs, f.job.account_ref, 'old', ordinary, () => {
      throw Error('ordinary request is unchanged');
    }),
    ordinary,
  );
  assert.equal(f.jobs.requestPolicy(f.job.account_ref, 'lab-model-selection:old'), undefined);
  assert.throws(
    () => freezeLabModelSourceSelection(f.jobs, f.job.account_ref, 'old', selected, () => f.job),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
});

test('downstream submission guards and summaries persist the selected source without changing the Lab job', async (t) => {
  const f = await labSourceFixture(t);
  await prepareLabModelSource(f.context, f.job, 'studio_normalized');
  assert.equal(bindLabModelSource(f.jobs, f.job, 'export', {}), undefined);
  const bound = bindLabModelSource(f.jobs, f.job, 'export', {}, 'studio_normalized')!;
  assert.deepEqual(bound.parameters, {
    project_id: 'studio-project',
    expected_operator_id: 'studio-operator',
  });
  bindLabModelSourceDelivery(f.jobs, f.job.account_ref, 'downstream-0', 'export', f.job, 'studio_normalized');
  assertLabModelSourceSubmission(f.jobs, f.job.account_ref, 'downstream-0', 'export', bound.parameters);
  for (const input of [
    { ...bound.parameters, project_id: 'other' },
    { ...bound.parameters, expected_operator_id: 'other' },
    { ...bound.parameters, source_operator_id: 'other' },
  ])
    assert.throws(
      () => assertLabModelSourceSubmission(f.jobs, f.job.account_ref, 'downstream-0', 'export', input),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
  assert.throws(
    () =>
      assertLabModelSourceSubmission(f.jobs, f.job.account_ref, 'downstream-0', 'texture', bound.parameters),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
  assert.throws(
    () => bindLabModelSourceDelivery(f.jobs, f.job.account_ref, 'downstream-0', 'export', f.job),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
  const downstream = f.jobs.prepare(f.job.account_ref, 'downstream-0', 'export', bound.parameters, quote);
  const summary = labModelSourceSummary(f.jobs, downstream)!;
  assert.equal(summary.source_representation, 'studio_normalized');
  assert.equal(object(summary.lab_model_source).source_task_id, f.job.job_id);
  assert.equal(object(summary.lab_model_source).original_coordinates_preserved, false);
  assert.equal(JSON.stringify(summary).includes(f.dir), false);
});

test('the actual convert plan binds its upstream project placeholder to the explicitly selected Studio source', async (t) => {
  const f = await labSourceFixture(t);
  await prepareLabModelSource(f.context, f.job, 'studio_normalized');
  const plan = processingPlan('convert', f.job.job_id, {
    param: { source_representation: 'studio_normalized' },
  });
  const step = plan.steps.find((candidate) => candidate.sourceRepresentation === 'studio_normalized')!;
  assert.equal(step.parameters.project_id, 'upstream');
  const bound = bindLabModelSource(
    f.jobs,
    f.job,
    step.operation,
    step.parameters,
    step.sourceRepresentation,
  )!;
  assert.equal(bound.parameters.project_id, 'studio-project');
  assert.equal(bound.parameters.expected_operator_id, 'studio-operator');
  for (const project_id of [undefined, 'upstream', 'studio-project'])
    assert.equal(
      bindLabModelSource(
        f.jobs,
        f.job,
        step.operation,
        { ...step.parameters, project_id },
        step.sourceRepresentation,
      )!.parameters.project_id,
      'studio-project',
    );
  assert.throws(
    () =>
      bindLabModelSource(
        f.jobs,
        f.job,
        step.operation,
        { ...step.parameters, project_id: 'unrelated-project' },
        step.sourceRepresentation,
      ),
    { code: 'LAB_MODEL_SOURCE_UNVERIFIED' },
  );
  bindLabModelSourceDelivery(
    f.jobs,
    f.job.account_ref,
    'convert-plan-0',
    step.operation,
    f.job,
    step.sourceRepresentation,
  );
  assertLabModelSourceSubmission(
    f.jobs,
    f.job.account_ref,
    'convert-plan-0',
    step.operation,
    bound.parameters,
  );
});
