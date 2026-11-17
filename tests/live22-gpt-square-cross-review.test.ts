/** 精确平方尺寸不能改变已存请求，也不能吞掉调用方显式冲突的网页控制。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rm } from 'node:fs/promises';
import { generationPlan } from '../cli/compat/planning.ts';
import { applyImageSize } from '../cli/compat/image-size.ts';
import { fixture } from './helpers.ts';

test('exact GPT square rejects invalid or conflicting controls before planning any operation', () => {
  for (const model of ['chat_image_2', 'chat_image_2.5_sunburst']) {
    for (const key of ['resolution', 'scale'])
      for (const value of [null, false, 0, [], {}, '', 'auto', '2K', '16:9'])
        assert.throws(
          () =>
            generationPlan('text-to-image', ['cube'], {
              model,
              param: { size: '1024x1024', [key]: value },
            }),
          { code: 'INVALID_INPUT' },
        );
    for (const size of [null, false, 1024, {}, '1024x1025', '1025x1024', '2048x2048', '4096x4096'])
      assert.throws(() => generationPlan('text-to-image', ['cube'], { model, param: { size } }));
  }
  for (const native of ['gpt_4o', 'gpt_image_1.5', 'flux.1_dev', 'flux.1_kontext_pro', 'midjourney'])
    assert.throws(() => applyImageSize({ size: '1024x1024' }, native), {
      code: 'STUDIO_CAPABILITY_UNAVAILABLE',
    });
});

test('new GPT square spelling recovers equivalent old native input and cannot rewrite a different size intent', async () => {
  for (const model of ['chat_image_2', 'chat_image_2.5_sunburst']) {
    const f = await fixture();
    try {
      const legacy = generationPlan('text-to-image', ['cube'], { model }).steps[0]!.parameters;
      const exact = generationPlan('text-to-image', ['cube'], { model, param: { size: '1024x1024' } })
        .steps[0]!.parameters;
      assert.deepEqual(exact, legacy);
      const original = await f.service.submit('image', 'legacy-square', legacy, 20);
      const restored = await f.service.submit('image', 'legacy-square', exact, 20);
      assert.equal(restored.job_id, original.job_id);
      assert.equal(f.gateway.posts, 1);
      assert.deepEqual(f.jobs.get(String(original.job_id)).input, legacy);
      const rectangular = generationPlan('text-to-image', ['cube'], {
        model,
        param: { resolution: '1K', scale: '16:9' },
      }).steps[0]!.parameters;
      const other = await f.service.submit('image', 'legacy-rectangle', rectangular, 20);
      await assert.rejects(f.service.submit('image', 'legacy-rectangle', exact, 20), {
        code: 'IDEMPOTENCY_CONFLICT',
      });
      assert.equal(f.gateway.posts, 2);
      assert.deepEqual(f.jobs.get(String(other.job_id)).input, rectangular);
    } finally {
      f.jobs.close();
      await rm(f.dir, { recursive: true, force: true });
    }
  }
});
