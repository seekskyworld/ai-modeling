/** 关闭贴图不应吞掉参数错误；检查 CLI 组合联动及其首次收费前边界。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generationPlan, processingPlan } from '../cli/compat/planning.ts';

const variants = [
  { name: 'text-to-model', inputs: ['cube'] },
  { name: 'image-to-model', inputs: ['front.png'] },
  { name: 'multiview-to-model', inputs: ['front.png', 'back.png'] },
];
const models = ['tripo-v3.1', 'tripo-v3.0', 'tripo-v2.5', 'tripo-p1', 'tripo-p2'];

test('invalid texture quality is rejected before planning a paid task even when final texture is off', () => {
  for (const variant of variants)
    for (const model of models)
      for (const linkage of [{ texture: false }, { generate_parts: true }])
        for (const texture_quality of ['invalid', 'ultra', '', 7, null, false, ['standard']])
          assert.throws(
            () =>
              generationPlan(variant.name, variant.inputs, {
                model,
                param: { ...linkage, texture_quality },
              }),
            { code: 'INVALID_INPUT', certainty: 'not_submitted' },
          );
});

test('public generation quality is validated before native enum translation for flags and params', () => {
  for (const variant of variants)
    for (const model of models)
      for (const texture of [false, true]) {
        for (const supplied of [
          { textureQuality: 'ultra', param: { texture } },
          { param: { texture, texture_quality: 'ultra' } },
        ])
          assert.throws(() => generationPlan(variant.name, variant.inputs, { model, ...supplied }), {
            code: 'INVALID_INPUT',
            certainty: 'not_submitted',
          });
        const plan = generationPlan(variant.name, variant.inputs, {
          model,
          param: { texture, texture_quality: 'extreme' },
        });
        if (!texture) assert.equal(plan.steps.length, 1);
        else assert.equal(plan.steps.at(-1)!.parameters.texture_quality, 'ultra');
      }
});

test('valid inactive texture qualities retain the same untextured request and no texture task', () => {
  for (const variant of variants)
    for (const model of models) {
      const baseline = generationPlan(variant.name, variant.inputs, { model, param: { texture: false } });
      for (const texture_quality of ['fast', 'standard', 'detailed', 'extreme']) {
        const plan = generationPlan(variant.name, variant.inputs, {
          model,
          param: { texture: false, texture_quality },
        });
        assert.equal(plan.steps.length, 1);
        assert.deepEqual(plan.steps[0]!.parameters, baseline.steps[0]!.parameters);
        assert.equal(plan.steps[0]!.requireTextureModel, undefined);
      }
    }
});

test('inactive fast quality still requires a legal explicit texture version', () => {
  for (const texture_version of ['v2.5', 'v3.0'])
    assert.throws(
      () =>
        generationPlan('text-to-model', ['cube'], {
          model: 'tripo-v3.1',
          param: { texture: false, texture_quality: 'fast', texture_version },
        }),
      { code: 'INVALID_INPUT' },
    );
  const plan = generationPlan('text-to-model', ['cube'], {
    model: 'tripo-v3.1',
    param: { texture: false, texture_quality: 'fast', texture_version: 'v3.5' },
  });
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0]!.parameters.texture, false);
});

test('standalone texture validates the public quality before upload and preserves extreme mapping', () => {
  for (const source of ['model.glb', 'task_audit']) {
    for (const supplied of [
      { textureQuality: 'ultra' },
      { param: { texture_quality: 'ultra' } },
      { textureQuality: 'extreme', param: { texture_quality: 'ultra' } },
    ])
      assert.throws(() => processingPlan('texture', source, supplied), {
        code: 'INVALID_INPUT',
        certainty: 'not_submitted',
      });
    for (const supplied of [
      { textureQuality: 'extreme' },
      { param: { texture_quality: 'extreme' } },
      { textureQuality: 'ultra', param: { texture_quality: 'extreme' } },
    ])
      assert.equal(
        processingPlan('texture', source, supplied).steps.at(-1)!.parameters.texture_quality,
        'ultra',
      );
  }
});
