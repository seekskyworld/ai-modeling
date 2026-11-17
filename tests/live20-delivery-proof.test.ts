/** 下载元数据与不可变证明的边界测试：双连接模拟读取后漂移，所有夹具均离线。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lstat, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fixture, quote } from './helpers.ts';
import { uvImportFixture } from './uv-import-fixture.ts';
import type { Artifact, Job } from '../studio/contracts/types.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import { JobStore } from '../cli/storage/jobs.ts';
import { fingerprint } from '../cli/core/fingerprint.ts';
import {
  exportJpegIdentity,
  exportJpegPolicyKey,
  exportJpegProofKey,
} from '../cli/core/export-jpeg-policy.ts';
import { uvArtifactIdentity, uvImportPolicyKey, uvImportProofKey } from '../cli/core/uv-import-policy.ts';
import { ensureExportJpeg } from '../cli/artifacts/export-jpeg-output.ts';
import { ensureUvImport } from '../cli/artifacts/uv-import-output.ts';

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Mode = 'jpeg' | 'uv';
const model: Artifact = { artifact_id: 'model', kind: 'model', format: 'glb', index: 0 };

async function deliveryCase(f: Fixture, mode: Mode, freeze = true) {
  const request = `delivery-${mode}`;
  let job: Job;
  let sourceIdentity: string | undefined;
  if (mode === 'jpeg') {
    const input = normalize('export', {
      project_id: 'project',
      expected_operator_id: 'source',
      format: 'glb',
      texture_format: 'JPEG',
    });
    f.jobs.bindRequestPolicy('test-account', exportJpegPolicyKey(request), {
      version: 1,
      mode: 'jpeg',
      project_id: 'project',
      operator_id: 'source',
    });
    job = f.jobs.prepare('test-account', request, 'export', input, quote);
  } else {
    const original = f.jobs.prepare(
      'test-account',
      'original-uv',
      'uv_commit',
      {
        project_id: 'project',
        current_operator_id: 'base',
        candidate_operator_id: 'candidate',
      },
      quote,
    );
    const source = f.jobs.update(original.job_id, 'succeeded', {
      remote_ids: { project_id: 'project', operator_id: 'applied' },
      artifacts: [model],
    });
    sourceIdentity = uvArtifactIdentity(source, model);
    const input = normalize('import_model', {
      model_path: path.join(f.dir, 'source.glb'),
      name: 'UV proof fixture',
      use_original_uv: true,
    });
    f.jobs.bindRequestPolicy('test-account', uvImportPolicyKey(request), {
      version: 1,
      input: fingerprint(input),
      source_job_id: source.job_id,
      source_artifact_id: model.artifact_id,
      source_identity: sourceIdentity,
      source_sha256: 'c'.repeat(64),
      source_bytes: 80,
    });
    job = f.jobs.prepare('test-account', request, 'import_model', input, quote);
  }
  job = f.jobs.update(job.job_id, 'succeeded', {
    remote_ids: { project_id: 'result', operator_id: 'result-operator' },
    artifacts: [model],
  });
  const prefix = mode === 'jpeg' ? 'source_' : 'imported_';
  const key = mode === 'jpeg' ? exportJpegProofKey(job, model) : uvImportProofKey(job, model);
  // JPEG交付登记会核实体文件；编码/解码效果仍由专门字节测试覆盖。
  const bytes = mode === 'jpeg' ? await uvImportFixture(false) : undefined;
  const localPath = path.join(await realpath(f.dir), 'delivery.glb');
  if (bytes) await writeFile(localPath, bytes);
  const proof = {
    version: 1,
    identity: mode === 'jpeg' ? exportJpegIdentity(job, model) : uvArtifactIdentity(job, model),
    ...(sourceIdentity ? { source_identity: sourceIdentity } : {}),
    sha256: bytes ? createHash('sha256').update(bytes).digest('hex') : 'b'.repeat(64),
    bytes: bytes?.length ?? 200,
    [`${prefix}sha256`]: 'a'.repeat(64),
    [`${prefix}bytes`]: 100,
    processing: `Verified ${mode} delivery fixture`,
  };
  if (freeze) f.jobs.bindArtifactPolicy(job, model, key, proof);
  const delivered: Artifact = {
    ...model,
    sha256: proof.sha256,
    bytes: proof.bytes,
    processing: proof.processing,
    source_sha256: 'a'.repeat(64),
    local_path: localPath,
  };
  const registered: Artifact = { ...delivered };
  if (bytes) {
    const file = await lstat(localPath, { bigint: true }),
      parent = await lstat(path.dirname(localPath), { bigint: true });
    registered.frontend_deliveries = [
      {
        identity: proof.identity,
        path: localPath,
        sha256: proof.sha256,
        bytes: proof.bytes,
        device: file.dev.toString(),
        inode: file.ino.toString(),
        parent_device: parent.dev.toString(),
        parent_inode: parent.ino.toString(),
      },
    ];
  }
  return {
    job,
    key,
    proof,
    delivered,
    registered,
    ensure: (current: Job) =>
      (mode === 'jpeg' ? ensureExportJpeg : ensureUvImport)(current, f.jobs, f.dir, f.gateway),
    contentCode: mode === 'jpeg' ? 'JPEG_EXPORT_CONTENT_CHANGED' : 'UV_COMPRESSION_CONTENT_CHANGED',
  };
}

for (const mode of ['jpeg', 'uv'] as const) {
  test(`${mode}区分合法原生摘要与交付摘要，旧交付任一字段漂移均停止读取且列表不冒充成功`, async () => {
    const f = await fixture();
    try {
      const row = await deliveryCase(f, mode);
      let reads = 0;
      f.gateway.artifactUrl = async () => {
        reads++;
        throw Error('Metadata failure must precede byte reads');
      };
      assert.equal(f.service.summary(row.job).state, 'succeeded');
      const raw = { ...model, sha256: 'a'.repeat(64), bytes: 100 };
      f.jobs.update(row.job.job_id, 'succeeded', { artifacts: [raw] });
      assert.equal(f.service.summary(f.jobs.get(row.job.job_id)).state, 'succeeded');
      f.jobs.saveArtifact(row.job.job_id, row.delivered);
      for (const mutation of [
        { sha256: 'd'.repeat(64) },
        { bytes: row.proof.bytes + 1 },
        { processing: 'another transform' },
        { source_sha256: 'e'.repeat(64) },
        { source_sha256: undefined },
        { processing: undefined },
      ]) {
        const current = f.jobs.update(row.job.job_id, 'succeeded', {
          artifacts: [{ ...row.delivered, ...mutation }],
        });
        assert.equal(f.service.summary(current).state, 'needs_attention');
        await assert.rejects(row.ensure(current), { code: row.contentCode });
        assert.deepEqual(f.jobs.requestPolicy('test-account', row.key), row.proof);
      }
      assert.equal(reads, 0);
      assert.equal(f.gateway.posts, 0);
    } finally {
      f.jobs.close();
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  test(`${mode}固定证明键自动约束下载写入，不传可选guard也不能提交错误交付摘要或原生摘要`, async () => {
    const f = await fixture();
    try {
      const row = await deliveryCase(f, mode);
      for (const mutation of [
        { sha256: 'f'.repeat(64) },
        { bytes: row.proof.bytes - 1 },
        { processing: undefined },
        { processing: 'different' },
        { source_sha256: 'f'.repeat(64) },
        { sha256: 'a'.repeat(64), bytes: 100, processing: undefined, source_sha256: undefined },
      ]) {
        assert.throws(() => f.jobs.saveArtifact(row.job.job_id, { ...row.delivered, ...mutation }), {
          code: 'ARTIFACT_POLICY_CONTENT_CHANGED',
        });
        assert.deepEqual(f.jobs.get(row.job.job_id).artifacts, [model]);
      }
      assert.throws(() => f.jobs.saveArtifact(row.job.job_id, { ...row.delivered, index: 2 }), {
        code: 'ARTIFACT_POLICY_IDENTITY_CHANGED',
      });
      f.jobs.saveArtifact(row.job.job_id, row.delivered);
      assert.deepEqual(f.jobs.get(row.job.job_id).artifacts, [row.registered]);
      assert.deepEqual(f.jobs.requestPolicy('test-account', row.key), row.proof);
    } finally {
      f.jobs.close();
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  test(`${mode}另一连接在读取后改旧摘要或回执，最终事务拒绝覆盖并保留原证明`, async () => {
    const f = await fixture();
    const other = new JobStore(path.join(f.dir, 'jobs.sqlite'));
    try {
      const row = await deliveryCase(f, mode);
      f.jobs.saveArtifact(row.job.job_id, row.delivered);
      const drift = { ...row.registered, sha256: 'd'.repeat(64) };
      other.update(row.job.job_id, 'succeeded', { artifacts: [drift] });
      assert.throws(() => f.jobs.saveArtifact(row.job.job_id, row.delivered), {
        code: 'ARTIFACT_POLICY_CONTENT_CHANGED',
      });
      assert.deepEqual(f.jobs.get(row.job.job_id).artifacts, [drift]);
      other.update(row.job.job_id, 'succeeded', {
        remote_ids: { project_id: 'result', operator_id: 'changed-receipt' },
        artifacts: [row.delivered],
      });
      assert.throws(() => f.jobs.saveArtifact(row.job.job_id, row.delivered), {
        code: 'ARTIFACT_POLICY_IDENTITY_CHANGED',
      });
      assert.equal(f.jobs.get(row.job.job_id).remote_ids.operator_id, 'changed-receipt');
      assert.deepEqual(f.jobs.requestPolicy('test-account', row.key), row.proof);
    } finally {
      other.close();
      f.jobs.close();
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  test(`${mode}首次绑定证明也原子核对已存原生摘要，不为漂移字节新建证明`, async () => {
    const f = await fixture();
    try {
      const row = await deliveryCase(f, mode, false);
      f.jobs.update(row.job.job_id, 'succeeded', {
        artifacts: [{ ...model, sha256: 'd'.repeat(64), bytes: 100 }],
      });
      assert.throws(() => f.jobs.bindArtifactPolicy(row.job, model, row.key, row.proof), {
        code: 'ARTIFACT_POLICY_CONTENT_CHANGED',
      });
      assert.equal(f.jobs.requestPolicy('test-account', row.key), undefined);
      f.jobs.update(row.job.job_id, 'succeeded', {
        artifacts: [{ ...model, sha256: 'a'.repeat(64), bytes: 100 }],
      });
      f.jobs.bindArtifactPolicy(row.job, model, row.key, row.proof);
      assert.deepEqual(f.jobs.requestPolicy('test-account', row.key), row.proof);
    } finally {
      f.jobs.close();
      await rm(f.dir, { recursive: true, force: true });
    }
  });
}
