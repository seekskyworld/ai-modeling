import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { checkWorkflows, workflowStep } from '../scripts/check-workflows.ts';
import { workflowFixture, workflowProof } from './workflow-harness.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const { workflows } = await checkWorkflows(root);
const release = workflows['release.yml']!;
const step = (job: string, id: string) => workflowStep(release, job, { id });
const named = (job: string, name: string) => workflowStep(release, job, { name });
const bashOnly = {
  skip:
    process.platform === 'win32'
      ? 'Release shell snippets execute on Linux; Windows runs the package matrix.'
      : false,
};
function condition(expression: string, context: object): boolean {
  const source = expression
    .trim()
    .replace(/^\$\{\{\s*/, '')
    .replace(/\s*\}\}$/, '');
  return Boolean(
    runInNewContext(
      source,
      {
        ...context,
        always: () => true,
        startsWith: (value: string, prefix: string) => value.startsWith(prefix),
      },
      { timeout: 100 },
    ),
  );
}

test('offline workflow contracts pin actions, keep six-file gates and separate serialized promotion', async () => {
  assert.equal(Object.keys((await checkWorkflows(root)).workflows).length, 3);
});

test('every actual workflow Bash snippet has valid shell syntax', bashOnly, () => {
  for (const workflow of Object.values(workflows))
    for (const job of Object.values(workflow.jobs))
      for (const item of job.steps)
        if (item.run) {
          const result = spawnSync('/bin/bash', ['-n'], { input: item.run, encoding: 'utf8' });
          assert.equal(result.status, 0, result.stderr);
        }
});

test('actual event and dependency guards reject manual or incomplete publication and allow immutable recovery', () => {
  const permitted = (
    changes: {
      event?: string;
      ref?: string;
      action?: string;
      inspect?: string;
      build?: string;
      smoke?: string;
      candidate?: string;
    } = {},
  ) =>
    condition(release.jobs.publish!.if!, {
      github: { event_name: changes.event ?? 'push', ref: changes.ref ?? 'refs/tags/v0.1.4' },
      needs: {
        inspect: { result: changes.inspect ?? 'success', outputs: { action: changes.action ?? 'prepare' } },
        build: { result: changes.build ?? 'success' },
        smoke: { result: changes.smoke ?? 'success' },
        candidate: { result: changes.candidate ?? 'success' },
      },
    });
  assert.equal(permitted(), true);
  assert.equal(permitted({ event: 'workflow_dispatch' }), false);
  assert.equal(permitted({ ref: 'refs/heads/main' }), false);
  for (const name of ['inspect', 'build', 'smoke', 'candidate'])
    assert.equal(permitted({ [name]: 'failure' }), false);
  for (const action of ['submit', 'wait', 'verify', 'published']) {
    const values = { action, build: 'skipped', smoke: 'skipped', candidate: 'skipped' };
    assert.equal(permitted(values), true);
    assert.equal(permitted({ ...values, event: 'workflow_dispatch' }), false);
    assert.equal(condition(release.jobs.build!.if!, { needs: { inspect: { outputs: { action } } } }), false);
  }
});

test('promotion guard requires tag push and successful persisted public archive verification', () => {
  for (const event of ['push', 'workflow_dispatch'])
    for (const verified of ['true', 'false', '']) {
      const context = {
        github: { event_name: event, ref: 'refs/tags/v0.1.4' },
        needs: { inspect: { result: 'success' }, publish: { result: 'success', outputs: { verified } } },
      };
      assert.equal(condition(release.jobs.promote!.if!, context), event === 'push' && verified === 'true');
    }
});

test(
  'manual main preview runs without querying or mutating the publication coordinator',
  bashOnly,
  async (t) => {
    const f = await workflowFixture(t);
    f.env.GITHUB_EVENT_NAME = 'workflow_dispatch';
    f.env.GITHUB_REF = 'refs/heads/main';
    f.run(step('inspect', 'identity'));
    f.run(step('inspect', 'preview'));
    f.run(named('candidate', 'Record the manual preview without requiring an existing version tag'));
    assert.equal((await f.outputs()).action, 'prepare');
    assert.equal(JSON.parse(await readFile(f.env.PLAN_FILE!, 'utf8')).should_publish, false);
    assert.deepEqual(
      (await f.calls()).map((call) => call.command),
      ['git'],
    );
  },
);

test('pushed version mismatch is rejected before publication state access', bashOnly, async (t) => {
  const f = await workflowFixture(t);
  f.env.GITHUB_REF = 'refs/tags/v9.9.9';
  f.run(step('inspect', 'identity'), false);
  assert.deepEqual(await f.calls(), []);
});

for (const action of ['publish', 'wait', 'verify', 'published'])
  test(
    `actual ${action} claim grants npm upload only to its newly persisted permission`,
    bashOnly,
    async (t) => {
      const f = await workflowFixture(t);
      f.env.WORKFLOW_CLAIM_REPORT = JSON.stringify({
        action,
        should_publish: action === 'publish',
        archive_path: f.archive,
      });
      f.run(step('publish', 'claim'));
      assert.equal((await f.outputs()).should_publish, String(action === 'publish'));
      assert.equal(
        condition(step('publish', 'npm').if!, { steps: { claim: { outputs: await f.outputs() } } }),
        action === 'publish',
      );
      assert.equal(
        (await f.calls()).some((call) => call.command === 'npm'),
        false,
      );
    },
  );

test('inconsistent permission is rejected before an upload', bashOnly, async (t) => {
  const f = await workflowFixture(t);
  f.env.WORKFLOW_CLAIM_REPORT = JSON.stringify({ action: 'wait', should_publish: true });
  f.run(step('publish', 'claim'), false);
});

test('new claim without the original frozen TGZ is rejected', bashOnly, async (t) => {
  const f = await workflowFixture(t);
  f.env.WORKFLOW_CLAIM_REPORT = JSON.stringify({ action: 'publish', should_publish: true });
  f.run(step('publish', 'claim'), false);
});

for (const action of ['submit', 'wait', 'verify', 'published'])
  test(`Trusted Publisher assertion distinguishes ${action} from a new submission`, bashOnly, async (t) => {
    const f = await workflowFixture(t);
    f.env.NPM_TRUSTED_PUBLISHER_CONFIGURED = 'false';
    f.env.WORKFLOW_PRECLAIM_REPORT = JSON.stringify({ action });
    f.run(
      named('publish', 'Check the npm-side Trusted Publisher prerequisite before a new claim'),
      action !== 'submit',
    );
    assert.equal(
      (await f.calls()).some((call) => call.args.includes('--begin-submission')),
      false,
    );
  });

test('confirmed Trusted Publisher permits the prepared prerequisite check', bashOnly, async (t) => {
  const f = await workflowFixture(t);
  f.run(named('publish', 'Check the npm-side Trusted Publisher prerequisite before a new claim'));
});

for (const exit of [0, 1, 137])
  test(
    `npm exit ${exit} records accepted or unknown and never retries the original upload`,
    bashOnly,
    async (t) => {
      const f = await workflowFixture(t);
      await writeFile(path.join(f.env.STATE_DIR!, 'claim.json'), f.env.WORKFLOW_CLAIM_REPORT!);
      f.env.WORKFLOW_NPM_EXIT = String(exit);
      f.run(step('publish', 'npm'));
      const result = await f.outputs();
      assert.equal(result.outcome, exit === 0 ? 'accepted' : 'unknown');
      f.env.NPM_OUTCOME = result.outcome;
      f.run(named('publish', 'Persist accepted or unknown outcome without retrying npm'));
      const uploads = (await f.calls()).filter((call) => call.command === 'npm');
      assert.equal(uploads.length, 1);
      assert.deepEqual(uploads[0]!.args.slice(0, 2), ['publish', f.archive]);
      assert.deepEqual(uploads[0]!.args.slice(-2), ['--tag', 'release-v0.1.4']);
    },
  );

test('cancelled upload with no result does not invent an accepted receipt', () => {
  const guard = named('publish', 'Persist accepted or unknown outcome without retrying npm').if!;
  assert.equal(
    condition(guard, {
      steps: { claim: { outputs: { should_publish: 'true' } }, npm: { outputs: { outcome: '' } } },
    }),
    false,
  );
});

test(
  'twenty registry-missing results preserve the claim without resubmission or promotion',
  bashOnly,
  async (t) => {
    const f = await workflowFixture(t);
    f.env.WORKFLOW_VERIFY_REPORTS = JSON.stringify([{ action: 'wait' }]);
    f.run(step('publish', 'public'), false);
    assert.equal(await readFile(path.join(f.directory, 'verify-count'), 'utf8'), '20');
    assert.equal(
      (await f.calls()).some((call) => call.command === 'npm'),
      false,
    );
    assert.equal((await f.outputs()).verified, undefined);
  },
);

test('recovery can verify after indexing without a local initial claim archive path', bashOnly, async (t) => {
  const f = await workflowFixture(t);
  f.env.WORKFLOW_VERIFY_REPORTS = JSON.stringify([{ action: 'wait' }, workflowProof()]);
  f.run(step('publish', 'public'));
  assert.equal((await f.outputs()).verified, 'true');
  assert.equal(await readFile(path.join(f.directory, 'verify-count'), 'utf8'), '2');
  await assert.rejects(access(path.join(f.env.STATE_DIR!, 'claim.json')));
});

for (const [label, change] of Object.entries({
  'dry run': { dry_run: true },
  'unpersisted state': { state: 'submitted' },
  'missing real download': { registry_tarball_downloaded: false },
  'hash mismatch': { archive_sha256: 'c'.repeat(64) },
  'source drift': { source: 'd'.repeat(40) },
  'wrong tag': { tag: 'v0.1.5' },
  'wrong repository': { repository: 'other/project' },
}))
  test(`actual public gate rejects ${label}`, bashOnly, async (t) => {
    const f = await workflowFixture(t);
    f.env.WORKFLOW_VERIFY_REPORTS = JSON.stringify([workflowProof(change)]);
    f.run(step('publish', 'public'), false);
    assert.equal((await f.outputs()).verified, undefined);
  });

test('unexpected verification actions cannot enter promotion', bashOnly, async (t) => {
  const f = await workflowFixture(t);
  f.env.WORKFLOW_VERIFY_REPORTS = JSON.stringify([{ action: 'prepare' }]);
  f.run(step('publish', 'public'), false);
  assert.equal((await f.outputs()).verified, undefined);
});

test(
  'publication paths initialize through RUNNER_TEMP instead of unsupported job context',
  bashOnly,
  async (t) => {
    const f = await workflowFixture(t);
    f.run(named('publish', 'Initialize isolated publication paths'));
    const environment = await readFile(f.env.GITHUB_ENV!, 'utf8');
    assert.match(environment, /STATE_DIR=.*ai-modeling-publication\n/);
    await access(path.join(f.directory, 'ai-modeling-publication'));
  },
);
