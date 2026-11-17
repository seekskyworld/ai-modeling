/** 网页另存模型保留 copy 展示身份，但可作为后续模型处理来源；不能伪造骨架或分割类型。 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { fixture, quote } from './helpers.ts';
import { taskType } from '../studio/contracts/task-type.ts';
import type { Job } from '../studio/contracts/types.ts';
import { parseChain } from '../cli/compat/chain.ts';
import { validateCompatibilityChain } from '../cli/compat/chain-policy.ts';
import { processingPlan, type Flags } from '../cli/compat/planning.ts';
import { executePlan, taskResult, type Application } from '../cli/compat/runtime.ts';

async function copiedModel(t: TestContext) {
  const f = await fixture();
  t.after(async () => {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  });
  const saved = f.jobs.prepare(
    'test-account',
    'original-copy',
    'copy',
    {
      project_id: 'original-project',
      operator_id: 'original-operator',
    },
    quote,
  );
  const source = f.jobs.update(saved.job_id, 'succeeded', {
    remote_ids: { project_id: 'copied-project', operator_id: 'copied-operator' },
    artifacts: [{ artifact_id: 'model', kind: 'model', format: 'glb', index: 0 }],
  });
  const submissions: Job[] = [];
  f.gateway.submit = async (job) => {
    submissions.push(structuredClone(job));
    return { remote_ids: { project_id: 'copied-project', operator_id: 'processed-operator' } };
  };
  f.gateway.status = async () => ({ state: 'succeeded', progress: 100, artifacts: [] });
  const app = {
    service: f.service,
    studio: {
      client: {
        request: async () => {
          throw new Error('This fixture permits no HTTP reads');
        },
      },
    },
    close: () => {},
  } as unknown as Application;
  return { ...f, app, source, submissions };
}

test('copy is a model-producing source without changing its public task type', async (t) => {
  const f = await copiedModel(t);
  assert.equal(taskType(f.source), 'copy');
  assert.equal(taskResult(await f.service.get(f.source.job_id)).type, 'copy');
  for (const chain of [
    'convert:glb',
    'texture',
    'decimate',
    'uv',
    'segment',
    'edit',
    'rig-check',
    'rig',
    'segment,complete,convert:glb',
    'rig-check,rig,retarget:preset:walk',
  ])
    assert.doesNotThrow(() => validateCompatibilityChain(parseChain(chain), taskType(f.source)), chain);
  assert.equal(f.submissions.length, 0);
});

for (const [command, flags, operation, outputType] of [
  [
    'convert',
    { format: 'glb', param: { texture_format: 'PNG', with_animation: false } },
    'export',
    'convert_model',
  ],
  [
    'texture',
    { param: { texture_prompt: { text: 'blue ceramic' }, pbr: false } },
    'texture',
    'texture_model',
  ],
] as const) {
  test(`standalone ${command} processes the copied project without another copy and resumes the original request`, async (t) => {
    const f = await copiedModel(t),
      plan = () => processingPlan(command, f.source.job_id, flags as Flags),
      execution = { download: false, requestId: `copy-${command}` };
    const result = await executePlan(f.app, plan(), execution);
    assert.equal(result.status, 'success');
    assert.equal(result.type, outputType);
    assert.equal(f.submissions.length, 1);
    assert.equal(f.submissions[0]!.operation, operation);
    assert.equal(f.submissions[0]!.input.project_id, 'copied-project');
    assert.notEqual(f.submissions[0]!.input.project_id, f.source.input.project_id);
    const again = await executePlan(f.app, plan(), execution);
    assert.equal(again.task_id, result.task_id);
    assert.equal(f.submissions.length, 1);
    assert.equal(taskResult(await f.service.get(f.source.job_id)).type, 'copy');
    assert.deepEqual(f.jobs.get(f.source.job_id), f.source);
  });
}

test('copy still requires real segmentation or rigging before completion or retargeting', async (t) => {
  const f = await copiedModel(t);
  for (const [command, param, required] of [
    ['complete', { part_names: ['part'] }, 'mesh_segmentation'],
    ['retarget', { animation: 'preset:walk', export_with_geometry: false }, 'animate_rig'],
  ] as const) {
    await assert.rejects(
      executePlan(f.app, processingPlan(command, f.source.job_id, { param }), {
        download: false,
        requestId: `invalid-copy-${command}`,
      }),
      {
        code: 'INVALID_INPUT',
        certainty: 'not_submitted',
        message: `${command} requires ${required}, but the preceding step produces copy.`,
      },
    );
    assert.equal(f.jobs.find(f.source.account_ref, `invalid-copy-${command}-0`), undefined);
  }
  for (const expression of ['texture,complete', 'rig,texture,retarget:preset:walk'])
    assert.throws(() => validateCompatibilityChain(parseChain(expression), 'copy'), {
      code: 'INVALID_INPUT',
    });
  assert.equal(f.submissions.length, 0);
});
