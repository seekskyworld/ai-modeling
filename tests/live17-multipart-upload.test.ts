/** 以真实 AWS SDK 序列化和受控 HTTP 响应核验分片身份、字节、回执及失败清理。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StudioClient } from '../studio/api/client.ts';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { uploadFile, uploadImage } from '../studio/api/upload.ts';

const partSize = 10 * 1024 * 1024;
const reference = { bucket: 'controlled-bucket', key: 'controlled/file.glb' };
const xml = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'application/xml' } });
const created = () =>
  xml(
    '<InitiateMultipartUploadResult><Bucket>controlled-bucket</Bucket><Key>controlled/file.glb</Key><UploadId>controlled-upload</UploadId></InitiateMultipartUploadResult>',
  );
const complete = () =>
  xml('<CompleteMultipartUploadResult><ETag>"controlled-complete"</ETag></CompleteMultipartUploadResult>');
const credentials = () =>
  new MemoryCredentials({
    cookie: 'controlled-cookie',
    deviceId: 'controlled-device',
    accountRef: 'controlled-account',
    importedAt: '2026-11-14T00:00:00Z',
  });
const temporary = () =>
  Response.json({
    code: 0,
    data: {
      sts_ak: 'controlled-access',
      sts_sk: 'controlled-secret',
      session_token: 'controlled-sts',
      resource_bucket: reference.bucket,
      resource_uri: reference.key,
    },
  });

test('large uploads preserve every original byte and submit sorted part ETags before returning a reference', async () => {
  const bytes = Buffer.alloc(partSize * 4 + 37);
  for (let index = 0; index < 5; index++)
    bytes.fill(index + 1, index * partSize, Math.min((index + 1) * partSize, bytes.length));
  const completed = new Map<number, Buffer>();
  const calls: string[] = [];
  let active = 0,
    maxActive = 0;
  const client = new StudioClient(credentials(), async (url, init) => {
    if (url.includes('/storage/temporary_token')) {
      calls.push('token');
      return temporary();
    }
    const endpoint = new URL(url);
    assert.equal(endpoint.hostname, 'controlled-bucket.s3-accelerate.amazonaws.com');
    assert.equal(new Headers(init.headers).has('cookie'), false);
    if (endpoint.searchParams.has('uploads')) {
      calls.push('create');
      return created();
    }
    assert.equal(endpoint.searchParams.get('uploadId'), 'controlled-upload');
    if (init.method === 'PUT') {
      const part = Number(endpoint.searchParams.get('partNumber'));
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, part === 1 ? 8 : 1));
      completed.set(part, Buffer.from(init.body as Uint8Array));
      active--;
      calls.push(`part-${part}`);
      return new Response('', { headers: { etag: `"part-${part}"` } });
    }
    assert.equal(init.method, 'POST');
    assert.equal(completed.size, 5);
    assert.equal(active, 0);
    const body = String(init.body);
    for (let part = 1; part <= 5; part++) {
      assert.ok(body.includes(`<PartNumber>${part}</PartNumber>`));
      assert.ok(body.includes(`part-${part}`));
      if (part > 1) assert.ok(body.indexOf(`part-${part - 1}`) < body.indexOf(`part-${part}`));
    }
    calls.push('complete');
    return complete();
  });
  assert.deepEqual(await uploadFile(client, bytes, 'glb'), reference);
  assert.equal(maxActive, 4);
  assert.equal(
    Buffer.compare(
      Buffer.concat([...completed].sort((a, b) => a[0] - b[0]).map(([, bytes]) => bytes)),
      bytes,
    ),
    0,
  );
  assert.deepEqual(calls.slice(0, 2), ['token', 'create']);
  assert.equal(calls.at(-1), 'complete');
});

test('multipart image audit cannot run before the complete receipt arrives', async () => {
  const calls: string[] = [];
  const client = new StudioClient(credentials(), async (url, init) => {
    if (url.includes('/storage/temporary_token')) {
      calls.push('token');
      return temporary();
    }
    if (url.includes('/audit/image')) {
      assert.equal(calls.at(-1), 'complete');
      calls.push('audit');
      return Response.json({ code: 0, data: { result: 'pass' } });
    }
    const endpoint = new URL(url);
    if (endpoint.searchParams.has('uploads')) {
      calls.push('create');
      return created();
    }
    if (init.method === 'PUT') {
      calls.push('part');
      return new Response('', { headers: { etag: `"part-${endpoint.searchParams.get('partNumber')}"` } });
    }
    calls.push('complete');
    return complete();
  });
  await uploadImage(client, Buffer.alloc(partSize + 1), 'png');
  assert.deepEqual(calls, ['token', 'create', 'part', 'part', 'complete', 'audit']);
});

test('failed or incomplete part receipts stop, wait for in-flight parts, abort once and never audit', async () => {
  for (const failure of ['expired', 'missing-etag']) {
    const calls: string[] = [];
    let active = 0;
    const client = new StudioClient(credentials(), async (url, init) => {
      if (url.includes('/storage/temporary_token')) return temporary();
      assert.equal(url.includes('/audit/image'), false);
      const endpoint = new URL(url);
      if (endpoint.searchParams.has('uploads')) {
        calls.push('create');
        return created();
      }
      if (init.method === 'DELETE') {
        assert.equal(active, 0);
        assert.equal(endpoint.searchParams.get('uploadId'), 'controlled-upload');
        calls.push('abort');
        return new Response(null, { status: 204 });
      }
      assert.equal(init.method, 'PUT');
      const part = Number(endpoint.searchParams.get('partNumber'));
      calls.push(`part-${part}`);
      active++;
      await new Promise((resolve) => setTimeout(resolve, part === 1 ? 8 : 1));
      active--;
      if (part === 2)
        return failure === 'expired'
          ? xml('<Error><Code>ExpiredToken</Code><Message>controlled-secret</Message></Error>', 403)
          : new Response('');
      return new Response('', { headers: { etag: '"first"' } });
    });
    await assert.rejects(uploadImage(client, Buffer.alloc(partSize + 1), 'png'), (error: unknown) => {
      assert.equal((error as { code: string }).code, 'UPLOAD_FAILED');
      assert.equal(JSON.stringify(error).includes('controlled-secret'), false);
      return true;
    });
    assert.deepEqual(calls, ['create', 'part-1', 'part-2', 'abort']);
  }
});

test('a lost completion response cannot lead to audit or an automatically restarted multipart upload', async () => {
  const calls: string[] = [];
  const client = new StudioClient(credentials(), async (url, init) => {
    if (url.includes('/storage/temporary_token')) return temporary();
    assert.equal(url.includes('/audit/image'), false);
    const endpoint = new URL(url);
    if (endpoint.searchParams.has('uploads')) {
      calls.push('create');
      return created();
    }
    if (init.method === 'PUT') return new Response('', { headers: { etag: '"part"' } });
    if (init.method === 'DELETE') {
      calls.push('abort');
      return new Response(null, { status: 204 });
    }
    calls.push('complete');
    throw new Error('controlled lost response');
  });
  await assert.rejects(uploadImage(client, Buffer.alloc(partSize + 1), 'png'), {
    code: 'UPLOAD_FAILED',
    certainty: 'not_submitted',
  });
  assert.deepEqual(calls, ['create', 'complete', 'abort']);
});
