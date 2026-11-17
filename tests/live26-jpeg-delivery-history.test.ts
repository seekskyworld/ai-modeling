/** JPEG交付保持冻结编码与原生摘要，两次下载相同已登记位置不应被误判为陌生文件。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFile, lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fixture, quote } from './helpers.ts';
import { uvImportFixture } from './uv-import-fixture.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import { exportJpegPolicyKey, exportJpegProofKey } from '../cli/core/export-jpeg-policy.ts';
import { ensureExportJpeg } from '../cli/artifacts/export-jpeg-output.ts';
import type { Artifact } from '../studio/contracts/types.ts';
import { downloadTask, type Application } from '../cli/compat/runtime.ts';
import { fullTools } from '../cli/compat/full-tools.ts';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const fileState = async (file: string) => {
  const stat = await lstat(file);
  return { inode: stat.ino, device: stat.dev, mtime: stat.mtimeMs, sha256: hash(await readFile(file)) };
};
async function prepared() {
  const f = await fixture(),
    bytes = await uvImportFixture(false),
    request = 'plain-jpeg',
    input = normalize('export', {
      project_id: 'project',
      format: 'glb',
      expected_operator_id: 'source',
      texture_format: 'JPEG',
    });
  f.service.config.outputDir = await realpath(path.join(f.dir, 'output'));
  f.jobs.bindRequestPolicy('test-account', exportJpegPolicyKey(request), {
    version: 1,
    mode: 'jpeg',
    project_id: 'project',
    operator_id: 'source',
  });
  const pending = f.jobs.prepare('test-account', request, 'export', input, quote),
    job = f.jobs.update(pending.job_id, 'succeeded', {
      remote_ids: { project_id: 'project', operator_id: 'export' },
      artifacts: [{ artifact_id: 'model', kind: 'model', format: 'glb', index: 0 }],
    });
  await ensureExportJpeg(job, f.jobs, f.dir, f.gateway, async () => new Response(new Uint8Array(bytes)));
  const forbidden = async (): Promise<never> => {
    throw Error('The verified JPEG cache and original task require no remote request.');
  };
  f.gateway.artifactUrl = f.gateway.submit = f.gateway.status = forbidden;
  const current = () => f.jobs.get(job.job_id).artifacts[0]!,
    proof = () => f.jobs.requestPolicy('test-account', exportJpegProofKey(job, current())),
    mutate = (change: (artifact: Artifact) => void) => {
      const db = new DatabaseSync(path.join(f.dir, 'jobs.sqlite'));
      try {
        const artifact = current();
        change(artifact);
        db.prepare('UPDATE jobs SET artifacts=? WHERE job_id=?').run(JSON.stringify([artifact]), job.job_id);
      } finally {
        db.close();
      }
    };
  return { ...f, id: job.job_id, bytes, proof, current, mutate, forbidden };
}
const dispose = async (f: Awaited<ReturnType<typeof prepared>>) => {
  f.jobs.close();
  await rm(f.dir, { recursive: true, force: true });
};

test('JPEG same-path and A/B/A recovery retains original inodes, processing and exact proof across restart', async () => {
  const f = await prepared();
  let second: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    const proof = f.proof(),
      a = await f.service.download(f.id, 'model', 'a.glb'),
      state = await fileState(String(a.local_path));
    assert.deepEqual(await f.service.download(f.id, 'model', 'a.glb'), a);
    const b = await f.service.download(f.id, 'model', 'b.glb');
    second = await fixture(f.dir);
    second.service.config.outputDir = f.service.config.outputDir;
    second.gateway.artifactUrl = second.gateway.submit = second.gateway.status = f.forbidden;
    const restored = await second.service.download(f.id, 'model', 'a.glb');
    assert.deepEqual(restored, a);
    assert.equal(restored.source_sha256, proof!.source_sha256);
    assert.equal(restored.processing, proof!.processing);
    assert.deepEqual(await fileState(String(a.local_path)), state);
    assert.deepEqual(await readFile(String(b.local_path)), f.bytes);
    assert.deepEqual(f.proof(), proof);
    assert.equal(f.current().frontend_deliveries?.length, 2);
    assert.equal(f.gateway.posts + second.gateway.posts, 0);
  } finally {
    second?.jobs.close();
    await dispose(f);
  }
});

test('JPEG keeps unregistered copies and replacement inodes rejected while trusted latest legacy path is retained', async () => {
  const f = await prepared();
  try {
    const a = String((await f.service.download(f.id, 'model', 'a.glb')).local_path),
      b = String((await f.service.download(f.id, 'model', 'b.glb')).local_path),
      copy = path.join(path.dirname(a), 'unrelated.glb');
    await copyFile(a, copy);
    await assert.rejects(f.service.download(f.id, 'model', copy), { code: 'OUTPUT_EXISTS' });
    f.mutate((artifact) => delete artifact.frontend_deliveries);
    await f.service.download(f.id, 'model', 'c.glb');
    assert.deepEqual(
      f.current().frontend_deliveries?.map((item) => path.basename(item.path)),
      ['b.glb', 'c.glb'],
    );
    await assert.rejects(f.service.download(f.id, 'model', a), { code: 'OUTPUT_EXISTS' });
    await f.service.download(f.id, 'model', b);
    await rename(b, path.join(path.dirname(b), 'retained-b.glb'));
    await writeFile(b, f.bytes);
    await assert.rejects(f.service.download(f.id, 'model', b), { code: 'OUTPUT_EXISTS' });
    assert.equal(f.gateway.posts, 0);
  } finally {
    await dispose(f);
  }
});

test('parallel JPEG downloads merge only transaction-current locations and retain both output histories', async () => {
  const f = await prepared(),
    second = await fixture(f.dir);
  try {
    second.service.config.outputDir = f.service.config.outputDir;
    second.gateway.artifactUrl = second.gateway.submit = second.gateway.status = f.forbidden;
    const before = f.proof(),
      files = await Promise.all([
        f.service.download(f.id, 'model', 'a.glb'),
        second.service.download(f.id, 'model', 'b.glb'),
      ]);
    assert.deepEqual(
      f
        .current()
        .frontend_deliveries?.map((entry) => path.basename(entry.path))
        .sort(),
      ['a.glb', 'b.glb'],
    );
    for (const file of files) await f.service.download(f.id, 'model', String(file.local_path));
    assert.deepEqual(f.proof(), before);
    assert.equal(f.gateway.posts + second.gateway.posts, 0);
  } finally {
    second.jobs.close();
    await dispose(f);
  }
});

test('an original native file is not registered as a JPEG delivery even when zero-texture bytes are identical', async () => {
  const f = await prepared();
  try {
    const native = path.join(f.service.config.outputDir, 'native-source.glb');
    await writeFile(native, f.bytes);
    f.mutate((artifact) => {
      artifact.local_path = native;
      artifact.sha256 = hash(f.bytes);
      artifact.bytes = f.bytes.length;
    });
    await f.service.download(f.id, 'model', 'delivered.glb');
    assert.deepEqual(
      f.current().frontend_deliveries?.map((entry) => path.basename(entry.path)),
      ['delivered.glb'],
    );
    await assert.rejects(f.service.download(f.id, 'model', native), { code: 'OUTPUT_EXISTS' });
    assert.deepEqual(await readFile(native), f.bytes);
  } finally {
    await dispose(f);
  }
});

test('CLI and full MCP JPEG download reject same-byte replacement at the saved local_path', async () => {
  const f = await prepared();
  try {
    const app = { service: f.service } as Application,
      delivered = await downloadTask(app, await f.service.get(f.id), { out: f.service.config.outputDir }),
      file = String(delivered.model_file),
      original = await fileState(file),
      proof = f.proof();
    await rename(file, file + '.original');
    await writeFile(file, f.bytes);
    assert.notEqual((await lstat(file)).ino, original.inode);
    const state = await fileState(file);
    await assert.rejects(downloadTask(app, await f.service.get(f.id), { out: path.dirname(file) }), {
      code: 'OUTPUT_EXISTS',
    });
    const tool = fullTools(app.service, app.studio).find((entry) => entry.name === 'ai_modeling_download')!;
    await assert.rejects(tool.run({ task_id: f.id, output_dir: path.dirname(file) }), {
      code: 'OUTPUT_EXISTS',
    });
    assert.deepEqual(await fileState(file), state);
    assert.deepEqual(f.proof(), proof);
    assert.equal(f.gateway.posts, 0);
  } finally {
    await dispose(f);
  }
});
