/** 显式JPEG与缺省JPEG共享实物证明，但不能共享或重写用户意图，也不能把失败改成保原生。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rm, readFile } from 'node:fs/promises';
import { Document, NodeIO } from '@gltf-transform/core';
import sharp from 'sharp';
import { fixture, quote } from './helpers.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import { ensureExportJpeg } from '../cli/artifacts/export-jpeg-output.ts';
import { inspectGlbJpeg } from '../cli/artifacts/glb-jpeg.ts';
import {
  assertExportJpegIntent,
  canExplicitExportJpeg,
  exportJpegIntent,
  exportJpegPolicyKey,
  exportJpegRequested,
  nativeExportEncodingReason,
} from '../cli/core/export-jpeg-policy.ts';
import { object } from '../studio/contracts/errors.ts';

async function model(alpha = 255) {
  const doc = new Document(),
    buffer = doc.createBuffer();
  const positions = doc
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setBuffer(buffer);
  const texture = doc
    .createTexture()
    .setMimeType('image/png')
    .setImage(
      await sharp(Buffer.from([50, 100, 200, alpha]), { raw: { width: 1, height: 1, channels: 4 } })
        .png()
        .toBuffer(),
    );
  const primitive = doc
    .createPrimitive()
    .setAttribute('POSITION', positions)
    .setMaterial(doc.createMaterial().setBaseColorTexture(texture));
  doc.createScene().addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(primitive)));
  return Buffer.from(await new NodeIO().writeBinary(doc));
}
const input = () =>
  normalize('export', {
    project_id: 'project',
    expected_operator_id: 'source',
    format: 'glb',
    texture_format: 'JPEG',
  });
function prepare(
  f: Awaited<ReturnType<typeof fixture>>,
  patch: Record<string, unknown> = {},
  request = 'explicit-jpeg',
) {
  const parameters = input();
  f.jobs.bindRequestPolicy('test-account', exportJpegPolicyKey(request), {
    version: 1,
    mode: 'jpeg',
    explicit: true,
    project_id: 'project',
    operator_id: 'source',
    intent: exportJpegIntent(parameters, true),
    ...patch,
  });
  const job = f.jobs.prepare('test-account', request, 'export', parameters, quote);
  return f.jobs.update(job.job_id, 'succeeded', {
    remote_ids: { project_id: 'project', operator_id: 'export' },
    artifacts: [{ artifact_id: 'model', kind: 'model', format: 'glb', index: 0 }],
  });
}

test('new explicit JPEG uses final-byte proof before reporting success and downloads that exact output', async () => {
  const f = await fixture();
  try {
    const job = prepare(f),
      original = await model();
    assert.ok(canExplicitExportJpeg(job.input));
    assert.doesNotThrow(() =>
      assertExportJpegIntent(f.jobs, 'test-account', job.request_id, 'export', job.input),
    );
    assert.ok(exportJpegRequested(f.jobs, job));
    assert.equal(object(f.service.summary(job).jpeg_output_validation).status, 'unverified');
    await ensureExportJpeg(job, f.jobs, f.dir, f.gateway, async () => new Response(new Uint8Array(original)));
    const result = await f.service.get(job.job_id),
      saved = await f.service.download(job.job_id, 'model', 'explicit.glb');
    assert.equal(object(result.jpeg_output_validation).status, 'verified');
    assert.equal(
      (await inspectGlbJpeg(await readFile(String(saved.local_path)))).images[0]!.mime,
      'image/jpeg',
    );
    assert.equal(f.gateway.posts, 0);
    for (const change of [
      { texture_format: 'PNG' },
      { flatten_bottom: true },
      { texture_packaging: 'zip' },
      { bake: false },
    ])
      assert.equal(canExplicitExportJpeg({ ...job.input, ...change }), false);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('explicit JPEG cannot become native-preserved or borrow an implicit intent after storage', async () => {
  const f = await fixture();
  try {
    const native = prepare(f, { mode: 'native', reason: 'unsupported pixels' }, 'native');
    assert.throws(() => exportJpegRequested(f.jobs, native), { code: 'JPEG_EXPORT_POLICY_CHANGED' });
    assert.throws(() => nativeExportEncodingReason(f.jobs, native), { code: 'JPEG_EXPORT_POLICY_CHANGED' });
    assert.throws(
      () => assertExportJpegIntent(f.jobs, 'test-account', native.request_id, 'export', native.input),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    const implicitIntent = prepare(f, { intent: exportJpegIntent(input()) }, 'wrong-intent');
    assert.throws(() => exportJpegRequested(f.jobs, implicitIntent), { code: 'JPEG_EXPORT_POLICY_CHANGED' });
    assert.throws(
      () =>
        assertExportJpegIntent(
          f.jobs,
          'test-account',
          implicitIntent.request_id,
          'export',
          implicitIntent.input,
        ),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    const invalidFlag = prepare(f, { explicit: 'true' }, 'wrong-flag');
    assert.throws(() => exportJpegRequested(f.jobs, invalidFlag), { code: 'JPEG_EXPORT_POLICY_CHANGED' });
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('a transparent final explicit JPEG result retains its original receipt and never becomes verified or native-preserved', async () => {
  const f = await fixture();
  try {
    const job = prepare(f),
      transparent = await model(254);
    await assert.rejects(
      ensureExportJpeg(job, f.jobs, f.dir, f.gateway, async () => new Response(new Uint8Array(transparent))),
      { code: 'TEXTURE_ENCODING_UNSUPPORTED' },
    );
    const saved = f.jobs.get(job.job_id),
      result = f.service.summary(saved);
    assert.deepEqual(saved.remote_ids, job.remote_ids);
    assert.equal(result.state, 'needs_attention');
    assert.equal(object(result.jpeg_output_validation).status, 'unverified');
    assert.equal(nativeExportEncodingReason(f.jobs, saved), undefined);
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('old explicit exports without a policy keep their original path and old default policy remains valid', async () => {
  const f = await fixture();
  try {
    const old = f.jobs.prepare('test-account', 'old-explicit', 'export', input(), quote);
    assert.equal(exportJpegRequested(f.jobs, old), false);
    const implicit = prepare(f, { explicit: undefined, intent: exportJpegIntent(input()) }, 'old-default');
    assert.ok(exportJpegRequested(f.jobs, implicit));
    assert.doesNotThrow(() =>
      assertExportJpegIntent(f.jobs, 'test-account', implicit.request_id, 'export', implicit.input),
    );
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
