import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { labSourceFixture } from './lab-model-source-fixture.ts';
import { quote } from './helpers.ts';
import { processingPlan, type Plan } from '../cli/compat/planning.ts';
import { redoPlan } from '../cli/compat/redo.ts';
import { attachLabModelRedoSource } from '../cli/compat/lab-model-redo.ts';
import { StudioClient } from '../studio/api/client.ts';
import { object, array } from '../studio/contracts/errors.ts';
import {
  prepareLabModelSource,
  bindLabModelSource,
  bindLabModelSourceDelivery,
  labModelSourceSummary,
  freezeLabModelSourceSelection,
  freezeLabModelIsolationLayout,
  prepareLabModelIsolationCopy,
  assertLabModelSourceSubmission,
} from '../cli/compat/lab-model-source.ts';
import { labModelIsolationProofKey } from '../cli/compat/lab-model-isolation-policy.ts';

function selectedPlan(source: string): Plan {
  return processingPlan('convert', source, {
    param: { source_representation: 'studio_normalized', texture_format: 'JPEG', with_animation: false },
  });
}
test('new explicit sources freeze copy → processing before reference selection and retain indices on restart', async (t) => {
  const f = await labSourceFixture(t),
    plan = selectedPlan('@source');
  const first = freezeLabModelIsolationLayout(f.jobs, f.job.account_ref, 'new', plan);
  assert.deepEqual(
    first.steps.map((step) => step.operation),
    ['copy', 'export'],
  );
  assert.equal(first.steps[0]!.source, '@source');
  assert.equal(first.steps[0]!.sourceRepresentation, 'studio_normalized');
  assert.equal(first.steps[1]!.source, 'upstream');
  assert.equal(first.steps[1]!.sourceRepresentation, undefined);
  const selected = freezeLabModelSourceSelection(f.jobs, f.job.account_ref, 'new', first.steps, () => f.job);
  assert.equal(selected[0]!.source, f.job.job_id);
  f.jobs.prepare(
    f.job.account_ref,
    'new-0',
    'copy',
    { project_id: 'studio-project', operator_id: 'studio-operator' },
    quote,
  );
  assert.deepEqual(freezeLabModelIsolationLayout(f.jobs, f.job.account_ref, 'new', plan), first);
  for (const changed of [processingPlan('convert', '@source', {}), selectedPlan('@different')])
    assert.throws(() => freezeLabModelIsolationLayout(f.jobs, f.job.account_ref, 'new', changed), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
});
test('old saved selections, automatic reference policies and existing children keep their original layout', async (t) => {
  const f = await labSourceFixture(t),
    plan = selectedPlan(f.job.job_id);
  freezeLabModelSourceSelection(f.jobs, f.job.account_ref, 'selected-old', plan.steps, () => f.job);
  f.jobs.bindRequestPolicy(f.job.account_ref, 'sources:reference-old', { intent: [], sources: [] });
  f.jobs.prepare(f.job.account_ref, 'job-old-0', 'export', { project_id: 'studio-project' }, quote);
  const db = new DatabaseSync(path.join(f.dir, 'jobs.sqlite'));
  t.after(() => db.close());
  const policies = () =>
    db
      .prepare(
        'SELECT account_ref,request_id,policy,legacy FROM request_policies ORDER BY account_ref,request_id',
      )
      .all();
  const before = policies();
  for (const request of ['selected-old', 'reference-old', 'job-old']) {
    assert.deepEqual(freezeLabModelIsolationLayout(f.jobs, f.job.account_ref, request, plan), plan);
    assert.equal(f.jobs.requestPolicy(f.job.account_ref, `lab-model-isolation-layout:${request}`), undefined);
    assert.equal(f.jobs.requestPolicy(f.job.account_ref, `lab-model-copy-request:${request}-0`), undefined);
  }
  const ordinary = processingPlan('convert', f.job.job_id, {});
  assert.equal(freezeLabModelIsolationLayout(f.jobs, f.job.account_ref, 'ordinary', ordinary), ordinary);
  assert.equal(f.jobs.requestPolicy(f.job.account_ref, 'lab-model-isolation-layout:ordinary'), undefined);
  assert.deepEqual(policies(), before, 'Legacy policy strings and complete key set must remain unchanged');
});

test('direct source redo freezes its original exact guards, then retargets only the verified processing step to the isolated copy', async (t) => {
  const f = await labSourceFixture(t);
  await prepareLabModelSource(f.context, f.job, 'studio_normalized');
  const input = bindLabModelSource(
    f.jobs,
    f.job,
    'export',
    { format: 'glb' },
    'studio_normalized',
  )!.parameters;
  bindLabModelSourceDelivery(
    f.jobs,
    f.job.account_ref,
    'legacy-export',
    'export',
    f.job,
    'studio_normalized',
    input,
  );
  const original = f.jobs.prepare(f.job.account_ref, 'legacy-export', 'export', input, quote),
    completed = f.jobs.update(original.job_id, 'succeeded', {
      remote_ids: { project_id: 'studio-project', operator_id: 'export-receipt' },
    });
  const redo = attachLabModelRedoSource(f.jobs, completed, redoPlan(completed), {});
  assert.equal(redo.steps[0]!.parameters.expected_operator_id, 'studio-operator');
  const isolated = freezeLabModelIsolationLayout(f.jobs, f.job.account_ref, 'new-redo', redo);
  assert.equal(isolated.steps[1]!.parameters.project_id, 'upstream');
  assert.equal(isolated.steps[1]!.parameters.expected_operator_id, 'upstream');
  const copyInput = bindLabModelSource(
    f.jobs,
    f.job,
    'copy',
    isolated.steps[0]!.parameters,
    'studio_normalized',
  )!.parameters;
  bindLabModelSourceDelivery(
    f.jobs,
    f.job.account_ref,
    'new-redo-0',
    'copy',
    f.job,
    'studio_normalized',
    copyInput,
  );
  const changed = structuredClone(redo);
  changed.steps[0]!.parameters.expected_operator_id = 'unrelated-original';
  const bad = freezeLabModelIsolationLayout(f.jobs, f.job.account_ref, 'bad-redo', changed);
  const badInput = bindLabModelSource(
    f.jobs,
    f.job,
    'copy',
    bad.steps[0]!.parameters,
    'studio_normalized',
  )!.parameters;
  assert.throws(
    () =>
      bindLabModelSourceDelivery(
        f.jobs,
        f.job.account_ref,
        'bad-redo-0',
        'copy',
        f.job,
        'studio_normalized',
        badInput,
      ),
    { code: 'LAB_MODEL_ISOLATION_UNVERIFIED' },
  );
  assert.equal(f.jobs.find(f.job.account_ref, 'bad-redo-0'), undefined);
  assert.equal(f.jobs.requestPolicy(f.job.account_ref, 'lab-model-delivery:bad-redo-0'), undefined);
});
test('a new plan already starting with its selected copy reuses that copy and requires the same byte proof', async (t) => {
  const f = await labSourceFixture(t),
    plan = selectedPlan(f.job.job_id);
  plan.steps.unshift({
    name: 'export-copy',
    operation: 'copy',
    source: f.job.job_id,
    sourceRepresentation: 'studio_normalized',
    parameters: { project_id: 'upstream', operator_id: 'upstream' },
  });
  const selected = freezeLabModelIsolationLayout(f.jobs, f.job.account_ref, 'already-copy', plan);
  assert.deepEqual(
    selected.steps.map((step) => step.operation),
    ['copy', 'export'],
  );
  assert.equal(selected.steps[0]!.name, 'export-copy');
  assert.equal(selected.steps[1]!.source, 'upstream');
  assert.equal(
    f.jobs.requestPolicy(f.job.account_ref, 'lab-model-isolation-layout:already-copy')?.mode,
    'existing_copy',
  );
  assert(f.jobs.requestPolicy(f.job.account_ref, 'lab-model-copy-request:already-copy-0'));
});
async function copyFixture(t: TestContext) {
  const f = await labSourceFixture(t);
  await prepareLabModelSource(f.context, f.job, 'studio_normalized');
  const plan = freezeLabModelIsolationLayout(
      f.jobs,
      f.job.account_ref,
      'isolated',
      selectedPlan(f.job.job_id),
    ),
    step = plan.steps[0]!;
  freezeLabModelSourceSelection(f.jobs, f.job.account_ref, 'isolated', plan.steps, () => f.job);
  const input = bindLabModelSource(f.jobs, f.job, 'copy', step.parameters, 'studio_normalized')!.parameters;
  bindLabModelSourceDelivery(
    f.jobs,
    f.job.account_ref,
    'isolated-0',
    'copy',
    f.job,
    'studio_normalized',
    input,
  );
  const prepared = f.jobs.prepare(f.job.account_ref, 'isolated-0', 'copy', input, quote);
  const copy = f.jobs.update(prepared.job_id, 'succeeded', {
    remote_ids: { project_id: 'copied-project', operator_id: 'copied-operator' },
  });
  const url =
    'https://tripo-data.rg1.data.tripo3d.com/tripo-studio/copied-operator/model.glb?Signature=fixture&Expires=1';
  const state = {
    detail: {
      id: 'copied-project',
      is_owner: true,
      model_url: url,
      operator: {
        operator_id: 'copied-operator',
        status: 'success',
        type: 'upload',
        is_pbr: false,
        metadata: {} as Record<string, unknown>,
      },
    },
    bytes: f.normalized,
    reads: 0,
    downloads: 0,
    account: f.job.account_ref,
    afterDownload: () => {},
  };
  const client = new StudioClient(f.credentials, async (url, init) => {
    const parsed = new URL(url);
    assert.equal(init.method, 'GET');
    assert.equal(parsed.pathname, '/v2/studio/project/detail/v3/copied-project');
    assert.equal(parsed.searchParams.get('operator_id'), 'copied-operator');
    state.reads++;
    return Response.json({ code: 0, data: state.detail });
  });
  const context = {
    ...f.context,
    client,
    accountRef: () => state.account,
    fetcher: async () => {
      state.downloads++;
      state.afterDownload();
      return new Response(new Uint8Array(state.bytes));
    },
  };
  return { ...f, plan, copy, state, context };
}
test('copy bytes gate continuation, disclose dropped metadata, and restore the same proof offline', async (t) => {
  const f = await copyFixture(t),
    input = { project_id: 'copied-project', format: 'glb' };
  assert.throws(
    () =>
      bindLabModelSourceDelivery(f.jobs, f.job.account_ref, 'isolated-1', 'export', f.copy, undefined, input),
    { code: 'LAB_MODEL_ISOLATION_UNVERIFIED' },
  );
  assert.equal(
    object(object(labModelSourceSummary(f.jobs, f.copy)!.lab_model_source).source_isolation).status,
    'pending',
  );
  const proof = await prepareLabModelIsolationCopy(f.context, f.copy);
  assert(proof);
  assert.equal(proof.sha256, createHash('sha256').update(f.normalized).digest('hex'));
  assert.equal(proof.bytes, f.normalized.length);
  assert.equal(proof.metadata_preserved, false);
  assert.deepEqual(proof.target.metadata, {});
  assert.equal(f.state.reads, 2);
  assert.equal(f.state.downloads, 1);
  bindLabModelSourceDelivery(f.jobs, f.job.account_ref, 'isolated-1', 'export', f.copy, undefined, input);
  const downstream = f.jobs.prepare(f.job.account_ref, 'isolated-1', 'export', input, quote);
  const summary = labModelSourceSummary(f.jobs, downstream)!,
    lineage = array(object(summary.lab_model_source).processing_lineage).map(object);
  assert.equal(lineage.length, 2);
  assert.equal(object(lineage[0]!.source_isolation).metadata_preserved, false);
  assert.equal(object(lineage[1]!.source_parameters).expected_operator_id, 'copied-operator');
  assert.deepEqual(
    await prepareLabModelIsolationCopy({ ...f.context, checkTargetCurrent: false }, f.copy),
    proof,
  );
  assert.equal(f.state.reads, 2);
  assert.equal(f.state.downloads, 1);
  assertLabModelSourceSubmission(f.jobs, f.job.account_ref, 'isolated-1', 'export', downstream.input);
});
for (const mutation of ['bytes', 'owner', 'operator', 'pbr', 'geometry'] as const)
  test(`an isolated copy with changed ${mutation} cannot acquire a proof or continue`, async (t) => {
    const f = await copyFixture(t);
    if (mutation === 'bytes') {
      f.state.bytes = Buffer.from(f.normalized);
      f.state.bytes[f.state.bytes.length - 1] = f.state.bytes[f.state.bytes.length - 1]! ^ 1;
    }
    if (mutation === 'owner') f.state.detail.is_owner = false;
    if (mutation === 'operator') f.state.detail.operator.operator_id = 'other';
    if (mutation === 'pbr') f.state.detail.operator.is_pbr = true;
    if (mutation === 'geometry') f.state.detail.operator.metadata.children_deleted = ['part'];
    await assert.rejects(prepareLabModelIsolationCopy(f.context, f.copy), {
      code: 'LAB_MODEL_ISOLATION_UNVERIFIED',
    });
    assert.equal(f.jobs.requestPolicy(f.job.account_ref, labModelIsolationProofKey(f.copy)), undefined);
    assert.throws(
      () =>
        bindLabModelSourceDelivery(f.jobs, f.job.account_ref, 'isolated-1', 'export', f.copy, undefined, {
          project_id: 'copied-project',
        }),
      { code: 'LAB_MODEL_ISOLATION_UNVERIFIED' },
    );
    assert.equal(f.jobs.get(f.copy.job_id).state, 'succeeded');
  });
test('account changes across the download boundary cannot freeze a copy proof', async (t) => {
  const f = await copyFixture(t);
  f.state.afterDownload = () => {
    f.state.account = 'other-account';
  };
  await assert.rejects(prepareLabModelIsolationCopy(f.context, f.copy), { code: 'ACCOUNT_MISMATCH' });
  assert.equal(f.jobs.requestPolicy(f.job.account_ref, labModelIsolationProofKey(f.copy)), undefined);
});
test('a changed copy receipt across the download boundary cannot freeze a replacement source identity', async (t) => {
  const f = await copyFixture(t);
  f.state.afterDownload = () => {
    f.jobs.update(f.copy.job_id, 'succeeded', {
      remote_ids: { project_id: 'copied-project', operator_id: 'replacement' },
    });
  };
  await assert.rejects(prepareLabModelIsolationCopy(f.context, f.copy), {
    code: 'LAB_MODEL_ISOLATION_UNVERIFIED',
  });
  assert.equal(f.jobs.requestPolicy(f.job.account_ref, labModelIsolationProofKey(f.copy)), undefined);
});
test('cached restoration verifies exact bytes and new continuation checks current metadata', async (t) => {
  const f = await copyFixture(t),
    proof = (await prepareLabModelIsolationCopy(f.context, f.copy))!;
  f.state.detail.operator.metadata.material_factor = { metallic: 0, roughness: 0.9 };
  await assert.rejects(prepareLabModelIsolationCopy(f.context, f.copy), {
    code: 'LAB_MODEL_ISOLATION_UNVERIFIED',
  });
  assert.deepEqual(
    await prepareLabModelIsolationCopy({ ...f.context, checkTargetCurrent: false }, f.copy),
    proof,
  );
  const bucket = createHash('sha256').update(f.copy.account_ref).digest('hex');
  await writeFile(
    path.join(f.dir, 'verified-output-cache', bucket, proof.sha256 + '.glb'),
    Buffer.alloc(proof.bytes),
  );
  await assert.rejects(prepareLabModelIsolationCopy({ ...f.context, checkTargetCurrent: false }, f.copy), {
    code: 'LAB_MODEL_ISOLATION_UNVERIFIED',
  });
});
