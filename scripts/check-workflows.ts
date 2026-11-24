/** Offline release wiring checks; actionlint installation is a separate explicit CI step. */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export interface WorkflowStep {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  shell?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
export interface WorkflowJob {
  name?: string;
  environment?: string;
  if?: string;
  needs?: string[] | string;
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  concurrency?: { group: string; 'cancel-in-progress': boolean };
  strategy?: { matrix?: { include: { os: string; platform: string }[] } };
  steps: WorkflowStep[];
}
export interface WorkflowDocument {
  on: { push?: { tags?: string[]; branches?: string[] }; workflow_dispatch?: unknown };
  permissions: Record<string, string>;
  concurrency?: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<string, WorkflowJob>;
}

export function workflowStep(
  workflow: WorkflowDocument,
  job: string,
  selection: { id?: string; name?: string },
) {
  const found = workflow.jobs[job]?.steps.find(
    (step) =>
      (selection.id !== undefined && step.id === selection.id) ||
      (selection.name !== undefined && step.name === selection.name),
  );
  assert.ok(found, `Missing workflow step ${job}/${selection.id ?? selection.name}`);
  return found;
}

function pinnedActions(workflows: Record<string, WorkflowDocument>) {
  let actions = 0;
  for (const [filename, workflow] of Object.entries(workflows)) {
    assert.equal(workflow.permissions?.contents, 'read', `${filename} default permissions`);
    for (const job of Object.values(workflow.jobs))
      for (const step of job.steps ?? []) {
        if (!step.uses) continue;
        assert.match(
          step.uses,
          /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[a-f0-9]{40}$/,
          `${filename}: action must be pinned to a full commit`,
        );
        actions++;
      }
  }
  return actions;
}

function releaseGuards(release: WorkflowDocument) {
  assert.deepEqual(release.on.push?.tags, ['v*']);
  assert.ok('workflow_dispatch' in release.on);
  assert.equal(release.concurrency?.['cancel-in-progress'], false);
  for (const [name, job] of Object.entries(release.jobs)) {
    if (name === 'publish' || name === 'promote') {
      assert.deepEqual(job.permissions, { contents: 'write', 'id-token': 'write' });
      assert.ok(job.if?.includes("github.event_name == 'push'"));
      assert.ok(job.if?.includes("startsWith(github.ref, 'refs/tags/v')"));
    } else if (name === 'auth') {
      assert.deepEqual(job.permissions, { contents: 'read', 'id-token': 'write' });
    } else assert.equal(job.permissions, undefined, `Unexpected elevated permissions on ${name}`);
  }
  assert.deepEqual(release.jobs.build?.needs, ['inspect', 'auth']);
  assert.deepEqual(release.jobs.smoke?.needs, ['inspect', 'build']);
  assert.deepEqual(release.jobs.candidate?.needs, ['inspect', 'build', 'smoke']);
  assert.deepEqual(release.jobs.publish?.needs, ['inspect', 'auth', 'build', 'smoke', 'candidate']);
  assert.equal(workflowStep(release, 'inspect', { id: 'state' }).if, "github.event_name == 'push'");
  assert.equal(
    workflowStep(release, 'candidate', { name: 'Preview publication preparation without any remote write' })
      .if,
    "github.event_name == 'push'",
  );
  assert.match(workflowStep(release, 'inspect', { id: 'preview' }).run!, /action=prepare/);
  assert.doesNotMatch(workflowStep(release, 'inspect', { id: 'preview' }).run!, /npm-publication\.ts/);
}

function authenticationGuards(release: WorkflowDocument) {
  const auth = release.jobs.auth!;
  assert.ok(auth, 'New submissions require real npm authentication before candidate work');
  assert.equal(auth.needs, 'inspect');
  assert.equal(auth.environment, 'npm');
  assert.ok(auth.if?.includes("github.event_name == 'push'"));
  assert.ok(auth.if?.includes("startsWith(github.ref, 'refs/tags/v')"));
  const command = 'node scripts/npm-auth-check.ts --repository "$GITHUB_REPOSITORY" --out "$AUTH_REPORT"';
  const preflight = workflowStep(release, 'auth', { id: 'authenticate' });
  const recheck = workflowStep(release, 'publish', { id: 'auth' });
  for (const step of [preflight, recheck]) {
    assert.equal(step.run, command);
    assert.ok(step.env?.AUTH_REPORT?.endsWith('.json'));
  }
  for (const step of [preflight, recheck, workflowStep(release, 'publish', { id: 'npm' })])
    for (const variable of ['NODE_AUTH_TOKEN', 'NPM_TOKEN', 'NPM_ID_TOKEN'])
      assert.equal(step.env?.[variable], '', `${step.name}: consistent credential environment`);
  for (const job of [auth, release.jobs.publish!]) {
    assert.equal(job.environment, 'npm');
    assert.ok(job.steps.some((step) => step.run === 'npm ci --ignore-scripts'));
    assert.ok(job.steps.some((step) => step.run?.includes('npm@11.17.0')));
    const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    assert.equal(checkout?.with?.ref, '${{ needs.inspect.outputs.source }}');
    assert.equal(checkout?.with?.['persist-credentials'], false);
  }
  const retain = workflowStep(release, 'auth', {
    name: 'Retain the credential-free authentication report',
  });
  assert.equal(retain.if, 'always()');
  assert.equal(retain.with?.path, preflight.env?.AUTH_REPORT);
  assert.doesNotMatch(
    auth.steps.map((step) => step.run ?? '').join('\n'),
    /npm publish|dist-tag|npm-publication/,
  );
  assert.equal(recheck.if, "steps.preclaim.outputs.action == 'submit'");
  const claim = workflowStep(release, 'publish', { id: 'claim' });
  assert.equal(claim.if, "steps.preclaim.outputs.action == 'submit' && steps.auth.outcome == 'success'");
  const order = ['preclaim', 'auth', 'claim', 'npm'].map((id) =>
    release.jobs.publish!.steps.findIndex((step) => step.id === id),
  );
  assert.ok(order.every((index, position) => index >= 0 && (position === 0 || index > order[position - 1]!)));
  assert.equal(recheck.env?.AUTH_REPORT, '${{ runner.temp }}/ai-modeling-publication/auth-before-claim.json');
  const retainClaim = workflowStep(release, 'publish', {
    name: 'Retain local receipts even when publication is still pending',
  });
  assert.equal(retainClaim.if, 'always()');
  assert.ok(String(retainClaim.with?.path).includes('${{ runner.temp }}/ai-modeling-publication/*.json'));
}

function archiveGates(release: WorkflowDocument) {
  const platforms = release.jobs.smoke?.strategy?.matrix?.include.map((entry) => entry.platform).sort();
  assert.deepEqual(platforms, ['darwin', 'linux', 'win32']);
  const exports = Object.values(release.jobs)
    .flatMap((job) => job.steps)
    .filter((step) => /npm run export /.test(step.run ?? ''));
  assert.equal(exports.length, 1);
  assert.match(exports[0]!.run!, /--target all/);
  assert.match(
    workflowStep(release, 'candidate', {
      name: 'Reject missing platforms, drift, stale pricing and mismatched source or archives',
    }).run!,
    /--require-ready/,
  );
  assert.match(
    workflowStep(release, 'smoke', {
      name: 'Verify global npm, local npm, npx, JSON credentials, Sharp, MCP and Skill',
    }).run!,
    /--require-locked/,
  );
  const publish = release.jobs.publish!;
  assert.ok(publish.if?.includes("needs.candidate.result == 'success'"));
  assert.equal(
    workflowStep(release, 'publish', { id: 'npm' }).if,
    "steps.claim.outputs.should_publish == 'true'",
  );
  const npm = workflowStep(release, 'publish', { id: 'npm' }).run!;
  assert.match(npm, /npm publish "\$ARCHIVE_PATH"/);
  assert.match(npm, /--tag "\$NPM_UPLOAD_TAG"/);
  assert.match(workflowStep(release, 'inspect', { id: 'identity' }).run!, /'upload_tag=release-' \+ tag/);
  assert.match(workflowStep(release, 'publish', { id: 'claim' }).run!, /--begin-submission/);
  assert.match(
    workflowStep(release, 'publish', { id: 'public' }).run!,
    /registry_tarball_downloaded !== true/,
  );
}

function promotionGates(release: WorkflowDocument) {
  const promote = release.jobs.promote!;
  assert.deepEqual(promote.needs, ['inspect', 'publish']);
  assert.ok(promote.if?.includes("needs.publish.outputs.verified == 'true'"));
  assert.equal(promote.concurrency?.['cancel-in-progress'], false);
  assert.ok(promote.concurrency?.group && !promote.concurrency.group.includes('${{'));
  const entrypoint = workflowStep(release, 'promote', {
    name: 'Verify pending originals and advance default channels without rollback',
  });
  assert.match(entrypoint.run!, /scripts\/release-promotion\.ts --repository/);
  assert.doesNotMatch(entrypoint.run!, /--tag|--version|npm publish|--latest/);
  const checkout = promote.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout?.with?.['fetch-depth'], 0);
  assert.equal(checkout?.with?.['persist-credentials'], false);
  for (const job of [release.jobs.publish!, promote]) {
    assert.ok(job.steps.some((step) => step.run === 'npm ci --ignore-scripts'));
    assert.ok(job.steps.some((step) => step.run?.includes('npm@11.17.0')));
  }
}

export async function checkWorkflows(root: string) {
  const directory = path.join(root, '.github/workflows');
  const workflows: Record<string, WorkflowDocument> = {};
  for (const filename of (await readdir(directory)).filter((name) => /\.ya?ml$/.test(name)))
    workflows[filename] = parse(await readFile(path.join(directory, filename), 'utf8')) as WorkflowDocument;
  const actions = pinnedActions(workflows);
  const release = workflows['release.yml'];
  assert.ok(release, 'The controlled release workflow is required');
  releaseGuards(release);
  authenticationGuards(release);
  archiveGates(release);
  promotionGates(release);
  for (const job of [release.jobs.smoke, workflows['check.yml']?.jobs['installed-package']])
    assert.ok(
      job?.steps.some((step) => step.run?.includes('tests/json-entry-race.test.ts')),
      'Native credential entry-race checks must run in both three-platform matrices',
    );
  assert.ok(
    workflows['check.yml']?.jobs.workflows?.steps.some((step) => step.run === 'node scripts/actionlint.ts'),
  );
  return { workflows, actions };
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const { workflows, actions } = await checkWorkflows(fileURLToPath(new URL('../', import.meta.url)));
  process.stdout.write(
    JSON.stringify({ workflows: Object.keys(workflows).length, pinned_actions: actions, offline: true }) +
      '\n',
  );
}
