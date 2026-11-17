/** 合成上游错误必须在数据库和 CLI/MCP 共用结果链中脱敏；成功链接与分页游标保持可用。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { rm } from 'node:fs/promises';
import { fixture, imageInput, quote } from './helpers.ts';
import { StudioClient } from '../studio/api/client.ts';
import { StudioGateway } from '../studio/api/gateway.ts';
import { MemoryLinks } from '../studio/auth/artifact-links.ts';
import { errorResult, object, sanitize, TripoError } from '../studio/contracts/errors.ts';
import { taskResult } from '../cli/compat/runtime.ts';

const marker = 'SYNTHETIC_CREDENTIAL_MARKER';
const signed = `https://synthetic-user:${marker}@cdn.tripo3d.ai/synthetic.glb?X-Amz-Signature=${marker}#${marker}`;

test('diagnostic strings redact embedded signed URLs, authentication and nested credential fields', () => {
  for (const message of [
    `Download failed for ${signed}; retry later.`,
    `Rejected Bearer ${marker} from upstream`,
    `Rejected Basic ${marker}== from upstream`,
    `Session failed: ory_kratos_session=${marker}; retry later`,
    `Reply contains x-auth-token: ${marker}`,
    `Authorization: Bearer ${marker}`,
    `Cookie: other=${marker}; ory_kratos_session=${marker}`,
    `{"api_key":"${marker}"}`,
    `{"cookie":"synthetic-session=${marker}"}`,
    JSON.stringify({ password: 'escaped"' + marker }),
    `Remote says eyJhbGciOiJub25lIn0.eyJzdWIiOiJzeW50aGV0aWMifQ.${marker}`,
  ]) {
    const result = errorResult(
      new TripoError('SYNTHETIC_ERROR', message, 'unknown', {
        nested: { api_key: marker, bearer: marker, credentials: marker, reason: message },
        http_status: 503,
        retry_after_ms: 12000,
      }),
    );
    assert.equal(JSON.stringify(result).includes(marker), false, message);
    assert.equal(result.code, 'SYNTHETIC_ERROR');
    assert.equal(result.certainty, 'unknown');
    assert.equal(result.http_status, 503);
    assert.equal(result.retry_after_ms, 12000);
  }
  assert.equal(
    sanitize(`Download failed for ${signed}; retry later.`),
    'Download failed for https://cdn.tripo3d.ai/synthetic.glb; retry later.',
  );
});

test('opaque pagination cursors are preserved exactly without allowing other token fields', () => {
  const cursor = 'eyJhbGciOiJub25lIn0.synthetic.pagination';
  const input = { pageToken: cursor, nextPageToken: signed, page_token: cursor, next_page_token: signed };
  assert.deepEqual(sanitize({ ...input, auth_token: marker }), input);
  assert.deepEqual(sanitize({ pageToken: { token: marker, message: `Bearer ${marker}` } }), {
    pageToken: { message: '[redacted authorization]' },
  });
});

test('actual progress -> gateway -> job store -> public task result never persists an embedded secret', async () => {
  const f = await fixture();
  try {
    const job = f.jobs.prepare('test-account', 'synthetic-failure', 'model', { prompt: 'Synthetic' }, quote);
    f.jobs.claim(job.job_id);
    f.jobs.update(job.job_id, 'submitted', {
      remote_ids: { project_id: 'synthetic-project', operator_id: 'synthetic-operator' },
    });
    const client = new StudioClient(f.service.credentials, async (url, init) => {
      assert.equal(url, 'https://api.tripo3d.ai/v2/studio/progress');
      assert.equal(init.method, 'POST');
      return Response.json({
        code: 0,
        data: [
          {
            operator_id: 'synthetic-operator',
            status: 'failed',
            reason: `Download failed for ${signed}; Authorization: Bearer ${marker}`,
          },
        ],
      });
    });
    f.service.gateway = new StudioGateway(client, [], new MemoryLinks());
    const result = await f.service.get(job.job_id);
    assert.equal(result.state, 'failed');
    for (const output of [f.jobs.get(job.job_id), result, taskResult(result)]) {
      assert.equal(JSON.stringify(output).includes(marker), false);
      assert.match(
        String(object(object(output).error).remote_reason),
        /https:\/\/cdn.tripo3d.ai\/synthetic.glb/,
      );
    }
    assert.equal(object(f.jobs.get(job.job_id).error).code, 'REMOTE_TASK_FAILED');
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('successful API payloads retain signed business links', async () => {
  const f = await fixture();
  try {
    const client = new StudioClient(f.service.credentials, async () =>
      Response.json({ code: 0, data: { url: signed } }),
    );
    assert.deepEqual(await client.request('GET', '/v2/studio/project/synthetic'), { url: signed });
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('an unknown submission stores a sanitized error without mutating its original recovery details', async () => {
  const f = await fixture();
  try {
    const failure = new TripoError('UPSTREAM_ERROR', `Failed at ${signed}`, 'unknown', {
      context: { api_key: marker, reason: `Bearer ${marker}` },
      http_status: 503,
      retry_after_ms: 5000,
    });
    f.gateway.failSubmit = failure;
    const result = await f.service.submit('image', 'synthetic-submit', imageInput, 10);
    const stored = f.jobs.find('test-account', 'synthetic-submit')!;
    assert.equal(stored.state, 'outcome_unknown');
    assert.equal(f.gateway.posts, 1);
    assert.equal(JSON.stringify(stored).includes(marker), false);
    assert.equal(JSON.stringify(taskResult(result)).includes(marker), false);
    assert.equal(object(stored.error).retry_after_ms, 5000);
    assert.equal(object(failure.details.context).api_key, marker);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
