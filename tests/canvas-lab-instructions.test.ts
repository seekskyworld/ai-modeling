/** Lab 说明合同使用合成响应；不提交任务、不修改网页保存状态。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectLabTaskInstructions,
  parseLabTaskInstructions,
} from '../studio/api/canvas-lab-instructions.ts';
import { object } from '../studio/contracts/errors.ts';

function response(overrides: Record<string, unknown> = {}) {
  return {
    taskInstructions: {
      saveStatus: 'LAB_TASK_INSTRUCTIONS_SAVE_STATUS_SAVED',
      saved: { nodeId: 'lab', version: '3', instructions: 'Inspect every attached view.' },
      ...overrides,
    },
  };
}

test('Lab instruction inspection preserves the raw payload and identifies the read-only workflow', () => {
  const input = response({
    saving: false,
    canSave: false,
    hasUpdates: false,
    futureField: { observation: 'preserve' },
  });
  const snapshot = structuredClone(input);
  const result = inspectLabTaskInstructions(input, 'lab'),
    validation = object(result.validation),
    support = object(result.cli_support);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(result.taskInstructions, input.taskInstructions);
  assert.equal(validation.valid, true);
  assert.equal(validation.save_status, 'SAVED');
  assert.equal(validation.saved_version, '3');
  assert.equal(validation.has_saved_instructions, true);
  assert.deepEqual(validation.reuse_blockers, []);
  assert.equal(support.state_source, 'GetLabTaskInstructions');
  assert.equal(support.manual_save, false);
  assert.match(String(support.reuse), /lab-plan --mode reuse_instructions/);
  assert.equal(Object.hasOwn(result, 'ready'), false);
  assert.equal(Object.hasOwn(result, 'remote_saved'), false);
});

test('Lab instruction defaults match the webpage without requiring omitted optional fields', () => {
  const parsed = parseLabTaskInstructions(response({ saved: { nodeId: 'lab' } }), 'lab');
  assert.equal(parsed.valid, true);
  assert.deepEqual(parsed.saved, { nodeId: 'lab', version: '0', instructions: '' });
  assert.equal(parsed.saving, false);
  assert.equal(parsed.canSave, false);
  assert.equal(parsed.hasUpdates, false);
  assert.deepEqual(parsed.reuseBlockers, ['saved_instructions_empty']);
  const reusable = parseLabTaskInstructions(
    response({ saved: { nodeId: 'lab', instructions: 'Inspect' } }),
    'lab',
  );
  assert.equal(reusable.valid, true);
  assert.equal(reusable.saved?.version, '0');
  assert.deepEqual(reusable.reuseBlockers, []);
});

test('Lab idle responses can legitimately omit saved instructions or return null', () => {
  for (const saved of [undefined, null]) {
    const parsed = parseLabTaskInstructions(response({ saveStatus: 'IDLE', saved }), 'lab');
    assert.equal(parsed.valid, true);
    assert.equal(parsed.saved, null);
    assert.deepEqual(parsed.reuseBlockers, ['saved_instructions_empty']);
  }
});

test('Lab known statuses are matched exactly with or without the service prefix', () => {
  for (const prefix of ['', 'LAB_TASK_INSTRUCTIONS_SAVE_STATUS_']) {
    for (const status of ['IDLE', 'SAVING', 'SAVED', 'FAILED']) {
      const parsed = parseLabTaskInstructions(response({ saveStatus: prefix + status }), 'lab');
      assert.equal(parsed.valid, true);
      assert.equal(parsed.saveStatus, status);
      assert.deepEqual(
        parsed.reuseBlockers,
        status === 'SAVING'
          ? ['instructions_saving']
          : status === 'FAILED'
            ? ['instructions_save_failed']
            : [],
      );
    }
  }
  const saving = parseLabTaskInstructions(response({ saving: true }), 'lab');
  assert.deepEqual(saving.reuseBlockers, ['instructions_saving']);
});

test('Lab unknown, missing or incorrectly typed status cannot be treated as usable instructions', () => {
  for (const saveStatus of [
    undefined,
    null,
    true,
    1,
    '',
    'PENDING',
    'UNSAVED',
    'NOT_SAVED',
    'OTHER_SAVING',
    'OTHER_FAILED',
    ' saved ',
  ]) {
    const input = response({ saveStatus }),
      parsed = parseLabTaskInstructions(input, 'lab'),
      inspected = inspectLabTaskInstructions(input, 'lab');
    assert.equal(parsed.valid, false);
    assert.equal(parsed.saveStatus, null);
    assert.ok(parsed.reuseBlockers.includes('instructions_state_invalid'));
    assert.ok(parsed.issues.some((issue) => issue.field === 'taskInstructions.saveStatus'));
    assert.deepEqual(inspected.taskInstructions, input.taskInstructions);
  }
});

test('Lab optional booleans and errors are validated when present without coercion', () => {
  for (const field of ['saving', 'canSave', 'hasUpdates']) {
    for (const invalid of [null, 'false', 'true', 0, 1, {}, []]) {
      const parsed = parseLabTaskInstructions(response({ [field]: invalid }), 'lab');
      assert.equal(parsed.valid, false);
      assert.ok(parsed.reuseBlockers.includes('instructions_state_invalid'));
      assert.ok(parsed.issues.some((issue) => issue.field === `taskInstructions.${field}`));
    }
  }
  for (const field of ['saveErrorCode', 'saveErrorMessage']) {
    for (const invalid of [null, false, 0, {}, []])
      assert.equal(parseLabTaskInstructions(response({ [field]: invalid }), 'lab').valid, false);
    assert.equal(parseLabTaskInstructions(response({ [field]: '' }), 'lab').valid, true);
  }
});

test('Lab malformed saved fields are retained as facts and block execution preparation', () => {
  for (const saved of [
    [],
    '',
    {},
    { nodeId: '' },
    { nodeId: ' ' },
    { nodeId: 1 },
    { nodeId: 'lab', version: 1 },
    { nodeId: 'lab', version: null },
    { nodeId: 'lab', version: '-1' },
    { nodeId: 'lab', version: '1.2' },
    { nodeId: 'lab', instructions: null },
    { nodeId: 'lab', instructions: 10 },
  ]) {
    const input = response({ saved }),
      parsed = parseLabTaskInstructions(input, 'lab');
    assert.equal(parsed.valid, false);
    assert.ok(parsed.reuseBlockers.includes('instructions_state_invalid'));
    assert.deepEqual(inspectLabTaskInstructions(input, 'lab').taskInstructions, input.taskInstructions);
  }
});

test('Lab response and instruction objects cannot be replaced with implicit empty success', () => {
  for (const input of [
    undefined,
    null,
    [],
    'saved',
    {},
    { taskInstructions: null },
    { taskInstructions: [] },
  ]) {
    const parsed = parseLabTaskInstructions(input, 'lab');
    assert.equal(parsed.valid, false);
    assert.ok(parsed.reuseBlockers.includes('instructions_state_invalid'));
    assert.ok(parsed.issues.some((issue) => issue.field === 'taskInstructions'));
  }
});

test('Lab instruction inspection rejects another node even when other fields are malformed', () => {
  for (const saveStatus of ['SAVED', undefined, 'UNKNOWN'])
    assert.throws(
      () => inspectLabTaskInstructions(response({ saveStatus, saved: { nodeId: 'other' } }), 'lab'),
      { code: 'CONTRACT_CHANGED' },
    );
});
