/** Actual 1K + 4:3 artifacts have model-specific pixels; no arithmetic ratio or tier extrapolation. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fullToolPlan } from '../cli/compat/full-tools.ts';
import { generationPlan } from '../cli/compat/planning.ts';
import { Operations } from '../studio/api/operations.ts';
import type { StudioClient } from '../studio/api/client.ts';
import type { Job } from '../studio/contracts/types.ts';

test('exact observed landscape sizes map to their native model controls in CLI and full MCP', async () => {
  for (const [model, size, native] of [
    ['chat_image_2', '1536x1152', 'gpt_image_2'],
    ['chat_image_2.5_sunburst', '1536x1152', 'gpt_image_2.5_sunburst'],
    ['banana_pro', '1200x896', 'gemini_3_pro_image_preview'],
    ['gemini-3-pro', '1200x896', 'gemini_3_pro_image_preview'],
  ]) {
    const text = generationPlan('text-to-image', ['cube'], { model, param: { size } });
    const direct = generationPlan('text-to-image', ['cube'], {
      model,
      param: { resolution: '1K', scale: '4:3' },
    });
    assert.deepEqual(text.steps[0]!.parameters, direct.steps[0]!.parameters);
    for (const plan of [
      text,
      generationPlan('image-to-image', ['one.png', 'two.png'], { model, prompt: 'cube', param: { size } }),
      fullToolPlan('ai_modeling_generate_image', { model, prompt: 'cube', size }),
      fullToolPlan('ai_modeling_generate_image', {
        model,
        prompt: 'cube',
        size,
        inputs: ['one.png', 'two.png'],
      }),
    ]) {
      assert.equal(plan.steps.length, 1);
      assert.equal(plan.steps[0]!.operation, 'image');
      assert.equal(plan.steps[0]!.parameters.model_version, native);
      assert.equal(plan.steps[0]!.parameters.resolution, '1K');
      assert.equal(plan.steps[0]!.parameters.scale, '4:3');
      assert.equal(plan.steps[0]!.parameters.size, undefined);
    }
    const request = await new Operations({} as StudioClient, []).build({
      operation: 'image',
      input: text.steps[0]!.parameters,
    } as Job);
    assert.equal(request.route, '/v2/studio/image/gen_image_v2');
    assert.equal(request.body.model_version, native);
    assert.equal(request.body.resolution, '1K');
    assert.equal(request.body.scale, '4:3');
  }
});

test('landscape aliases remain model-specific and reject unverified sizes and conflicting controls', () => {
  for (const [model, size] of [
    ['chat_image_2', '1536x1152'],
    ['chat_image_2.5_sunburst', '1536x1152'],
    ['banana_pro', '1200x896'],
  ]) {
    for (const conflict of [
      { scale: 'auto' },
      { scale: '1:1' },
      { scale: '3:4' },
      { resolution: '2K' },
      { resolution: '4K' },
    ]) {
      assert.throws(
        () => generationPlan('text-to-image', ['cube'], { model, param: { size, ...conflict } }),
        { code: 'INVALID_INPUT' },
      );
    }
  }
  for (const [model, sizes] of [
    ['chat_image_2', ['1200x896', '1152x1535', '1024x768']],
    ['chat_image_2.5_sunburst', ['1200x896', '1152x1535', '1024x768']],
    ['banana_pro', ['1536x1152', '896x1199', '1184x864']],
    ['banana', ['1200x896', '1536x1152']],
    ['banana2', ['1200x896', '1536x1152']],
  ] as const)
    for (const size of sizes) {
      assert.throws(() => generationPlan('text-to-image', ['cube'], { model, param: { size } }));
    }
});
