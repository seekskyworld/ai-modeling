/** Execute the actual Linux release snippets using disposable, non-network command substitutes. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import type { WorkflowStep } from '../scripts/check-workflows.ts';

export const workflowSource = 'a'.repeat(40);
export const workflowDigest = 'b'.repeat(64);
export const workflowProof = (changes: object = {}) => ({
  action: 'published',
  state: 'published',
  dry_run: false,
  registry_tarball_downloaded: true,
  archive_sha256: workflowDigest,
  verification: { sha256: workflowDigest },
  source: workflowSource,
  tag: 'v0.1.4',
  repository: 'maintainer/ai-modeling',
  ...changes,
});

const shim = `import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const [name, ...args] = process.argv.slice(2);
if (name === 'node' && !['scripts/npm-publication.ts', 'scripts/npm-auth-check.ts'].includes(args[0])) {
  const child = spawnSync(process.env.WORKFLOW_REAL_NODE, args, { env: process.env, stdio: 'inherit' });
  process.exit(child.status ?? 1);
}
const root = process.env.WORKFLOW_TEST_ROOT;
fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify({command: name, args}) + '\\n');
if (name === 'node') {
  if (args[0] === 'scripts/npm-auth-check.ts') {
    fs.writeFileSync(args[args.indexOf('--out') + 1], process.env.WORKFLOW_AUTH_REPORT);
    process.exit(Number(process.env.WORKFLOW_AUTH_EXIT ?? 0));
  }
  let report;
  if (args.includes('--begin-submission')) report = JSON.parse(process.env.WORKFLOW_CLAIM_REPORT);
  else if (args.includes('--submitted')) report = { action: 'wait', outcome: args[args.indexOf('--outcome') + 1] };
  else if (args[1] === 'verify') {
    const records = JSON.parse(process.env.WORKFLOW_VERIFY_REPORTS);
    const filename = path.join(root, 'verify-count');
    const count = fs.existsSync(filename) ? Number(fs.readFileSync(filename, 'utf8')) : 0;
    fs.writeFileSync(filename, String(count + 1));
    report = records[Math.min(count, records.length - 1)];
  } else report = JSON.parse(process.env.WORKFLOW_PRECLAIM_REPORT);
  fs.writeFileSync(args[args.indexOf('--out') + 1], JSON.stringify(report));
} else if (name === 'npm') process.exit(Number(process.env.WORKFLOW_NPM_EXIT ?? 0));
else if (name === 'git') process.stdout.write(process.env.SOURCE_COMMIT + '\\n');
`;

export async function workflowFixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-workflow-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binaries = path.join(directory, 'bin');
  for (const name of ['bin', 'state', 'candidate']) await mkdir(path.join(directory, name));
  await writeFile(path.join(directory, 'shim.mjs'), shim);
  for (const name of ['node', 'npm', 'git', 'sleep']) {
    const filename = path.join(binaries, name);
    await writeFile(filename, `#!/bin/sh\nexec "$WORKFLOW_REAL_NODE" "$WORKFLOW_SHIM" ${name} "$@"\n`);
    await chmod(filename, 0o755);
  }
  const archive = path.join(directory, 'original.tgz');
  await writeFile(archive, 'synthetic frozen original');
  await writeFile(
    path.join(directory, 'package.json'),
    JSON.stringify({ name: '@seekskyworld/ai-modeling', version: '0.1.4' }),
  );
  await writeFile(path.join(directory, 'candidate', 'readiness.json'), JSON.stringify({ ready: true }));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: binaries + path.delimiter + process.env.PATH,
    GH_TOKEN: 'synthetic-unused-token',
    GITHUB_TOKEN: '',
    NODE_AUTH_TOKEN: '',
    NPM_TOKEN: '',
    NPM_ID_TOKEN: '',
    WORKFLOW_REAL_NODE: process.execPath,
    WORKFLOW_SHIM: path.join(directory, 'shim.mjs'),
    WORKFLOW_TEST_ROOT: directory,
    GITHUB_OUTPUT: path.join(directory, 'output'),
    GITHUB_ENV: path.join(directory, 'env'),
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/tags/v0.1.4',
    GITHUB_REPOSITORY: 'maintainer/ai-modeling',
    RUNNER_TEMP: directory,
    SOURCE_COMMIT: workflowSource,
    RELEASE_TAG: 'v0.1.4',
    VERSION: '0.1.4',
    STATE_DIR: path.join(directory, 'state'),
    RESTORE_DIR: path.join(directory, 'restore'),
    CANDIDATE_DIR: path.join(directory, 'candidate'),
    PLAN_FILE: path.join(directory, 'preview.json'),
    AUTH_REPORT: path.join(directory, 'state', 'auth-before-claim.json'),
    NPM_UPLOAD_TAG: 'release-v0.1.4',
    PUBLICATION_RUN: '123.1',
    NPM_TRUSTED_PUBLISHER_CONFIGURED: 'true',
    WORKFLOW_PRECLAIM_REPORT: JSON.stringify({ action: 'submit' }),
    WORKFLOW_AUTH_REPORT: JSON.stringify({ schema_version: 1, success: true, stages: [] }),
    WORKFLOW_CLAIM_REPORT: JSON.stringify({ action: 'publish', should_publish: true, archive_path: archive }),
    WORKFLOW_VERIFY_REPORTS: JSON.stringify([workflowProof()]),
  };
  const run = (step: WorkflowStep, success = true) => {
    assert.ok(step.run);
    const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run], {
      cwd: directory,
      env,
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(result.status === 0, success, `${step.name ?? step.id}: ${result.stderr} ${result.stdout}`);
    return result;
  };
  const outputs = async () =>
    Object.fromEntries(
      (await readFile(env.GITHUB_OUTPUT!, 'utf8').catch(() => ''))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('=')),
    );
  const calls = async () =>
    (await readFile(path.join(directory, 'calls.jsonl'), 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { command: string; args: string[] });
  return { directory, env, archive, run, outputs, calls };
}
