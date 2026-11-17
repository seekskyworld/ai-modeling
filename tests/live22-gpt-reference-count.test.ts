/** 当前网页GPT2/2.5的普通有序引用和主图+追加引用链：总16张，不外推其它模型。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fullToolPlan } from '../cli/compat/full-tools.ts';
import { generationPlan } from '../cli/compat/planning.ts';
import { normalize } from '../studio/contracts/schemas.ts';

const references = Array.from({ length: 17 }, (_, index) => `image-${index}.png`);
const asset = (index: number) => ({ asset_id: `asset-${index}`, output_index: 0 });

test('GPT2 and GPT2.5 explicit primary permit fifteen additional references across native source forms', () => {
  const variants: Record<string, unknown>[] = [
    { image_path: 'primary.png', image_paths: references.slice(0, 15) },
    { image_asset: asset(0), image_assets: references.slice(0, 15).map((_, index) => asset(index + 1)) },
    {
      image_asset: asset(0),
      image_sources: references
        .slice(0, 15)
        .map((file, index) => (index % 2 ? { image_path: file } : asset(index + 1))),
    },
  ];
  for (const model_version of ['gpt_image_2', 'gpt_image_2.5_sunburst'])
    for (const variant of variants) {
      const normalized = normalize('image', { model_version, prompt: 'cube', ...variant });
      const key =
        'image_paths' in variant
          ? 'image_paths'
          : 'image_assets' in variant
            ? 'image_assets'
            : 'image_sources';
      assert.equal((normalized[key] as unknown[]).length, 15);
      const invalid = {
        ...variant,
        [key]: [...(variant[key] as unknown[]), key === 'image_paths' ? 'extra.png' : asset(99)],
      };
      assert.throws(() => normalize('image', { model_version, prompt: 'cube', ...invalid }));
    }
});

test('other image models retain ten additional references while generic GPT2 counts all sixteen', () => {
  for (const model_version of ['gpt_image_1.5', 'gemini_3.1_flash_image_preview', 'flux.1_kontext_pro']) {
    assert.doesNotThrow(() =>
      normalize('image', {
        model_version,
        prompt: 'cube',
        image_path: 'primary.png',
        image_paths: references.slice(0, 10),
      }),
    );
    assert.throws(() =>
      normalize('image', {
        model_version,
        prompt: 'cube',
        image_path: 'primary.png',
        image_paths: references.slice(0, 11),
      }),
    );
  }
  assert.doesNotThrow(() =>
    normalize('image', {
      model_version: 'gpt_image_2',
      prompt: 'cube',
      image_paths: references.slice(0, 16),
    }),
  );
  assert.throws(() =>
    normalize('image', {
      model_version: 'gpt_image_2',
      prompt: 'cube',
      image_paths: references.slice(0, 17),
    }),
  );
});

test('explicit GPT2 edit-base preserves primary and every ordered mixed reference through planning', () => {
  const mixed = ['11111111-1111-4111-8111-111111111111', ...references.slice(1, 16)];
  mixed[15] = '22222222-2222-4222-8222-222222222222';
  const plan = generationPlan('image-to-image', mixed, {
    model: 'chat_image_2',
    prompt: 'cube',
    editBase: true,
  });
  const step = plan.steps[0]!;
  assert.equal((step.parameters.image_sources as unknown[]).length, 15);
  assert.deepEqual(step.imageReferences, [
    { reference: mixed[0], target: 'image_asset' },
    { reference: mixed[15], target: 'image_sources', index: 14 },
  ]);
  assert.equal((step.parameters.image_sources as { asset_id?: string }[])[14]!.asset_id, 'cli-reference-15');
  assert.throws(() =>
    generationPlan('image-to-image', references, { model: 'chat_image_2', prompt: 'cube', editBase: true }),
  );
  assert.doesNotThrow(() =>
    generationPlan('image-to-image', references.slice(0, 16), {
      model: 'chat_image_2.5_sunburst',
      prompt: 'cube',
      editBase: true,
    }),
  );
  assert.throws(() =>
    generationPlan('image-to-image', references.slice(0, 11), {
      model: 'banana2',
      prompt: 'cube',
      editBase: true,
    }),
  );
});

test('full MCP accepts sixteen ordered GPT2 and GPT2.5 inputs without inventing a primary image', () => {
  for (const model of ['chat_image_2', 'chat_image_2.5_sunburst']) {
    const step = fullToolPlan('ai_modeling_generate_image', {
      model,
      prompt: 'cube',
      inputs: references.slice(0, 16),
    }).steps[0]!;
    assert.equal((step.parameters.image_paths as string[]).length, 16);
    assert.equal(step.parameters.image_path, undefined);
    assert.equal(step.parameters.image_asset, undefined);
    assert.throws(() =>
      fullToolPlan('ai_modeling_generate_image', {
        model,
        prompt: 'cube',
        inputs: references,
      }),
    );
  }
});
