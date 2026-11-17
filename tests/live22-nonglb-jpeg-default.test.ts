/** 非 GLB 导入应可继续原生转换；不能把 JPEG 缺省偏好变成必需格式或吞掉错误页。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fixture } from './helpers.ts';
import { binaryFbx } from './fixtures/fbx.ts';
import { nurbsFbxNodes } from './fixtures/fbx-nurbs.ts';
import { applyDefaultExportJpeg, readJpegSource } from '../cli/compat/export-jpeg-default.ts';
import { exportJpegPolicyKey } from '../cli/core/export-jpeg-policy.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import type { Gateway } from '../studio/api/gateway.ts';

test('FBX source downloads verify the real format and preserve the frozen native fallback on retry', async () => {
  const f = await fixture();
  try {
    const bytes = binaryFbx(nurbsFbxNodes()),
      gateway: Gateway = f.gateway;
    gateway.jpegSource = async () => ({ operator_id: 'source', url: 'https://cdn.tripo3d.ai/model.fbx' });
    const context = { jobs: f.jobs, gateway, dataDir: f.dir, accountRef: () => 'test-account' };
    const parameters = () =>
      normalize('export', { project_id: 'project', format: 'glb', expected_operator_id: 'source' });
    let reads = 0;
    const read = async (url: string, directory: string) =>
      readJpegSource(url, directory, async () => {
        reads++;
        return new Response(new Uint8Array(bytes));
      });
    const input = parameters();
    const warnings = await applyDefaultExportJpeg(context, 'fbx-source', input, undefined, read);
    assert.match(warnings[0]!, /Native texture encoding.*FBX/);
    assert.equal(input.texture_format, undefined);
    const policy = f.jobs.requestPolicy('test-account', exportJpegPolicyKey('fbx-source'))!;
    assert.equal(policy.mode, 'native');
    assert.equal(policy.source_format, 'fbx');
    assert.equal(policy.source_sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(reads, 1);
    await applyDefaultExportJpeg(context, 'fbx-source', parameters(), undefined, read);
    assert.equal(reads, 1);
    await assert.rejects(
      applyDefaultExportJpeg(
        context,
        'fbx-source',
        { ...parameters(), texture_format: 'JPEG' },
        undefined,
        read,
      ),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    await assert.rejects(
      applyDefaultExportJpeg(
        context,
        'explicit-fbx',
        { ...parameters(), texture_format: 'JPEG' },
        undefined,
        read,
      ),
      { code: 'TEXTURE_ENCODING_UNSUPPORTED', certainty: 'not_submitted' },
    );
    assert.equal(f.jobs.requestPolicy('test-account', exportJpegPolicyKey('explicit-fbx')), undefined);
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('source reading still rejects false suffixes, error pages and nonmodel bytes', async () => {
  const f = await fixture();
  try {
    const bytes = binaryFbx(nurbsFbxNodes());
    await assert.rejects(
      readJpegSource(
        'https://cdn.tripo3d.ai/model.glb',
        f.dir,
        async () => new Response(new Uint8Array(bytes)),
      ),
      { code: 'ARTIFACT_FORMAT_MISMATCH' },
    );
    await assert.rejects(
      readJpegSource(
        'https://cdn.tripo3d.ai/model.fbx',
        f.dir,
        async () => new Response('<html>upstream failed</html>'),
      ),
      { code: 'INVALID_ARTIFACT' },
    );
    await assert.rejects(readJpegSource('https://cdn.tripo3d.ai/model.png', f.dir), {
      code: 'TEXTURE_SOURCE_UNVERIFIED',
    });
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
