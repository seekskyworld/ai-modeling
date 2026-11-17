/** 新缺省编码的来源、持久策略、最终产物与并发回执必须共同满足，不能把成功回执当JPEG验收。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import sharp from 'sharp';
import { fixture, quote } from './helpers.ts';
import { applyDefaultExportJpeg } from '../cli/compat/export-jpeg-default.ts';
import { applyExportDefaultValues } from '../cli/compat/export-default-values.ts';
import { ensureExportJpeg } from '../cli/artifacts/export-jpeg-output.ts';
import { inspectGlbJpeg } from '../cli/artifacts/glb-jpeg.ts';
import {
  exportJpegPolicyKey,
  exportJpegProofKey,
  exportJpegRequested,
} from '../cli/core/export-jpeg-policy.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import type { Gateway } from '../studio/api/gateway.ts';
import type { Job } from '../studio/contracts/types.ts';
import { fingerprint } from '../cli/core/fingerprint.ts';
import { taskResult } from '../cli/compat/runtime.ts';

async function model(alpha = 255, blue = false): Promise<Buffer> {
  const doc = new Document(),
    buffer = doc.createBuffer();
  const position = doc
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setBuffer(buffer);
  const uv = doc
    .createAccessor()
    .setType('VEC2')
    .setArray(new Float32Array([0, 0, 1, 0, 0, 1]))
    .setBuffer(buffer);
  const image = await sharp(Buffer.from(blue ? [0, 0, 255, alpha] : [255, 0, 0, alpha]), {
    raw: { width: 1, height: 1, channels: 4 },
  })
    .png()
    .toBuffer();
  const texture = doc.createTexture().setImage(image).setMimeType('image/png');
  const material = doc.createMaterial().setBaseColorTexture(texture);
  const mesh = doc
    .createMesh()
    .addPrimitive(
      doc
        .createPrimitive()
        .setAttribute('POSITION', position)
        .setAttribute('TEXCOORD_0', uv)
        .setMaterial(material),
    );
  doc.createScene().addChild(doc.createNode().setMesh(mesh));
  return Buffer.from(await new NodeIO().writeBinary(doc));
}
const native = (): Record<string, unknown> =>
  normalize('export', { project_id: 'project', format: 'glb', expected_operator_id: 'source' });
function prepared(f: Awaited<ReturnType<typeof fixture>>, request = 'jpeg-result'): Job {
  const input = { ...native(), texture_format: 'JPEG' };
  f.jobs.bindRequestPolicy('test-account', exportJpegPolicyKey(request), {
    version: 1,
    mode: 'jpeg',
    project_id: 'project',
    operator_id: 'source',
  });
  const job = f.jobs.prepare('test-account', request, 'export', input, quote);
  return f.jobs.update(job.job_id, 'succeeded', {
    remote_ids: { project_id: 'project', operator_id: 'export' },
    artifacts: [{ artifact_id: 'model', kind: 'model', format: 'glb', index: 0 }],
  });
}

test('缺省JPEG预检冻结不透明来源，重复意图不重读，改来源或选项拒绝', async () => {
  const f = await fixture();
  try {
    let reads = 0,
      sources = 0;
    const gateway = f.gateway as Gateway;
    gateway.jpegSource = async () => {
      sources++;
      return { operator_id: 'source', url: 'https://cdn.tripo3d.ai/source.glb' };
    };
    const context = { jobs: f.jobs, gateway, dataDir: f.dir, accountRef: () => 'test-account' };
    const bytes = await model();
    const read = async () => {
      reads++;
      return bytes;
    };
    const parameters = native(),
      warnings = await applyDefaultExportJpeg(context, 'new', parameters, undefined, read);
    assert.equal(parameters.texture_format, 'JPEG');
    assert.match(warnings[0]!, /texture-only/);
    assert.equal(reads, 1);
    assert.equal(sources, 1);
    const repeated = native();
    await applyDefaultExportJpeg(context, 'new', repeated, undefined, read);
    assert.deepEqual(repeated, parameters);
    assert.equal(reads, 1);
    for (const changed of [
      { ...native(), project_id: 'other' },
      { ...native(), texture_size: 1024 },
    ])
      await assert.rejects(applyDefaultExportJpeg(context, 'new', changed, undefined, read), {
        code: 'IDEMPOTENCY_CONFLICT',
      });
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('真实透明源保原生并说明JPEG默认未满足，明确编码/其他容器/无烘焙不被改写', async () => {
  const f = await fixture();
  try {
    const gateway = f.gateway as Gateway;
    gateway.jpegSource = async () => ({ operator_id: 'source', url: 'https://cdn.tripo3d.ai/source.glb' });
    const context = { jobs: f.jobs, gateway, dataDir: f.dir, accountRef: () => 'test-account' };
    const parameters = native(),
      transparent = await model(254);
    const warning = await applyDefaultExportJpeg(
      context,
      'transparent',
      parameters,
      undefined,
      async () => transparent,
    );
    assert.equal(parameters.texture_format, undefined);
    assert.match(warning[0]!, /not fulfilled.*non-opaque/);
    assert.equal(f.jobs.requestPolicy('test-account', exportJpegPolicyKey('transparent'))?.mode, 'native');
    const nativeJob = f.jobs.prepare('test-account', 'transparent', 'export', parameters, quote);
    f.jobs.update(nativeJob.job_id, 'succeeded');
    const restored = await f.service.get(nativeJob.job_id);
    assert.equal(restored.state, 'succeeded');
    assert.equal((restored.jpeg_output_validation as Record<string, unknown>).status, 'native_preserved');
    assert.match(String((restored.jpeg_output_validation as Record<string, unknown>).reason), /non-opaque/);
    assert.deepEqual(
      f.service.summary(f.jobs.get(nativeJob.job_id)).jpeg_output_validation,
      restored.jpeg_output_validation,
    );
    for (const input of [
      { ...native(), texture_format: 'PNG' },
      { ...native(), format: 'fbx' },
      { ...native(), bake: false },
      { ...native(), flatten_bottom: true },
    ]) {
      const before = fingerprint(input);
      assert.deepEqual(
        await applyDefaultExportJpeg(context, 'skip', input, undefined, async () => {
          throw Error('Must not read');
        }),
        [],
      );
      assert.equal(fingerprint(input), before);
    }
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('JPEG策略落库后任务创建前中断，换编码/格式/操作在任何提交前拒绝', async () => {
  const f = await fixture();
  try {
    const gateway = f.gateway as Gateway;
    gateway.jpegSource = async () => ({ operator_id: 'source', url: 'https://cdn.tripo3d.ai/source.glb' });
    const parameters = native();
    await applyDefaultExportJpeg(
      { jobs: f.jobs, gateway, dataDir: f.dir, accountRef: () => 'test-account' },
      'interrupted',
      parameters,
      undefined,
      async () => model(),
    );
    for (const changed of [
      { ...parameters, texture_format: 'PNG' },
      { ...parameters, format: 'obj' },
      { ...parameters, texture_size: 1024 },
      { ...parameters, expected_operator_id: 'other' },
    ])
      await assert.rejects(f.service.submit('export', 'interrupted', changed, 10), {
        code: 'IDEMPOTENCY_CONFLICT',
      });
    await assert.rejects(f.service.submit('image', 'interrupted', { prompt: 'cube' }, 10), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    assert.equal(f.gateway.posts, 0);
    assert.equal(f.jobs.find('test-account', 'interrupted'), undefined);
    const first = await f.service.submit('export', 'interrupted', parameters, 10);
    const again = await f.service.submit('export', 'interrupted', parameters, 10);
    assert.equal(again.job_id, first.job_id);
    assert.equal(f.gateway.posts, 1);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('旧任务恢复原编码，新的JPEG任务重入恢复JPEG而不重新预检', async () => {
  const f = await fixture();
  try {
    for (const texture_format of [undefined, 'PNG', 'JPEG']) {
      const input = { ...native(), ...(texture_format ? { texture_format } : {}) },
        job = f.jobs.prepare('test-account', `old-${texture_format}`, 'export', input, quote),
        parameters = native();
      applyExportDefaultValues(parameters, ['texture_format'], job);
      assert.equal(parameters.texture_format, texture_format);
      await applyDefaultExportJpeg(
        { jobs: f.jobs, gateway: f.gateway, dataDir: f.dir, accountRef: () => 'test-account' },
        job.request_id,
        parameters,
        job,
        async () => {
          throw Error('Must not read');
        },
      );
      assert.equal(fingerprint(parameters), fingerprint(input));
      assert.equal(exportJpegRequested(f.jobs, job), false);
    }
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('--no-download同样验收最终JPEG，离线读取与下载复用精确缓存且不再次提交', async () => {
  const f = await fixture();
  try {
    const job = prepared(f),
      source = await model();
    await ensureExportJpeg(job, f.jobs, f.dir, f.gateway, async () => new Response(new Uint8Array(source)));
    f.gateway.artifactUrl = async () => {
      throw Error('Offline; verified cache should be enough');
    };
    const result = await f.service.get(job.job_id);
    assert.equal(result.state, 'succeeded');
    assert.equal((result.jpeg_output_validation as Record<string, unknown>).status, 'verified');
    assert.deepEqual(taskResult(result).jpeg_output_validation, result.jpeg_output_validation);
    assert.equal(f.service.summary(f.jobs.get(job.job_id)).state, 'succeeded');
    const saved = await f.service.download(job.job_id, 'model', 'opaque.glb');
    const checked = await inspectGlbJpeg(await readFile(String(saved.local_path)));
    assert.ok(checked.images.every((image) => image.mime === 'image/jpeg'));
    assert.match(String(saved.processing), /original geometry, skins and animation bytes retained/);
    assert.equal(f.gateway.posts, 0);
    assert.ok(f.jobs.requestPolicy('test-account', exportJpegProofKey(job, job.artifacts[0]!)));
    await f.service.download(job.job_id, 'model', 'opaque-again.glb');
    assert.ok(
      (await readFile(path.join(f.dir, 'output/opaque.glb'))).equals(
        await readFile(path.join(f.dir, 'output/opaque-again.glb')),
      ),
    );
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('最终原生结果变透明时不写成功证明，也不重做远端导出', async () => {
  const f = await fixture();
  try {
    const job = prepared(f),
      source = await model(254);
    await assert.rejects(
      ensureExportJpeg(job, f.jobs, f.dir, f.gateway, async () => new Response(new Uint8Array(source))),
      { code: 'TEXTURE_ENCODING_UNSUPPORTED' },
    );
    assert.equal(f.jobs.get(job.job_id).state, 'succeeded');
    assert.equal(f.service.summary(f.jobs.get(job.job_id)).state, 'needs_attention');
    assert.equal(
      (
        (f.service.list(10, 0).jobs as Record<string, unknown>[])[0]!.jpeg_output_validation as Record<
          string,
          unknown
        >
      ).status,
      'unverified',
    );
    assert.equal(f.jobs.requestPolicy('test-account', exportJpegProofKey(job, job.artifacts[0]!)), undefined);
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('并发同身份不同结果只冻结第一个证明，下载期间更换回执不能绑定旧字节', async () => {
  const f = await fixture();
  try {
    const job = prepared(f),
      red = await model(),
      blue = await model(255, true);
    const results = await Promise.allSettled(
      [red, blue].map((bytes) =>
        ensureExportJpeg(job, f.jobs, f.dir, f.gateway, async () => new Response(new Uint8Array(bytes))),
      ),
    );
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    assert.equal(rejected.reason.code, 'ARTIFACT_POLICY_CONTENT_CHANGED');
    const first = f.jobs.requestPolicy('test-account', exportJpegProofKey(job, job.artifacts[0]!));
    const changed = f.jobs.update(job.job_id, 'succeeded', {
      remote_ids: { project_id: 'project', operator_id: 'replacement' },
    });
    await assert.rejects(ensureExportJpeg(changed, f.jobs, f.dir, f.gateway), {
      code: 'JPEG_EXPORT_IDENTITY_CHANGED',
    });
    assert.equal(f.service.summary(changed).state, 'needs_attention');
    assert.deepEqual(f.jobs.requestPolicy('test-account', exportJpegProofKey(job, job.artifacts[0]!)), first);
    const other = prepared(f, 'race');
    f.gateway.artifactUrl = async () => {
      f.jobs.update(other.job_id, 'succeeded', {
        remote_ids: { project_id: 'project', operator_id: 'changed-during-url' },
      });
      return 'https://cdn.tripo3d.ai/source.glb';
    };
    await assert.rejects(
      ensureExportJpeg(other, f.jobs, f.dir, f.gateway, async () => new Response(new Uint8Array(red))),
      { code: 'JPEG_EXPORT_IDENTITY_CHANGED' },
    );
    assert.equal(
      f.jobs.requestPolicy('test-account', exportJpegProofKey(other, other.artifacts[0]!)),
      undefined,
    );
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('原子字节证明验证终态、回执、产物索引和输入，保留首个证明', async () => {
  const f = await fixture();
  try {
    const job = prepared(f),
      artifact = job.artifacts[0]!,
      proof = { sha256: 'a'.repeat(64), bytes: 12 };
    f.jobs.bindArtifactPolicy(job, artifact, 'atomic-proof', proof);
    f.jobs.bindArtifactPolicy(job, artifact, 'atomic-proof', proof);
    assert.throws(
      () => f.jobs.bindArtifactPolicy(job, artifact, 'atomic-proof', { ...proof, sha256: 'b'.repeat(64) }),
      { code: 'ARTIFACT_POLICY_CONTENT_CHANGED' },
    );
    assert.throws(
      () =>
        f.jobs.bindArtifactPolicy(
          { ...job, input: { ...job.input, format: 'obj' } },
          artifact,
          'bad-input',
          proof,
        ),
      { code: 'ARTIFACT_POLICY_IDENTITY_CHANGED' },
    );
    assert.throws(() => f.jobs.bindArtifactPolicy(job, { ...artifact, index: 1 }, 'bad-index', proof), {
      code: 'ARTIFACT_POLICY_IDENTITY_CHANGED',
    });
    assert.equal(f.jobs.requestPolicy('test-account', 'bad-index'), undefined);
    assert.deepEqual(f.jobs.requestPolicy('test-account', 'atomic-proof'), proof);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
