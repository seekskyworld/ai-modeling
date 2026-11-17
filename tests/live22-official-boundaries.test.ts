/** 系统官方构造器差分发现的付费前漏洞：原始无效值不能静默变成另一种有效任务。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fullToolPlan } from '../cli/compat/full-tools.ts';
import { generationPlan, processingPlan } from '../cli/compat/planning.ts';
import { normalize } from '../studio/contracts/schemas.ts';

const invalid = { code: 'INVALID_INPUT', certainty: 'not_submitted' };

test('explicit invalid convert face limit cannot request default paid retopology', () => {
  for (const source of ['model.glb', 'task_audit'])
    for (const value of [null, '', false, [], 0.5, Number.NaN, Infinity])
      for (const flags of [
        { format: 'GLTF', faceLimit: value },
        { format: 'GLTF', param: { face_limit: value } },
        { format: 'GLTF', faceLimit: 500, param: { face_limit: value } },
      ])
        assert.throws(() => processingPlan('convert', source, flags), invalid);
  assert.equal(processingPlan('convert', 'task_audit', { format: 'GLTF' }).steps.length, 1);
  assert.equal(
    processingPlan('convert', 'task_audit', { format: 'GLTF', faceLimit: 100 }).steps[0]!.parameters
      .face_limit,
    100,
  );
});

test('invalid explicit rig spec cannot silently select the default skeleton', () => {
  for (const source of ['model.glb', 'task_audit'])
    for (const spec of [null, '', false, 0, [], '__invalid__'])
      assert.throws(() => processingPlan('rig', source, { spec }), invalid);
  for (const spec of ['tripo', 'mixamo', 'actorcore', 'unity', 'unreal', 'vrm'])
    assert.equal(
      processingPlan('rig', 'task_audit', { model: 'v3.0', spec }).steps[0]!.parameters.skeleton_preset,
      spec,
    );
});

test('explicit empty or malformed full image references never fall back to text-to-image', () => {
  for (const value of ['', ' ', null, false, 0, [], {}, [''], [null]])
    for (const key of ['input', 'inputs'])
      assert.throws(
        () => fullToolPlan('ai_modeling_generate_image', { prompt: 'cube', model: 'banana2', [key]: value }),
        invalid,
      );
  assert.throws(
    () =>
      fullToolPlan('ai_modeling_generate_image', {
        prompt: 'cube',
        input: 'front.png',
        inputs: ['back.png'],
      }),
    invalid,
  );
  const edited = fullToolPlan('ai_modeling_generate_image', {
    prompt: 'cube',
    model: 'banana2',
    input: 'front.png',
  });
  assert.match(String(edited.steps[0]!.parameters.image_path), /front\.png$/);
  const generated = fullToolPlan('ai_modeling_generate_image', { prompt: 'cube', model: 'banana2' });
  assert.equal(generated.steps[0]!.parameters.image_path, undefined);
});

test('official image templates keep endpoint roles and raw model spelling before normalization', () => {
  for (const name of ['text-to-image', 'image-to-image']) {
    const input = name === 'text-to-image' ? ['cube'] : ['front.png'];
    for (const template of [null, '', 0, false, '__invalid__'])
      assert.throws(
        () => generationPlan(name, input, { model: 'banana2', prompt: 'cube', param: { template } }),
        invalid,
      );
    for (const model of ['banana2 ', ' banana2', 'gemini-3.1-flash '])
      assert.throws(() => generationPlan(name, input, { model, prompt: 'cube' }), invalid);
  }
  assert.throws(
    () => generationPlan('text-to-image', ['cube'], { model: 'banana2', param: { template: '3d_enhance' } }),
    invalid,
  );
  assert.throws(
    () =>
      generationPlan('image-to-image', ['front.png'], {
        model: 'banana2',
        prompt: 'cube',
        param: { template: 'asset_extraction' },
      }),
    invalid,
  );
  assert.equal(
    generationPlan('image-to-image', ['front.png'], { model: 'banana2', param: { template: '3d_enhance' } })
      .steps[0]!.parameters.template_name,
    '3d_enhance',
  );
  assert.equal(
    generationPlan('text-to-image', ['cube'], { model: 'banana2', param: { template: 'asset_extraction' } })
      .steps[0]!.parameters.template_name,
    'asset_extraction',
  );
  assert.equal(
    normalize('image', { prompt: 'cube', template_name: '3d_enhance' }).template_name,
    '3d_enhance',
  );
});

test('image edit primary and extra references share the official total limit', () => {
  const images = Array.from({ length: 11 }, (_, index) => `image-${index}.png`);
  for (const model of ['banana', 'banana2', 'banana_pro']) {
    assert.throws(
      () => generationPlan('image-to-image', images, { model, prompt: 'cube', editBase: true }),
      invalid,
    );
    const plan = generationPlan('image-to-image', images.slice(0, 10), {
      model,
      prompt: 'cube',
      editBase: true,
    });
    assert.equal((plan.steps[0]!.parameters.image_paths as string[]).length, 9);
  }
});

test('official image prompt length counts trimmed text for generation and editing', () => {
  const padding = ' '.repeat(1000);
  for (const kind of ['text-to-image', 'image-to-image']) {
    const prompt = padding + 'x'.repeat(1800) + padding;
    const input = kind === 'text-to-image' ? [prompt] : ['front.png'];
    const plan = generationPlan(kind, input, { model: 'banana2', prompt });
    assert.equal(plan.steps[0]!.parameters.prompt, 'x'.repeat(1800));
    const tooLong = padding + 'x'.repeat(1801) + padding;
    assert.throws(
      () =>
        generationPlan(kind, kind === 'text-to-image' ? [tooLong] : ['front.png'], {
          model: 'banana2',
          prompt: tooLong,
        }),
      { code: 'INVALID_INPUT' },
    );
  }
});
