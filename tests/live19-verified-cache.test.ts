/** 内部验收不能丢掉 URL-only 回执唯一的原文件；复用只认同账号冻结的 SHA/字节。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { recoverVerifiedArtifact, saveVerifiedOutputCache } from '../cli/artifacts/verified-output-cache.ts';
import { fixture, quote, tinyGlb } from './helpers.ts';
import type { Artifact, Job } from '../studio/contracts/types.ts';

const artifact = (): Artifact => ({ artifact_id: 'model', kind: 'model', format: 'glb', index: 0 });
const proof = (bytes: Buffer): { sha256: string; bytes: number } => ({
  sha256: createHash('sha256').update(bytes).digest('hex'),
  bytes: bytes.length,
});
function prepare(f: Awaited<ReturnType<typeof fixture>>, account = 'test-account', request = 'cache'): Job {
  return f.jobs.prepare(account, request, 'export', { project_id: 'project', format: 'glb' }, quote);
}
async function savedModel(
  f: Awaited<ReturnType<typeof fixture>>,
  account: string,
  request: string,
  data: Buffer,
): Promise<Artifact> {
  const job = prepare(f, account, request),
    file = path.join(f.dir, `${request}.glb`);
  await writeFile(file, data);
  const saved = { ...artifact(), ...proof(data), local_path: file };
  f.jobs.claim(job.job_id);
  f.jobs.update(job.job_id, 'submitted', { remote_ids: { operator_id: request, project_id: 'project' } });
  f.jobs.update(job.job_id, 'succeeded', { artifacts: [saved] });
  return saved;
}
test('private verified cache survives loss of the original file and concurrent writes preserve identical bytes', async () => {
  const f = await fixture();
  try {
    const job = prepare(f),
      data = tinyGlb(),
      expected = proof(data);
    const [a, b] = await Promise.all([
      saveVerifiedOutputCache(job, artifact(), expected, data, f.dir),
      saveVerifiedOutputCache(job, artifact(), expected, data, f.dir),
    ]);
    assert.equal(a.local_path, b.local_path);
    const cached = await recoverVerifiedArtifact(job, artifact(), expected, f.jobs, f.dir);
    assert.deepEqual(await readFile(cached!.local_path!), data);
    assert.equal(f.jobs.get(job.job_id).artifacts.length, 0);
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
test('legacy matching bytes can be recovered only from the same account and are rehashed from disk', async () => {
  const f = await fixture();
  try {
    const job = prepare(f),
      data = tinyGlb(),
      expected = proof(data);
    await savedModel(f, 'different-account', 'wrong-account', data);
    assert.equal(await recoverVerifiedArtifact(job, artifact(), expected, f.jobs, f.dir), undefined);
    const original = await savedModel(f, 'test-account', 'old-original', data);
    await writeFile(original.local_path!, Buffer.from('not the original bytes'));
    assert.equal(await recoverVerifiedArtifact(job, artifact(), expected, f.jobs, f.dir), undefined);
    await writeFile(original.local_path!, data);
    const restored = await recoverVerifiedArtifact(job, artifact(), expected, f.jobs, f.dir);
    assert.deepEqual(await readFile(restored!.local_path!), data);
    await rm(original.local_path!);
    assert.ok(await recoverVerifiedArtifact(job, artifact(), expected, f.jobs, f.dir));
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
test('bad content addresses, replacement bytes and corrupt private cache cannot become verified output', async () => {
  const f = await fixture();
  try {
    const job = prepare(f),
      data = tinyGlb(),
      expected = proof(data);
    await assert.rejects(
      saveVerifiedOutputCache(job, artifact(), expected, Buffer.from('replacement'), f.dir),
      { code: 'VERIFIED_CACHE_INVALID' },
    );
    await assert.rejects(
      recoverVerifiedArtifact(job, artifact(), { ...expected, sha256: '../invalid' }, f.jobs, f.dir),
      { code: 'VERIFIED_CACHE_INVALID' },
    );
    const location = path.join(
      f.dir,
      'verified-output-cache',
      createHash('sha256').update(job.account_ref).digest('hex'),
      `${expected.sha256}.glb`,
    );
    await mkdir(path.dirname(location), { recursive: true });
    await writeFile(location, Buffer.from('corrupt'));
    await assert.rejects(saveVerifiedOutputCache(job, artifact(), expected, data, f.dir), {
      code: 'VERIFIED_CACHE_INVALID',
    });
    assert.deepEqual(await readFile(location), Buffer.from('corrupt'));
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('cache roots and account buckets reject symbolic links or non-directories before read or publication', async () => {
  for (const level of ['root', 'account', 'file']) {
    const f = await fixture();
    try {
      const job = prepare(f),
        data = tinyGlb(),
        expected = proof(data);
      const root = path.join(f.dir, 'verified-output-cache'),
        alternate = path.join(f.dir, 'alternate-empty-directory');
      await mkdir(alternate);
      if (level === 'root') await symlink(alternate, root);
      else if (level === 'file') await writeFile(root, 'not a directory');
      else {
        await mkdir(root);
        await symlink(alternate, path.join(root, createHash('sha256').update(job.account_ref).digest('hex')));
      }
      await assert.rejects(saveVerifiedOutputCache(job, artifact(), expected, data, f.dir), {
        code: 'VERIFIED_CACHE_PATH_DENIED',
      });
      await assert.rejects(recoverVerifiedArtifact(job, artifact(), expected, f.jobs, f.dir), {
        code: 'VERIFIED_CACHE_PATH_DENIED',
      });
      assert.deepEqual(await readdir(alternate), []);
      assert.equal(f.gateway.posts, 0);
    } finally {
      f.jobs.close();
      await rm(f.dir, { recursive: true, force: true });
    }
  }
});
