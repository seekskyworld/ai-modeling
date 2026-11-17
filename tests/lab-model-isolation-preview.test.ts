/** 离线预览揭示新意图的隔离准备，但不能读取旧布局、初始化账号或改写步骤。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { processingPlan } from '../cli/compat/planning.ts';
import { dryRunPlan } from '../cli/compat/run-plan.ts';
import { JobStore } from '../cli/storage/jobs.ts';
import { array, object } from '../studio/contracts/errors.ts';

const exec = promisify(execFile);
const source = '00000000-0000-4000-8000-000000000001';
function selectedPlan() {
  return processingPlan('convert', source, {
    param: { source_representation: 'studio_normalized', texture_format: 'PNG', with_animation: false },
  });
}

test('selected-source dry-run adds conditional preparation without database access or changing processing steps', async (t) => {
  const reads = t.mock.method(JobStore.prototype, 'requestPolicy', () => {
    throw new Error('Offline preview cannot read a saved request');
  });
  const writes = t.mock.method(JobStore.prototype, 'bindRequestPolicy', () => {
    throw new Error('Offline preview cannot bind a request policy');
  });
  const lookup = t.mock.method(JobStore.prototype, 'find', () => {
    throw new Error('Offline preview cannot select existing children');
  });
  const plan = selectedPlan(),
    original = structuredClone(plan),
    result = await dryRunPlan(plan, { requestId: 'possibly-legacy', wait: false });
  assert.equal(result.valid, true);
  assert.equal(result.candidates, 1);
  assert.deepEqual(plan, original);
  assert.deepEqual(result.steps, original.steps);
  assert.deepEqual(
    array(result.steps).map((step) => object(step).operation),
    ['export'],
  );
  const preparation = object(array(result.preparation_steps)[0]);
  assert.equal(preparation.operation, 'copy');
  assert.equal(preparation.source, source);
  assert.equal(preparation.may_have_separate_cost, true);
  assert.equal(preparation.existing_first_copy_reused, false);
  assert.match(String(preparation.applies_to), /New requests.*legacy layout/);
  assert.match(String(preparation.verification), /SHA, size and all bytes/);
  assert.match(String(result.preparation_note), /candidates counts generation choices, not HTTP requests/);
  assert.match(String(result.preparation_note), /copy plus processing requires waiting/);
  assert.match(String(result.preparation_note), /existing requests retain their original frozen layout/);
  const reused = selectedPlan();
  reused.steps.unshift({
    name: 'existing-copy',
    operation: 'copy',
    source,
    sourceRepresentation: 'studio_normalized',
    parameters: { project_id: 'upstream', operator_id: 'upstream' },
  });
  const before = structuredClone(reused),
    preview = await dryRunPlan(reused, {});
  assert.equal(object(array(preview.preparation_steps)[0]).existing_first_copy_reused, true);
  assert.deepEqual(reused, before);
  assert.deepEqual(preview.steps, before.steps);
  const ordinary = await dryRunPlan(processingPlan('convert', source, {}), {});
  assert.equal(ordinary.preparation_steps, undefined);
  assert.equal(ordinary.preparation_note, undefined);
  assert.equal(reads.mock.callCount(), 0);
  assert.equal(writes.mock.callCount(), 0);
  assert.equal(lookup.mock.callCount(), 0);
});

test('CLI source-isolation dry-run succeeds without data initialization, credentials, network or subprocess permission', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tripo-isolation-preview-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const guard = path.join(dir, 'guard.mjs'),
    credentials = new URL('../studio/auth/credentials.ts', import.meta.url).href,
    client = new URL('../studio/api/client.ts', import.meta.url).href;
  await writeFile(
    guard,
    `
import { KeyringStore } from ${JSON.stringify(credentials)};
import { StudioClient } from ${JSON.stringify(client)};
const denied = () => { throw new Error('Offline CLI preview attempted external access'); };
for (const method of ['load', 'save', 'clear', 'saveIfUnchanged']) KeyringStore.prototype[method] = denied;
StudioClient.prototype.request = denied;
globalThis.fetch = denied;
`,
  );
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const { stdout } = await exec(
    process.execPath,
    [
      '--permission',
      '--allow-fs-read=*',
      '--allow-addons',
      '--import',
      pathToFileURL(guard).href,
      fileURLToPath(new URL('../cli/main.ts', import.meta.url)),
      'model',
      'convert',
      source,
      '--format',
      'glb',
      '--param',
      'source_representation=studio_normalized',
      '--request-id',
      'possibly-legacy',
      '--dry-run',
      '--no-wait',
      '--json',
    ],
    {
      env: {
        ...env,
        AI_MODELING_DATA_DIR: path.join(dir, 'never-initialized'),
        AI_MODELING_PROFILE: 'offline-isolation-preview',
      },
      timeout: 15000,
    },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.valid, true);
  assert.equal(result.dry_run, true);
  assert.deepEqual(
    array(result.steps).map((step) => object(step).operation),
    ['export'],
  );
  assert.equal(object(array(result.preparation_steps)[0]).operation, 'copy');
  assert.deepEqual(await readdir(dir), ['guard.mjs']);
});
