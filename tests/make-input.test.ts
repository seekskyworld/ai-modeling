/** 输入误分类可能花费模型积分，覆盖引用、混合类型与真实文件边界而非仅镜像字段。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyMakeInputs } from '../cli/compat/make-input.ts';
import { makePlan } from '../cli/compat/planning.ts';

test('make keeps task and upload identities out of text generation', () => {
  for (const input of ['task_example', '@last', '@named', '11111111-1111-4111-8111-111111111111'])
    assert.equal(classifyMakeInputs([input]).kind, 'reference');
  assert.throws(() => classifyMakeInputs(['file_example']), {
    code: 'STUDIO_CAPABILITY_UNAVAILABLE',
    certainty: 'not_submitted',
  });
  assert.equal(classifyMakeInputs(['studio_file_model_example']).kind, 'model');
  assert.equal(classifyMakeInputs(['studio_file_image_example']).kind, 'image');
  assert.throws(() => classifyMakeInputs(['studio_file_unknown']), { code: 'INVALID_INPUT' });
  for (const inputs of [
    ['@last', 'ignored'],
    ['one.glb', 'two.glb'],
    ['one.glb', 'front.png'],
    ['front.png', 'a cube'],
  ])
    assert.throws(() => classifyMakeInputs(inputs), { code: 'INVALID_INPUT', certainty: 'not_submitted' });
});

test('supported image paths and URLs keep roles without network access', () => {
  for (const value of [
    '~/assets/front.png',
    './assets/front.jpg',
    '/tmp/front image.webp',
    'https://example.test/image',
  ])
    assert.equal(classifyMakeInputs([value]).kind, 'image');
  assert.equal(classifyMakeInputs(['https://example.test/model.glb?version=2']).kind, 'model');
  assert.equal(classifyMakeInputs(['front.png', 'https://example.test/back.jpeg']).kind, 'multiview');
  assert.equal(classifyMakeInputs(['front.png', 'left.png', 'back.png', 'right.png']).values.length, 4);
  assert.throws(() => classifyMakeInputs(['front.png', 'left.png', 'back.png', 'right.png', 'extra.png']));
  assert.throws(() => classifyMakeInputs(['https://user:secret@example.test/front.png']));
  assert.throws(() => classifyMakeInputs(['https://']));
  assert.deepEqual(classifyMakeInputs(['a', 'blue', 'robot']), {
    kind: 'text',
    values: ['a', 'blue', 'robot'],
  });
  assert.equal(classifyMakeInputs(['a robot wearing red/blue clothes']).kind, 'text');
});

test('existing unsupported files and typo paths are rejected instead of generating their names', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tripo-make-input-'));
  try {
    for (const name of ['unsupported.txt', 'image.bmp', 'image.tiff', 'without-extension']) {
      const file = path.join(dir, name);
      await writeFile(file, 'classification fixture');
      assert.throws(() => classifyMakeInputs([file]), { certainty: 'not_submitted' });
    }
    assert.throws(() => classifyMakeInputs([dir]), { code: 'INVALID_INPUT' });
    for (const file of ['./missing.blend', '../missing.objx', '/tmp/no such model.blend'])
      assert.throws(() => classifyMakeInputs([file]), { code: 'INVALID_INPUT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('make planner preserves task sources and rejects incompatible inputs before generation', () => {
  const referenced = makePlan(['task_example'], { then: 'texture' });
  assert.equal(referenced.steps.length, 1);
  assert.equal(referenced.steps[0]?.operation, 'texture');
  assert.equal(referenced.sourceValidation?.reference, 'task_example');
  for (const inputs of [
    ['file_example'],
    ['task_example', 'ignored'],
    ['first.glb', 'second.glb'],
    ['first.glb', 'front.png'],
    ['front.png', 'a blue robot'],
    ['image.bmp'],
    ['./missing.blend'],
  ])
    assert.throws(() => makePlan(inputs, { then: 'texture' }), { certainty: 'not_submitted' });
  const multiview = makePlan(['front.png', 'back.png'], {});
  assert.equal(multiview.steps[0]?.parameters.mode, 'multiview');
  assert.deepEqual(multiview.steps[0]?.parameters.image_paths, [
    path.resolve('front.png'),
    null,
    path.resolve('back.png'),
    null,
  ]);
  const prompt = makePlan(['a', 'blue', 'robot'], {});
  assert.equal(prompt.steps[0]?.parameters.prompt, 'a blue robot');
});
