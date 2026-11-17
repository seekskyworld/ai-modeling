/** 原生读取的网络恢复不得覆盖已有摘要；仅模拟下载，不使用账号或生产数据库。 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EnvHttpProxyAgent, MockAgent } from 'undici';
import { nativeScaleBytes } from '../cli/artifacts/smartsegment-scale-io.ts';
import type { Artifact } from '../studio/contracts/types.ts';
import { fixture, quote } from './helpers.ts';
import { scaleModel } from './helpers-smartsegment-scale.ts';

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
async function setup(t: TestContext) {
  const f = await fixture(),
    original = await scaleModel(undefined, 0.4),
    changed = await scaleModel(undefined, 0.6),
    agent = new MockAgent();
  assert.equal(original.length, changed.length);
  assert.notEqual(sha(original), sha(changed));
  agent.disableNetConnect();
  t.mock.method(EnvHttpProxyAgent.prototype, 'dispatch', agent.dispatch.bind(agent));
  const artifact: Artifact = {
    artifact_id: 'model',
    kind: 'model',
    format: 'glb',
    index: 0,
    local_path: path.join(f.dir, 'missing-source.glb'),
    sha256: sha(original),
    bytes: original.length,
  };
  const prepared = f.jobs.prepare('test-account', 'original-source', 'import_model', {}, quote),
    job = f.jobs.update(prepared.job_id, 'succeeded', {
      remote_ids: { project_id: 'original-project', operator_id: 'original-operator' },
      artifacts: [artifact],
    }),
    before = structuredClone(job);
  let lookups = 0;
  f.gateway.artifactUrl = async () => {
    lookups++;
    return 'https://cdn.tripo3d.ai/frozen-source.glb';
  };
  t.after(async () => {
    assert.deepEqual(f.jobs.get(job.job_id), before);
    f.jobs.close();
    await agent.close();
    await rm(f.dir, { recursive: true, force: true });
  });
  return {
    ...f,
    job,
    artifact,
    original,
    changed,
    lookups: () => lookups,
    respond: (bytes: Buffer) =>
      agent
        .get('https://cdn.tripo3d.ai')
        .intercept({ path: '/frozen-source.glb', method: 'GET' })
        .reply(200, bytes),
  };
}

test('missing local source rejects a different valid GLB of the same size without replacing its receipt', async (t) => {
  const f = await setup(t);
  f.respond(f.changed);
  await assert.rejects(nativeScaleBytes(f.job, f.artifact, f.gateway, f.dir), {
    code: 'NATIVE_OUTPUT_CONTENT_CHANGED',
    certainty: 'read',
  });
  assert.equal(f.lookups(), 1);
  assert.deepEqual(await readdir(path.join(f.dir, 'smartsegment-scale-checks')), []);
});

test('a length-only original receipt still rejects a different size', async (t) => {
  const f = await setup(t),
    artifact = { ...f.artifact, bytes: f.original.length + 4 };
  delete artifact.sha256;
  f.respond(f.original);
  await assert.rejects(nativeScaleBytes(f.job, artifact, f.gateway, f.dir), {
    code: 'NATIVE_OUTPUT_CONTENT_CHANGED',
  });
});

test('a hash-only original receipt rejects changed bytes', async (t) => {
  const f = await setup(t),
    artifact = { ...f.artifact };
  delete artifact.bytes;
  f.respond(f.changed);
  await assert.rejects(nativeScaleBytes(f.job, artifact, f.gateway, f.dir), {
    code: 'NATIVE_OUTPUT_CONTENT_CHANGED',
  });
});

test('a renewed native URL restores the exact missing original', async (t) => {
  const f = await setup(t);
  f.respond(f.original);
  assert.deepEqual(await nativeScaleBytes(f.job, f.artifact, f.gateway, f.dir), f.original);
  assert.equal(f.lookups(), 1);
  assert.deepEqual(await readdir(path.join(f.dir, 'smartsegment-scale-checks')), []);
});

test('a receipt without previous byte observations allows its first native read', async (t) => {
  const f = await setup(t),
    artifact = { ...f.artifact };
  delete artifact.sha256;
  delete artifact.bytes;
  f.respond(f.changed);
  assert.deepEqual(await nativeScaleBytes(f.job, artifact, f.gateway, f.dir), f.changed);
});

test('the verified local original needs no network lookup', async (t) => {
  const f = await setup(t);
  await writeFile(f.artifact.local_path!, f.original);
  assert.deepEqual(await nativeScaleBytes(f.job, f.artifact, f.gateway, f.dir), f.original);
  assert.equal(f.lookups(), 0);
});
