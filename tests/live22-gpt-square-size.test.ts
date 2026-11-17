/** Exact GPT square dimensions map to the verified native controls; never resize after generation. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fullToolPlan } from '../cli/compat/full-tools.ts';
import { generationPlan } from '../cli/compat/planning.ts';
import { Operations } from '../studio/api/operations.ts';
import type { StudioClient } from '../studio/api/client.ts';
import type { Job } from '../studio/contracts/types.ts';

test('verified GPT square size uses the same single native image operation in CLI and full MCP', async () => {
  for (const [model, native] of [
    ['chat_image_2', 'gpt_image_2'],
    ['chat_image_2.5_sunburst', 'gpt_image_2.5_sunburst'],
  ]) {
    const text = generationPlan('text-to-image', ['cube'], { model, param: { size: '1024x1024' } });
    const image = generationPlan('image-to-image', ['source.png'], {
      model,
      prompt: 'cube',
      param: { size: '1024x1024' },
    });
    const full = fullToolPlan('ai_modeling_generate_image', { model, prompt: 'cube', size: '1024x1024' });
    const fullImage = fullToolPlan('ai_modeling_generate_image', {
      model,
      prompt: 'cube',
      size: '1024x1024',
      inputs: ['one.png', 'two.png'],
    });
    for (const plan of [text, image, full, fullImage]) {
      assert.equal(plan.steps.length, 1);
      const step = plan.steps[0]!;
      assert.equal(step.operation, 'image');
      assert.equal(step.parameters.model_version, native);
      assert.equal(step.parameters.resolution, '1K');
      assert.equal(step.parameters.scale, '1:1');
      assert.equal(step.parameters.size, undefined);
    }
    const request = await new Operations({} as StudioClient, []).build({
      operation: 'image',
      input: text.steps[0]!.parameters,
    } as Job);
    assert.equal(request.route, '/v2/studio/image/gen_image_v2');
    assert.equal(request.body.resolution, '1K');
    assert.equal(request.body.scale, '1:1');
    assert.equal(request.body.model_version, native);
    assert.equal(request.body.size, undefined);
  }
});

test('GPT exact square rejects contradictory controls and keeps unverified sizes and models closed', () => {
  for (const model of ['chat_image_2', 'chat_image_2.5_sunburst']) {
    for (const param of [
      { size: '1024x1024', scale: 'auto' },
      { size: '1024x1024', scale: '16:9' },
      { size: '1024x1024', resolution: '2K' },
      { size: '1024x1024', resolution: '4K' },
      { size: '2048x2048' },
      { size: '1024x1536' },
      { size: '1536x1024' },
      { size: 'auto' },
    ])
      assert.throws(() => generationPlan('text-to-image', ['cube'], { model, param }));
    const ignored = generationPlan('text-to-image', ['cube'], {
      model,
      param: { size: '1024x1024', aspect_ratio: '16:9' },
    });
    assert.equal(ignored.steps[0]!.parameters.scale, '1:1');
    assert.ok(ignored.warnings.some((warning) => warning.includes('aspect_ratio')));
  }
  for (const model of ['chat_image_1.5', 'chat_image_2.5_flare', 'banana2']) {
    assert.throws(() => generationPlan('text-to-image', ['cube'], { model, param: { size: '1024x1024' } }));
  }
});
