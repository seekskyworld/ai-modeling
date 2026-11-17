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
    } else assert.equal(job.permissions, undefined, `Only publication coordinators may elevate ${name}`);
  }
  assert.equal(release.jobs.build?.if, "needs.inspect.outputs.action == 'prepare'");
  assert.equal(workflowStep(release, 'inspect', { id: 'state' }).if, "github.event_name == 'push'");
  assert.equal(
    workflowStep(release, 'candidate', { name: 'Preview publication preparation without any remote write' })
      .if,
    "github.event_name == 'push'",
  );
  assert.match(workflowStep(release, 'inspect', { id: 'preview' }).run!, /action=prepare/);
  assert.doesNotMatch(workflowStep(release, 'inspect', { id: 'preview' }).run!, /npm-publication\.ts/);
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
