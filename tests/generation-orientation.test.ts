/** 官方图片朝向仅对最终贴图生效；检查跨模型、联动和 MCP→CLI 的提交边界。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generationPlan } from '../cli/compat/planning.ts';
import { fullToolPlan } from '../cli/compat/full-tools.ts';

const variants = [
  {
    name: 'image-to-model',
    inputs: ['front.png'],
    tool: 'ai_modeling_image_to_3d',
    source: { input: 'front.png' },
  },
  {
    name: 'multiview-to-model',
    inputs: ['front.png', 'back.png'],
    tool: 'ai_modeling_multiview_to_3d',
    source: { front: 'front.png', back: 'back.png' },
  },
];
const models = ['tripo-v3.1', 'tripo-v3.0', 'tripo-v2.5', 'tripo-p1', 'tripo-p2'];

test('inactive image orientation preserves the exact untextured generation across H/P and full MCP', () => {
  for (const variant of variants) {
    for (const model of models) {
      const base = generationPlan(variant.name, variant.inputs, { model, param: { texture: false } });
      const aligned = generationPlan(variant.name, variant.inputs, {
        model,
        param: { texture: false, orientation: 'align_image' },
      });
      assert.deepEqual(
        aligned.steps,
        base.steps.map((step, i) => ({
          ...step,
          warnings: aligned.steps[i]!.warnings,
        })),
      );
      assert.equal(aligned.steps.length, 1);
      assert.equal(aligned.steps[0]!.parameters.texture, false);
      assert.ok(aligned.warnings.some((warning) => warning.includes('has no effect with texture=false')));
      const mcp = fullToolPlan(variant.tool, {
        ...variant.source,
        model,
        texture: false,
        orientation: 'align_image',
      });
      assert.equal(mcp.steps.length, 1);
      assert.equal(mcp.steps[0]!.parameters.orientation, undefined);
      assert.equal(mcp.steps[0]!.parameters.texture, false);
    }
  }
});

test('parts may disable image orientation only after the final PBR/texture linkage', () => {
  for (const variant of variants) {
    const flags = { model: 'tripo-v3.1', param: { generate_parts: true, pbr: true } };
    const base = generationPlan(variant.name, variant.inputs, flags);
    const aligned = generationPlan(variant.name, variant.inputs, {
      ...flags,
      param: { ...flags.param, orientation: 'align_image' },
    });
    assert.deepEqual(aligned.steps[0]!.parameters, base.steps[0]!.parameters);
    assert.equal(aligned.steps[0]!.parameters.texture, false);
    for (const model of models) {
      for (const param of [
        { orientation: 'align_image' },
        { orientation: 'align_image', texture: true },
        { orientation: 'align_image', texture: false, pbr: true },
        { orientation: 'invalid', texture: false },
      ])
        assert.throws(() => generationPlan(variant.name, variant.inputs, { model, param }));
    }
    for (const model of ['tripo-p1', 'tripo-p2']) {
      // P 系列会先移除不支持的 parts，不能借此把原本开启的贴图当成关闭。
      assert.throws(() =>
        generationPlan(variant.name, variant.inputs, {
          model,
          param: { generate_parts: true, orientation: 'align_image' },
        }),
      );
    }
  }
  assert.throws(() =>
    generationPlan('text-to-model', ['cube'], {
      model: 'tripo-v3.1',
      param: { texture: false, orientation: 'align_image' },
    }),
  );
});
