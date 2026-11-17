/** 官方组合参数回归：验证拒绝、真实意图和预览输入，避免语法齐全掩盖行为差异。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { processingPlan } from '../cli/compat/planning.ts';
import { fullToolPlan, fullTools } from '../cli/compat/full-tools.ts';
import { object, array } from '../studio/contracts/errors.ts';
import { fixture } from './helpers.ts';

test('quad conversion rejects glTF before any work and selects FBX for other formats', () => {
  for (const format of ['glb', 'GLTF'])
    assert.throws(() => processingPlan('convert', 'source.glb', { format, quad: true }), {
      code: 'INVALID_INPUT',
    });
  const plan = processingPlan('convert', 'project', { format: 'OBJ', quad: true, faceLimit: 1000 });
  assert.equal(plan.steps[0]?.parameters.quad, true);
  assert.equal(plan.steps.at(-1)?.parameters.format, 'fbx');
  assert.ok(plan.warnings.some((w) => w.includes('forces FBX')));
  assert.equal(processingPlan('convert', 'project', { format: 'GLTF', quad: false }).steps.length, 1);
  assert.throws(
    () =>
      processingPlan('convert', 'project', {
        format: 'fbx',
        quad: true,
        flattenBottom: false,
        pivotToCenterBottom: true,
      }),
    { code: 'STUDIO_CAPABILITY_UNAVAILABLE' },
  );
  assert.throws(() =>
    processingPlan('convert', 'project', { format: 'fbx', quad: true, param: { force_symmetry: true } }),
  );
});

test('convert normalizes encoding and warns when removing irrelevant official options', () => {
  const plan = processingPlan('convert', 'project', {
    format: 'OBJ',
    textureFormat: 'png',
    fbxPreset: 'mixamo',
    param: { force_symmetry: true },
  });
  assert.equal(plan.steps[0]?.parameters.texture_format, 'PNG');
  assert.ok(plan.warnings.some((w) => w.includes('fbx_preset')));
  assert.ok(plan.warnings.some((w) => w.includes('force_symmetry')));
  const fbx = processingPlan('convert', 'project', { format: 'fbx', exportVertexColors: true });
  assert.equal(fbx.steps[0]?.parameters.export_vertex_colors, false);
  assert.ok(fbx.warnings.some((w) => w.includes('export_vertex_colors')));
  assert.throws(() => processingPlan('convert', 'project', { format: 'OBJ', fbxPreset: 'unknown' }));
});

test('retarget refuses conflicting selection and never ignores unsupported standalone export intent', () => {
  assert.throws(
    () =>
      fullToolPlan('ai_modeling_animate', {
        task_id: 'task_audit',
        animation: 'preset:walk',
        animations: ['preset:idle'],
      }),
    { code: 'INVALID_INPUT' },
  );
  const plan = fullToolPlan('ai_modeling_animate', {
    task_id: 'task_audit',
    animation: 'preset:walk',
    bake_animation: true,
  });
  assert.equal(plan.steps[0]?.parameters.bake_animation, undefined);
  assert.ok(plan.warnings.some((w) => w.includes('deprecated')));
  for (const extra of [{ out_format: 'fbx' }, { animate_in_place: true }])
    assert.throws(
      () =>
        fullToolPlan('ai_modeling_animate', {
          task_id: 'task_audit',
          animation: 'preset:walk',
          export_with_geometry: false,
          ...extra,
        }),
      { code: 'STUDIO_CAPABILITY_UNAVAILABLE' },
    );
});

test('mesh edit accepts official bbox forms without discarding extra coordinates', () => {
  const expected = [
    [-0.5, -0.5, -0.5],
    [0.5, 0.5, 0.5],
  ];
  for (const bbox of [expected, expected.flat(), '-0.5/-0.5/-0.5/0.5/0.5/0.5', '-0.5,-0.5;-0.5 0.5,0.5,0.5'])
    assert.deepEqual(processingPlan('edit', 'project', { bbox }).steps[0]?.parameters.bbox, expected);
  for (const bbox of ['0,0,0,1,1,1,999', [0, 0, 0, 1, 1], [0, 0, 0, 1, 1, NaN]])
    assert.throws(() => processingPlan('edit', 'project', { bbox }), { code: 'INVALID_INPUT' });
});

test('full generation keeps official parameter adjustment warnings visible', () => {
  const plan = fullToolPlan('ai_modeling_text_to_3d', {
    prompt: 'cube',
    model: 'tripo-p2',
    generate_parts: true,
  });
  assert.ok(plan.warnings.some((w) => w.includes('generate_parts')));
});

test('advisory validates the actual text and supports image and multiview placeholders without submission', async () => {
  const f = await fixture();
  const tool = fullTools(f.service, {
    client: {
      request: async () => {
        throw new Error('Unexpected network');
      },
    },
    assets: async () => ({}),
  }).find((t) => t.name === 'ai_modeling_plan')!;
  const input = (name: string, generation: Record<string, unknown>): Record<string, unknown> => ({
    goal: 'create an asset',
    steps: [{ tool: name, purpose: 'model', generation }],
  });
  try {
    const result = object(
      await tool.run(input('ai_modeling_text_to_3d', { prompt: 'original exact prompt' })),
    );
    const plan = object(object(array(result.steps)[0]).plan);
    assert.equal(
      object(array(plan.steps)[0]).parameters && object(object(array(plan.steps)[0]).parameters).prompt,
      'original exact prompt',
    );
    await assert.rejects(tool.run(input('ai_modeling_text_to_3d', {})));
    await assert.rejects(tool.run(input('ai_modeling_text_to_3d', { prompt: 'x'.repeat(1025) })));
    for (const name of ['ai_modeling_image_to_3d', 'ai_modeling_multiview_to_3d'])
      assert.ok(await tool.run(input(name, { model: 'tripo-p2' })));
    await assert.rejects(tool.run(input('ai_modeling_convert', { prompt: 'cube' })), {
      code: 'INVALID_INPUT',
    });
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
