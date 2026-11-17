/** URL 内容在并发与重试中必须稳定；恶意文件和 glTF 外链在上传前拒绝。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { materializeInputs } from '../cli/artifacts/source.ts';
import { generation, type Plan } from '../cli/compat/planning.ts';
import { detectFormat } from '../studio/files.ts';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5X8AAAAASUVORK5CYII=',
  'base64',
);
const plan = (): Plan => ({
  steps: [generation('image-to-model', ['https://input.example/image.png'], {})],
  pending_uploads: [],
  warnings: [],
});

test('URL input uses no credentials and concurrent/repeated intentions preserve the first complete bytes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tripo-source-'));
  let calls = 0;
  try {
    const fetcher = async (_url: string, init: RequestInit) => {
      calls++;
      assert.equal(init.headers, undefined);
      assert.equal(init.redirect, 'manual');
      return new Response(Buffer.concat([png, Buffer.from(String(calls))]));
    };
    const results = await Promise.all([
      materializeInputs(plan(), dir, 'intent', fetcher),
      materializeInputs(plan(), dir, 'intent', fetcher),
    ]);
    const file = String(results[0]!.steps[0]!.parameters.image_path);
    assert.equal(results[1]!.steps[0]!.parameters.image_path, file);
    const bytes = await readFile(file);
    const prior = calls;
    await materializeInputs(plan(), dir, 'intent', fetcher);
    assert.equal(calls, prior);
    assert.deepEqual(await readFile(file), bytes);
    assert.equal((await readdir(path.join(dir, 'input-cache'))).length, 1);
    await materializeInputs(plan(), dir, 'different-intent', fetcher);
    assert.equal(calls, prior + 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('URL input rejects credential-bearing redirects and error documents without caching them', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tripo-source-'));
  try {
    let calls = 0;
    await assert.rejects(
      materializeInputs(plan(), dir, 'redirect', async () => {
        calls++;
        return new Response(null, {
          status: 302,
          headers: { location: 'https://name:secret@input.example/file' },
        });
      }),
      { code: 'INVALID_INPUT' },
    );
    assert.equal(calls, 1);
    await assert.rejects(
      materializeInputs(plan(), dir, 'html', async () => new Response('<html>not a model</html>')),
      { code: 'INVALID_ARTIFACT' },
    );
    assert.deepEqual(await readdir(path.join(dir, 'input-cache')), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('text glTF accepts embedded resources but rejects external buffers and textures', () => {
  const model = {
    asset: { version: '2.0' },
    meshes: [{ primitives: [] }],
    buffers: [{ uri: 'data:application/octet-stream;base64,AAAA', byteLength: 3 }],
  };
  assert.equal(detectFormat(Buffer.from(JSON.stringify(model))), 'gltf');
  assert.throws(
    () => detectFormat(Buffer.from(JSON.stringify({ ...model, buffers: [{ uri: '../private.bin' }] }))),
    { code: 'INVALID_ARTIFACT' },
  );
  assert.throws(
    () =>
      detectFormat(
        Buffer.from(JSON.stringify({ ...model, images: [{ uri: 'https://elsewhere.example/image.png' }] })),
      ),
    { code: 'INVALID_ARTIFACT' },
  );
});
