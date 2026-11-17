/** 显式减面引擎必须先校验，不能把空值静默换成网页 default 并提交导入或收费任务。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { processingPlan } from '../cli/compat/planning.ts';
import { normalize } from '../studio/contracts/schemas.ts';

test('invalid explicit decimate models fail before any source import or remesh plan', () => {
  for (const source of ['model.glb', 'task_audit'])
    for (const model of ['', ' ', null, false, 0, []])
      for (const flags of [{ model }, { param: { model } }, { model: 'default', param: { model } }])
        assert.throws(() => processingPlan('decimate', source, flags), {
          code: 'INVALID_INPUT',
          certainty: 'not_submitted',
        });
});

test('valid default remesh keeps its native plan and fixed engines remain explicit gaps', () => {
  const baseline = processingPlan('decimate', 'task_audit', { param: { face_limit: 1000 } });
  const explicit = processingPlan('decimate', 'task_audit', {
    param: { model: 'default', face_limit: 1000 },
  });
  assert.deepEqual(explicit.steps, baseline.steps);
  assert.equal(explicit.steps.length, 1);
  assert.equal(explicit.steps[0]!.operation, 'remesh');
  for (const model of ['v1.0', 'v2.0', 'v3.0'])
    assert.throws(() => processingPlan('decimate', 'task_audit', { param: { model, face_limit: 1000 } }), {
      code: 'STUDIO_CAPABILITY_UNAVAILABLE',
    });
});

test('official default decimate rejects out-of-range face limits before import or a paid step', () => {
  for (const source of ['model.glb', 'task_audit'])
    for (const model of [undefined, 'default'])
      for (const quad of [false, true]) {
        const maximum = quad ? 10000 : 20000;
        for (const faceLimit of [100, 499, maximum + 1, 150000])
          for (const supplied of [
            { model, quad, faceLimit },
            { param: { model, quad, face_limit: faceLimit } },
            { faceLimit: 500, param: { model, quad, face_limit: faceLimit } },
          ])
            assert.throws(() => processingPlan('decimate', source, supplied), {
              code: 'INVALID_INPUT',
              certainty: 'not_submitted',
            });
        for (const faceLimit of [500, maximum])
          assert.equal(
            processingPlan('decimate', source, {
              model,
              quad,
              faceLimit: 100,
              param: { face_limit: faceLimit },
            }).steps.at(-1)!.parameters.face_limit,
            faceLimit,
          );
      }
});

test('native web remesh and convert internal remesh keep their separately supported face range', () => {
  assert.equal(normalize('remesh', { project_id: 'project', face_limit: 100 }).face_limit, 100);
  const convert = processingPlan('convert', 'task_audit', { format: 'GLTF', faceLimit: 100 });
  assert.equal(convert.steps[0]!.operation, 'remesh');
  assert.equal(convert.steps[0]!.parameters.face_limit, 100);
});
