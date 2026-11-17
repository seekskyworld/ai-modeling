/** 检查真正的文件系统边界、流式下载和网络错误语义，避免只验证参数映射。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MemoryCredentials, parseCredential } from '../studio/auth/credentials.ts';
import { StudioClient } from '../studio/api/client.ts';
import { errorResult, sanitize, TripoError } from '../studio/contracts/errors.ts';
import { allowedDownload, download } from '../cli/artifacts/download.ts';
import { detectFormat, outputTarget, readInput, validateGlb } from '../studio/files.ts';
import { fixture, tinyGlb } from './helpers.ts';
import { PricingService } from '../studio/api/pricing.ts';
import { resolveDestination } from '../cli/artifacts/destination.ts';
import { configFromEnv } from '../cli/core/config.ts';
import sharp from 'sharp';

test('automatic image downloads use the real encoding once while explicit paths and existing files stay protected', async () => {
  const f = await fixture();
  const jpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'orange' } })
    .jpeg()
    .toBuffer();
  let requests = 0;
  const fetcher = async (): Promise<Response> => {
    requests++;
    return new Response(new Uint8Array(jpeg));
  };
  try {
    const result = await download(
      'https://cdn.tripo3d.ai/image',
      f.service.config.outputDir,
      'automatic.png',
      'image',
      fetcher,
      true,
    );
    assert.equal(requests, 1);
    assert.equal(path.basename(result.local_path), 'automatic.jpeg');
    assert.deepEqual(await readFile(result.local_path), jpeg);
    assert.deepEqual(await readdir(f.service.config.outputDir), ['automatic.jpeg']);
    await assert.rejects(
      download('https://cdn.tripo3d.ai/image', f.service.config.outputDir, 'chosen.png', 'image', fetcher),
      { code: 'OUTPUT_EXTENSION' },
    );
    await assert.rejects(
      download(
        'https://cdn.tripo3d.ai/image',
        f.service.config.outputDir,
        'automatic.png',
        'image',
        fetcher,
        true,
      ),
      { code: 'OUTPUT_EXISTS' },
    );
    assert.deepEqual(await readFile(result.local_path), jpeg);
    assert.deepEqual(await readdir(f.service.config.outputDir), ['automatic.jpeg']);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('paid HTTP failures never retry; plan refusal differs from authentication', async () => {
  const cases = [
    { status: 403, body: { code: 6102 }, code: 'PLAN_REQUIRED', certainty: 'not_submitted' },
    { status: 401, body: { code: 1002 }, code: 'AUTH_REQUIRED', certainty: 'not_submitted' },
    { status: 503, body: { code: 500 }, code: 'UPSTREAM_ERROR', certainty: 'unknown' },
    { status: 429, body: {}, code: 'RATE_LIMITED', certainty: 'unknown' },
  ];
  for (const value of cases) {
    let calls = 0;
    const client = new StudioClient(new MemoryCredentials(parseCredential('a'.repeat(32))), async () => {
      calls++;
      return Response.json(value.body, { status: value.status });
    });
    await assert.rejects(client.request('POST', '/v2/studio/image/gen_image_v2', {}, { paid: true }), {
      code: value.code,
      certainty: value.certainty,
    });
    assert.equal(calls, 1);
  }
  const client = new StudioClient(
    new MemoryCredentials(parseCredential('a'.repeat(32))),
    async () => new Response('<html>bad gateway</html>', { status: 200 }),
  );
  await assert.rejects(client.request('POST', '/v2/studio/image/gen_image_v2', {}, { paid: true }), {
    certainty: 'unknown',
  });
});
test('credential parsing never executes cURL and output sanitization removes authentication', () => {
  const session = parseCredential(
    "curl 'https://api.tripo3d.ai/v2/studio/progress' -H 'Cookie: ory_kratos_session=" +
      'a'.repeat(32) +
      "; other=value' $(never-execute)",
  );
  assert.equal(session.cookie, 'a'.repeat(32));
  assert.throws(() => parseCredential('short'), { code: 'INVALID_CREDENTIAL' });
  assert.deepEqual(
    sanitize({
      authorization: 'secret',
      nested: { token: 'secret' },
      url: 'https://example.com/a?signature=secret',
    }),
    { nested: {}, url: 'https://example.com/a' },
  );
  assert.equal(JSON.stringify(errorResult(new Error('token secret'))).includes('token secret'), false);
});
test('output traversal and symlink parents cannot escape; input roots are enforced', async () => {
  const f = await fixture();
  try {
    const output = f.service.config.outputDir;
    const outside = path.join(f.dir, 'outside');
    await mkdir(outside);
    await symlink(outside, path.join(output, 'link'));
    await assert.rejects(outputTarget(output, '../escape.glb'), { code: 'OUTPUT_PATH_DENIED' });
    await assert.rejects(outputTarget(output, 'link/model.glb'), { code: 'OUTPUT_PATH_DENIED' });
    const file = path.join(outside, 'image.png');
    await writeFile(file, Buffer.alloc(32));
    await assert.rejects(readInput(file, [output]), { code: 'INPUT_PATH_DENIED' });
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
test('download validates format and length, preserves existing files and never sends cookies', async () => {
  const f = await fixture();
  const glb = tinyGlb();
  try {
    const fetcher = async (_url: string, init: RequestInit): Promise<Response> => {
      assert.equal(init.headers, undefined);
      return new Response(new Uint8Array(glb), { headers: { 'content-length': String(glb.length) } });
    };
    const result = await download(
      'https://cdn.tripo3d.ai/model.glb',
      f.service.config.outputDir,
      'verified.glb',
      'glb',
      fetcher,
    );
    assert.equal(result.bytes, glb.length);
    assert.equal(result.sha256.length, 64);
    assert.deepEqual(await readFile(result.local_path), glb);
    await assert.rejects(
      download(
        'https://cdn.tripo3d.ai/model.glb',
        f.service.config.outputDir,
        'verified.glb',
        'glb',
        fetcher,
      ),
      { code: 'OUTPUT_EXISTS' },
    );
    await assert.rejects(
      download(
        'https://cdn.tripo3d.ai/model.glb',
        f.service.config.outputDir,
        'bad.glb',
        'glb',
        async () => new Response('not a real model'),
      ),
      { code: 'INVALID_ARTIFACT' },
    );
    await assert.rejects(
      download(
        'https://cdn.tripo3d.ai/model.glb',
        f.service.config.outputDir,
        'bad.glb',
        'glb',
        async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } }),
      ),
      { code: 'DOWNLOAD_HOST_DENIED' },
    );
    assert.equal(allowedDownload('https://tripo3d.ai.evil.example/a'), false);
    assert.equal(allowedDownload('https://user:secret@cdn.tripo3d.ai/a'), false);
    assert.throws(() => detectFormat(glb.subarray(0, glb.length - 4)), { code: 'INVALID_ARTIFACT' });
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
test('price evidence expiry and missing operation cost cannot be treated as zero', async () => {
  const f = await fixture();
  const filename = path.join(f.dir, 'pricing.json');
  const prices = new PricingService(filename);
  try {
    assert.equal((await prices.quote('rig', {})).known, false);
    const snapshot = {
      reviewed_at: new Date(Date.now() - 1000).toISOString(),
      expires_at: new Date(Date.now() + 60000).toISOString(),
      source: 'fixture',
      credits: { Rigging: 20 },
      evidence: [],
    };
    await writeFile(filename, JSON.stringify(snapshot));
    assert.equal((await prices.quote('rig', {})).credits, 20);
    assert.equal((await prices.quote('animate', {})).known, false);
    await writeFile(filename, JSON.stringify({ ...snapshot, credits: { ApplyRetexture: 0 } }));
    assert.equal((await prices.quote('retexture_apply', {})).known, false);
    await writeFile(filename, JSON.stringify({ ...snapshot, credits: { ApplyTextureBasic: 10 } }));
    assert.equal((await prices.quote('retexture_apply', {})).credits, 10);
    await writeFile(
      filename,
      JSON.stringify({ ...snapshot, expires_at: new Date(Date.now() - 1).toISOString() }),
    );
    assert.equal((await prices.quote('rig', {})).known, false);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
test('unknown error details are sanitized before external reporting', () => {
  const result = errorResult(new TripoError('TEST', 'Safe message', 'read', { remote_code: 2010 }));
  assert.equal(result.remote_code, 2010);
});
test('animation-only GLBs are accepted only for an explicitly declared animation artifact', () => {
  const animation = tinyGlb(true);
  assert.throws(() => detectFormat(animation), { code: 'INVALID_ARTIFACT' });
  assert.equal(detectFormat(animation, true), 'glb');
  assert.equal(allowedDownload('https://tripo-data.rg1.data.tripo3d.com/file.glb'), true);
  assert.equal(allowedDownload('https://tripo-data.rg1.data.tripo3d.com.evil.example/file.glb'), false);
});

test('input validation accepts an actual PNG and rejects oversized or non-image uploads', async () => {
  const f = await fixture();
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
    'base64',
  );
  const file = path.join(f.dir, 'input.png');
  try {
    await writeFile(file, png);
    const input = await readInput(file, [f.dir]);
    assert.equal(input.format, 'png');
    assert.deepEqual(input.bytes, png);
    assert.equal(input.sha256.length, 64);
    await assert.rejects(readInput(file, [f.dir], 10), { code: 'INPUT_SIZE' });
    await writeFile(file, tinyGlb());
    await assert.rejects(readInput(file, [f.dir]), { code: 'INPUT_FORMAT' });
    assert.throws(() => detectFormat(png.subarray(0, 30)), { code: 'INVALID_ARTIFACT' });
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('GLB validation rejects malformed JSON and external dependencies before publication', () => {
  const valid = tinyGlb();
  assert.throws(() => validateGlb(Buffer.alloc(4)), { code: 'INVALID_ARTIFACT' });
  const corrupt = Buffer.from(valid);
  corrupt[20] = 0;
  assert.throws(() => validateGlb(corrupt), { code: 'INVALID_ARTIFACT' });
  corrupt.writeUInt32LE(corrupt.length, 12);
  assert.throws(() => validateGlb(corrupt), { code: 'INVALID_ARTIFACT' });
  const json = JSON.stringify({ meshes: [{}], images: [{ uri: 'file:///private/image.png' }] });
  const body = Buffer.from(json.padEnd(Math.ceil(json.length / 4) * 4, ' '));
  const external = Buffer.concat([valid.subarray(0, 20), body]);
  external.writeUInt32LE(external.length, 8);
  external.writeUInt32LE(body.length, 12);
  assert.throws(() => validateGlb(external), { code: 'INVALID_ARTIFACT' });
});

test('failed downloads leave no partial file, even for incompatible formats and redirects', async () => {
  const f = await fixture();
  const glb = new Uint8Array(tinyGlb());
  const cases = [
    {
      response: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new DOMException('fixture timeout', 'TimeoutError'));
            },
          }),
        ),
      expected: 'glb',
      file: 'timed-out.glb',
      code: 'DOWNLOAD_FAILED',
    },
    {
      response: () => new Response(glb),
      expected: 'image',
      file: 'bad.png',
      code: 'ARTIFACT_FORMAT_MISMATCH',
    },
    { response: () => new Response(glb), expected: 'glb', file: 'bad.png', code: 'OUTPUT_EXTENSION' },
    {
      response: () => new Response(glb, { headers: { 'content-length': '999' } }),
      expected: 'glb',
      file: 'bad.glb',
      code: 'INVALID_ARTIFACT',
    },
    {
      response: () => new Response(null, { status: 302 }),
      expected: 'glb',
      file: 'bad.glb',
      code: 'DOWNLOAD_REDIRECT',
    },
    {
      response: () => new Response(null, { status: 404 }),
      expected: 'glb',
      file: 'bad.glb',
      code: 'DOWNLOAD_FAILED',
    },
  ];
  try {
    for (const value of cases)
      await assert.rejects(
        download(
          'https://cdn.tripo3d.ai/model',
          f.service.config.outputDir,
          value.file,
          value.expected,
          async () => value.response(),
        ),
        { code: value.code },
      );
    assert.deepEqual(await readdir(f.service.config.outputDir), []);
    assert.equal(allowedDownload('not a URL'), false);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('callers choose independent file locations while optional roots still restrict access', async () => {
  const f = await fixture();
  try {
    const config = configFromEnv({});
    assert.equal(config.outputDir, '');
    assert.deepEqual(config.inputRoots, []);
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
      'base64',
    );
    const input = path.join(f.dir, 'caller-input.png');
    await writeFile(input, png);
    assert.equal((await readInput(input, config.inputRoots)).format, 'png');
    for (const folder of ['project-a/models', 'project-b/assets']) {
      const requested = path.join(f.dir, folder, 'robot.glb');
      const destination = await resolveDestination('', requested);
      const result = await download(
        'https://cdn.tripo3d.ai/model.glb',
        destination.root,
        destination.relative,
        'glb',
        async () => new Response(new Uint8Array(tinyGlb())),
      );
      assert.equal(result.local_path, await realpath(requested));
    }
    await assert.rejects(resolveDestination('', 'robot.glb'), { code: 'DESTINATION_REQUIRED' });
    const denied = await resolveDestination(f.service.config.outputDir, path.join(f.dir, 'outside.glb'));
    await assert.rejects(outputTarget(denied.root, denied.relative), { code: 'OUTPUT_PATH_DENIED' });
    const nested = await resolveDestination(f.service.config.outputDir, 'models/robot.glb');
    assert.equal(
      await outputTarget(nested.root, nested.relative),
      path.join(await realpath(f.service.config.outputDir), 'models/robot.glb'),
    );
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
