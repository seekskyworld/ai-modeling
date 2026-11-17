/** 真实远端会返回过期签名或404；恢复只使用已校验文件，损坏缓存和旧未加工结果不得冒充成功。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fixture, tinyGlb } from './helpers.ts';
import { text, TripoError } from '../studio/contracts/errors.ts';
import { downloadTask, type Application } from '../cli/compat/runtime.ts';

async function preparedExport(
  processed: boolean,
): Promise<Awaited<ReturnType<typeof fixture>> & { id: string }> {
  const f = await fixture();
  const result = await f.service.submit('export', 'recover-export', { project_id: 'p', scale_factor: 2 }, 10);
  const id = text(result.job_id);
  await f.service.get(id);
  const bytes = tinyGlb(),
    source = path.join(f.dir, 'original.glb');
  await writeFile(source, bytes);
  f.jobs.saveArtifact(id, {
    artifact_id: 'image-0',
    kind: 'model',
    format: 'glb',
    index: 0,
    local_path: source,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ...(processed ? { processing: 'Blender verified transform', source_sha256: 'b'.repeat(64) } : {}),
  });
  f.gateway.artifactUrl = async () => {
    throw new TripoError('DOWNLOAD_FAILED', 'Expired remote URL.', 'read', { http_status: 403 });
  };
  return { ...f, id };
}

test('expired downloads restore verified bytes with provenance, without resubmission or overwrite', async () => {
  const f = await preparedExport(true);
  try {
    const first = await f.service.download(f.id, 'image-0', 'restored.glb');
    assert.equal(first.restored_from_cache, true);
    assert.match(text(first.processing), /Blender/);
    assert.deepEqual(await readFile(text(first.local_path)), tinyGlb());
    f.gateway.artifactUrl = async () => {
      throw new TripoError('UPSTREAM_ERROR', 'Temporary metadata error.', 'read', { http_status: 520 });
    };
    const upstream = await f.service.download(f.id, 'image-0', 'upstream-520.glb');
    assert.equal(upstream.restored_from_cache, true);
    assert.deepEqual(await readFile(text(upstream.local_path)), tinyGlb());
    f.gateway.artifactUrl = async () => {
      throw new TripoError('UPSTREAM_ERROR', 'Unknown submission.', 'unknown', { http_status: 500 });
    };
    await assert.rejects(f.service.download(f.id, 'image-0', 'unknown.glb'), { code: 'UPSTREAM_ERROR' });
    f.gateway.artifactUrl = async () => {
      throw new TripoError('DOWNLOAD_FAILED', 'Expired remote URL.', 'read', { http_status: 403 });
    };
    await assert.rejects(f.service.download(f.id, 'image-0', 'restored.glb'), { code: 'OUTPUT_EXISTS' });
    // 数据库里记录的是最后一次已下载位置；同尺寸篡改也必须由摘要检查发现。
    const corrupt = tinyGlb();
    corrupt[corrupt.length - 1] = 0;
    await writeFile(text(upstream.local_path), corrupt);
    await assert.rejects(f.service.download(f.id, 'image-0', 'corrupt.glb'), { code: 'DOWNLOAD_FAILED' });
    await assert.rejects(access(path.join(f.dir, 'output', 'corrupt.glb')));
    assert.equal(f.gateway.posts, 1);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('old exports without verified transform provenance cannot satisfy a transformed download', async () => {
  const f = await preparedExport(false);
  try {
    await assert.rejects(f.service.download(f.id, 'image-0', 'old.glb'), { code: 'DOWNLOAD_FAILED' });
    assert.equal(f.gateway.posts, 1);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('automatic delivery does not report a deleted cached output as downloaded', async () => {
  const f = await preparedExport(true);
  try {
    const output = path.join(f.service.config.outputDir, 'image-0.glb');
    await writeFile(output, tinyGlb());
    const artifact = f.jobs.get(f.id).artifacts[0]!;
    f.jobs.saveArtifact(f.id, { ...artifact, local_path: output });
    const app = { service: f.service } as Application;
    const job = { ...f.jobs.get(f.id) };
    const result = await downloadTask(app, job, { out: f.service.config.outputDir });
    assert.deepEqual(result.files, [output]);
    await rm(output);
    await assert.rejects(downloadTask(app, job, { out: f.service.config.outputDir }), {
      code: 'DOWNLOAD_FAILED',
    });
    assert.equal(f.gateway.posts, 1);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
