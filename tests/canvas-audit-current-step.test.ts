/** Explicit saved currentStepId resolves retries without choosing by array position or retry counters. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditNodeAttribution } from '../studio/api/canvas-audit-attribution.ts';

type RecordValue = Record<string, unknown>;
const tasks = [
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
];
const imageUrl = (task: string) =>
  `https://tripo-data.fixture.data.tripo3d.com/generate-image/20260101/${task}/image.png`;
function fixture() {
  const asset = {
    assetId: 'asset',
    nodeId: 'node',
    selected: true,
    role: 'ASSET_ROLE_CURRENT',
    source: 'ASSET_SOURCE_STUDIO',
    kind: 'ASSET_KIND_IMAGE',
    url: imageUrl(tasks[0]!),
  };
  const node = { id: 'node', type: 'NODE_TYPE_GENERATE_IMAGE', nodeAssets: [{ ...asset }] };
  const current: RecordValue = {
    nodeId: 'node',
    runId: 'run',
    currentStepId: 'original-step',
    selectedAssetId: 'asset',
    status: 'NODE_STATUS_DONE',
  };
  const steps: RecordValue[] = [
    {
      stepId: 'original-step',
      nodeId: 'node',
      taskId: tasks[0],
      status: 'RUN_STEP_STATUS_DONE',
      retryNo: 0,
      seqNo: 1,
    },
    {
      stepId: 'later-step',
      nodeId: 'node',
      taskId: tasks[1],
      status: 'RUN_STEP_STATUS_DONE',
      retryNo: 7,
      seqNo: 99,
    },
    {
      stepId: 'other-step',
      nodeId: 'other',
      taskId: tasks[2],
      status: 'RUN_STEP_STATUS_DONE',
      retryNo: 0,
      seqNo: 2,
    },
  ];
  const run: RecordValue = {
    runId: 'run',
    canvasId: 'canvas',
    turnId: 'turn',
    status: 'RUN_STATUS_SUCCEEDED',
    nodeIds: ['node', 'other'],
    steps,
  };
  return {
    node,
    current,
    run,
    steps,
    asset,
    inspect: () =>
      auditNodeAttribution('turn', node, current, [asset], [{ requested_run_id: 'run', response: { run } }]),
  };
}

test('currentStepId selects the exact saved original step even when a later retry exists', () => {
  for (const reversed of [false, true]) {
    const f = fixture();
    if (reversed) f.steps.reverse();
    const result = f.inspect();
    for (const proof of [result.run, result.selection, result.generation]) {
      assert.equal(proof.status, 'verified');
      assert.equal(proof.step_id, 'original-step');
      assert.equal(proof.task_id, tasks[0]);
    }
    assert.equal(result.generation.evidence, 'generate_image_task_path');
  }
});

test('an explicitly selected retry proves only the object tied to that exact task', () => {
  const f = fixture();
  f.current.currentStepId = 'later-step';
  let result = f.inspect();
  assert.equal(result.run.step_id, 'later-step');
  assert.equal(result.selection.status, 'verified');
  assert.equal(result.generation.status, 'unknown');
  assert.equal(result.generation.reason, 'asset_task_identity_unverified');
  f.asset.url = imageUrl(tasks[1]!);
  f.node.nodeAssets[0]!.url = f.asset.url;
  result = f.inspect();
  assert.equal(result.generation.status, 'verified');
  assert.equal(result.generation.task_id, tasks[1]);
});

for (const target of ['missing-step', 'other-step']) {
  test(`current step ${target} cannot fall back to the node's newest retry`, () => {
    const f = fixture();
    f.current.currentStepId = target;
    assert.throws(f.inspect, { code: 'CONTRACT_CHANGED' });
  });
}

test('a missing currentStepId remains unknown despite a complete set of retry counters', () => {
  const f = fixture();
  delete f.current.currentStepId;
  const result = f.inspect();
  assert.equal(result.run.status, 'unknown');
  assert.equal(result.run.reason, 'step_identity_incomplete');
});

for (const [mode, reason] of [
  ['missing-node-coverage', 'run_steps_incomplete'],
  ['duplicate-step', 'run_steps_ambiguous'],
  ['duplicate-task', 'run_tasks_ambiguous'],
  ['missing-task', 'step_identity_incomplete'],
  ['missing-node', 'step_identity_incomplete'],
  ['duplicate-node-list', 'run_nodes_ambiguous'],
  ['different-turn', 'run_belongs_to_another_turn'],
]) {
  test(`repeated-node proof rejects ${mode}`, () => {
    const f = fixture();
    if (mode === 'missing-node-coverage') f.run.steps = f.steps.slice(0, 2);
    if (mode === 'duplicate-step') f.steps[1]!.stepId = f.steps[0]!.stepId;
    if (mode === 'duplicate-task') f.steps[1]!.taskId = f.steps[0]!.taskId;
    if (mode === 'missing-task') delete f.steps[1]!.taskId;
    if (mode === 'missing-node') delete f.steps[1]!.nodeId;
    if (mode === 'duplicate-node-list') f.run.nodeIds = ['node', 'other', 'node'];
    if (mode === 'different-turn') f.run.turnId = 'another-turn';
    const result = f.inspect();
    assert.equal(result.run.status, 'unknown');
    assert.equal(result.generation.reason, reason);
  });
}

test('a retry step naming a node outside the exact source run remains a contract failure', () => {
  const f = fixture();
  f.steps[1]!.nodeId = 'foreign';
  assert.throws(f.inspect, { code: 'CONTRACT_CHANGED' });
});

for (const mode of ['run', 'node', 'step']) {
  test(`failed ${mode} status cannot prove a generated result for the current step`, () => {
    const f = fixture();
    if (mode === 'run') f.run.status = 'RUN_STATUS_FAILED';
    if (mode === 'node') f.current.status = 'NODE_STATUS_FAILED';
    if (mode === 'step') f.steps[0]!.status = 'RUN_STEP_STATUS_FAILED';
    const result = f.inspect();
    assert.equal(result.run.status, 'verified');
    assert.equal(result.selection.status, 'verified');
    assert.equal(result.generation.reason, 'execution_not_completed');
  });
}

test('split results with internal tasks prove current run and selection, but not image generation', () => {
  const f = fixture();
  f.node.type = 'NODE_TYPE_SPLIT_RESULT';
  f.steps[0]!.taskId = 'internaltask-original';
  f.steps[1]!.taskId = 'internaltask-retry';
  const result = f.inspect();
  assert.equal(result.run.status, 'verified');
  assert.equal(result.run.step_id, 'original-step');
  assert.equal(result.selection.status, 'verified');
  assert.equal(result.generation.status, 'unknown');
  assert.equal(result.generation.reason, 'asset_generation_binding_unavailable');
});

test('the current run can be verified without a selected result', () => {
  const f = fixture();
  f.current.selectedAssetId = '';
  const result = f.inspect();
  assert.equal(result.run.status, 'verified');
  assert.equal(result.selection.reason, 'selected_asset_identity_incomplete');
  assert.equal(result.generation.status, 'unknown');
});
