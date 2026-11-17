/** 在纯规划阶段复现官方链组合规则，避免生成已收费后才发现下一步必然无效。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChain } from '../cli/compat/chain.ts';
import { validateCompatibilityChain } from '../cli/compat/chain-policy.ts';
import { compatibleRigModel, validateRigPolicy } from '../cli/compat/rig-policy.ts';
import { makePlan, processingPlan } from '../cli/compat/planning.ts';
import { executePlan, type Application } from '../cli/compat/runtime.ts';
import { fixture, quote } from './helpers.ts';

test('chain primary arguments and semicolon syntax retain official roles', () => {
  assert.deepEqual(parseChain(' RIG : quadruped,texture:detailed,convert:format=fbx;texture_size=1536'), [
    { name: 'rig', param: { rig_type: 'quadruped' } },
    { name: 'texture', param: { texture_quality: 'detailed' } },
    { name: 'convert', param: { format: 'fbx', texture_size: 1536 } },
  ]);
  assert.deepEqual(parseChain('edit:0/0/0/1/1/1'), [{ name: 'edit', param: { bbox: '0/0/0/1/1/1' } }]);
  assert.deepEqual(parseChain('rig:'), [{ name: 'rig', param: {} }]);
  assert.deepEqual(parseChain('animate:animations=["preset:idle","preset:walk"]'), [
    { name: 'retarget', param: { animations: ['preset:idle', 'preset:walk'] } },
  ]);
  assert.deepEqual(parseChain('texture:prompt="red; blue, ceramic"'), [
    { name: 'texture', param: { prompt: 'red; blue, ceramic' } },
  ]);
  for (const expression of ['rig,texture:prompt="unclosed', 'edit:bbox=[[0,0,0],[1,1,1]', 'rig:foo=]'])
    assert.throws(() => parseChain(expression), { code: 'INVALID_INPUT' });
});

test('rig policy rejects unsupported combinations but preserves default quadruped and six biped specs', () => {
  for (const params of [
    { model: 'v1.0', rig_type: 'quadruped' },
    { model: 'rig-v2.0', rig_type: 'others' },
    { rig_type: 'quadruped', spec: 'mixamo' },
    { model: 'v2.5', spec: 'actorcore' },
    { model: 'v1.0', spec: 'unity' },
  ])
    assert.throws(() => validateRigPolicy(params), { code: 'INVALID_INPUT', certainty: 'not_submitted' });
  validateRigPolicy({ rig_type: 'quadruped' });
  assert.equal(compatibleRigModel(undefined, 'quadruped'), 'v2.5-20260210');
  for (const spec of ['tripo', 'mixamo', 'actorcore', 'unity', 'unreal', 'vrm']) validateRigPolicy({ spec });
  validateRigPolicy({ model: 'v1.0', spec: 'mixamo' });
  validateRigPolicy({ model: 'v3.0', rig_type: 'others' });
});

test('known chain sources reject unrigged retargeting and completion before generation can submit', () => {
  for (const expression of [
    'complete',
    'retarget:preset:walk',
    'texture,complete',
    'rig,texture,retarget:preset:walk',
  ])
    assert.throws(() => validateCompatibilityChain(parseChain(expression), 'text_to_model'), {
      code: 'INVALID_INPUT',
      certainty: 'not_submitted',
    });
  validateCompatibilityChain(parseChain('segment,complete,convert:fbx'), 'text_to_model');
  validateCompatibilityChain(parseChain('rig-check,rig,retarget:preset:walk'), 'text_to_model');
  validateCompatibilityChain(parseChain('retarget:preset:walk'), 'animate_rig');
  validateCompatibilityChain(parseChain('complete'), 'mesh_segmentation');
  validateCompatibilityChain(parseChain('retarget:preset:walk'));
  assert.throws(() => validateCompatibilityChain(parseChain('texture,complete')), { code: 'INVALID_INPUT' });
  for (const step of ['import', 'smartsegment'])
    assert.throws(() => validateCompatibilityChain(parseChain(step)), { code: 'INVALID_INPUT' });
});

test('rig model compatibility is checked before web preset aliases and across passthrough checks', () => {
  for (const expression of [
    'rig:model=v1.0,retarget:preset:walk',
    'rig:model=v3.0,retarget:preset:biped:walk',
    'rig:model=v2.5,rig-check,retarget:preset:biped:walk',
  ])
    assert.throws(() => validateCompatibilityChain(parseChain(expression), 'text_to_model'), {
      code: 'INVALID_INPUT',
    });
  validateCompatibilityChain(parseChain('rig:model=v1.0,retarget:preset:biped:walk'), 'text_to_model');
  validateCompatibilityChain(parseChain('rig:quadruped,retarget:preset:quadruped:walk'), 'text_to_model');
});

test('generic chain motion inherits the known skeleton across rig checks and explicit body presets survive', () => {
  for (const expression of [
    'rig:quadruped,retarget:preset:walk',
    'rig:quadruped,rig-check,retarget:preset:walk',
    'rig:quadruped,retarget:preset:quadruped:walk',
  ]) {
    const motion = makePlan(['a quadruped dog'], { then: expression }).steps.find(
      (step) => step.operation === 'animate',
    );
    assert.equal(motion?.parameters.animation, 'preset:quadruped:walk');
    assert.equal(motion?.parameters.rig_type, 'quadruped');
  }
  const biped = makePlan(['a robot'], { then: 'rig,retarget:preset:walk' }).steps.find(
    (step) => step.operation === 'animate',
  );
  assert.equal(biped?.parameters.animation, 'preset:biped:walk');
});

test('generic direct retarget uses the known source rig type before creating a paid intent', async () => {
  const f = await fixture();
  const source = f.jobs.prepare(
    'test-account',
    'quadruped-source',
    'rig',
    { project_id: 'project', model_version: 'v2.5-20260210', rig_type: 'quadruped' },
    quote,
  );
  f.jobs.update(source.job_id, 'submitting');
  f.jobs.update(source.job_id, 'submitted', {
    remote_ids: { project_id: 'project', operator_id: 'rig-operator' },
  });
  f.jobs.update(source.job_id, 'succeeded');
  const submitted: Record<string, unknown>[] = [];
  f.gateway.submit = async (job) => {
    submitted.push(job.input);
    return { remote_ids: { project_id: 'project', operator_id: 'animation-operator' } };
  };
  f.gateway.status = async () => ({ state: 'succeeded', progress: 100, artifacts: [] });
  const app = {
    service: f.service,
    studio: f.gateway,
    close: () => f.jobs.close(),
  } as unknown as Application;
  try {
    const plan = processingPlan('retarget', source.job_id, {
      animation: 'preset:walk',
      param: { export_with_geometry: false },
    });
    await executePlan(app, plan, { download: false, requestId: 'quadruped-motion' });
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0]?.animation, 'preset:quadruped:walk');
    assert.equal(submitted[0]?.rig_type, 'quadruped');
  } finally {
    app.close();
  }
});
