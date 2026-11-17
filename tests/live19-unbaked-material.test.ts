/** 原生材质保留必须绑定实际表面；来源、结果和下载证明跨重启/并发仍不可替换。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Document } from '@gltf-transform/core';
import sharp from 'sharp';
import { materialSnapshot, sameMaterialSnapshot } from '../cli/artifacts/material-snapshot.ts';
import { freezeUnbakedSource, verifyUnbakedBytes } from '../cli/artifacts/unbaked-material.ts';
import { unbakedSourceKey, unbakedProofKey, hasUnbakedProof } from '../cli/core/unbaked-material-policy.ts';
import { modelIO } from '../cli/local/gltf.ts';
import { processingPlan } from '../cli/compat/planning.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import { TripoError } from '../studio/contracts/errors.ts';
import type { Artifact, Job } from '../studio/contracts/types.ts';
import { fixture, quote } from './helpers.ts';
import { Operations } from '../studio/api/operations.ts';
import type { StudioClient } from '../studio/api/client.ts';
import { StudioGateway } from '../studio/api/gateway.ts';
import { MemoryLinks } from '../studio/auth/artifact-links.ts';

async function model(
  options: {
    exported?: boolean;
    swap?: boolean;
    roughness?: number;
    colors?: boolean;
    reverse?: boolean;
    cyclic?: boolean;
  } = {},
): Promise<Buffer> {
  const doc = new Document(),
    buffer = doc.createBuffer();
  const positions = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [10, 0, 0],
    [11, 0, 0],
    [10, 1, 0],
  ].flatMap(([x, y, z]) => (options.exported ? [-z!, y!, x!] : [x!, y!, z!]));
  const position = doc
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array(positions))
    .setBuffer(buffer);
  const uv = doc
    .createAccessor()
    .setType('VEC2')
    .setArray(new Float32Array((options.swap ? [0.9, 0.1] : [0.1, 0.9]).flatMap((u) => [u, 0, u, 0.5, u, 1])))
    .setBuffer(buffer);
  const png = await sharp(Buffer.from([255, 0, 0, 0, 0, 255]), { raw: { width: 2, height: 1, channels: 3 } })
    .png()
    .toBuffer();
  const texture = doc.createTexture().setMimeType('image/png').setImage(png);
  const material = doc
    .createMaterial()
    .setMetallicFactor(0.8)
    .setRoughnessFactor(options.roughness ?? 0.2)
    .setDoubleSided(true)
    .setBaseColorTexture(texture);
  const primitive = doc
    .createPrimitive()
    .setAttribute('POSITION', position)
    .setAttribute('TEXCOORD_0', uv)
    .setMaterial(material);
  if (options.reverse || options.cyclic)
    primitive.setIndices(
      doc
        .createAccessor()
        .setType('SCALAR')
        .setArray(new Uint16Array(options.reverse ? [0, 2, 1, 3, 5, 4] : [1, 2, 0, 4, 5, 3]))
        .setBuffer(buffer),
    );
  if (options.colors)
    primitive.setAttribute(
      'COLOR_0',
      doc.createAccessor().setType('VEC3').setArray(new Float32Array(18).fill(0.5)).setBuffer(buffer),
    );
  doc.createScene().addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(primitive)));
  return Buffer.from(await (await modelIO()).writeBinary(doc));
}
function mutate(bytes: Buffer, change: (json: Record<string, unknown>) => void): Buffer {
  const length = bytes.readUInt32LE(12),
    json = JSON.parse(bytes.subarray(20, 20 + length).toString());
  change(json);
  const raw = Buffer.from(JSON.stringify(json)),
    body = Buffer.alloc(Math.ceil(raw.length / 4) * 4, 32);
  raw.copy(body);
  const header = Buffer.from(bytes.subarray(0, 20)),
    tail = bytes.subarray(20 + length);
  header.writeUInt32LE(body.length, 12);
  header.writeUInt32LE(20 + body.length + tail.length, 8);
  return Buffer.concat([header, body, tail]);
}
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const input = (): Record<string, unknown> =>
  normalize('export', { project_id: 'project', expected_operator_id: 'source', bake: false });

async function prepared(
  f: Awaited<ReturnType<typeof fixture>>,
  request = 'unbaked',
  raw = input(),
): Promise<Job> {
  const job = f.jobs.prepare('test-account', request, 'export', raw, quote);
  const gateway = Object.assign(f.gateway, {
    materialSource: async () => ({ url: 'https://cdn.tripo3d.ai/source.glb', material_factors: {} }),
  });
  await freezeUnbakedSource(job, f.jobs, f.dir, gateway, async () => await model());
  return job;
}
async function completed(
  f: Awaited<ReturnType<typeof fixture>>,
  request = 'unbaked',
  bytes?: Buffer,
): Promise<Job> {
  const job = await prepared(f, request),
    data = bytes ?? (await model({ exported: true }));
  const file = path.join(f.dir, `${request}.glb`);
  await writeFile(file, data);
  const artifact: Artifact = {
    artifact_id: 'model',
    kind: 'model',
    format: 'glb',
    index: 0,
    local_path: file,
    bytes: data.length,
    sha256: digest(data),
  };
  f.jobs.claim(job.job_id);
  f.jobs.update(job.job_id, 'submitted', {
    remote_ids: { project_id: 'project', operator_id: 'export-original' },
  });
  return f.jobs.update(job.job_id, 'succeeded', { artifacts: [artifact] });
}

test('material proof binds UV/colors to actual surfaces and preserves basic PBR fields', async () => {
  const source = await materialSnapshot(await model(), {}, true),
    good = await materialSnapshot(await model({ exported: true }));
  assert.equal(sameMaterialSnapshot(source, good), true);
  assert.equal(
    sameMaterialSnapshot(source, await materialSnapshot(await model({ exported: true, cyclic: true }))),
    true,
  );
  for (const options of [{ swap: true }, { roughness: 0.7 }, { colors: true }, { reverse: true }]) {
    const changed = await materialSnapshot(await model({ exported: true, ...options }));
    assert.equal(sameMaterialSnapshot(source, changed), false);
  }
  const modified = mutate(await model({ exported: true }), (json) => {
    const m = (json.materials as Record<string, unknown>[])[0]!;
    m.doubleSided = false;
  });
  assert.equal(sameMaterialSnapshot(source, await materialSnapshot(modified)), false);
});

test('unknown nested extensions, external resources and animation clips fail before material proof', async () => {
  const bytes = await model();
  for (const edit of [
    (j: Record<string, unknown>) => {
      (j.materials as Record<string, unknown>[])[0]!.extensions = {
        KHR_materials_transmission: { transmissionFactor: 1 },
      };
    },
    (j: Record<string, unknown>) => {
      (j.buffers as Record<string, unknown>[])[0]!.uri = 'https://example.invalid/model.bin';
    },
    (j: Record<string, unknown>) => {
      j.animations = [{ samplers: [], channels: [] }];
    },
  ])
    await assert.rejects(materialSnapshot(mutate(bytes, edit)), { code: 'UNBAKED_MATERIAL_UNSUPPORTED' });
});

test('bake=false plans use exact static GLB and reject source-changing paid prefixes', () => {
  const plan = processingPlan('convert', '@model', { param: { bake: false, format: 'GLTF' } });
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0]!.parameters.bake, false);
  assert.equal(plan.steps[0]!.parameters.expected_operator_id, 'upstream');
  for (const param of [
    { bake: true },
    { bake: false, format: 'FBX' },
    { bake: false, pack_uv: true },
    { bake: false, texture_format: 'PNG' },
    { bake: false, part_names: ['part'] },
    { bake: false, face_limit: 4000 },
    { bake: false, quad: true },
    { bake: false, export_orientation: '+x' },
    { bake: false, with_animation: true },
  ])
    assert.throws(() => processingPlan('convert', '@model', { param }));
  assert.throws(() => processingPlan('convert', 'model.glb', { param: { bake: false } }), {
    code: 'STUDIO_CAPABILITY_UNAVAILABLE',
  });
});

test('native export carries exact source guard but never fabricates a bake request field', async () => {
  let operator = 'source';
  const client = {
    request: async () => ({
      id: 'project',
      is_owner: true,
      operator: { operator_id: operator, status: 'success' },
    }),
  } as unknown as StudioClient;
  const job = { operation: 'export', input: input() } as Job;
  const request = await new Operations(client, []).build(job);
  assert.equal(request.route, '/v2/studio/operation/export');
  assert.equal(request.body.bake, undefined);
  assert.equal(request.body.expected_operator_id, undefined);
  assert.equal(request.body.format, 'gltf');
  operator = 'different';
  await assert.rejects(new Operations(client, []).build(job), { code: 'PROJECT_CHANGED' });
});

test('material source reads the exact owned operator and rejects changed identity or geometry metadata', async () => {
  const initial = {
    id: 'project',
    is_owner: true,
    model_url: 'https://cdn.tripo3d.ai/source.glb',
    operator: {
      operator_id: 'source',
      status: 'success',
      is_pbr: true,
      metadata: { material_factor: { metallic: 0.8, roughness: 0.2 } },
    },
  };
  let detail: Record<string, unknown> = initial;
  const client = {
    forAccount: (account: string) => {
      assert.equal(account, 'test-account');
      return {
        request: async (method: string, route: string) => {
          assert.equal(method, 'GET');
          assert.equal(route, '/v2/studio/project/detail/v3/project?operator_id=source');
          return detail;
        },
      };
    },
  } as unknown as StudioClient;
  const gateway = new StudioGateway(client, [], new MemoryLinks());
  const job = { account_ref: 'test-account', operation: 'export', input: input() } as Job;
  assert.deepEqual((await gateway.materialSource(job)).material_factors, { metallic: 0.8, roughness: 0.2 });
  for (const next of [
    { ...initial, id: 'different' },
    { ...initial, operator: { ...initial.operator, operator_id: 'different' } },
    { ...initial, is_owner: false },
    { ...initial, operator: { ...initial.operator, metadata: { children_deleted: ['part'] } } },
    {
      ...initial,
      operator: {
        ...initial.operator,
        metadata: { transform_matrix: [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
      },
    },
  ]) {
    detail = next;
    await assert.rejects(gateway.materialSource(job));
  }
});

test('source snapshot rejects texture downsampling and cannot be attached after a receipt arrives', async () => {
  const f = await fixture();
  try {
    await assert.rejects(prepared(f, 'small', { ...input(), texture_size: 1 }), {
      code: 'UNBAKED_MATERIAL_UNSUPPORTED',
    });
    const job = f.jobs.prepare('test-account', 'late', 'export', input(), quote);
    const gateway = Object.assign(f.gateway, {
      materialSource: async () => ({ url: 'https://cdn.tripo3d.ai/source.glb', material_factors: {} }),
    });
    await assert.rejects(
      freezeUnbakedSource(job, f.jobs, f.dir, gateway, async () => {
        f.jobs.claim(job.job_id);
        f.jobs.update(job.job_id, 'submitted', { remote_ids: { operator_id: 'arrived' } });
        return await model();
      }),
      { code: 'UNBAKED_SOURCE_UNVERIFIED' },
    );
    assert.equal(f.jobs.requestPolicy('test-account', unbakedSourceKey(job)), undefined);
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('successful and unmet exports survive restart with original receipts and zero resubmissions', async () => {
  const f = await fixture();
  let closed = false;
  try {
    const good = await completed(f),
      bad = await completed(f, 'wrong-surface', await model({ exported: true, swap: true }));
    assert.equal((await f.service.get(good.job_id)).state, 'succeeded');
    assert.equal(hasUnbakedProof(f.jobs, f.jobs.get(good.job_id)), true);
    const failure = await f.service.get(bad.job_id);
    assert.equal(failure.state, 'needs_attention');
    assert.equal(failure.remote_state, 'succeeded');
    assert.equal(f.jobs.get(bad.job_id).state, 'succeeded');
    await rm(good.artifacts[0]!.local_path!);
    f.jobs.close();
    closed = true;
    const restarted = await fixture(f.dir);
    try {
      assert.equal((await restarted.service.get(good.job_id)).state, 'succeeded');
      restarted.gateway.artifactUrl = async () => {
        throw new TripoError('DOWNLOAD_FAILED', 'URL-only export link expired.', 'read', {
          http_status: 403,
        });
      };
      const cached = await restarted.service.download(
        good.job_id,
        good.artifacts[0]!.artifact_id,
        'private-cache-restored.glb',
      );
      assert.equal(cached.restored_from_cache, true);
      assert.equal(cached.sha256, good.artifacts[0]!.sha256);
      assert.equal(
        (await restarted.service.submit('export', bad.request_id, bad.input, 10)).state,
        'needs_attention',
      );
      assert.equal(restarted.gateway.posts, 0);
      await assert.rejects(
        restarted.service.submit('export', good.request_id, { ...good.input, bake: undefined }, 10),
        { code: 'IDEMPOTENCY_CONFLICT' },
      );
    } finally {
      restarted.jobs.close();
    }
  } finally {
    if (!closed) f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('old exports without source proof remain unverified and new unavailable preflight performs zero POST', async () => {
  const f = await fixture();
  try {
    const noSource = await f.service.submit('export', 'no-source', input(), 10);
    assert.equal(noSource.state, 'failed');
    assert.equal(f.gateway.posts, 0);
    const old = f.jobs.prepare('test-account', 'old', 'export', input(), quote);
    f.jobs.claim(old.job_id);
    f.jobs.update(old.job_id, 'submitted', { remote_ids: { project_id: 'project', operator_id: 'old' } });
    f.jobs.update(old.job_id, 'succeeded');
    const view = await f.service.submit('export', 'old', old.input, 10);
    assert.equal(view.state, 'needs_attention');
    assert.equal((view.error as { code: string }).code, 'UNBAKED_SOURCE_UNVERIFIED');
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('first material proof cannot be overwritten and altered bytes or receipts cannot reuse it', async () => {
  const f = await fixture();
  try {
    const job = await completed(f);
    await f.service.get(job.job_id);
    const artifact = f.jobs.get(job.job_id).artifacts[0]!;
    const key = unbakedProofKey(job, artifact),
      proof = f.jobs.requestPolicy(job.account_ref, key)!;
    assert.throws(() => f.jobs.bindUnbakedPolicy(job, key, { ...proof, sha256: 'a'.repeat(64) }, artifact), {
      code: 'UNBAKED_OUTPUT_CONTENT_CHANGED',
    });
    assert.deepEqual(f.jobs.requestPolicy(job.account_ref, key), proof);
    const changed = mutate(await readFile(artifact.local_path!), (json) => {
      json.extras = { benign: 'different original bytes' };
    });
    await assert.rejects(verifyUnbakedBytes(job, artifact, changed, f.jobs), {
      code: 'UNBAKED_OUTPUT_CONTENT_CHANGED',
    });
    f.jobs.update(job.job_id, 'succeeded', {
      remote_ids: { project_id: 'project', operator_id: 'replaced' },
    });
    const view = await f.service.get(job.job_id);
    assert.equal(view.state, 'needs_attention');
    assert.equal((view.error as { code: string }).code, 'UNBAKED_OUTPUT_IDENTITY_CHANGED');
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('material downloads restore original cache and reject URL-read and final-save identity races', async () => {
  for (const phase of ['restore', 'url', 'save']) {
    const f = await fixture();
    try {
      const job = await completed(f);
      await f.service.get(job.job_id);
      const artifact = f.jobs.get(job.job_id).artifacts[0]!;
      const change = (): void => {
        f.jobs.update(job.job_id, 'succeeded', {
          remote_ids: { project_id: 'project', operator_id: 'changed' },
        });
      };
      f.gateway.artifactUrl = async () => {
        if (phase === 'url') change();
        throw new TripoError('NETWORK_ERROR', 'Original URL expired.', 'read');
      };
      if (phase === 'save') {
        const save = f.jobs.saveArtifact.bind(f.jobs);
        f.jobs.saveArtifact = (id, a, guard) => {
          change();
          return save(id, a, guard);
        };
      }
      if (phase === 'restore') {
        const restored = await f.service.download(job.job_id, artifact.artifact_id, 'restored.glb');
        assert.equal(restored.restored_from_cache, true);
        assert.deepEqual(await readFile(String(restored.local_path)), await readFile(artifact.local_path!));
      } else {
        await assert.rejects(f.service.download(job.job_id, artifact.artifact_id, 'race.glb'), {
          code: 'UNBAKED_OUTPUT_IDENTITY_CHANGED',
        });
        assert.deepEqual(f.jobs.get(job.job_id).artifacts[0], artifact);
        if (phase === 'url') await assert.rejects(access(path.join(f.dir, 'output', 'race.glb')));
      }
      assert.equal(f.gateway.posts, 0);
    } finally {
      f.jobs.close();
      await rm(f.dir, { recursive: true, force: true });
    }
  }
});

test('a changed receipt between proof read and result publication cannot be returned as verified', async () => {
  const f = await fixture();
  try {
    const job = await completed(f);
    await f.service.get(job.job_id);
    const original = f.jobs.requestPolicy.bind(f.jobs);
    let changed = false;
    f.jobs.requestPolicy = (account, key) => {
      const proof = original(account, key);
      if (!changed && key.startsWith('unbaked-result:')) {
        changed = true;
        f.jobs.update(job.job_id, 'succeeded', {
          remote_ids: { project_id: 'project', operator_id: 'changed-before-result' },
        });
      }
      return proof;
    };
    const view = await f.service.get(job.job_id);
    assert.equal(view.state, 'needs_attention');
    assert.equal((view.error as { code: string }).code, 'UNBAKED_OUTPUT_IDENTITY_CHANGED');
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
