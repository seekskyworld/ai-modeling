/** 用受控审核和存储响应验证网页准入链，不上传真实敏感素材或读取系统凭据。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admittedImageResult, referenceImageResult } from '../studio/auth/image-admission.ts';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { StudioClient } from '../studio/api/client.ts';
import { uploadImage } from '../studio/api/upload.ts';
import { Operations } from '../studio/api/operations.ts';
import { resolveImageReferences } from '../cli/compat/image-references.ts';
import { TripoError } from '../studio/contracts/errors.ts';

const image = { bucket: 'controlled-bucket', key: 'controlled/image.png' };
const assetId = '11111111-1111-4111-8111-111111111111';
const credentials = () =>
  new MemoryCredentials({
    cookie: 'controlled-cookie',
    deviceId: 'controlled-device',
    accountRef: 'controlled-account',
    importedAt: '2026-11-14T00:00:00Z',
  });
const asset = (result: string) => ({
  asset_id: assetId,
  status: 'success',
  output: { data: [{ ...image, image_audit_result: result }] },
});

test('reference-image uses the website scene rule and cannot satisfy age confirmation locally', () => {
  assert.equal(admittedImageResult({ result: 'pass' }), 'pass');
  assert.equal(admittedImageResult({ result: 'sensitive' }), 'sensitive');
  assert.equal(admittedImageResult({ result: 'nsfw', age_confirm_status: 'confirmed' }), 'nsfw');
  for (const scene of ['profile-background', 'canvas-input', 'unknown']) {
    assert.equal(admittedImageResult({ result: 'pass' }, scene), 'pass');
    for (const result of ['sensitive', 'nsfw', 'reject'])
      assert.throws(() => admittedImageResult({ result, age_confirm_status: 'confirmed' }, scene), {
        code: 'CONTENT_AUDIT_REJECTED',
        certainty: 'not_submitted',
      });
  }
  for (const age_confirm_status of [undefined, 'unconfirmed', true, 'yes'])
    assert.throws(() => admittedImageResult({ result: 'nsfw', age_confirm_status }), {
      code: 'AGE_CONFIRMATION_REQUIRED',
      certainty: 'not_submitted',
    });
  for (const audit of [{}, { result: 'reject' }, { result: 'nsfw', age_confirm_status: 'denied' }])
    assert.throws(() => admittedImageResult(audit), { code: 'CONTENT_AUDIT_REJECTED' });
});

test('upload completes S3 before audit and preserves the server result without forwarding account secrets', async () => {
  for (const audit of [
    { result: 'pass' },
    { result: 'sensitive' },
    { result: 'nsfw', age_confirm_status: 'confirmed' },
  ]) {
    const calls: string[] = [];
    const client = new StudioClient(credentials(), async (url, init) => {
      if (url.includes('/storage/temporary_token')) {
        calls.push('temporary_token');
        assert.deepEqual(JSON.parse(String(init.body)), { client: 'aws', format: 'png' });
        return Response.json({
          code: 0,
          data: {
            sts_ak: 'controlled-access',
            sts_sk: 'controlled-secret',
            session_token: 'controlled-sts',
            resource_bucket: image.bucket,
            resource_uri: image.key,
          },
        });
      }
      if (new URL(url).hostname.endsWith('.amazonaws.com')) {
        calls.push('s3');
        assert.equal(init.method, 'PUT');
        const headers = new Headers(init.headers);
        assert.equal(headers.has('cookie'), false);
        assert.equal(headers.get('authorization')?.startsWith('AWS4-HMAC-SHA256 '), true);
        assert.equal(headers.get('x-amz-security-token') === 'controlled-sts', true);
        return new Response('', { status: 200, headers: { etag: '"controlled-etag"' } });
      }
      assert.equal(new URL(url).pathname, '/v2/studio/audit/image');
      calls.push('audit');
      assert.deepEqual(JSON.parse(String(init.body)), { image });
      return Response.json({ code: 0, data: audit });
    });
    const reference = await uploadImage(client, Buffer.from('controlled-image'), 'png');
    assert.deepEqual(calls, ['temporary_token', 's3', 'audit']);
    assert.deepEqual(reference, { ...image, image_audit_result: audit.result, image_source: 'upload' });
    assert.equal('age_confirm_status' in reference, false);
  }
});

test('failed S3 transfer never audits or advances to generation and does not expose its signed request', async () => {
  let audits = 0,
    uploads = 0;
  const client = new StudioClient(credentials(), async (url) => {
    if (url.includes('/storage/temporary_token'))
      return Response.json({
        code: 0,
        data: {
          sts_ak: 'controlled-access',
          sts_sk: 'controlled-secret',
          session_token: 'controlled-sts',
          resource_bucket: image.bucket,
          resource_uri: image.key,
        },
      });
    if (new URL(url).hostname.endsWith('.amazonaws.com')) {
      uploads++;
      throw new Error('controlled-secret signed request');
    }
    audits++;
    return Response.json({ code: 0, data: { result: 'pass' } });
  });
  await assert.rejects(uploadImage(client, Buffer.from('controlled-image'), 'png'), (error: unknown) => {
    assert.ok(error instanceof TripoError);
    assert.equal(error.code, 'UPLOAD_FAILED');
    assert.equal(error.certainty, 'not_submitted');
    assert.equal(JSON.stringify(error).includes('controlled-secret'), false);
    return true;
  });
  assert.equal(uploads, 1);
  assert.equal(audits, 0);
});

test('stored reference classifications cannot act as stale or fabricated NSFW age confirmation', async () => {
  let audits = 0;
  const ref = { ...image, image_audit_result: 'nsfw', age_confirm_status: 'confirmed' };
  await assert.rejects(referenceImageResult(ref), { code: 'AGE_CONFIRMATION_REQUIRED' });
  await assert.rejects(
    referenceImageResult(ref, async (seen) => {
      audits++;
      assert.deepEqual(seen, image);
      return { result: 'nsfw', age_confirm_status: 'denied' };
    }),
    { code: 'CONTENT_AUDIT_REJECTED' },
  );
  assert.equal(
    await referenceImageResult(ref, async () => ({ result: 'nsfw', age_confirm_status: 'confirmed' })),
    'nsfw',
  );
  assert.equal(
    await referenceImageResult({ ...image, image_audit_result: 'sensitive' }, async () => {
      assert.fail('sensitive references do not require synthetic pass reclassification');
    }),
    'sensitive',
  );
  await assert.rejects(referenceImageResult({ image_audit_result: 'pass' }), {
    code: 'CONTENT_AUDIT_REJECTED',
  });
  assert.equal(audits, 1);
});

test('generated asset references preserve sensitive and verify NSFW against the current account audit', async () => {
  for (const result of ['pass', 'sensitive', 'nsfw']) {
    let audits = 0;
    const client = new StudioClient(credentials(), async (url, init) => {
      if (url.includes('/get_image_asset')) return Response.json({ code: 0, data: asset(result) });
      assert.equal(new URL(url).pathname, '/v2/studio/audit/image');
      assert.deepEqual(JSON.parse(String(init.body)), { image });
      audits++;
      return Response.json({ code: 0, data: { result: 'nsfw', age_confirm_status: 'confirmed' } });
    });
    const output = await new Operations(client, []).imageReference({ image_asset: { asset_id: assetId } });
    assert.deepEqual(output, { ...image, image_source: 'generate', image_audit_result: result });
    assert.equal(audits, result === 'nsfw' ? 1 : 0);
  }
});

test('generated storage references with missing audit classification complete the webpage audit prerequisite', async () => {
  let audits = 0;
  for (const image_audit_result of [undefined, null, '']) {
    const result = await referenceImageResult({ ...image, image_audit_result }, async (seen) => {
      audits++;
      assert.deepEqual(seen, image);
      return { result: 'sensitive' };
    });
    assert.equal(result, 'sensitive');
  }
  await assert.rejects(
    referenceImageResult({ ...image, image_audit_result: 'reject' }, async () => {
      assert.fail('explicit rejection cannot be replaced by a synthetic audit');
    }),
    { code: 'CONTENT_AUDIT_REJECTED' },
  );
  assert.equal(audits, 3);
});

test('CLI image preflight accepts website-sensitive references but rechecks NSFW before new submissions', async () => {
  const params = { image_sources: [{ asset_id: 'placeholder', output_index: 0 }] };
  const bindings = [{ reference: assetId, target: 'image_sources' as const, index: 0 }];
  let classification = 'sensitive',
    age = 'confirmed',
    reads = 0,
    audits = 0;
  const resolver = {
    accountRef: 'controlled-account',
    findJob: () => {
      throw new TripoError('JOB_NOT_FOUND', 'controlled missing local job');
    },
    refreshJob: async () => {
      throw new Error('No refresh for raw asset');
    },
    readAsset: async () => {
      reads++;
      return asset(classification);
    },
    auditReference: async (seen: { bucket: string; key: string }) => {
      audits++;
      assert.deepEqual(seen, image);
      return { result: classification, age_confirm_status: age };
    },
  };
  const expected = { image_sources: [{ asset_id: assetId, output_index: 0 }] };
  assert.deepEqual(await resolveImageReferences(params, bindings, resolver), expected);
  assert.equal(audits, 0);
  classification = 'nsfw';
  assert.deepEqual(await resolveImageReferences(params, bindings, resolver), expected);
  age = 'unconfirmed';
  await assert.rejects(resolveImageReferences(params, bindings, resolver), {
    code: 'AGE_CONFIRMATION_REQUIRED',
  });
  classification = 'reject';
  await assert.rejects(resolveImageReferences(params, bindings, resolver), {
    code: 'CONTENT_AUDIT_REJECTED',
  });
  assert.equal(audits, 2);
  const readCount = reads;
  assert.deepEqual(await resolveImageReferences(params, bindings, resolver, expected), expected);
  assert.equal(reads, readCount);
  assert.equal(audits, 2);
});

test('generated image identity mismatch fails before classification or audit can be used', async () => {
  let reads = 0;
  const client = new StudioClient(credentials(), async () => {
    reads++;
    return Response.json({ code: 0, data: { ...asset('sensitive'), asset_id: 'different' } });
  });
  await assert.rejects(new Operations(client, []).imageReference({ image_asset: { asset_id: assetId } }), {
    code: 'INPUT_NOT_READY',
  });
  assert.equal(reads, 1);
});

test('model upload handles cannot enter image audit or read the system image credential store', async () => {
  const client = new StudioClient(credentials(), async () => {
    assert.fail('model tokens are rejected before any remote audit');
  });
  await assert.rejects(
    new Operations(client, []).imageReference({
      image_path: `studio_file_model_${assetId}`,
    }),
    { code: 'CONTENT_AUDIT_REJECTED' },
  );
});
