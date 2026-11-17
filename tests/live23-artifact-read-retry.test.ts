/** 下载只重试响应前连接失败；原URL/时限/目录/已验证结果边界不能被重试改变。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { download, downloadArtifactBytes } from '../cli/artifacts/download.ts';
import { fetchReadTransport } from '../studio/api/read-transport.ts';
import { TripoError } from '../studio/contracts/errors.ts';
import type { Fetcher } from '../studio/api/client.ts';
import { tinyGlb } from './helpers.ts';

const url = 'https://tripo-data.rg1.data.tripo3d.com/exact/source.glb?token=fixture-only&expires=original';
const failure = (code = 'UND_ERR_CONNECT_TIMEOUT') =>
  new TypeError('controlled fetch failure', { cause: { code } });
const body = () =>
  new Response(new Uint8Array(tinyGlb()), { headers: { 'content-length': String(tinyGlb().length) } });

test('memory and file downloads retry the same GET and original timeout signal before receiving headers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tripo-read-retry-'));
  try {
    for (const disk of [false, true]) {
      const calls: Array<{ url: string; init: RequestInit }> = [];
      const fetcher: Fetcher = async (address, init) => {
        calls.push({ url: address, init });
        if (calls.length < 3) throw failure();
        return body();
      };
      if (disk) {
        const saved = await download(url, root, 'source.glb', 'glb', fetcher);
        assert.deepEqual(await readFile(saved.local_path), tinyGlb());
      } else assert.deepEqual(await downloadArtifactBytes(url, 'glb', fetcher), tinyGlb());
      assert.equal(calls.length, 3);
      for (const call of calls) {
        assert.equal(call.url, url);
        assert.equal(call.init.method, 'GET');
        assert.equal(call.init.redirect, 'manual');
        assert.equal(call.init.headers, undefined);
        assert.equal(call.init.body, undefined);
        assert.equal(call.init.signal, calls[0]!.init.signal);
      }
    }
    assert.deepEqual(await readdir(root), ['source.glb']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an unavailable artifact stops after three connection attempts without creating a partial output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tripo-read-offline-'));
  let calls = 0;
  try {
    await assert.rejects(
      download(url, root, 'offline.glb', 'glb', async () => {
        calls++;
        throw failure('ECONNREFUSED');
      }),
      { code: 'DOWNLOAD_FAILED', certainty: 'read' },
    );
    assert.equal(calls, 3);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('HTTP failures, unknown transport errors and malformed content never restart a download', async () => {
  const cases: Array<{ fetcher: Fetcher; code: string }> = [
    ...[401, 403, 404, 429, 503].map((status) => ({
      fetcher: async () => new Response('failed', { status }),
      code: 'DOWNLOAD_FAILED',
    })),
    {
      fetcher: async () => {
        throw new TypeError('unknown fetch rejection');
      },
      code: 'DOWNLOAD_FAILED',
    },
    {
      fetcher: async () => {
        throw failure('ERR_INVALID_URL');
      },
      code: 'DOWNLOAD_FAILED',
    },
    { fetcher: async () => new Response('not a GLB'), code: 'INVALID_ARTIFACT' },
    {
      fetcher: async () => new Response(new Uint8Array(tinyGlb()), { headers: { 'content-length': '999' } }),
      code: 'INVALID_ARTIFACT',
    },
  ];
  for (const row of cases) {
    let calls = 0;
    await assert.rejects(
      downloadArtifactBytes(url, 'glb', async (...args) => {
        calls++;
        return await row.fetcher(...args);
      }),
      { code: row.code },
    );
    assert.equal(calls, 1);
  }
});

test('a recognized socket error in the response body is not a connection retry', async () => {
  let calls = 0;
  await assert.rejects(
    downloadArtifactBytes(url, 'glb', async () => {
      calls++;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(failure('UND_ERR_SOCKET'));
          },
        }),
      );
    }),
    { code: 'DOWNLOAD_FAILED' },
  );
  assert.equal(calls, 1);
});

test('disk publication failures after one response never cause another artifact request', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tripo-read-disk-'));
  let calls = 0;
  try {
    const gone = path.join(root, 'gone');
    await mkdir(gone);
    await assert.rejects(
      download(url, gone, 'disk.glb', 'glb', async () => {
        calls++;
        await rm(gone, { recursive: true });
        return body();
      }),
      { code: 'ENOENT' },
    );
    assert.equal(calls, 1);
    calls = 0;
    await assert.rejects(
      download(
        url,
        root,
        'validate.glb',
        'glb',
        async () => {
          calls++;
          return body();
        },
        false,
        {
          validateBytes: async () => {
            throw Object.assign(new Error('controlled disk validation error'), { code: 'EIO' });
          },
        },
      ),
      { code: 'DOWNLOAD_FAILED' },
    );
    assert.equal(calls, 1);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('redirects retain exact query and one timeout budget while every destination stays allowlisted', async () => {
  const redirected = 'https://cdn.tripo3d.ai/exact/source.glb?token=second-fixture-only';
  const calls: Array<{ url: string; init: RequestInit }> = [];
  assert.deepEqual(
    await downloadArtifactBytes(url, 'glb', async (address, init) => {
      calls.push({ url: address, init });
      if (calls.length === 1) return new Response(null, { status: 302, headers: { location: redirected } });
      if (calls.length === 2) throw failure('ECONNRESET');
      return body();
    }),
    tinyGlb(),
  );
  assert.deepEqual(
    calls.map((call) => call.url),
    [url, redirected, redirected],
  );
  assert(calls.every((call) => call.init.signal === calls[0]!.init.signal));
  let denied = 0;
  await assert.rejects(
    downloadArtifactBytes(url, 'glb', async () => {
      denied++;
      return new Response(null, {
        status: 302,
        headers: { location: 'https://outside.invalid/not-requested' },
      });
    }),
    { code: 'DOWNLOAD_HOST_DENIED' },
  );
  assert.equal(denied, 1);
});

test('retry backoff and transfer obey the first signal, without renewing its timeout', async (t) => {
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal),
    created: number[] = [],
    signals: AbortSignal[] = [];
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    created.push(milliseconds);
    return originalTimeout(220);
  });
  const before = performance.now();
  await assert.rejects(
    downloadArtifactBytes(url, 'glb', async (_address, init) => {
      signals.push(init.signal!);
      if (signals.length === 1) throw failure();
      await delay(3000, undefined, { signal: init.signal! });
      assert.fail('The first timeout must terminate the later transfer');
    }),
    { code: 'DOWNLOAD_FAILED' },
  );
  assert.deepEqual(created, [600000]);
  assert.equal(signals.length, 2);
  assert.equal(signals[0], signals[1]);
  assert.equal(signals[0]!.aborted, true);
  assert(performance.now() - before < 1200);
});

test('an already expired shared budget does not even issue the first GET', async () => {
  let calls = 0;
  const abort = new AbortController();
  abort.abort();
  for (const budget of [
    { signal: abort.signal, deadline: performance.now() + 1000 },
    { signal: new AbortController().signal, deadline: performance.now() - 1 },
  ]) {
    await assert.rejects(
      fetchReadTransport(
        async () => {
          calls++;
          return body();
        },
        url,
        { method: 'GET' },
        {
          readRetry: true,
          timeoutMs: 1000,
          budget,
          beforeRetry: () => undefined,
          failure: () => new TripoError('DOWNLOAD_FAILED', 'Expired first budget'),
        },
      ),
      { code: 'DOWNLOAD_FAILED' },
    );
  }
  assert.equal(calls, 0);
});
