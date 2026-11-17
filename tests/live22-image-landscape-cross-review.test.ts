/** 横图精确别名保留原生字段和旧请求意图，不按数学比例外推未经验证的尺寸。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rm } from 'node:fs/promises';
import { generationPlan } from '../cli/compat/planning.ts';
import { fullToolPlan } from '../cli/compat/full-tools.ts';
import { fixture } from './helpers.ts';

const cases = [
  ['chat_image_2', '1536x1152', '1152x1535', '1200x896'],
  ['chat_image_2.5_sunburst', '1536x1152', '1152x1535', '1200x896'],
  ['banana_pro', '1200x896', '896x1199', '1536x1152'],
] as const;

test('exact landscape aliases reject conflicting controls, unverified dimensions and another model dimensions', () => {
  for (const [model, size, unverified, foreign] of cases) {
    for (const param of [
      { size, resolution: null },
      { size, resolution: '2K' },
      { size, resolution: '4K' },
      { size, scale: null },
      { size, scale: false },
      { size, scale: 'auto' },
      { size, scale: '1:1' },
      { size, scale: '3:4' },
      { size, scale: '16:9' },
    ])
      assert.throws(() => generationPlan('text-to-image', ['cube'], { model, param }), {
        code: 'INVALID_INPUT',
      });
    for (const candidate of [unverified, foreign, '1600x1200', '800x600'])
      assert.throws(() => generationPlan('text-to-image', ['cube'], { model, param: { size: candidate } }), {
        code: 'STUDIO_CAPABILITY_UNAVAILABLE',
      });
  }
});

test('landscape aliases keep equivalent native payloads; exact delivery intention is stored separately', async () => {
  for (const [model, size] of cases) {
    const f = await fixture();
    try {
      const native = generationPlan('text-to-image', ['cube'], {
        model,
        param: { resolution: '1K', scale: '4:3' },
      });
      const alias = generationPlan('text-to-image', ['cube'], { model, param: { size } });
      const full = fullToolPlan('ai_modeling_generate_image', { model, prompt: 'cube', size });
      assert.equal(alias.steps.length, 1);
      assert.equal(full.steps.length, 1);
      assert.deepEqual(alias.steps[0]!.parameters, native.steps[0]!.parameters);
      assert.deepEqual(full.steps[0]!.parameters, native.steps[0]!.parameters);
      assert.ok(alias.steps[0]!.imageSize);
      assert.equal(native.steps[0]!.imageSize, undefined);
      const first = await f.service.submit('image', 'native-landscape', native.steps[0]!.parameters, 20);
      const recovered = await f.service.submit('image', 'native-landscape', alias.steps[0]!.parameters, 20);
      assert.equal(recovered.job_id, first.job_id);
      assert.equal(f.gateway.posts, 1);
      assert.deepEqual(f.jobs.get(String(first.job_id)).input, native.steps[0]!.parameters);
      const square = generationPlan('text-to-image', ['cube'], { model }).steps[0]!.parameters;
      await assert.rejects(f.service.submit('image', 'native-landscape', square, 20), {
        code: 'IDEMPOTENCY_CONFLICT',
      });
      assert.equal(f.gateway.posts, 1);
    } finally {
      f.jobs.close();
      await rm(f.dir, { recursive: true, force: true });
    }
  }
});
