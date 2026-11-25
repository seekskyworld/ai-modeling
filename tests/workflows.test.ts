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
        cancelled: () => false,
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
      auth?: string;
      build?: string;
      smoke?: string;
      candidate?: string;
    } = {},
  ) =>
    condition(release.jobs.publish!.if!, {
      github: { event_name: changes.event ?? 'push', ref: changes.ref ?? 'refs/tags/v0.1.4' },
      needs: {
        inspect: { result: changes.inspect ?? 'success', outputs: { action: changes.action ?? 'prepare' } },
        auth: { result: changes.auth ?? 'success' },
        build: { result: changes.build ?? 'success' },
        smoke: { result: changes.smoke ?? 'success' },
        candidate: { result: changes.candidate ?? 'success' },
      },
    });
  assert.equal(permitted(), true);
  assert.equal(permitted({ event: 'workflow_dispatch' }), false);
  assert.equal(permitted({ ref: 'refs/heads/main' }), false);
  for (const name of ['inspect', 'auth', 'build', 'smoke', 'candidate'])
    assert.equal(permitted({ [name]: 'failure' }), false);
  for (const action of ['submit', 'wait', 'verify', 'published']) {
    const values = { action, build: 'skipped', smoke: 'skipped', candidate: 'skipped' };
    assert.equal(permitted(values), true);
    assert.equal(permitted({ ...values, event: 'workflow_dispatch' }), false);
    assert.equal(
      condition(release.jobs.build!.if!, {
        github: { event_name: 'push' },
        needs: { inspect: { result: 'success', outputs: { action } }, auth: { result: 'success' } },
      }),
      false,
    );
    for (const auth of ['failure', 'cancelled', 'skipped'])
      assert.equal(permitted({ ...values, auth }), action !== 'submit');
  }
  for (const action of ['', 'publish', 'unknown', 'import_required'])
    assert.equal(permitted({ action }), false);
});

test('real authentication is exclusive to new tag submissions and gates candidate work', () => {
  for (const event of ['push', 'workflow_dispatch'])
    for (const action of ['prepare', 'submit', 'wait', 'verify', 'published'])
      for (const inspect of ['success', 'failure', 'cancelled', 'skipped'])
        for (const auth of ['success', 'failure', 'cancelled', 'skipped']) {
          const context = {
            github: { event_name: event, ref: 'refs/tags/v0.1.4' },
            needs: { inspect: { result: inspect, outputs: { action } }, auth: { result: auth } },
          };
          assert.equal(
            condition(release.jobs.auth!.if!, context),
            event === 'push' && inspect === 'success' && ['prepare', 'submit'].includes(action),
          );
          assert.equal(
            condition(release.jobs.build!.if!, context),
            inspect === 'success' &&
              action === 'prepare' &&
              (event === 'workflow_dispatch' || auth === 'success'),
          );
        }
  assert.equal(
    condition(release.jobs.auth!.if!, {
      github: { event_name: 'push', ref: 'refs/heads/main' },
      needs: { inspect: { result: 'success', outputs: { action: 'prepare' } } },
    }),
    false,
  );
});

test('manual preview continues its full candidate graph after the authentication job is skipped', () => {
  const context = {
    github: { event_name: 'workflow_dispatch', ref: 'refs/heads/main' },
    needs: {
      inspect: { result: 'success', outputs: { action: 'prepare' } },
      auth: { result: 'skipped' },
      build: { result: 'success' },
      smoke: { result: 'success' },
      candidate: { result: 'success' },
    },
  };
  assert.equal(condition(release.jobs.auth!.if!, context), false);
  for (const job of ['build', 'smoke', 'candidate']) {
    assert.match(release.jobs[job]!.if!, /always\(\)/);
    assert.equal(condition(release.jobs[job]!.if!, context), true);
  }
  assert.equal(condition(release.jobs.publish!.if!, context), false);
  for (const failed of ['inspect', 'build', 'smoke']) {
    const failedContext = structuredClone(context);
    failedContext.needs[failed as 'inspect' | 'build' | 'smoke'].result = 'failure';
    assert.equal(condition(release.jobs.candidate!.if!, failedContext), false);
    if (failed !== 'smoke') assert.equal(condition(release.jobs.smoke!.if!, failedContext), false);
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

async function submissionSteps(fixture: Awaited<ReturnType<typeof workflowFixture>>, authSuccess = true) {
  const steps: Record<string, { outcome: string; outputs: Record<string, string> }> = Object.fromEntries(
    ['preclaim', 'auth', 'claim', 'npm'].map((id) => [id, { outcome: 'skipped', outputs: {} }]),
  );
  let successful = true;
  for (const id of ['preclaim', 'auth', 'claim', 'npm']) {
    const current = step('publish', id);
    if (!successful || (current.if && !condition(current.if, { steps }))) continue;
    const result = fixture.run(current, id !== 'auth' || authSuccess);
    successful = result.status === 0;
    steps[id] = { outcome: successful ? 'success' : 'failure', outputs: await fixture.outputs() };
  }
  return steps;
}

test('early authentication failure writes its report and prevents the build gate', bashOnly, async (t) => {
  const f = await workflowFixture(t);
  f.env.WORKFLOW_AUTH_EXIT = '1';
  f.env.WORKFLOW_AUTH_REPORT = JSON.stringify({ schema_version: 1, success: false, stages: [] });
  f.run(step('auth', 'authenticate'), false);
  assert.equal(JSON.parse(await readFile(f.env.AUTH_REPORT!, 'utf8')).success, false);
  assert.equal(
    condition(release.jobs.build!.if!, {
      github: { event_name: 'push' },
      needs: { inspect: { result: 'success', outputs: { action: 'prepare' } }, auth: { result: 'failure' } },
    }),
    false,
  );
  assert.deepEqual(
    (await f.calls()).map((call) => call.args[0]),
    ['scripts/npm-auth-check.ts'],
  );
  assert.equal(condition(named('auth', 'Retain the credential-free authentication report').if!, {}), true);
});

test(
  'expired authentication after candidate work preserves the prepared state without consuming a claim',
  bashOnly,
  async (t) => {
    const f = await workflowFixture(t);
    f.env.AUTH_REPORT = path.join(f.directory, 'auth-before-build.json');
    f.run(step('auth', 'authenticate'));
    f.env.AUTH_REPORT = path.join(f.env.STATE_DIR!, 'auth-before-claim.json');
    f.env.WORKFLOW_AUTH_EXIT = '1';
    f.env.WORKFLOW_AUTH_REPORT = JSON.stringify({ schema_version: 1, success: false, stages: [] });
    const steps = await submissionSteps(f, false);
    assert.equal(steps.auth!.outcome, 'failure');
    assert.equal(steps.claim!.outcome, 'skipped');
    assert.equal(steps.npm!.outcome, 'skipped');
    const calls = await f.calls();
    assert.equal(calls.filter((call) => call.args[0] === 'scripts/npm-auth-check.ts').length, 2);
    assert.equal(
      calls.some((call) => call.args.includes('--begin-submission') || call.command === 'npm'),
      false,
    );
    assert.equal(JSON.parse(await readFile(f.env.AUTH_REPORT!, 'utf8')).success, false);
    await assert.rejects(access(path.join(f.env.STATE_DIR!, 'claim.json')));
    assert.equal(
      condition(named('publish', 'Retain local receipts even when publication is still pending').if!, {}),
      true,
    );
  },
);

test(
  'successful reauthentication precedes the unique claim and exact original upload',
  bashOnly,
  async (t) => {
    const f = await workflowFixture(t);
    const steps = await submissionSteps(f);
    assert.equal(steps.auth!.outcome, 'success');
    assert.equal(steps.claim!.outputs.should_publish, 'true');
    const calls = await f.calls();
    assert.equal(calls.length, 4);
    assert.equal(calls[0]!.args[0], 'scripts/npm-publication.ts');
    assert.equal(calls[1]!.args[0], 'scripts/npm-auth-check.ts');
    assert.ok(calls[2]!.args.includes('--begin-submission'));
    assert.deepEqual(calls[3]!.args.slice(0, 2), ['publish', f.archive]);
  },
);

for (const action of ['wait', 'verify', 'published'])
  test(
    `fresh preclaim ${action} bypasses authentication and claims while preserving public verification`,
    bashOnly,
    async (t) => {
      const f = await workflowFixture(t);
      // This also covers inspect=prepare/submit followed by another run acquiring the claim.
      f.env.WORKFLOW_PRECLAIM_REPORT = JSON.stringify({ action });
      f.env.NPM_TRUSTED_PUBLISHER_CONFIGURED = 'false';
      f.env.WORKFLOW_AUTH_EXIT = '1';
      const steps = await submissionSteps(f, false);
      for (const id of ['auth', 'claim', 'npm']) assert.equal(steps[id]!.outcome, 'skipped');
      f.run(step('publish', 'public'));
      assert.equal((await f.outputs()).verified, 'true');
      const calls = await f.calls();
      assert.ok(calls.some((call) => call.args[1] === 'verify'));
      assert.equal(
        calls.some(
          (call) =>
            call.args[0] === 'scripts/npm-auth-check.ts' ||
            call.args.includes('--begin-submission') ||
            call.command === 'npm',
        ),
        false,
      );
      await assert.rejects(access(f.env.AUTH_REPORT!));
      await assert.rejects(access(path.join(f.env.STATE_DIR!, 'claim.json')));
    },
  );

test('concurrent acquisition after reauthentication still cannot replay npm', bashOnly, async (t) => {
  const f = await workflowFixture(t);
  f.env.WORKFLOW_CLAIM_REPORT = JSON.stringify({ action: 'wait', should_publish: false });
  const steps = await submissionSteps(f);
  assert.equal(steps.auth!.outcome, 'success');
  assert.equal(steps.claim!.outputs.should_publish, 'false');
  assert.equal(steps.npm!.outcome, 'skipped');
  f.run(step('publish', 'public'));
  assert.equal((await f.outputs()).verified, 'true');
  assert.equal(
    (await f.calls()).some((call) => call.command === 'npm'),
    false,
  );
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
