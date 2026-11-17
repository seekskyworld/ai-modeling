import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { labSourceFixture } from './lab-model-source-fixture.ts';
import { quote } from './helpers.ts';
import { JobStore } from '../cli/storage/jobs.ts';
import type { Job, Operation } from '../studio/contracts/types.ts';
import { array, object } from '../studio/contracts/errors.ts';
import { fingerprint } from '../cli/core/fingerprint.ts';
import { processingPlan } from '../cli/compat/planning.ts';
import { redoPlan } from '../cli/compat/redo.ts';
import {
  prepareLabModelSource,
  labModelSourceProof,
  labModelSourceDisclosure,
  bindLabModelSource,
  bindLabModelSourceDelivery,
  assertLabModelSourceSubmission,
  labModelSourceSummary,
  redoLabModelSourceSelection,
} from '../cli/compat/lab-model-source.ts';

async function sourceFixture(t: TestContext, operation: Operation = 'remesh') {
  const f = await labSourceFixture(t);
  await prepareLabModelSource(f.context, f.job, 'studio_normalized');
  const params =
    operation === 'uv_generate'
      ? { current_operator_id: 'upstream' }
      : operation === 'texture'
        ? { action: 'generate', texture_seed: 11 }
        : operation === 'remesh'
          ? { face_limit: 500 }
          : {};
  const bound = bindLabModelSource(f.jobs, f.job, operation, params, 'studio_normalized')!;
  bindLabModelSourceDelivery(
    f.jobs,
    f.job.account_ref,
    'direct',
    operation,
    f.job,
    'studio_normalized',
    bound.parameters,
  );
  const prepared = f.jobs.prepare(f.job.account_ref, 'direct', operation, bound.parameters, quote);
  const result = f.jobs.update(prepared.job_id, 'succeeded', {
    remote_ids: {
      project_id: operation === 'copy' ? 'copied-project' : 'studio-project',
      operator_id: `${operation}-result`,
    },
  });
  return { ...f, result };
}
function inherit(
  f: Awaited<ReturnType<typeof sourceFixture>>,
  source: Job,
  request: string,
  operation: Operation,
  input: Record<string, unknown>,
) {
  bindLabModelSourceDelivery(f.jobs, f.job.account_ref, request, operation, source, undefined, input);
  assertLabModelSourceSubmission(f.jobs, f.job.account_ref, request, operation, input);
  return f.jobs.prepare(f.job.account_ref, request, operation, input, quote);
}
function mutatePolicy(
  f: Awaited<ReturnType<typeof sourceFixture>>,
  request: string,
  change: (p: Record<string, unknown>) => void,
) {
  const policy = f.jobs.requestPolicy(f.job.account_ref, `lab-model-delivery:${request}`)!;
  change(policy);
  const db = new DatabaseSync(path.join(f.dir, 'jobs.sqlite'));
  try {
    db.prepare('UPDATE request_policies SET policy=? WHERE account_ref=? AND request_id=?').run(
      JSON.stringify(policy),
      f.job.account_ref,
      `lab-model-delivery:${request}`,
    );
  } finally {
    db.close();
  }
}

test('existing v1 direct summaries preserve their complete original shape without retroactive lineage fields', async (t) => {
  const f = await sourceFixture(t);
  assert.deepEqual(labModelSourceSummary(f.jobs, f.result), {
    source_representation: 'studio_normalized',
    lab_model_source: labModelSourceDisclosure(labModelSourceProof(f.jobs, f.job)!),
  });
  assert.equal(
    object(labModelSourceSummary(f.jobs, f.result)!.lab_model_source).processing_lineage,
    undefined,
  );
  assert.deepEqual(
    Object.keys(f.jobs.requestPolicy(f.job.account_ref, 'lab-model-delivery:direct')!).sort(),
    [
      'version',
      'operation',
      'representation',
      'source_job_id',
      'source_proof',
      'project_id',
      'operator_id',
    ].sort(),
  );
});

test('the actual remesh → export plan retains its original Lab disclosure and exact two-step lineage after restart', async (t) => {
  const f = await sourceFixture(t);
  const plan = processingPlan('convert', f.job.job_id, {
    param: { source_representation: 'studio_normalized', face_limit: 500 },
  });
  assert.deepEqual(
    plan.steps.map((step) => step.operation),
    ['remesh', 'export'],
  );
  assert.equal(plan.steps[0]!.sourceRepresentation, 'studio_normalized');
  assert.equal(plan.steps[1]!.sourceRepresentation, undefined);
  const input: Record<string, unknown> = {
    ...plan.steps[1]!.parameters,
    project_id: f.result.remote_ids.project_id,
  };
  const job = inherit(f, f.result, 'chain-final', 'export', input);
  assert.equal(input.expected_operator_id, 'remesh-result');
  const marker = f.jobs.requestPolicy(f.job.account_ref, 'lab-model-delivery:chain-final')!;
  assert.equal(marker.version, 2);
  assert.equal(marker.upstream_job_id, f.result.job_id);
  assert.equal(object(marker.upstream_identity).input_hash, f.result.input_hash);
  assert.equal(object(marker.upstream_identity).remote_ids, fingerprint(f.result.remote_ids));
  const summary = labModelSourceSummary(f.jobs, job)!,
    disclosure = object(summary.lab_model_source),
    lineage = array(disclosure.processing_lineage).map(object);
  assert.equal(disclosure.source_task_id, f.job.job_id);
  assert.equal(disclosure.project_id, 'studio-project');
  assert.equal(disclosure.operator_id, 'studio-operator');
  assert.equal(lineage.length, 2);
  assert.equal(lineage[0]!.job_id, f.result.job_id);
  assert.equal(object(lineage[1]!.source_parameters).expected_operator_id, 'remesh-result');
  const reopened = new JobStore(path.join(f.dir, 'jobs.sqlite'));
  try {
    assert.deepEqual(labModelSourceSummary(reopened, reopened.get(job.job_id)), summary);
    bindLabModelSourceDelivery(
      reopened,
      f.job.account_ref,
      'chain-final',
      'export',
      reopened.get(f.result.job_id),
      undefined,
      { ...input },
    );
  } finally {
    reopened.close();
  }
  assert.equal(f.calls.length, 8);
  assert.equal(f.downloads(), 1);
});

test('third-step processing uses the export base model, while copied models keep their new project identity', async (t) => {
  const f = await sourceFixture(t, 'copy');
  const prepared = inherit(f, f.result, 'exported', 'export', { project_id: 'copied-project' });
  const exported = f.jobs.update(prepared.job_id, 'succeeded', {
    remote_ids: { project_id: 'copied-project', operator_id: 'export-receipt' },
  });
  const input = { project_id: 'copied-project', action: 'pbr' };
  const final = inherit(f, exported, 'pbr', 'texture', input);
  assert.equal(final.input.expected_operator_id, 'copy-result');
  const disclosure = object(labModelSourceSummary(f.jobs, final)!.lab_model_source),
    lineage = array(disclosure.processing_lineage).map(object);
  assert.equal(disclosure.project_id, 'studio-project');
  assert.equal(lineage.length, 3);
  assert.equal(object(lineage[2]!.source_target).project_id, 'copied-project');
  assert.equal(object(lineage[2]!.source_target).basis, 'export_input_model');
  assert.throws(
    () =>
      inherit(f, exported, 'wrong-export-model', 'texture', {
        project_id: 'copied-project',
        expected_operator_id: 'export-receipt',
      }),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
});

test('UV application binds its original base and exact candidate independently, then permits the committed model', async (t) => {
  const f = await sourceFixture(t, 'uv_generate');
  assert.throws(() => inherit(f, f.result, 'unapplied-export', 'export', { project_id: 'studio-project' }), {
    code: 'IDEMPOTENCY_CONFLICT',
  });
  const applied = inherit(f, f.result, 'uv-applied', 'uv_commit', {
    project_id: 'studio-project',
    current_operator_id: 'studio-operator',
    candidate_operator_id: 'uv_generate-result',
  });
  assert.throws(
    () =>
      assertLabModelSourceSubmission(f.jobs, f.job.account_ref, 'uv-applied', 'uv_commit', {
        ...applied.input,
        current_operator_id: 'uv_generate-result',
      }),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
  assert.throws(
    () =>
      assertLabModelSourceSubmission(f.jobs, f.job.account_ref, 'uv-applied', 'uv_commit', {
        ...applied.input,
        candidate_operator_id: 'studio-operator',
      }),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
  const done = f.jobs.update(applied.job_id, 'succeeded', { remote_ids: f.result.remote_ids });
  const final = inherit(f, done, 'uv-export', 'export', { project_id: 'studio-project' });
  assert.equal(final.input.expected_operator_id, 'uv_generate-result');
  assert.equal(
    array(object(labModelSourceSummary(f.jobs, final)!.lab_model_source).processing_lineage).length,
    3,
  );
});

for (const change of ['remote', 'input', 'marker', 'summary'] as const)
  test(`persisted ${change} changes invalidate inherited submission and disclosure`, async (t) => {
    const f = await sourceFixture(t),
      final = inherit(f, f.result, 'guarded', 'export', { project_id: 'studio-project' });
    if (change === 'remote')
      f.jobs.update(f.result.job_id, 'succeeded', {
        remote_ids: { ...f.result.remote_ids, operator_id: 'other' },
      });
    if (change === 'input') {
      const db = new DatabaseSync(path.join(f.dir, 'jobs.sqlite'));
      try {
        db.prepare('UPDATE jobs SET input=? WHERE job_id=?').run(
          JSON.stringify({ ...f.result.input, face_limit: 900 }),
          f.result.job_id,
        );
      } finally {
        db.close();
      }
    }
    if (change === 'marker')
      mutatePolicy(f, f.result.request_id, (p) => {
        p.source_proof = '0'.repeat(64);
      });
    if (change === 'summary')
      mutatePolicy(f, final.request_id, (p) => {
        p.upstream_summary = '0'.repeat(64);
      });
    assert.throws(
      () =>
        assertLabModelSourceSubmission(
          f.jobs,
          f.job.account_ref,
          final.request_id,
          final.operation,
          final.input,
        ),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    assert.throws(() => labModelSourceSummary(f.jobs, final), { code: 'IDEMPOTENCY_CONFLICT' });
  });

test('lineage rejects account changes, incomplete sources, missing parameters and retrofitted old requests', async (t) => {
  const f = await sourceFixture(t);
  assert.throws(
    () =>
      bindLabModelSourceDelivery(f.jobs, 'other-account', 'foreign', 'export', f.result, undefined, {
        project_id: 'studio-project',
      }),
    { code: 'LAB_MODEL_SOURCE_UNVERIFIED' },
  );
  assert.throws(
    () => bindLabModelSourceDelivery(f.jobs, f.job.account_ref, 'missing-params', 'export', f.result),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
  f.jobs.prepare(f.job.account_ref, 'old-request', 'export', { project_id: 'studio-project' }, quote);
  assert.throws(() => inherit(f, f.result, 'old-request', 'export', { project_id: 'studio-project' }), {
    code: 'IDEMPOTENCY_CONFLICT',
  });
  const pending = inherit(f, f.result, 'pending', 'texture', { project_id: 'studio-project' });
  assert.throws(() => inherit(f, pending, 'too-early', 'export', { project_id: 'studio-project' }), {
    code: 'IDEMPOTENCY_CONFLICT',
  });
  assert.throws(() => inherit(f, f.result, 'no-animate-guard', 'animate', { project_id: 'studio-project' }), {
    code: 'IDEMPOTENCY_CONFLICT',
  });
  const ordinary = f.jobs.prepare(
    f.job.account_ref,
    'ordinary-source',
    'remesh',
    { project_id: 'ordinary' },
    quote,
  );
  bindLabModelSourceDelivery(f.jobs, f.job.account_ref, 'ordinary-result', 'export', ordinary);
  assert.equal(f.jobs.requestPolicy(f.job.account_ref, 'lab-model-delivery:ordinary-result'), undefined);
  assert.equal(redoLabModelSourceSelection(f.jobs, ordinary, ordinary.input), undefined);
});

test('a persisted cycle or a changed source cannot acquire a replacement lineage marker', async (t) => {
  const f = await sourceFixture(t),
    pending = inherit(f, f.result, 'cycle-target', 'export', { project_id: 'studio-project' });
  const final = f.jobs.update(pending.job_id, 'succeeded', {
    remote_ids: { project_id: 'studio-project', operator_id: 'export-result' },
  });
  assert.throws(
    () => bindLabModelSourceDelivery(f.jobs, f.job.account_ref, final.request_id, 'export', undefined),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
  assert.throws(
    () =>
      bindLabModelSourceDelivery(
        f.jobs,
        f.job.account_ref,
        final.request_id,
        'export',
        final,
        undefined,
        final.input,
      ),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
  mutatePolicy(f, final.request_id, (p) => {
    p.upstream_job_id = final.job_id;
  });
  assert.throws(() => labModelSourceSummary(f.jobs, final), {
    code: 'IDEMPOTENCY_CONFLICT',
    message: /cycle/,
  });
});

test('redo restores direct and inherited source selections without changing the previous task', async (t) => {
  const f = await sourceFixture(t),
    before = structuredClone(f.result);
  const direct = redoPlan(f.result);
  assert.deepEqual(redoLabModelSourceSelection(f.jobs, f.result, direct.steps[0]!.parameters), {
    source: f.job.job_id,
    sourceRepresentation: 'studio_normalized',
  });
  const pending = inherit(f, f.result, 'redo-export', 'export', {
    project_id: 'studio-project',
    format: 'glb',
  });
  const final = f.jobs.update(pending.job_id, 'succeeded', {
    remote_ids: { project_id: 'studio-project', operator_id: 'export-result' },
  });
  const inherited = redoPlan(final);
  assert.deepEqual(redoLabModelSourceSelection(f.jobs, final, inherited.steps[0]!.parameters), {
    source: f.result.job_id,
  });
  assert.deepEqual(f.jobs.get(f.result.job_id), before);
  assert.throws(
    () =>
      redoLabModelSourceSelection(f.jobs, f.result, {
        ...direct.steps[0]!.parameters,
        expected_operator_id: 'other',
      }),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
});

test('seeded texture redo follows the original result and freezes its inherited source on recovery', async (t) => {
  const f = await sourceFixture(t, 'texture'),
    plan = redoPlan(f.result, 22),
    input = plan.steps[0]!.parameters;
  assert.equal(input.expected_operator_id, 'texture-result');
  const selection = redoLabModelSourceSelection(f.jobs, f.result, input)!;
  assert.deepEqual(selection, { source: f.result.job_id });
  const pending = inherit(f, f.result, 'texture-redo', 'texture', input);
  const restored = redoPlan(f.result, undefined, pending);
  assert.equal(restored.steps[0]!.parameters.texture_seed, 22);
  assert.deepEqual(redoLabModelSourceSelection(f.jobs, f.result, restored.steps[0]!.parameters), selection);
  bindLabModelSourceDelivery(
    f.jobs,
    f.job.account_ref,
    pending.request_id,
    'texture',
    f.result,
    undefined,
    restored.steps[0]!.parameters,
  );
  assert.equal(
    array(object(labModelSourceSummary(f.jobs, pending)!.lab_model_source).processing_lineage).length,
    2,
  );
});
