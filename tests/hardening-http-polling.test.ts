/** 全部使用合成响应与虚拟时间；HTTP失败不重放写入，watch只查询原任务。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioClient } from '../studio/api/client.ts';
import { WebMicroClient } from '../studio/api/micro-client.ts';
import { MemoryCredentials, accountReference } from '../studio/auth/credentials.ts';
import { TripoError, errorResult } from '../studio/contracts/errors.ts';
import { retryAfterMilliseconds } from '../studio/api/http-status.ts';
import { waitTask, type Application } from '../cli/compat/runtime.ts';
import { pollingDelay } from '../cli/compat/polling.ts';

const subject = 'synthetic-http-status-account';
const readRpc = '/tripo.canvas.api.agent.LabService/GetLabJob';
const writeRpc = '/tripo.canvas.api.agent.RunService/Run';
const readRest = '/v2/studio/user/profile/payment';
const writeRest = '/v2/studio/operation/generate';
function session() {
  return {
    accountRef: accountReference(subject),
    cookie: 'synthetic-cookie-not-real',
    bearer: `eyJ0eXAiOiJKV1QifQ.${Buffer.from(JSON.stringify({ sub: subject, exp: Date.now() / 1000 + 3600 })).toString('base64url')}.synthetic`,
    deviceId: 'synthetic-device',
    importedAt: '2026-11-16T00:00:00Z',
  };
}

for (const surface of ['REST', 'RPC', 'SSE'] as const) {
  test(`${surface} classifies HTTP 429 and 503 before JSON or embedded authentication codes`, async () => {
    for (const status of [429, 503])
      for (const json of [false, true]) {
        let sends = 0,
          logins = 0;
        const client = new StudioClient(
          new MemoryCredentials(session()),
          async () => {
            sends++;
            const body = json
              ? JSON.stringify({ code: 1002, error: { code: 16 }, reason: 'SYNTHETIC_SECRET' })
              : '<html>SYNTHETIC_SECRET</html>';
            return new Response(body, { status, headers: { 'retry-after': '12' } });
          },
          undefined,
          async () => {
            logins++;
          },
        );
        const micro = new WebMicroClient(client, 'canvas');
        const operation =
          surface === 'REST'
            ? client.request('GET', readRest)
            : surface === 'RPC'
              ? micro.call(readRpc, { jobId: 'original' })
              : micro.stream(
                  '/tripo.canvas.api.agent.LabService/SubscribeLabEvents',
                  { jobId: 'original' },
                  new AbortController().signal,
                );
        await assert.rejects(operation, (error: unknown) => {
          assert.ok(error instanceof TripoError);
          assert.equal(error.code, status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR');
          assert.equal(error.certainty, 'read');
          assert.deepEqual(error.details, { http_status: status, retry_after_ms: 12000 });
          assert.equal(JSON.stringify(errorResult(error)).includes('SYNTHETIC_SECRET'), false);
          return true;
        });
        assert.equal(sends, 1);
        assert.equal(logins, 0);
      }
  });
}

test('REST and RPC writes retain unknown certainty on rate/server errors and are sent once', async () => {
  for (const micro of [false, true])
    for (const status of [429, 503]) {
      let sends = 0;
      const client = new StudioClient(
        new MemoryCredentials(session()),
        async () => {
          sends++;
          return new Response('SYNTHETIC_PRIVATE_RESPONSE', { status, headers: { 'retry-after': '9' } });
        },
        undefined,
        async () => assert.fail('No login on an HTTP rate/server error'),
      );
      await assert.rejects(
        micro
          ? new WebMicroClient(client, 'canvas').call(writeRpc, {}, true)
          : client.request('POST', writeRest, {}, { paid: true }),
        {
          code: status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR',
          certainty: 'unknown',
          details: { http_status: status, retry_after_ms: 9000 },
        },
      );
      assert.equal(sends, 1);
    }
});

test('Retry-After accepts bounded integer seconds and HTTP dates, without accepting malformed numeric input', () => {
  const now = Date.parse('Mon, 16 Nov 2026 12:00:00 GMT');
  assert.equal(retryAfterMilliseconds('12', now), 12000);
  assert.equal(retryAfterMilliseconds(' 0 ', now), 0);
  assert.equal(retryAfterMilliseconds('Mon, 16 Nov 2026 12:00:05 GMT', now), 5000);
  assert.equal(retryAfterMilliseconds('Mon, 16 Nov 2026 11:59:59 GMT', now), 0);
  assert.equal(retryAfterMilliseconds('86401', now), 86400000);
  for (const invalid of [null, '', '-1', '1.5', 'NaN', 'Infinity', 'tomorrow', '9'.repeat(400)])
    assert.equal(retryAfterMilliseconds(invalid, now), undefined);
});

function pollFixture(sequence: Record<string, unknown>[]) {
  let now = 0;
  const requests: Array<{ id: string; at: number; wait: number }> = [],
    sleeps: number[] = [];
  const app = {
    service: {
      get: async (id: string, wait: number) => {
        requests.push({ id, at: now, wait });
        const next = sequence.shift();
        assert.ok(next, 'No poll is allowed after timeout or final state');
        if (next.advance) now += Number(next.advance);
        return next;
      },
      submit: async () => assert.fail('watch must never submit'),
    },
  } as unknown as Application;
  const timing = {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
  };
  return { app, timing, requests, sleeps };
}

test('watch respects Retry-After, polls only the original task, and never polls after its deadline', async () => {
  const f = pollFixture([
    { state: 'running', poll_error: { code: 'RATE_LIMITED', retry_after_ms: 5000 } },
    { state: 'running', poll_error: { code: 'UPSTREAM_ERROR', retry_after_ms: 50000 } },
  ]);
  const result = await waitTask(f.app, 'original-task', 12, f.timing);
  assert.equal(result.wait_timed_out, true);
  assert.deepEqual(f.sleeps, [5000, 7000]);
  assert.deepEqual(f.requests, [
    { id: 'original-task', at: 0, wait: 12 },
    { id: 'original-task', at: 5000, wait: 7 },
  ]);
});

test('watch backs off consecutive failures and resets after successful original-task polling', async () => {
  const failure = { state: 'running', poll_error: { code: 'NETWORK_ERROR' } };
  const f = pollFixture([
    failure,
    failure,
    { state: 'running', advance: 1000 },
    failure,
    { state: 'succeeded' },
  ]);
  assert.equal((await waitTask(f.app, 'original-task', 60, f.timing)).state, 'succeeded');
  assert.deepEqual(f.sleeps, [2000, 4000, 2000]);
  assert.ok(f.requests.every((request) => request.id === 'original-task'));
  assert.equal(pollingDelay({}, 99), 30000);
  assert.equal(pollingDelay({ retry_after_ms: NaN }, 2), 4000);
  assert.equal(pollingDelay({ retry_after_ms: -1 }, 1), 2000);
});

test('zero timeout still inspects once and a submitting wait cannot exceed the remaining deadline', async () => {
  for (const seconds of [0, 1]) {
    const f = pollFixture([{ state: 'submitting' }]);
    assert.equal((await waitTask(f.app, 'original-task', seconds, f.timing)).wait_timed_out, true);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.sleeps, seconds ? [1000] : []);
  }
});
