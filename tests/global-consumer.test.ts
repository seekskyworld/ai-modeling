import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { compareInstalledPackageFiles } from '../scripts/global-consumer.ts';

test('global dependency comparison checks bytes and file inventory independently of matching versions', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-global-bytes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const expected = path.join(directory, 'reviewed');
  const actual = path.join(directory, 'global');
  for (const root of [expected, actual]) {
    await mkdir(root);
    await writeFile(path.join(root, 'package.json'), '{"name":"runtime","version":"1.0.0"}');
    await writeFile(path.join(root, 'module.node'), Buffer.from([0, 1, 2, 3]));
  }
  assert.equal(await compareInstalledPackageFiles(expected, actual), 2);
  await writeFile(path.join(actual, 'module.node'), Buffer.from([0, 1, 2, 4]));
  await assert.rejects(compareInstalledPackageFiles(expected, actual), /dependency bytes changed/);
  await writeFile(path.join(actual, 'module.node'), Buffer.from([0, 1, 2, 3]));
  await writeFile(path.join(actual, 'injected.js'), '');
  await assert.rejects(compareInstalledPackageFiles(expected, actual), /file inventory changed/);
});

test('global dependency verification rejects links instead of following another installed tree', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-global-link-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const expected = path.join(directory, 'reviewed');
  const linked = path.join(directory, 'linked');
  await mkdir(expected);
  await writeFile(path.join(expected, 'package.json'), '{}');
  await symlink(expected, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(compareInstalledPackageFiles(expected, linked), /real directory/);
});
