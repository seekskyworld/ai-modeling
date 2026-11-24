/** 新版网页编辑差异回归：输入角色、空视角、完整恢复、冲突与静态姿态导出。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../studio/contracts/schemas.ts';
import { textureSubmission } from '../studio/api/texture.ts';
import { PricingService } from '../studio/api/pricing.ts';
import { reviewedPrices } from '../studio/api/reviewed-prices.ts';
import { fullToolPlan } from '../cli/compat/full-tools.ts';
import { generation, processingPlan } from '../cli/compat/planning.ts';
import { listModels } from '../cli/compat/catalog.ts';
import { metadataBody, metadataSchema } from '../studio/api/metadata.ts';
import type { StudioClient } from '../studio/api/client.ts';
import { object, text } from '../studio/contracts/errors.ts';
import { dryRunPlan } from '../cli/compat/run-plan.ts';
import { fixture } from './helpers.ts';
import { Operations } from '../studio/api/operations.ts';
import type { Job } from '../studio/contracts/types.ts';
import { needsExportTransform, transformedExportFormat } from '../studio/contracts/export-options.ts';
import { rm } from 'node:fs/promises';

test('Midjourney preserves a requested single image but refuses image inputs before upload', () => {
  const input = generation('text-to-image', ['wooden fox'], { model: 'midjourney' }).parameters;
  assert.equal(input.amount, 1);
  for (const source of [
    { image_path: '/missing.png' },
    { image_paths: ['/missing.png'] },
    { image_asset: { asset_id: 'existing' } },
    { image_assets: [{ asset_id: 'existing' }] },
  ])
    assert.throws(() => normalize('image', { ...input, ...source }), /text-to-image only/);
  assert.throws(
    () => generation('image-to-image', ['@last'], { model: 'midjourney', prompt: 'wooden' }),
    /text-to-image only/,
  );
  const catalogs = listModels();
  const hasMidjourney = (capability: string) =>
    (catalogs.find((x) => x.capability === capability)!.models as { id: string }[]).some(
      (model) => model.id === 'midjourney',
    );
  assert.equal(hasMidjourney('text-to-image'), true);
  assert.equal(hasMidjourney('image-to-image'), false);
});

test('official style image stays independent and view keys preserve back/right slots', () => {
  const full = fullToolPlan('ai_modeling_texture', {
    input: '@last',
    prompt: 'wood',
    style_image: 'style.png',
  });
  assert.match(text(full.steps[0]!.parameters.style_image_path), /style\.png$/);
  assert.equal(full.steps[0]!.parameters.image_path, undefined);
  const x = processingPlan('texture', '@last', {
    param: {
      texture_prompt: {
        images: [{ right: { url: 'https://example.org/right.png' } }, { front: 'front.png' }],
        style_image: 'style.png',
      },
    },
  }).steps[0]!.parameters;
  assert.deepEqual((x.image_paths as unknown[]).slice(1), [null, null, 'https://example.org/right.png']);
  assert.match(text(x.style_image_path), /style\.png$/);
  assert.throws(
    () =>
      processingPlan('texture', '@last', {
        param: { texture_prompt: { images: [{ front: 'a' }, { front: 'b' }] } },
      }),
    { code: 'INVALID_INPUT' },
  );
  assert.throws(() =>
    processingPlan('texture', '@last', {
      param: { texture_prompt: { images: [{ left: 'a' }, { back: 'b' }] } },
    }),
  );
});

test('Studio texture sends audited content, separate style and selected original mesh names', async () => {
  const input = normalize('texture', {
    project_id: 'p',
    image_assets: [{ asset_id: 'front' }, null, { asset_id: 'back' }, null],
    style_image_asset: { asset_id: 'palette' },
    part_names: ['arm'],
  });
  const submission = await textureSubmission(input, async (x) => ({
    bucket: 'test',
    key: text(object(x.image_asset).asset_id),
    image_audit_result: 'pass',
    image_source: 'generate',
  }));
  assert.deepEqual(submission.body.images, [
    { bucket: 'test', key: 'front', image_audit_result: 'pass', image_source: 'generate' },
    null,
    { bucket: 'test', key: 'back', image_audit_result: 'pass', image_source: 'generate' },
    null,
  ]);
  assert.deepEqual(submission.body.style_image, {
    bucket: 'test',
    key: 'palette',
    image_audit_result: 'pass',
  });
  assert.deepEqual(submission.body.part_names, ['arm']);
  const preset = await textureSubmission(
    normalize('texture', { project_id: 'p', prompt: 'wood', style_preset: 'wood' }),
    async () => {
      throw Error('Preset must not upload');
    },
  );
  assert.deepEqual(preset.body.style_image, {
    bucket: 'tripo-data',
    key: 'tripo-studio/style_image/wood.jpg',
  });
  assert.equal(preset.body.part_names, undefined);
});

test('style pricing adds five credits and rejects missing evidence rather than quoting base price', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(reviewedPrices.reviewed_at) });
  const pricing = new PricingService('/missing-editor-prices.json', reviewedPrices);
  for (const key of ['style_image_path', 'style_image_asset', 'style_preset']) {
    const q = await pricing.quote('texture', {
      action: 'generate',
      texture_quality: 'standard',
      [key]: 'test',
    });
    assert.equal(q.credits, 15);
  }
  const { TextureStyle: ignored, ...credits } = reviewedPrices.credits;
  assert.equal(ignored, 5);
  const missing = await new PricingService('/missing-editor-prices.json', {
    ...reviewedPrices,
    credits,
  }).quote('texture', { style_preset: 'wood' });
  assert.equal(missing.known, false);
  assert.match(missing.explanation, /No verified price for .*TextureStyle/);
});

test('invalid mixed texture inputs and sparse batches stop before submission', () => {
  for (const texture_prompt of [null, 123, true, []])
    assert.throws(() => processingPlan('texture', '@last', { param: { texture_prompt } }), {
      code: 'INVALID_INPUT',
    });
  for (const input of [
    { prompt: 'red', image_path: 'front.png' },
    { image_paths: [null, 'left.png', 'back.png'] },
    { image_paths: ['front.png', null, null] },
    { action: 'upscale', style_preset: 'wood' },
    { style_preset: 'wood', style_image_path: 'style.png' },
  ])
    assert.throws(() => normalize('texture', { project_id: 'p', ...input }));
  assert.throws(() => normalize('model', { mode: 'batch', image_assets: [{ asset_id: 'a' }, null] }));
  const model = normalize('model', {
    mode: 'multiview',
    image_assets: [{ asset_id: 'a' }, null, { asset_id: 'b' }, null],
  });
  assert.equal((model.image_assets as unknown[])[1], null);
});

test('metadata restores empty maps, toggles visibility incrementally and detects same-operator changes', async () => {
  let metadata = {
    children_deleted: ['arm'],
    children_rename: { head: 'Head' },
    children_transform_matrix: {},
    material_factor: { metallic: 0, roughness: 0.5 },
  };
  const client = {
    request: async () => ({ operator: { operator_id: 'op', metadata } }),
  } as unknown as StudioClient;
  const base = { project_id: 'p', expected_operator_id: 'op' };
  const update = await metadataBody(
    client,
    metadataSchema.parse({ ...base, children_visibility: { arm: true, leg: false } }),
  );
  assert.deepEqual(update.children_deleted, ['leg']);
  assert.deepEqual(update.children_rename, { head: 'Head' });
  assert.deepEqual(
    (await metadataBody(client, metadataSchema.parse({ ...base, replace: true, children_rename: {} })))
      .children_rename,
    {},
  );
  const expected = structuredClone(metadata);
  metadata = { ...metadata, children_deleted: ['head'] };
  await assert.rejects(metadataBody(client, metadataSchema.parse({ ...base, expected_metadata: expected })), {
    code: 'PROJECT_CHANGED',
  });
});

test('static animation bake accepts one motion without creating an animated export', () => {
  const animation = '0c9f9960-68a7-4a8f-ac90-5b89be071540';
  const input = normalize('export', {
    project_id: 'p',
    enable_bake_animation: true,
    animations: [animation],
    bake_animation_frame: 12,
  });
  assert.equal(input.with_animation, false);
  for (const extra of [{ animations: [] }, { animations: [animation, animation] }, { with_animation: true }])
    assert.throws(() => normalize('export', { ...input, ...extra }));
});

test('style files are validated in dry-run and fingerprinted before the paid submit', async () => {
  const plan = processingPlan('texture', '@last', {
    param: { prompt: 'red', style_image: '/missing-tripo-style.png' },
  });
  await assert.rejects(dryRunPlan(plan, {}), { code: 'INVALID_INPUT' });
  const f = await fixture();
  try {
    await assert.rejects(
      f.service.submit(
        'texture',
        'missing-style',
        { project_id: 'p', prompt: 'red', style_image_path: '/missing-tripo-style.png' },
        15,
      ),
    );
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('official size options request a native GLB and declare local conversion instead of ignored web fields', async () => {
  const input = normalize('export', {
    project_id: 'p',
    format: 'stl',
    scale_factor: 2,
    pivot_to_center_bottom: true,
    flatten_bottom: true,
  });
  const client = {
    request: async () => ({ is_owner: true, operator: { operator_id: 'op', status: 'success' } }),
  } as unknown as StudioClient;
  const request = await new Operations(client, []).build({ operation: 'export', input } as Job);
  assert.equal(request.body.format, 'gltf');
  assert.equal(request.body.texture_packaging, 'embedded');
  for (const ignored of ['scale_factor', 'pivot_to_center_bottom', 'flatten_bottom'])
    assert.equal(request.body[ignored], undefined);
  assert.equal(needsExportTransform(input), true);
  assert.equal(transformedExportFormat(input), 'stl');
  assert.equal(transformedExportFormat({ format: 'fbx', texture_packaging: 'zip' }), 'zip');
  assert.equal(needsExportTransform({ scale_factor: 1, flatten_bottom: false }), false);
  assert.throws(() => normalize('export', { ...input, format: 'fbx', fbx_preset: 'mixamo' }));
  for (const orientation of ['+x', '-x', '+y', '-y']) {
    const oriented = normalize('export', { ...input, export_orientation: orientation });
    const native = await new Operations(client, []).build({ operation: 'export', input: oriented } as Job);
    assert.equal(native.body.export_orientation, orientation);
  }
  assert.ok(
    processingPlan('convert', '@last', { format: 'stl', scaleFactor: 2 }).warnings.some((s) =>
      s.includes('native metadata'),
    ),
  );
});

test('reviewed website pricing includes the Smart Poly base and P2 quad in its fixed price', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(reviewedPrices.reviewed_at) });
  const pricing = new PricingService('/missing-editor-prices.json', reviewedPrices);
  assert.equal((await pricing.quote('remesh', { smart_poly: true, quad: false })).credits, 35);
  assert.equal((await pricing.quote('remesh', { smart_poly: true, quad: true })).credits, 40);
  assert.equal(
    (await pricing.quote('model', { model_version: 'Nexus-v2.0-20260801', quad: true })).credits,
    100,
  );
  assert.equal(
    (await pricing.quote('model', { model_version: 'Nexus-v1.0-20260214', quad: true })).credits,
    40,
  );
});

test('bundled reviewed prices stop authorizing quotes at expiry and before their review date', async (t) => {
  const expires = Date.parse(reviewedPrices.expires_at),
    reviewed = Date.parse(reviewedPrices.reviewed_at),
    pricing = new PricingService('/missing-editor-prices.json', reviewedPrices);
  assert.ok(reviewed < expires);
  t.mock.timers.enable({ apis: ['Date'], now: expires - 1 });
  const valid = await pricing.quote('remesh', { smart_poly: true, quad: false });
  assert.equal(valid.known, true);
  assert.equal(valid.credits, 35);
  for (const [now, reason, date, recovery] of [
    [expires, /^Pricing review expired at /, reviewedPrices.expires_at, /ai-modeling pricing update/],
    [
      reviewed - 1,
      /^Pricing review is dated in the future /,
      reviewedPrices.reviewed_at,
      /Check the system clock/,
    ],
  ] as const) {
    t.mock.timers.setTime(now);
    const unavailable = await pricing.quote('remesh', { smart_poly: true, quad: false });
    assert.equal(unavailable.known, false);
    assert.equal(unavailable.credits, undefined);
    assert.match(unavailable.explanation, reason);
    assert.ok(unavailable.explanation.includes(date));
    assert.match(unavailable.explanation, /ai-modeling pricing status/);
    assert.match(unavailable.explanation, recovery);
  }
});
