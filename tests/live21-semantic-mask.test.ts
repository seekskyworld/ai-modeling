/** 分割预览必须绑定精确模型，不混入缩略图或其他变体，也不能因模型已成功就漏掉PNG。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { StudioClient } from '../studio/api/client.ts';
import { StudioGateway } from '../studio/api/gateway.ts';
import { existingArtifact, existingArtifactSchema } from '../studio/api/existing-artifact.ts';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { MemoryLinks } from '../studio/auth/artifact-links.ts';
import { modelResultsStatus } from '../studio/api/model-results.ts';
import { missingSemanticMasks } from '../studio/api/semantic-mask.ts';
import { TripoError } from '../studio/contracts/errors.ts';
import type { Artifact, Job } from '../studio/contracts/types.ts';
import { fixture, quote } from './helpers.ts';

const model: Artifact = { artifact_id: 'model', kind: 'model', format: 'glb', index: 0 };
const mask: Artifact = { artifact_id: 'semantic-mask', kind: 'image', format: 'png', index: 1 };
const job = {
  job_id: 'original',
  account_ref: 'fixture',
  operation: 'model',
  input: { mode: 'image', generate_parts: true },
  remote_ids: { project_id: 'project', operator_id: 'operator' },
  artifacts: [],
} as unknown as Job;
function source() {
  return {
    id: 'project',
    is_owner: true,
    model_url: 'https://cdn.tripo3d.ai/original.glb',
    segmentation_map_url: 'https://cdn.tripo3d.ai/segmentation.png?signature=temporary',
    operator: { operator_id: 'operator', is_segmented: true, status: 'success' },
  };
}
function gateway(detail: () => Record<string, unknown>): StudioGateway {
  const credentials = new MemoryCredentials({
    accountRef: 'fixture',
    cookie: 'fixture',
    deviceId: 'fixture',
    importedAt: '',
  });
  return new StudioGateway(
    new StudioClient(credentials, async (input) => {
      const url = String(input);
      assert.ok(!url.includes('openapi'));
      const data = url.endsWith('/progress') ? [{ operator_id: 'operator', status: 'success' }] : detail();
      return Response.json({ code: 0, data });
    }),
    [],
    new MemoryLinks(),
  );
}

test('parts model exposes original GLB plus independent preview, with no persisted signed URL', async () => {
  const value = source(),
    api = gateway(() => value);
  const status = await api.status(job);
  assert.equal(status.state, 'succeeded');
  assert.deepEqual(status.artifacts, [model, mask]);
  assert.ok(!JSON.stringify(status).includes('signature'));
  assert.equal(await api.artifactUrl(job, mask), value.segmentation_map_url);
  assert.equal(await api.artifactUrl(job, model), value.model_url);
});

test('v2 segmentation and resegmentation expose their own preview, while legacy v1 is unchanged', async () => {
  for (const operation of ['segment', 'resegment'] as const) {
    const status = await gateway(source).status({
      ...job,
      operation,
      input: { model_version: 'v2.0-20260430' },
    });
    assert.deepEqual(status.artifacts, [model, mask]);
  }
  assert.deepEqual(
    (
      await gateway(source).status({
        ...job,
        operation: 'segment',
        input: { model_version: 'v1.0-20250506' },
      })
    ).artifacts,
    [model],
  );
});

test('existing web previews need an exact operator and work without any local generation task', async () => {
  const input = {
    kind: 'segmentation_preview',
    id: 'project',
    operator_id: 'operator',
    destination_path: '/caller/mask.png',
  };
  const parsed = existingArtifactSchema.parse(input);
  assert.equal(existingArtifactSchema.safeParse({ ...input, operator_id: undefined }).success, false);
  const result = await existingArtifact(gateway(source).client, parsed);
  assert.equal(result.url, source().segmentation_map_url);
  assert.equal(result.format, 'image');
  assert.equal(result.source_id, 'project');
  assert.equal(result.operator_id, 'operator');
  await assert.rejects(existingArtifact(gateway(() => ({ ...source(), is_owner: false })).client, parsed), {
    code: 'OWNERSHIP_REQUIRED',
  });
  await assert.rejects(
    existingArtifact(gateway(() => ({ ...source(), segmentation_map_url: '' })).client, parsed),
    { code: 'ARTIFACT_NOT_READY' },
  );
});

test('missing, wrong-history, foreign, unfinished or contradictory previews fail closed', async () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ ...source(), segmentation_map_url: '' }, 'ARTIFACT_NOT_READY'],
    [{ ...source(), id: 'other' }, 'CONTRACT_CHANGED'],
    [{ ...source(), operator: { ...source().operator, operator_id: 'latest' } }, 'CONTRACT_CHANGED'],
    [{ ...source(), is_owner: false }, 'OWNERSHIP_REQUIRED'],
    [{ ...source(), operator: { ...source().operator, is_segmented: false } }, 'ARTIFACT_NOT_READY'],
    [{ ...source(), operator: { ...source().operator, status: 'running' } }, 'ARTIFACT_NOT_READY'],
    [{ ...source(), segmentation_map_url: 'invalid' }, 'CONTRACT_CHANGED'],
    [
      {
        ...source(),
        operator: { ...source().operator, segmentation_map_url: 'https://cdn.tripo3d.ai/other.png' },
      },
      'CONTRACT_CHANGED',
    ],
  ];
  for (const [value, code] of cases) await assert.rejects(gateway(() => value).status(job), { code });
  await assert.rejects(gateway(source).artifactUrl({ ...job, input: {} }, mask), {
    code: 'CONTRACT_CHANGED',
  });
});

test('multiple model receipts keep each mask identity and source index across failed reads', async () => {
  const batch = {
    ...job,
    input: { ...job.input, mode: 'batch', image_paths: ['first', 'second'] },
    remote_ids: {
      models: [0, 1].map((i) => ({ accepted: true as const, project_id: `p${i}`, operator_id: `o${i}` })),
    },
  };
  const status = await modelResultsStatus(batch, async () => ({
    state: 'succeeded',
    progress: 100,
    artifacts: [model, mask],
  }));
  assert.deepEqual(
    status.artifacts.map((a) => [a.artifact_id, a.index]),
    [
      ['model-0', 0],
      ['semantic-mask-0', 0],
      ['model-1', 1],
      ['semantic-mask-1', 1],
    ],
  );
  const saved = { ...batch, artifacts: status.artifacts };
  assert.equal(missingSemanticMasks(saved), false);
  assert.equal(missingSemanticMasks({ ...saved, artifacts: status.artifacts.slice(0, 3) }), true);
  const retry = await modelResultsStatus(saved, async () => {
    throw new Error('read unavailable');
  });
  assert.deepEqual(retry.artifacts, status.artifacts);
  assert.equal(retry.state, 'running');
});

test('completed old parts task discovers only its new preview without submitting or replacing its model', async () => {
  const f = await fixture();
  try {
    const prepared = f.jobs.prepare('test-account', 'old-parts', 'model', job.input, quote);
    const original = { ...model, local_path: '/old/model.glb', sha256: 'original', bytes: 42 };
    f.jobs.update(prepared.job_id, 'succeeded', { remote_ids: job.remote_ids, artifacts: [original] });
    let reads = 0;
    f.gateway.status = async () => {
      reads++;
      return { state: 'succeeded', progress: 100, artifacts: [model, mask] };
    };
    await f.service.get(prepared.job_id);
    assert.deepEqual(f.jobs.get(prepared.job_id).artifacts, [original, mask]);
    await f.service.get(prepared.job_id);
    assert.equal(reads, 1);
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('legacy success with a missing single or partial batch preview stays visibly unverified until read recovery', async () => {
  for (const batch of [false, true]) {
    const f = await fixture();
    try {
      const input = {
        mode: batch ? 'batch' : 'image',
        generate_parts: true,
        ...(batch ? { image_paths: ['a', 'b'] } : {}),
      };
      const original = f.jobs.prepare('test-account', 'old-missing-mask', 'model', input, quote);
      const remote_ids = batch
        ? {
            models: [0, 1].map((i) => ({
              accepted: true as const,
              project_id: `p${i}`,
              operator_id: `o${i}`,
            })),
          }
        : job.remote_ids;
      const artifacts = batch
        ? [0, 1].map((index) => ({ ...model, artifact_id: `model-${index}`, index }))
        : [model];
      f.jobs.update(original.job_id, 'succeeded', { remote_ids, artifacts });
      assert.equal(f.service.summary(f.jobs.get(original.job_id)).state, 'needs_attention');
      let recovered = false;
      f.gateway.status = async (current) => {
        if (!batch && !recovered)
          throw new TripoError('ARTIFACT_NOT_READY', 'Missing original preview', 'read');
        const result = { state: 'succeeded' as const, progress: 100, artifacts: [model, mask] };
        if (!batch) return result;
        return await modelResultsStatus(current, async (child) => {
          if (!recovered && child.remote_ids.operator_id === 'o1')
            throw new TripoError('ARTIFACT_NOT_READY', 'Missing second preview', 'read');
          return result;
        });
      };
      const incomplete = await f.service.get(original.job_id);
      assert.equal(incomplete.state, 'needs_attention');
      assert.equal(incomplete.remote_state, 'succeeded');
      assert.ok(incomplete.poll_error);
      assert.equal(f.jobs.get(original.job_id).state, 'succeeded');
      recovered = true;
      const complete = await f.service.get(original.job_id);
      assert.equal(complete.state, 'succeeded');
      assert.equal(f.service.summary(f.jobs.get(original.job_id)).state, 'succeeded');
      assert.equal(f.gateway.posts, 0);
    } finally {
      f.jobs.close();
      await rm(f.dir, { recursive: true, force: true });
    }
  }
});

test('a failed legacy batch discovers previews of accepted siblings while retaining its failure', async () => {
  const f = await fixture();
  try {
    const input = { mode: 'batch', image_paths: ['a', 'b'], generate_parts: true };
    const original = f.jobs.prepare('test-account', 'old-partial-parts', 'model', input, quote);
    const accepted = { ...model, artifact_id: 'model-0', index: 0, sha256: 'retained-model' };
    f.jobs.update(original.job_id, 'failed', {
      remote_ids: { models: [{ accepted: true, project_id: 'p0', operator_id: 'o0' }, { accepted: false }] },
      artifacts: [accepted],
      error: { code: 'MODEL_RESULT_FAILED', message: 'Second item was rejected' },
    });
    f.gateway.status = async (current) =>
      await modelResultsStatus(current, async () => ({
        state: 'succeeded',
        progress: 100,
        artifacts: [model, mask],
      }));
    const found = await f.service.get(original.job_id);
    assert.equal(found.state, 'failed');
    assert.deepEqual(f.jobs.get(original.job_id).artifacts, [
      accepted,
      { ...mask, artifact_id: 'semantic-mask-0', index: 0 },
    ]);
    assert.equal(f.jobs.get(original.job_id).state, 'failed');
    assert.equal(f.jobs.get(original.job_id).error?.code, 'MODEL_RESULT_FAILED');
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
