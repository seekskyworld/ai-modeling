import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkUpdate, updateInstructions } from '../cli/update.ts';
import { PACKAGE_NAME } from '../version.ts';

const execute = promisify(execFile);
const metadata = (version: string, name = PACKAGE_NAME) => Response.json({ name, version });

test('npm version checks only the scoped public endpoint and provide the exact upgrade version', async () => {
  const result = await checkUpdate(async (url, init) => {
    assert.equal(url, 'https://registry.npmjs.org/%40seekskyworld%2Fai-modeling/latest');
    assert.equal(init.method, 'GET');
    assert.deepEqual(init.headers, { Accept: 'application/json' });
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    return metadata('0.2.0');
  }, '0.1.0');
  assert.equal(result.published, true);
  assert.equal(result.update_available, true);
  assert.equal(result.updated, false);
  assert.equal(result.command, `npm install --global ${PACKAGE_NAME}@0.2.0`);
});

test('update comparison handles stable, prerelease and build versions without advising a downgrade', async () => {
  for (const [current, latest, newer] of [
    ['0.1.0', '0.1.0', false],
    ['0.2.0', '0.1.9', false],
    ['0.1.0-rc.2', '0.1.0-rc.10', true],
    ['0.1.0-rc.10', '0.1.0', true],
    ['0.1.0', '0.1.0-rc.10', false],
    ['0.1.0-beta.2', '0.1.0-beta', false],
    ['0.1.0-beta.2', '0.1.0-beta.a', true],
    ['0.1.0+first', '0.1.0+second', false],
    ['0.1.0-a', '0.1.0-b', true],
  ] as const) {
    const result = await checkUpdate(async () => metadata(latest), current);
    assert.equal(result.update_available, newer, `${current} -> ${latest}`);
    if (!newer) assert.equal(result.command, null);
  }
});

test('missing or unverifiable registry versions never claim the installation is up to date', async () => {
  const missing = await checkUpdate(async () => new Response('{}', { status: 404 }));
  assert.equal(missing.published, false);
  assert.equal(missing.latest, null);
  assert.equal(missing.update_available, null);
  assert.equal(missing.command, null);
  for (const fetcher of [
    async () => metadata('0.2.0', 'some-other-package'),
    async () => metadata('0.2.0; echo unexpected'),
    async () => metadata('0.2.0-01'),
    async () => new Response('{}', { status: 500 }),
    async () => new Response('not-json'),
    async () => new Response('x'.repeat(1024 * 1024 + 1)),
    async () => {
      throw new Error('sensitive-network-diagnostic');
    },
  ]) {
    await assert.rejects(checkUpdate(fetcher), (error: unknown) => {
      assert.equal((error as { code: string }).code, 'UPDATE_CHECK_FAILED');
      assert.doesNotMatch(String(error), /sensitive-network-diagnostic/);
      return true;
    });
  }
});

test('update without --check prints package-manager instructions offline without initializing state', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-modeling-update-'));
  const data = path.join(dir, 'state');
  try {
    const { stdout } = await execute(
      process.execPath,
      [fileURLToPath(new URL('../cli/main.ts', import.meta.url)), 'update', '--json'],
      { env: { ...process.env, AI_MODELING_DATA_DIR: data } },
    );
    const result = JSON.parse(stdout);
    assert.equal(result.command, updateInstructions().command);
    assert.equal(result.latest, null);
    assert.equal(result.updated, false);
    await assert.rejects(access(data), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
