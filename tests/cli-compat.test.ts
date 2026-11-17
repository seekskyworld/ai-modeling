/** 用真实 CLI 进程验证官方命令语法、离线模型映射、输入拒绝和退出码。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makePlan, processing, processingPlan, generation } from '../cli/compat/planning.ts';
import { pipedTask } from '../cli/compat/input.ts';
import { parseChain } from '../cli/compat/chain.ts';
import { resolveMultiviewReference } from '../studio/api/discovery.ts';
const exec = promisify(execFile);
test('make dry-run uses Studio P2 without needing login or network', async () => {
  const { stdout } = await exec(
    process.execPath,
    ['cli/main.ts', 'make', 'a blue robot', '--model', 'tripo-p2', '--dry-run', '--json'],
    { env: { ...process.env, AI_MODELING_PROFILE: 'offline-no-account', HTTPS_PROXY: 'http://127.0.0.1:1' } },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.valid, true);
  assert.equal(result.steps[0].parameters.model_version, 'Nexus-v2.0-20260801');
  assert.equal(result.steps[0].parameters.pbr, false);
  assert.equal(result.backend, 'studio');
});
test('official processing names map to validated Studio operations and explicit presets', () => {
  assert.equal(processing('convert', '@last', { format: 'GLTF' }).parameters.format, 'glb');
  assert.equal(
    processing('retarget', '@last', { animation: ['preset:walk'] }).parameters.animation,
    'preset:biped:walk',
  );
  const plan = makePlan(['cat'], { for: 'print' });
  assert.equal(
    processing('retarget', '@last', { animation: ['preset:quadruped:walk'] }).parameters.rig_type,
    'quadruped',
  );
  assert.equal(plan.steps[0]!.parameters.texture, false);
  assert.equal(plan.steps[1]!.parameters.format, 'stl');
  assert.equal(processing('decimate', '@last', { faceLimit: 5000, bake: false }).parameters.bake, false);
  const remeshUv = processingPlan('decimate', '@last', { faceLimit: 500, bake: false, smartUv: true });
  assert.deepEqual(
    remeshUv.steps.map((step) => step.operation),
    ['remesh', 'uv_generate', 'uv_commit'],
  );
  assert.equal(remeshUv.steps[0]!.parameters.smart_uv, undefined);
  assert.equal(processingPlan('decimate', '@last', { param: { smart_uv: false } }).steps.length, 1);
  assert.throws(() => makePlan(['cat'], { for: 'unknown' }));
});
test('invalid offline plan returns official usage exit code before auth', async () => {
  await assert.rejects(
    exec(process.execPath, [
      'cli/main.ts',
      'make',
      'cat',
      '--param',
      'invalid_parameter=1',
      '--dry-run',
      '--json',
    ]),
    (error) => {
      assert.equal((error as { code: number }).code, 2);
      const result = JSON.parse((error as { stdout: string }).stdout);
      assert.equal(result.code, 'INVALID_INPUT');
      assert.equal(typeof result.error, 'string');
      return true;
    },
  );
});
test('processing chains keep step parameters, override presets and reject no-wait before submission', () => {
  assert.deepEqual(parseChain('rig:model=rig-v3.0,rig_type=biped,retarget:preset:walk,convert:fbx'), [
    { name: 'rig', param: { model: 'rig-v3.0', rig_type: 'biped' } },
    { name: 'retarget', param: { animation: 'preset:walk' } },
    { name: 'convert', param: { format: 'fbx' } },
  ]);
  const plan = makePlan(['robot'], { for: 'game-mobile', then: 'convert:stl' });
  assert.equal(plan.steps.length, 3);
  assert.equal(plan.steps.at(-1)!.parameters.format, 'stl');
  assert.throws(() => makePlan(['robot'], { then: 'rig', wait: false }), { code: 'INVALID_INPUT' });
  const rig = processing('rig', '@last', { param: { model: 'rig-v2.5', rig_type: 'quadruped' } });
  assert.equal(rig.parameters.model_version, 'v2.5-20260210');
  const texture = processingPlan('texture', '@last', {
    param: { pbr: true, texture_prompt: { text: 'blue' } },
  });
  assert.equal(texture.steps.length, 2);
  assert.equal(texture.steps[0]!.parameters.prompt, 'blue');
  assert.equal(texture.steps[1]!.parameters.action, 'pbr');
  const animations = processingPlan('retarget', '@last', { animation: ['preset:walk', 'preset:run'] });
  assert.equal(animations.steps.length, 3);
  assert.equal(animations.steps[2]!.animationsFromChain, true);
});
test('headless input rejects empty and upstream failure JSON without selecting @last', () => {
  assert.equal(pipedTask('{"task_id":"original"}'), 'original');
  assert.equal(pipedTask('{"result":{"job_id":"original"}}'), 'original');
  assert.throws(() => pipedTask(''), { code: 'INVALID_INPUT' });
  assert.throws(() => pipedTask('{"error":{"code":"RATE_LIMITED"},"exit_code":9}'), { code: 'RATE_LIMITED' });
  assert.throws(
    () => pipedTask('{"error":"Rate limited","code":"RATE_LIMITED","exit_code":9,"task_id":"unsafe"}'),
    { code: 'RATE_LIMITED' },
  );
});
test('official generation references and image aliases resolve without treating task names as file paths', () => {
  const multi = generation('multiview-to-model', ['@views'], {});
  assert.equal(multi.source, '@views');
  assert.equal((multi.parameters.image_assets as unknown[]).length, 4);
  const image = generation('image-to-image', ['@picture'], { prompt: 'Blue robot', model: 'banana2' });
  assert.equal(image.parameters.model_version, 'gemini_3.1_flash_image_preview');
  assert.equal(image.parameters.image_paths, undefined);
  const fromFile = generation('image-to-multiview', ['./reference.png'], {});
  assert.equal(fromFile.operation, 'image_process');
  assert.equal(fromFile.parameters.action, 'multiview');
});
test('single multiview references reject ordinary four-image batches and unfinished or mismatched assets', async () => {
  const asset = {
    asset_id: 'views',
    status: 'success',
    type: 'multiview_images',
    output: { data: [{}, {}, {}, {}] },
  };
  const client = { request: async () => asset };
  assert.deepEqual(
    await resolveMultiviewReference(client, 'views'),
    [0, 1, 2, 3].map((output_index) => ({ asset_id: 'views', output_index })),
  );
  await assert.rejects(resolveMultiviewReference(client, 'different'), { code: 'CONTRACT_CHANGED' });
  asset.status = 'running';
  await assert.rejects(resolveMultiviewReference(client, 'views'), { code: 'INPUT_NOT_READY' });
  asset.status = 'success';
  asset.type = 'images';
  await assert.rejects(resolveMultiviewReference(client, 'views'), { code: 'INVALID_INPUT' });
  asset.type = 'multiview_images';
  asset.output.data.pop();
  await assert.rejects(resolveMultiviewReference(client, 'views'), { code: 'INVALID_INPUT' });
});

test('Canvas continuation keeps remote selection identity separate from CLI submission identity', async () => {
  const input = {
    turn_id: 'turn',
    request_id: 'selection',
    selected_option_ids: ['cat'],
    accept_variable_cost: true,
  };
  const { stdout } = await exec(process.execPath, [
    'cli/main.ts',
    'studio',
    'canvas-continue',
    '--input',
    JSON.stringify(input),
    '--request-id',
    'local-intent',
    '--dry-run',
    '--json',
  ]);
  assert.equal(JSON.parse(stdout).steps[0].parameters.request_id, 'selection');
  const named = await exec(process.execPath, [
    'cli/main.ts',
    'studio',
    'canvas-continue',
    '--turn-id',
    'turn',
    '--remote-request-id',
    'selection',
    '--selected-option-ids',
    '["cat"]',
    '--accept-variable-cost',
    'true',
    '--request-id',
    'local-intent',
    '--dry-run',
    '--json',
  ]);
  assert.equal(JSON.parse(named.stdout).steps[0].parameters.request_id, 'selection');
});
