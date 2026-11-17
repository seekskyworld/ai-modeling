/** 实测发现的持久化边界：UV应用会关闭候选上下文，原任务模型导入不能跟随变化的别名/URL。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { fixture, quote } from './helpers.ts';
import { preserveUvLayout } from '../cli/artifacts/uv-cache.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import { Operations } from '../studio/api/operations.ts';
import { existingArtifactSchema, uvCandidate } from '../studio/api/existing-artifact.ts';
import type { StudioClient } from '../studio/api/client.ts';
import type { Job } from '../studio/contracts/types.ts';
import { TripoError } from '../studio/contracts/errors.ts';

test('generation maps verified negative/UV fields without silently accepting image negative prompts', async () => {
  const input = normalize('model', { mode: 'text', prompt: 'F', negative_prompt: 'holes', export_uv: false });
  const submission = await new Operations({} as StudioClient, []).build({ operation: 'model', input } as Job);
  assert.equal(submission.body.negative_prompt, 'holes');
  assert.equal(submission.body.export_uv, false);
  assert.throws(() => normalize('model', { mode: 'image', image_path: 'a.png', negative_prompt: 'holes' }));
  assert.throws(() => normalize('model', { mode: 'text', prompt: 'F', negative_prompt: 'x'.repeat(256) }));
});

test('UV layout preserves original bytes before application and restores only the exact candidate', async () => {
  const f = await fixture();
  try {
    const input = { project_id: 'project', current_operator_id: 'base', action: 'generate' };
    const job = f.jobs.prepare('test-account', 'uv-source', 'uv_generate', input, quote);
    f.jobs.claim(job.job_id);
    const done = f.jobs.update(job.job_id, 'succeeded', {
      remote_ids: { project_id: 'project', operator_id: 'candidate' },
      artifacts: [{ artifact_id: 'uv-layout', kind: 'image', format: 'png', index: 1 }],
    });
    assert.equal(f.jobs.uvCandidate('test-account', 'project', 'base', 'candidate')?.job_id, done.job_id);
    assert.equal(f.jobs.uvCandidate('other-account', 'project', 'base', 'candidate'), undefined);
    assert.equal(f.jobs.uvCandidate('test-account', 'project', 'other', 'candidate'), undefined);
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#123456' } })
      .png()
      .toBuffer();
    await preserveUvLayout(
      done,
      f.service.config,
      f.jobs,
      f.gateway,
      async () => new Response(new Uint8Array(bytes)),
    );
    const cached = f.jobs.get(done.job_id).artifacts[0]!;
    assert.deepEqual(await readFile(cached.local_path!), bytes);
    f.gateway.artifactUrl = async () => {
      throw new TripoError('STUDIO_REJECTED', 'Context closed', 'read', {
        remote_code: 2043,
        http_status: 409,
      });
    };
    await f.service.submit(
      'uv_commit',
      'commit',
      { project_id: 'project', current_operator_id: 'base', candidate_operator_id: 'candidate' },
      10,
    );
    assert.equal(f.gateway.posts, 1);
    const restored = await f.service.download(
      done.job_id,
      'uv-layout',
      path.join(f.dir, 'output', 'saved.png'),
    );
    assert.equal(restored.restored_from_cache, true);
    assert.deepEqual(await readFile(String(restored.local_path)), bytes);
    await writeFile(String(restored.local_path), Buffer.from('corrupted'));
    await assert.rejects(
      f.service.download(done.job_id, 'uv-layout', path.join(f.dir, 'output', 'corrupted.png')),
      { code: 'STUDIO_REJECTED' },
    );
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('UV native layout selection rejects a foreign context or absent candidate', async () => {
  assert.throws(() =>
    existingArtifactSchema.parse({ kind: 'uv_layout', id: 'p', destination_path: '/tmp/x.webp' }),
  );
  const input = {
    kind: 'uv_layout',
    id: 'p',
    current_operator_id: 'b',
    operator_id: 'c',
    destination_path: '/tmp/x.webp',
  };
  assert.ok(existingArtifactSchema.parse(input));
  const client = {
    request: async () => ({
      project_id: 'p',
      current_operator_id: 'b',
      candidates: [{ operator_id: 'c', uv_layout: { url: 'https://example.org/a.webp' } }],
    }),
  };
  assert.equal((await uvCandidate(client, 'p', 'b', 'c')).operator_id, 'c');
  await assert.rejects(uvCandidate(client, 'p', 'b', 'different'), { code: 'ARTIFACT_NOT_FOUND' });
  await assert.rejects(uvCandidate(client, 'other', 'b', 'c'), { code: 'CONTRACT_CHANGED' });
});
