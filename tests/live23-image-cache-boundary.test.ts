/** 私有目录预置/跨await替换都不能把原图或编码结果写到dataDir以外。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir, rename, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { fixture, imageInput, quote } from './helpers.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import { freezeImageSizePolicy } from '../cli/core/image-size-policy.ts';
import { freezeImageOutputPolicy } from '../cli/core/image-output-policy.ts';
import { ensureImageSize } from '../cli/artifacts/image-size-output.ts';
import { ensureImageOutput } from '../cli/artifacts/image-output.ts';
import { downloadArtifactBytes } from '../cli/artifacts/download.ts';
import type { Artifact, Job } from '../studio/contracts/types.ts';
import type { Fetcher } from '../studio/api/client.ts';

const cases = [
  { mode: 'size', directory: 'image-size-cache', ensure: ensureImageSize },
  { mode: 'format', directory: 'image-output-cache', ensure: ensureImageOutput },
] as const;
async function prepared(mode: 'size' | 'format', local: boolean) {
  const f = await fixture(),
    request = 'boundary-' + mode;
  const bytes = await sharp({ create: { width: 2, height: 3, channels: 3, background: '#d40ca2' } })
    .png()
    .toBuffer();
  if (mode === 'size') freezeImageSizePolicy(f.jobs, 'test-account', request, { width: 2, height: 3 });
  else freezeImageOutputPolicy(f.jobs, 'test-account', request, 'jpeg');
  const job = f.jobs.prepare('test-account', request, 'image', normalize('image', imageInput), quote);
  const artifact: Artifact = { artifact_id: 'image-0', kind: 'image', format: 'image', index: 0 };
  if (local) {
    const file = path.join(f.dir, 'input.png');
    await writeFile(file, bytes);
    Object.assign(artifact, {
      local_path: file,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  f.jobs.claim(job.job_id);
  f.jobs.update(job.job_id, 'submitted', { remote_ids: { asset_id: 'owned-boundary' } });
  const complete = f.jobs.update(job.job_id, 'succeeded', { artifacts: [artifact] });
  return { ...f, job: complete, bytes };
}
async function cleanup(f: Awaited<ReturnType<typeof prepared>>, outside: string): Promise<void> {
  f.jobs.close();
  await rm(f.dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
}

for (const entry of cases) {
  test(`${entry.mode} cache rejects a preexisting parent symlink without any outside files`, async () => {
    const f = await prepared(entry.mode, true),
      outside = await mkdtemp(path.join(os.tmpdir(), 'ai-modeling-outside-image-'));
    try {
      await symlink(outside, path.join(f.dir, entry.directory), 'dir');
      await assert.rejects(entry.ensure(f.job, f.jobs, f.dir, f.gateway), {
        code: 'IMAGE_CACHE_PATH_DENIED',
      });
      assert.deepEqual(await readdir(outside), []);
      assert.equal(f.jobs.get(f.job.job_id).state, 'succeeded');
      assert.equal(f.gateway.posts, 0);
    } finally {
      await cleanup(f, outside);
    }
  });

  for (const replacement of ['symlink', 'directory'] as const) {
    test(`${entry.mode} cache rejects parent ${replacement} replacement during artifact download`, async () => {
      const f = await prepared(entry.mode, false),
        outside = await mkdtemp(path.join(os.tmpdir(), 'ai-modeling-outside-image-'));
      try {
        const root = path.join(f.dir, entry.directory);
        const fetcher: Fetcher = async () => {
          await rename(root, root + '-moved');
          if (replacement === 'symlink') await symlink(outside, root, 'dir');
          else await mkdir(root);
          return new Response(Uint8Array.from(f.bytes));
        };
        await assert.rejects(entry.ensure(f.job, f.jobs, f.dir, f.gateway, fetcher), {
          code: 'IMAGE_CACHE_PATH_DENIED',
        });
        assert.deepEqual(await readdir(outside), []);
        if (replacement === 'directory') assert.deepEqual(await readdir(root), []);
        const current = f.jobs.get(f.job.job_id);
        assert.equal(current.artifacts[0]!.image_size, undefined);
        assert.equal(current.artifacts[0]!.image_output, undefined);
        assert.equal(f.gateway.posts, 0);
      } finally {
        await cleanup(f, outside);
      }
    });
  }

  test(`${entry.mode} cache parent symlink cannot be reused by get/list/download even with matching bytes`, async () => {
    const f = await prepared(entry.mode, true),
      outside = await mkdtemp(path.join(os.tmpdir(), 'ai-modeling-outside-image-'));
    try {
      const job: Job = await entry.ensure(f.job, f.jobs, f.dir, f.gateway);
      const artifact = job.artifacts[0]!;
      const cached =
        entry.mode === 'size' ? artifact.image_size!.source_cache_path : artifact.image_output!.cache_path;
      const parent = path.dirname(cached),
        moved = path.join(outside, 'retained-original');
      await rename(parent, moved);
      await symlink(moved, parent, 'dir');
      const before = await readdir(moved);
      assert.equal(f.service.summary(job).state, 'needs_attention');
      const view = await f.service.get(job.job_id);
      assert.equal(view.state, 'needs_attention');
      assert.equal(view.remote_state, 'succeeded');
      await assert.rejects(
        f.service.download(job.job_id, 'image-0', entry.mode === 'size' ? 'denied.png' : 'denied.jpeg'),
        { code: 'IMAGE_CACHE_PATH_DENIED' },
      );
      assert.deepEqual(await readdir(moved), before);
      assert.equal(f.gateway.posts, 0);
    } finally {
      await cleanup(f, outside);
    }
  });
}

test('private-image byte download retains host, HTTP and complete-stream checks', async () => {
  let calls = 0;
  const fetcher: Fetcher = async () => {
    calls++;
    return new Response('untrusted');
  };
  await assert.rejects(downloadArtifactBytes('https://example.test/a.png', 'image', fetcher), {
    code: 'DOWNLOAD_HOST_DENIED',
  });
  assert.equal(calls, 0);
  await assert.rejects(
    downloadArtifactBytes(
      'https://cdn.tripo3d.ai/a.png',
      'image',
      async () => new Response('x', { headers: { 'content-length': '10' } }),
    ),
    { code: 'INVALID_ARTIFACT' },
  );
  await assert.rejects(
    downloadArtifactBytes(
      'https://cdn.tripo3d.ai/a.png',
      'image',
      async () => new Response('x', { status: 404 }),
    ),
    { code: 'DOWNLOAD_FAILED' },
  );
});
