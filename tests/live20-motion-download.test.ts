/** 动作下载必须读取项目内选中的 retarget，不能把同一详情的主骨架当作动作文件。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { StudioClient } from '../studio/api/client.ts';
import { MemoryCredentials } from '../studio/auth/credentials.ts';
import { existingArtifact, existingArtifactSchema } from '../studio/api/existing-artifact.ts';
import { downloadExistingArtifact } from '../cli/artifacts/library-download.ts';
import { tinyGlb } from './helpers.ts';
import { Document } from '@gltf-transform/core';
import { modelIO } from '../cli/local/gltf.ts';

const modelUrl = 'https://cdn.tripo3d.ai/rig.glb';
const motionUrl = 'https://cdn.tripo3d.ai/motion.glb';
const input = (extra: Record<string, unknown> = {}) =>
  existingArtifactSchema.parse({
    kind: 'motion',
    id: 'project',
    operator_id: 'walk',
    destination_path: '/tmp/caller-motion.glb',
    ...extra,
  });
function detail() {
  return {
    id: 'project',
    is_owner: true,
    model_url: modelUrl,
    operator: {
      operator_id: 'walk',
      status: 'success',
      type: 'retarget',
      model_url: modelUrl,
      retarget: [
        { id: 'idle', operator_id: 'idle', status: 'success', model_url: 'https://cdn.tripo3d.ai/idle.glb' },
        { id: 'walk', operator_id: 'walk', status: 'success', model_url: motionUrl },
      ],
    },
  };
}
function fixture(body: unknown, afterRequest?: (credentials: MemoryCredentials) => void) {
  const credentials = new MemoryCredentials({
    cookie: 'not-a-real-cookie-value',
    deviceId: 'test-device',
    accountRef: 'test-account',
    importedAt: new Date().toISOString(),
  });
  const requests: string[] = [];
  const client = new StudioClient(credentials, async (url, init) => {
    requests.push(url);
    assert.equal(init.method, 'GET');
    assert.equal(url, 'https://api.tripo3d.ai/v2/studio/project/detail/v3/project?operator_id=walk');
    afterRequest?.(credentials);
    return Response.json({ code: 0, data: body });
  });
  return { client, requests };
}

test('motion downloads require an exact operator and reject unrelated context', () => {
  assert.equal(input().kind, 'motion');
  for (const extra of [
    { operator_id: undefined },
    { output_index: 1 },
    { current_operator_id: 'base' },
    { template_id: 'template' },
    { canvas_id: 'canvas' },
    { node_id: 'node' },
    { job_id: 'remote-job' },
  ])
    assert.throws(() => input(extra));
});

test('exact applied motion and model downloads select different original files from the same history', async () => {
  const { client, requests } = fixture(detail());
  const motion = await existingArtifact(client, input());
  assert.deepEqual(motion, {
    url: motionUrl,
    format: 'animation',
    source_id: 'project',
    operator_id: 'walk',
  });
  const model = await existingArtifact(client, input({ kind: 'model' }));
  assert.equal(model.url, modelUrl);
  assert.equal(requests.length, 2);
});

test('applied motion rejects another project, history, duplicate or conflicting motion identity', async () => {
  const wrongProject = detail();
  wrongProject.id = 'another-project';
  const wrongHistory = detail();
  wrongHistory.operator.operator_id = 'latest';
  const duplicate = detail();
  duplicate.operator.retarget.push({ ...duplicate.operator.retarget[1]! });
  const wrongId = detail();
  wrongId.operator.retarget[1]!.id = 'different-motion';
  const wrongOperator = detail();
  wrongOperator.operator.retarget[1]!.operator_id = 'different-motion';
  for (const response of [wrongProject, wrongHistory, duplicate, wrongId, wrongOperator])
    await assert.rejects(existingArtifact(fixture(response).client, input()), { code: 'CONTRACT_CHANGED' });
});

test('missing or incomplete motion never falls back to the completed rig or another animation', async () => {
  const absent = detail();
  absent.operator.retarget.pop();
  await assert.rejects(existingArtifact(fixture(absent).client, input()), { code: 'ARTIFACT_NOT_FOUND' });
  const unfinished = detail();
  unfinished.operator.retarget[1]!.status = 'running';
  const failedHistory = detail();
  failedHistory.operator.status = 'failed';
  const missingFile = detail();
  missingFile.operator.retarget[1]!.model_url = '';
  for (const response of [unfinished, failedHistory, missingFile])
    await assert.rejects(existingArtifact(fixture(response).client, input()), { code: 'ARTIFACT_NOT_READY' });
});

test('motion ownership and account binding are rechecked before releasing its original URL', async () => {
  const otherOwner = detail();
  otherOwner.is_owner = false;
  await assert.rejects(existingArtifact(fixture(otherOwner).client, input()), { code: 'OWNERSHIP_REQUIRED' });
  const changed = fixture(detail(), (credentials) => {
    credentials.save({ ...credentials.load()!, accountRef: 'another-account' });
  });
  await assert.rejects(existingArtifact(changed.client, input()), { code: 'ACCOUNT_MISMATCH' });
});

test('motion download publishes the selected animation bytes and safe source identity without a new task', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tripo-motion-download-'));
  try {
    const doc = new Document(),
      buffer = doc.createBuffer();
    const node = doc.createNode('joint');
    doc.createScene().addChild(node);
    const time = doc
      .createAccessor()
      .setType('SCALAR')
      .setArray(new Float32Array([0, 1]))
      .setBuffer(buffer);
    const translation = doc
      .createAccessor()
      .setType('VEC3')
      .setArray(new Float32Array([0, 0, 0, 0, 0.5, 0]))
      .setBuffer(buffer);
    const sampler = doc.createAnimationSampler().setInput(time).setOutput(translation);
    doc
      .createAnimation('walk')
      .addSampler(sampler)
      .addChannel(
        doc.createAnimationChannel().setSampler(sampler).setTargetNode(node).setTargetPath('translation'),
      );
    const bytes = Buffer.from(await (await modelIO()).writeBinary(doc));
    const { client, requests } = fixture(detail());
    let downloads = 0;
    const saved = await downloadExistingArtifact(
      client,
      dir,
      input({ destination_path: path.join(dir, 'walk.glb') }),
      async (url) => {
        downloads++;
        assert.equal(url, motionUrl);
        return new Response(new Uint8Array(bytes), { headers: { 'content-type': 'model/gltf-binary' } });
      },
    );
    assert.equal(saved.kind, 'motion');
    assert.equal(saved.source_id, 'project');
    assert.equal(saved.operator_id, 'walk');
    assert.equal(saved.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(await readFile(path.join(dir, 'walk.glb')), bytes);
    assert.equal(downloads, 1);
    assert.equal(requests.length, 1);
    assert.ok(!JSON.stringify(saved).includes('https:'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('motion download rejects a static rig or empty clip before publishing any file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tripo-motion-content-'));
  try {
    const json = Buffer.from(
      JSON.stringify({
        asset: { version: '2.0' },
        nodes: [{}],
        animations: [
          {
            channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }],
            samplers: [{ input: 0, output: 1 }],
          },
        ],
      }),
    );
    const header = Buffer.alloc(20),
      padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
    header.write('glTF');
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(20 + padded.length, 8);
    header.writeUInt32LE(padded.length, 12);
    header.writeUInt32LE(0x4e4f534a, 16);
    for (const bytes of [tinyGlb(), tinyGlb(true), Buffer.concat([header, padded])]) {
      await assert.rejects(
        downloadExistingArtifact(
          fixture(detail()).client,
          dir,
          input({ destination_path: path.join(dir, 'walk.glb') }),
          async () => new Response(new Uint8Array(bytes)),
        ),
        { code: 'INVALID_ARTIFACT' },
      );
      assert.deepEqual(await readdir(dir), []);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
