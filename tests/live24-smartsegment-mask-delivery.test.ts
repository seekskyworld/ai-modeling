/** 完整metadata产物组跨目录恢复；所有账号和数据均为临时夹具。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { copyFile, link, lstat, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { executePlan, downloadTask } from '../cli/compat/runtime.ts';
import { scaleFixture } from './helpers-smartsegment-scale.ts';
import { scaleSourceKey } from '../cli/core/smartsegment-scale-policy.ts';
import { object } from '../studio/contracts/errors.ts';

async function fixture() {
  const f = await scaleFixture();
  f.service.config.outputDir = await realpath(f.service.config.outputDir);
  await executePlan(f.app, f.plan(), f.flags);
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#7543db' } })
    .png()
    .toBuffer();
  const file = path.join(f.dir, 'current-mask.png');
  await writeFile(file, bytes);
  const job = f.modelJob();
  f.jobs.update(job.job_id, 'succeeded', {
    artifacts: job.artifacts.map((a) =>
      a.artifact_id === 'semantic-mask'
        ? {
            ...a,
            local_path: file,
            bytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          }
        : a,
    ),
  });
  return { ...f, maskBytes: bytes, maskFile: file };
}

test('metadata model and PNG reuse only registered original locations across B to C to B', async () => {
  const f = await fixture();
  try {
    const id = f.modelJob().job_id;
    const b = await downloadTask(
      f.app,
      { ...f.modelJob() },
      { out: path.join(f.service.config.outputDir, 'B') },
    );
    const files = b.files as string[];
    const before = await Promise.all(
      files.map(async (file) => ({ file, stat: await lstat(file), bytes: await readFile(file) })),
    );
    await downloadTask(f.app, { ...f.modelJob() }, { out: path.join(f.service.config.outputDir, 'C') });
    const restored = await downloadTask(
      f.app,
      { ...f.modelJob() },
      {
        out: path.join(f.service.config.outputDir, 'B'),
      },
    );
    assert.deepEqual(restored.files, files);
    for (const saved of before) {
      const stat = await lstat(saved.file);
      assert.equal(stat.ino, saved.stat.ino);
      assert.equal(stat.mtimeMs, saved.stat.mtimeMs);
      assert.deepEqual(await readFile(saved.file), saved.bytes);
    }
    const masks = f.jobs.get(id).artifacts.find((a) => a.artifact_id === 'semantic-mask')!;
    assert.equal(masks.frontend_deliveries?.length, 3); // current legacy location plus B/C
    assert.equal(f.gateway.posts, 3);
  } finally {
    await f.close();
  }
});

for (const kind of ['copy', 'hardlink', 'symlink', 'inode', 'unknown-history'] as const)
  test(`metadata PNG refuses ${kind} without overwriting or regenerating`, async () => {
    const f = await fixture();
    try {
      const id = f.modelJob().job_id;
      const a = String((await f.service.download(id, 'semantic-mask', 'mask-A.png')).local_path);
      await f.service.download(id, 'semantic-mask', 'mask-B.png');
      const target = path.join(f.service.config.outputDir, kind + '.png');
      if (kind === 'copy' || kind === 'unknown-history') await copyFile(a, target);
      if (kind === 'hardlink') await link(a, target);
      if (kind === 'symlink') await symlink(a, target);
      if (kind === 'inode') {
        await rename(a, a + '.original');
        await copyFile(a + '.original', a);
      }
      await assert.rejects(f.service.download(id, 'semantic-mask', kind === 'inode' ? a : target), {
        code: 'OUTPUT_EXISTS',
      });
      assert.equal(f.gateway.posts, 3);
    } finally {
      await f.close();
    }
  });

test('PNG frozen bytes recover after current delivery removal and reject changed artifact digest', async () => {
  const f = await fixture();
  try {
    const id = f.modelJob().job_id;
    const a = await f.service.download(id, 'semantic-mask', 'mask-A.png');
    await rm(String(a.local_path));
    await rm(f.maskFile);
    const b = await f.service.download(id, 'semantic-mask', 'mask-B.png');
    assert.deepEqual(await readFile(String(b.local_path)), f.maskBytes);
    const job = f.modelJob();
    f.jobs.update(id, 'succeeded', {
      artifacts: job.artifacts.map((item) =>
        item.artifact_id === 'semantic-mask' ? { ...item, sha256: 'f'.repeat(64) } : item,
      ),
    });
    await assert.rejects(f.service.download(id, 'semantic-mask', 'changed.png'));
    assert.equal(f.gateway.posts, 3);
  } finally {
    await f.close();
  }
});

test('PNG rechecks the frozen source after an asynchronous proof read before publication', async () => {
  const f = await fixture();
  try {
    const source = f.jobs.requestPolicy('test-account', scaleSourceKey('metadata-scale'))!;
    const original = f.jobs.requestPolicy.bind(f.jobs);
    let changed = false;
    f.jobs.requestPolicy = (account, key) => {
      const value = original(account, key);
      if (!changed && key.startsWith('smartsegment-scale-mask:')) {
        changed = true;
        queueMicrotask(() => rmSync(String(object(source.parameters).model_path)));
      }
      return value;
    };
    const target = path.join(f.service.config.outputDir, 'must-not-publish.png');
    await assert.rejects(f.service.download(f.modelJob().job_id, 'semantic-mask', target), {
      code: 'SMARTSEGMENT_SCALE_SOURCE_MISSING',
    });
    await assert.rejects(lstat(target), { code: 'ENOENT' });
    assert.equal(changed, true);
    assert.equal(f.gateway.posts, 3);
  } finally {
    await f.close();
  }
});

test('a JPEG payload cannot be frozen or delivered as the original PNG mask', async () => {
  const f = await fixture();
  try {
    const bytes = await sharp(f.maskBytes).jpeg().toBuffer();
    await writeFile(f.maskFile, bytes);
    const job = f.modelJob();
    f.jobs.update(job.job_id, 'succeeded', {
      artifacts: job.artifacts.map((a) =>
        a.artifact_id === 'semantic-mask'
          ? { ...a, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
          : a,
      ),
    });
    await assert.rejects(f.service.download(job.job_id, 'semantic-mask', 'wrong.png'), {
      code: 'ARTIFACT_FORMAT_MISMATCH',
    });
    assert.equal(f.gateway.posts, 3);
  } finally {
    await f.close();
  }
});
