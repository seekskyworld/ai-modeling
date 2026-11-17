/** 原生材料导出的已验目录登记须跨进程保留，且不放宽陌生文件或替换inode的拒绝。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, link, lstat, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { freezeUnbakedSource } from '../cli/artifacts/unbaked-material.ts';
import { unbakedProofKey, unbakedSourceKey } from '../cli/core/unbaked-material-policy.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import { array, object, TripoError } from '../studio/contracts/errors.ts';
import type { Artifact } from '../studio/contracts/types.ts';
import { fixture, quote } from './helpers.ts';
import { uvFixtureChunks, uvFixtureGlb, uvImportFixture } from './uv-import-fixture.ts';
import { downloadTask, type Application } from '../cli/compat/runtime.ts';
import { fullTools } from '../cli/compat/full-tools.ts';

const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const fileIdentity = async (file: string) => {
  const state = await lstat(file);
  return { device: state.dev, inode: state.ino, mtime: state.mtimeMs, sha256: hash(await readFile(file)) };
};
async function prepared() {
  const f = await fixture(),
    source = await uvImportFixture(false),
    parsed = uvFixtureChunks(source);
  const node = object(array(parsed.json.nodes)[0]);
  delete node.translation;
  node.matrix = [0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, -1, 1];
  const output = uvFixtureGlb(parsed.json, parsed.binary),
    parameters = normalize('export', {
      project_id: 'project',
      expected_operator_id: 'source',
      bake: false,
      pivot_to_center_bottom: true,
    }),
    job = f.jobs.prepare('test-account', 'original-native-unbaked', 'export', parameters, quote);
  const gateway = Object.assign(f.gateway, {
    materialSource: async () => ({ url: 'https://cdn.tripo3d.ai/source.glb', material_factors: {} }),
  });
  await freezeUnbakedSource(job, f.jobs, f.dir, gateway, async () => source);
  const original = path.join(await realpath(path.join(f.dir, 'output')), 'original.glb');
  f.service.config.outputDir = path.dirname(original);
  await writeFile(original, output);
  f.jobs.claim(job.job_id);
  f.jobs.update(job.job_id, 'submitted', {
    remote_ids: { project_id: 'project', operator_id: 'native-export' },
  });
  const artifact: Artifact = {
    artifact_id: 'model',
    kind: 'model',
    format: 'glb',
    index: 0,
    local_path: original,
    sha256: hash(output),
    bytes: output.length,
  };
  f.jobs.update(job.job_id, 'succeeded', { artifacts: [artifact] });
  assert.equal((await f.service.get(job.job_id)).state, 'succeeded');
  const calls = { reads: 0 };
  gateway.artifactUrl = async () => {
    calls.reads++;
    throw new TripoError('NETWORK_ERROR', 'Controlled offline original URL; cached proof is available.');
  };
  const current = () => f.jobs.get(job.job_id).artifacts[0]!;
  const proofs = () =>
    [unbakedSourceKey(job), unbakedProofKey(job, artifact)].map((key) =>
      f.jobs.requestPolicy(job.account_ref, key),
    );
  const mutate = (change: (value: Artifact) => void) => {
    const db = new DatabaseSync(path.join(f.dir, 'jobs.sqlite'));
    try {
      const value = current();
      change(value);
      db.prepare('UPDATE jobs SET artifacts=? WHERE job_id=?').run(JSON.stringify([value]), job.job_id);
    } finally {
      db.close();
    }
  };
  return { ...f, id: job.job_id, output, original, current, proofs, mutate, calls };
}
const close = async (f: Awaited<ReturnType<typeof prepared>>) => {
  f.jobs.close();
  await rm(f.dir, { recursive: true, force: true });
};

test('native unbaked A/B/C history survives reopen and reuses original inodes without rereading upstream', async () => {
  const f = await prepared();
  let reopened: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    const proof = f.proofs(),
      paths = [f.original];
    for (const name of ['a.glb', 'b.glb', 'c.glb'])
      paths.push(String((await f.service.download(f.id, 'model', name)).local_path));
    const states = await Promise.all(paths.map(fileIdentity));
    assert.deepEqual(
      f.current().frontend_deliveries?.map((entry) => entry.path),
      paths,
    );
    reopened = await fixture(f.dir);
    reopened.service.config.outputDir = path.dirname(f.original);
    reopened.gateway.artifactUrl = async () => {
      throw Error('Registered original files require no remote read');
    };
    for (const location of paths) {
      const restored = await reopened.service.download(f.id, 'model', location);
      assert.equal(restored.local_path, location);
      assert.equal(restored.sha256, hash(f.output));
    }
    assert.deepEqual(await Promise.all(paths.map(fileIdentity)), states);
    assert.deepEqual(f.proofs(), proof);
    assert.equal((await reopened.service.get(f.id)).state, 'succeeded');
    assert.equal(f.gateway.posts + reopened.gateway.posts, 0);
  } finally {
    reopened?.jobs.close();
    await close(f);
  }
});

test('unregistered same-byte copies, hardlinks, symlinks and replacement inodes are still rejected', async () => {
  const f = await prepared();
  try {
    await f.service.download(f.id, 'model', 'b.glb');
    const root = path.dirname(f.original),
      copy = path.join(root, 'copy.glb'),
      hard = path.join(root, 'hard.glb'),
      symbolic = path.join(root, 'symbolic.glb');
    await copyFile(f.original, copy);
    await link(f.original, hard);
    await symlink(f.original, symbolic);
    const registry = f.current().frontend_deliveries;
    for (const file of [copy, hard, symbolic])
      await assert.rejects(f.service.download(f.id, 'model', file), { code: 'OUTPUT_EXISTS' });
    await rename(f.original, path.join(root, 'kept-original.glb'));
    await writeFile(f.original, f.output);
    assert.notEqual(String((await lstat(f.original)).ino), registry![0]!.inode);
    await assert.rejects(f.service.download(f.id, 'model', f.original), { code: 'OUTPUT_EXISTS' });
    assert.deepEqual(f.current().frontend_deliveries, registry);
    assert.equal((await lstat(symbolic)).isSymbolicLink(), true);
    assert.equal(f.gateway.posts, 0);
  } finally {
    await close(f);
  }
});

test('a legacy latest path is registered, but its already-lost historical copy is never inferred', async () => {
  const f = await prepared();
  try {
    const b = String((await f.service.download(f.id, 'model', 'b.glb')).local_path);
    f.mutate((artifact) => {
      delete artifact.frontend_deliveries;
    });
    const c = String((await f.service.download(f.id, 'model', 'c.glb')).local_path);
    assert.deepEqual(
      f.current().frontend_deliveries?.map((entry) => entry.path),
      [b, c],
    );
    await assert.rejects(f.service.download(f.id, 'model', f.original), { code: 'OUTPUT_EXISTS' });
    const state = await fileIdentity(b);
    await f.service.download(f.id, 'model', b);
    assert.deepEqual(await fileIdentity(b), state);
    assert.equal(f.gateway.posts, 0);
  } finally {
    await close(f);
  }
});

test('parallel native downloads merge current transaction locations without replacing either proof', async () => {
  const f = await prepared(),
    other = await fixture(f.dir);
  try {
    other.service.config.outputDir = path.dirname(f.original);
    other.gateway.artifactUrl = f.gateway.artifactUrl;
    const proof = f.proofs();
    const results = await Promise.all([
      f.service.download(f.id, 'model', 'a.glb'),
      other.service.download(f.id, 'model', 'b.glb'),
    ]);
    const paths = [f.original, ...results.map((item) => String(item.local_path))].sort();
    assert.deepEqual(
      f
        .current()
        .frontend_deliveries?.map((entry) => entry.path)
        .sort(),
      paths,
    );
    for (const location of paths) await f.service.download(f.id, 'model', location);
    assert.deepEqual(f.proofs(), proof);
    assert.equal(f.gateway.posts + other.gateway.posts, 0);
  } finally {
    other.jobs.close();
    await close(f);
  }
});

test('changed parent-directory identity and forged incoming history do not authorize reuse', async () => {
  const f = await prepared();
  try {
    const a = String((await f.service.download(f.id, 'model', 'nested/a.glb')).local_path),
      current = f.current(),
      proof = f.proofs();
    f.jobs.saveArtifact(f.id, { ...current, frontend_deliveries: [] });
    assert.deepEqual(f.current().frontend_deliveries, current.frontend_deliveries);
    const originalParent = path.dirname(a);
    await rename(originalParent, originalParent + '-kept');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(originalParent);
    await link(path.join(originalParent + '-kept', 'a.glb'), a);
    assert.equal(
      (await lstat(a)).ino,
      Number(current.frontend_deliveries!.find((entry) => entry.path === a)!.inode),
    );
    await assert.rejects(f.service.download(f.id, 'model', a), { code: 'OUTPUT_EXISTS' });
    assert.deepEqual(f.proofs(), proof);
    assert.equal(f.gateway.posts, 0);
  } finally {
    await close(f);
  }
});

test('CLI and full MCP native unbaked download reject a same-byte replacement at the saved local_path', async () => {
  const f = await prepared();
  try {
    const app = { service: f.service } as Application,
      delivered = await downloadTask(app, await f.service.get(f.id), { out: f.service.config.outputDir }),
      file = String(delivered.model_file),
      previous = await fileIdentity(file),
      proofs = f.proofs();
    await rename(file, file + '.original');
    await writeFile(file, f.output);
    assert.notEqual((await lstat(file)).ino, previous.inode);
    const state = await fileIdentity(file);
    await assert.rejects(downloadTask(app, await f.service.get(f.id), { out: path.dirname(file) }), {
      code: 'OUTPUT_EXISTS',
    });
    const tool = fullTools(app.service, app.studio).find((entry) => entry.name === 'ai_modeling_download')!;
    await assert.rejects(tool.run({ task_id: f.id, output_dir: path.dirname(file) }), {
      code: 'OUTPUT_EXISTS',
    });
    assert.deepEqual(await fileIdentity(file), state);
    assert.deepEqual(f.proofs(), proofs);
    assert.equal(f.gateway.posts, 0);
  } finally {
    await close(f);
  }
});
