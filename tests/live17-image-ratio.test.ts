/** 网页取消比例选择时不发送 scale；显式模式不改变旧任务规范化后的 1:1 指纹。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { normalize } from '../studio/contracts/schemas.ts';
import { Operations } from '../studio/api/operations.ts';
import { StudioClient } from '../studio/api/client.ts';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import type { Job } from '../studio/contracts/types.ts';
import { generationPlan } from '../cli/compat/planning.ts';
import { fixture } from './helpers.ts';

test('explicit auto ratio reaches the webpage as an omitted field with the reference intact', async () => {
  const client = new StudioClient(
    new MemoryCredentials({
      cookie: 'fixture',
      deviceId: 'device',
      accountRef: 'test-account',
      importedAt: new Date().toISOString(),
    }),
    async () =>
      Response.json({
        code: 0,
        data: {
          asset_id: 'input',
          status: 'success',
          output: { data: [{ bucket: 'fixture', key: 'input.png', image_audit_result: 'pass' }] },
        },
      }),
  );
  const input = normalize('image', {
    prompt: 'a blue robot',
    model_version: 'gemini_3.1_flash_image_preview',
    image_asset: { asset_id: 'input' },
    scale: 'auto',
  });
  const request = await new Operations(client, []).build({ operation: 'image', input } as Job);
  assert.equal(request.route, '/v2/studio/image/gen_image_v2');
  assert.equal(Object.hasOwn(request.body, 'scale'), false);
  assert.deepEqual(request.body.image, {
    bucket: 'fixture',
    key: 'input.png',
    image_source: 'generate',
    image_audit_result: 'pass',
  });
  assert.equal(request.body.resolution, '1K');
  assert.equal(request.body.amount, 1);
  assert.equal(input.scale, 'auto');
});

test('auto is a Studio ratio extension and does not falsely accept unsupported official pixel sizes', () => {
  const plan = generationPlan('image-to-image', ['input.png'], {
    model: 'banana2',
    prompt: 'a blue robot',
    param: { scale: 'auto' },
  });
  assert.equal(plan.steps[0]!.parameters.scale, 'auto');
  assert.throws(() =>
    generationPlan('image-to-image', ['input.png'], {
      model: 'banana',
      prompt: 'robot',
      param: { size: '1024x1024', scale: 'auto' },
    }),
  );
  assert.throws(() =>
    generationPlan('text-to-image', ['robot'], { model: 'banana2', param: { size: 'auto' } }),
  );
});

test('default 1:1 and explicit auto remain distinct stable intents across task recovery', async () => {
  const f = await fixture();
  const parameters = { prompt: 'a blue robot', image_asset: { asset_id: 'input' } };
  try {
    assert.equal(normalize('image', parameters).scale, '1:1');
    const original = await f.service.submit('image', 'legacy-ratio', parameters, 10);
    const resumed = await f.service.submit('image', 'legacy-ratio', parameters, 10);
    assert.equal(resumed.job_id, original.job_id);
    await assert.rejects(f.service.submit('image', 'legacy-ratio', { ...parameters, scale: 'auto' }, 10), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    const automatic = await f.service.submit('image', 'auto-ratio', { ...parameters, scale: 'auto' }, 10);
    const restored = await f.service.submit('image', 'auto-ratio', { ...parameters, scale: 'auto' }, 10);
    assert.equal(automatic.job_id, restored.job_id);
    assert.equal(f.jobs.get(String(automatic.job_id)).input.scale, 'auto');
    assert.equal(f.gateway.posts, 2);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
