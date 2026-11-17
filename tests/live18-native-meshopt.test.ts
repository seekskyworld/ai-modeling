/** 原生压缩按实际字节验收；重点覆盖伪声明、未压缩结果、重启及同意图恢复不得重新收费。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MeshoptEncoder } from 'meshoptimizer';
import { verifyNativeMeshopt } from '../cli/artifacts/native-meshopt.ts';
import {
  assertNativeOutputIdentity,
  hasNativeOutputProof,
  verifyNativeArtifactBytes,
} from '../cli/artifacts/native-output.ts';
import { download } from '../cli/artifacts/download.ts';
import { generationPlan, processingPlan } from '../cli/compat/planning.ts';
import { executePlan, taskResult, type Application } from '../cli/compat/runtime.ts';
import { freezeNativeOutputPolicy } from '../cli/compat/native-output-policy.ts';
import { executionExitCode } from '../cli/compat/execution-policy.ts';
import { fixture, tinyGlb } from './helpers.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import { quote } from './helpers.ts';
import type { Artifact, Job } from '../studio/contracts/types.ts';
import { TripoError } from '../studio/contracts/errors.ts';

function glb(json: Record<string, unknown>, binary: Uint8Array): Buffer {
  const raw = Buffer.from(JSON.stringify(json));
  const body = Buffer.alloc(Math.ceil(raw.length / 4) * 4, 32);
  raw.copy(body);
  const data = Buffer.alloc(Math.ceil(binary.length / 4) * 4);
  Buffer.from(binary).copy(data);
  const header = Buffer.alloc(20),
    binHeader = Buffer.alloc(8);
  header.write('glTF');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(28 + body.length + data.length, 8);
  header.writeUInt32LE(body.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  binHeader.writeUInt32LE(data.length);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, body, binHeader, data]);
}
async function compressedFixture(): Promise<{
  bytes: Buffer;
  json: Record<string, unknown>;
  binary: Uint8Array;
}> {
  await MeshoptEncoder.ready;
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const binary = MeshoptEncoder.encodeGltfBuffer(new Uint8Array(positions.buffer), 3, 12, 'ATTRIBUTES');
  const json = {
    asset: { version: '2.0' },
    extensionsUsed: ['EXT_meshopt_compression'],
    extensionsRequired: ['EXT_meshopt_compression'],
    buffers: [{ byteLength: binary.length }, { byteLength: 36 }],
    bufferViews: [
      {
        buffer: 1,
        byteLength: 36,
        extensions: {
          EXT_meshopt_compression: {
            buffer: 0,
            byteOffset: 0,
            byteLength: binary.length,
            byteStride: 12,
            count: 3,
            mode: 'ATTRIBUTES',
          },
        },
      },
    ],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  };
  return { bytes: glb(json, binary), json, binary };
}

test('native Meshopt validates compressed geometry, not extension declarations or corrupt bytes', async () => {
  const source = await compressedFixture();
  assert.deepEqual(await verifyNativeMeshopt(source.bytes), {
    compressed_buffer_views: 1,
    geometry_accessors: 1,
  });
  await assert.rejects(verifyNativeMeshopt(tinyGlb()), { code: 'NATIVE_OUTPUT_REQUIREMENT_FAILED' });
  const corrupt = Uint8Array.from(source.binary);
  corrupt[0] = 0;
  await assert.rejects(verifyNativeMeshopt(glb(source.json, corrupt)), {
    code: 'NATIVE_OUTPUT_REQUIREMENT_FAILED',
  });
  const fake = structuredClone(source.json);
  fake.accessors = [{ bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' }];
  fake.bufferViews = [...(source.json.bufferViews as unknown[]), { buffer: 0, byteLength: 36 }];
  await assert.rejects(verifyNativeMeshopt(glb(fake, source.binary)), {
    code: 'NATIVE_OUTPUT_REQUIREMENT_FAILED',
  });
  for (const buffer of [
    { byteLength: source.binary.length, uri: 'data:application/octet-stream;base64,AAAA' },
    { byteLength: source.binary.length - 4 },
  ]) {
    const declared = structuredClone(source.json);
    declared.buffers = [buffer];
    await assert.rejects(verifyNativeMeshopt(glb(declared, source.binary)), {
      code: 'NATIVE_OUTPUT_REQUIREMENT_FAILED',
    });
  }
});

test('compression plans freeze effect requirements across P-series and PBR without sending a web field', () => {
  const hd = generationPlan('text-to-model', ['cube'], {
    model: 'tripo-v3.1',
    param: { texture: false, compress: 'geometry' },
  });
  assert.equal(hd.steps[0]!.requireNativeMeshopt, true);
  assert.equal(hd.steps[0]!.parameters.compress, undefined);
  const p2 = generationPlan('text-to-model', ['cube'], {
    model: 'tripo-p2',
    param: { pbr: true, compress: 'geometry' },
  });
  assert.deepEqual(
    p2.steps.map((s) => s.requireNativeMeshopt),
    [true, true, true],
  );
  assert.ok(p2.steps.every((s) => s.parameters.compress === undefined));
  const texture = processingPlan('texture', '@model', { param: { compress: 'geometry', pbr: true } });
  assert.deepEqual(
    texture.steps.map((s) => s.requireNativeMeshopt),
    [true, true],
  );
  for (const param of [
    { quad: true, compress: 'geometry' },
    { compress: 'geometry', export_orientation: '+x' },
  ])
    assert.throws(() => generationPlan('text-to-model', ['cube'], { model: 'tripo-v3.1', param }), {
      code: 'STUDIO_CAPABILITY_UNAVAILABLE',
    });
  const uv = processingPlan('uv', '@model', { param: { compress: 'geometry' } });
  assert.deepEqual(
    uv.steps.map((step) => step.operation),
    ['uv_generate', 'uv_commit', 'import_model'],
  );
  assert.equal(uv.steps.at(-1)!.uvImportFromChain, true);
  const edit = processingPlan('edit', '@model', {
    param: {
      compress: 'geometry',
      bbox: [
        [-0.5, -0.9, -0.5],
        [0.5, -0.2, 0.5],
      ],
    },
  });
  assert.equal(edit.steps[0]!.operation, 'local_edit');
  assert.equal(edit.steps[0]!.requireNativeMeshopt, true);
  assert.equal(edit.steps[0]!.parameters.compress, undefined);
});

test('explicit disabled real-world sizing preserves native generation/export semantics; enabled sizing remains unavailable', () => {
  for (const name of ['text-to-model', 'image-to-model', 'multiview-to-model']) {
    const inputs =
      name === 'text-to-model'
        ? ['cube']
        : name === 'image-to-model'
          ? ['front.png']
          : ['front.png', 'back.png'];
    const defaults = generationPlan(name, inputs, { model: 'tripo-v3.1' });
    const disabled = generationPlan(name, inputs, { model: 'tripo-v3.1', param: { auto_size: false } });
    assert.deepEqual(disabled.steps[0]!.parameters, defaults.steps[0]!.parameters);
    assert.ok(disabled.warnings.some((w) => w.includes('auto_size=false')));
    assert.throws(() => generationPlan(name, inputs, { model: 'tripo-v3.1', param: { auto_size: true } }));
  }
  const converted = processingPlan('convert', '@model', { param: { format: 'GLTF', auto_size: false } });
  assert.equal(converted.steps[0]!.parameters.auto_size, undefined);
  assert.ok(converted.warnings.some((w) => w.includes('auto_size=false')));
  assert.throws(() => processingPlan('convert', '@model', { param: { format: 'GLTF', auto_size: true } }));
});

async function completedModel(
  f: Awaited<ReturnType<typeof fixture>>,
  bytes: Buffer,
  request = 'compressed',
  operation: 'model' | 'local_edit' = 'model',
): Promise<Job> {
  freezeNativeOutputPolicy(f.jobs, 'test-account', request, true);
  const prepared = f.jobs.prepare(
    'test-account',
    request,
    operation,
    operation === 'model'
      ? normalize('model', { mode: 'text', prompt: 'triangle' })
      : normalize('local_edit', {
          project_id: 'project',
          source_operator_id: 'source',
          bbox: [
            [-0.5, -0.9, -0.5],
            [0.5, -0.2, 0.5],
          ],
          face_limit: 4000,
        }),
    quote,
  );
  const file = path.join(f.dir, `${request}.glb`);
  await writeFile(file, bytes);
  const artifact: Artifact = {
    artifact_id: 'model-0',
    kind: 'model',
    format: 'glb',
    index: 0,
    local_path: file,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  f.jobs.claim(prepared.job_id);
  f.jobs.update(prepared.job_id, 'submitted', {
    remote_ids: { operator_id: 'native-original', project_id: 'project' },
  });
  return f.jobs.update(prepared.job_id, 'succeeded', { artifacts: [artifact] });
}

test('no-download success verifies native bytes; persisted proof and failed requirements survive restart without POST', async () => {
  const f = await fixture();
  const good = await completedModel(f, (await compressedFixture()).bytes);
  const bad = await completedModel(f, tinyGlb(), 'uncompressed');
  let closed = false;
  try {
    assert.equal((await f.service.get(good.job_id)).state, 'succeeded');
    assert.equal(f.jobs.get(good.job_id).artifacts[0]!.native_validation?.geometry_compression, 'meshopt');
    const failure = await f.service.get(bad.job_id);
    assert.equal(failure.state, 'needs_attention');
    assert.equal(failure.remote_state, 'succeeded');
    assert.equal(f.jobs.get(bad.job_id).state, 'succeeded');
    assert.equal(executionExitCode(taskResult(failure)), 6);
    assert.equal(
      (f.service.list(10, 0).jobs as Record<string, unknown>[]).find((j) => j.job_id === bad.job_id)?.state,
      'needs_attention',
    );
    await rm(good.artifacts[0]!.local_path!);
    f.jobs.close();
    closed = true;
    const restarted = await fixture(f.dir);
    try {
      assert.equal((await restarted.service.get(good.job_id)).state, 'succeeded');
      const recovered = await restarted.service.submit('model', bad.request_id, bad.input, 10);
      assert.equal(recovered.state, 'needs_attention');
      assert.equal(restarted.gateway.posts, 0);
      assert.throws(() => freezeNativeOutputPolicy(restarted.jobs, 'test-account', bad.request_id, false), {
        code: 'IDEMPOTENCY_CONFLICT',
      });
    } finally {
      restarted.jobs.close();
    }
  } finally {
    if (!closed) f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('P2 local edit verifies native bytes, and failed output or changed receipt never regenerates on restart', async () => {
  const f = await fixture();
  const bytes = (await compressedFixture()).bytes;
  const good = await completedModel(f, bytes, 'edit-compressed', 'local_edit');
  const bad = await completedModel(f, tinyGlb(), 'edit-uncompressed', 'local_edit');
  let closed = false;
  try {
    assert.equal((await f.service.get(good.job_id)).state, 'succeeded');
    const verified = f.jobs.get(good.job_id);
    assert.equal(hasNativeOutputProof(verified), true);
    const artifact = verified.artifacts[0]!;
    const changedReceipt = { ...verified, remote_ids: { ...verified.remote_ids, operator_id: 'other' } };
    assert.equal(hasNativeOutputProof(changedReceipt), false);
    assert.throws(() => assertNativeOutputIdentity(changedReceipt, artifact), {
      code: 'NATIVE_OUTPUT_IDENTITY_CHANGED',
    });
    const changedFormat = { ...artifact, format: 'fbx' };
    assert.throws(() => assertNativeOutputIdentity(verified, changedFormat), {
      code: 'NATIVE_OUTPUT_IDENTITY_CHANGED',
    });
    const changedBytes = (await compressedFixture()).bytes;
    // 修改不影响压缩数据的 JSON 尾部空格，仍为合法 Meshopt，但不再是已验原字节。
    changedBytes[20 + changedBytes.readUInt32LE(12) - 1] = 9;
    await verifyNativeMeshopt(changedBytes);
    await assert.rejects(verifyNativeArtifactBytes(verified, artifact, changedBytes, 'glb'), {
      code: 'NATIVE_OUTPUT_CONTENT_CHANGED',
    });
    const failure = await f.service.get(bad.job_id);
    assert.equal(failure.state, 'needs_attention');
    assert.equal(failure.remote_state, 'succeeded');
    f.jobs.update(good.job_id, 'succeeded', { remote_ids: changedReceipt.remote_ids });
    const identityFailure = await f.service.get(good.job_id);
    assert.equal(identityFailure.state, 'needs_attention');
    assert.equal((identityFailure.error as { code: string }).code, 'NATIVE_OUTPUT_IDENTITY_CHANGED');
    assert.equal(f.gateway.posts, 0);
    f.jobs.close();
    closed = true;
    const restarted = await fixture(f.dir);
    try {
      assert.equal((await restarted.service.get(good.job_id)).state, 'needs_attention');
      const recovered = await restarted.service.submit('local_edit', bad.request_id, bad.input, 10);
      assert.equal(recovered.state, 'needs_attention');
      assert.equal(restarted.gateway.posts, 0);
      assert.throws(() => freezeNativeOutputPolicy(restarted.jobs, 'test-account', bad.request_id, false), {
        code: 'IDEMPOTENCY_CONFLICT',
      });
    } finally {
      restarted.jobs.close();
    }
  } finally {
    if (!closed) f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('native proof persistence rejects another receipt arriving during artifact verification', async () => {
  const f = await fixture();
  try {
    const job = await completedModel(f, (await compressedFixture()).bytes, 'edit-cas', 'local_edit');
    await f.service.get(job.job_id);
    const proof = f.jobs.get(job.job_id).artifacts[0]!.native_validation!;
    f.jobs.update(job.job_id, 'succeeded', { remote_ids: { ...job.remote_ids, operator_id: 'new-receipt' } });
    assert.throws(
      () =>
        f.jobs.saveNativeValidation(job.job_id, job.artifacts[0]!.artifact_id, proof, {
          account_ref: job.account_ref,
          operation: job.operation,
          remote_ids: job.remote_ids,
          format: job.artifacts[0]!.format,
          index: job.artifacts[0]!.index,
        }),
      { code: 'NATIVE_OUTPUT_IDENTITY_CHANGED' },
    );
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('native edit downloads restore only original verified cache and reject changed receipt or content', async () => {
  const f = await fixture();
  try {
    const bytes = (await compressedFixture()).bytes;
    const job = await completedModel(f, bytes, 'edit-download', 'local_edit');
    await f.service.get(job.job_id);
    const verified = f.jobs.get(job.job_id);
    const artifact = verified.artifacts[0]!;
    let reads = 0;
    f.gateway.artifactUrl = async () => {
      reads++;
      throw new TripoError('NETWORK_ERROR', 'Original URL unavailable.', 'read');
    };
    const recovered = await f.service.download(job.job_id, artifact.artifact_id, 'restored.glb');
    assert.equal(recovered.restored_from_cache, true);
    assert.deepEqual(await readFile(String(recovered.local_path)), bytes);
    assert.equal(reads, 1);
    f.jobs.update(job.job_id, 'succeeded', { remote_ids: { ...job.remote_ids, operator_id: 'other' } });
    await assert.rejects(f.service.download(job.job_id, artifact.artifact_id, 'wrong-identity.glb'), {
      code: 'NATIVE_OUTPUT_IDENTITY_CHANGED',
    });
    assert.equal(reads, 1);
    await assert.rejects(access(path.join(f.dir, 'output', 'wrong-identity.glb')));
    const modified = (await compressedFixture()).bytes;
    modified[20 + modified.readUInt32LE(12) - 1] = 9;
    await assert.rejects(
      download(
        'https://cdn.tripo3d.ai/replaced.glb',
        f.dir,
        'changed.glb',
        'glb',
        async () => new Response(new Uint8Array(modified)),
        false,
        { validateBytes: (data, format) => verifyNativeArtifactBytes(verified, artifact, data, format) },
      ),
      { code: 'NATIVE_OUTPUT_CONTENT_CHANGED' },
    );
    await assert.rejects(access(path.join(f.dir, 'changed.glb')));
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('concurrent native readers cannot replace the first proof with another compressed artifact', async () => {
  const f = await fixture();
  try {
    const job = await completedModel(f, (await compressedFixture()).bytes, 'edit-proof-race', 'local_edit');
    await f.service.get(job.job_id);
    const artifact = f.jobs.get(job.job_id).artifacts[0]!;
    const first = artifact.native_validation!;
    const expected = {
      account_ref: job.account_ref,
      operation: job.operation,
      remote_ids: job.remote_ids,
      format: artifact.format,
      index: artifact.index,
    };
    assert.throws(
      () =>
        f.jobs.saveNativeValidation(
          job.job_id,
          artifact.artifact_id,
          {
            ...first,
            sha256: 'a'.repeat(64),
            checked_at: new Date(Date.now() + 1000).toISOString(),
          },
          expected,
        ),
      { code: 'NATIVE_OUTPUT_CONTENT_CHANGED' },
    );
    f.jobs.saveNativeValidation(
      job.job_id,
      artifact.artifact_id,
      {
        ...first,
        checked_at: new Date(Date.now() + 2000).toISOString(),
      },
      expected,
    );
    assert.deepEqual(f.jobs.get(job.job_id).artifacts[0]!.native_validation, first);
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('native download rejects receipt changes during URL read and at the final save transaction', async () => {
  for (const phase of ['url', 'save']) {
    const f = await fixture();
    try {
      const job = await completedModel(
        f,
        (await compressedFixture()).bytes,
        'edit-download-race',
        'local_edit',
      );
      await f.service.get(job.job_id);
      const original = f.jobs.get(job.job_id).artifacts[0]!;
      const change = (): void => {
        f.jobs.update(job.job_id, 'succeeded', {
          remote_ids: { ...job.remote_ids, operator_id: `changed-at-${phase}` },
        });
      };
      f.gateway.artifactUrl = async () => {
        if (phase === 'url') change();
        throw new TripoError('NETWORK_ERROR', 'Original URL unavailable.', 'read');
      };
      if (phase === 'save') {
        const save = f.jobs.saveArtifact.bind(f.jobs);
        f.jobs.saveArtifact = (id, artifact, expected) => {
          change();
          return save(id, artifact, expected);
        };
      }
      await assert.rejects(f.service.download(job.job_id, original.artifact_id, 'race.glb'), {
        code: 'NATIVE_OUTPUT_IDENTITY_CHANGED',
      });
      assert.deepEqual(f.jobs.get(job.job_id).artifacts[0], original);
      if (phase === 'url') await assert.rejects(access(path.join(f.dir, 'output', 'race.glb')));
      assert.equal(f.gateway.posts, 0);
    } finally {
      f.jobs.close();
      await rm(f.dir, { recursive: true, force: true });
    }
  }
});

test('no-wait original tasks are validated on read, and changing compression never creates another submission', async () => {
  const f = await fixture();
  const plan = generationPlan('text-to-model', ['triangle'], {
    model: 'tripo-v3.1',
    param: { texture: false, compress: 'geometry' },
  });
  const bytes = (await compressedFixture()).bytes;
  const file = path.join(f.dir, 'native.glb');
  await writeFile(file, bytes);
  f.gateway.status = async () => ({
    state: 'succeeded',
    progress: 100,
    artifacts: [
      {
        artifact_id: 'model-0',
        kind: 'model',
        format: 'glb',
        index: 0,
        local_path: file,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    ],
  });
  const app = { service: f.service } as Application;
  try {
    const pending = await executePlan(app, plan, { requestId: 'no-wait', wait: false, download: false });
    assert.equal(pending.status, 'queued');
    assert.equal(f.gateway.posts, 1);
    assert.equal((await f.service.get(String(pending.task_id))).state, 'succeeded');
    const recovered = await executePlan(app, plan, { requestId: 'no-wait', wait: false, download: false });
    assert.equal(recovered.status, 'success');
    assert.equal(f.gateway.posts, 1);
    const changed = generationPlan('text-to-model', ['triangle'], {
      model: 'tripo-v3.1',
      param: { texture: false },
    });
    await assert.rejects(executePlan(app, changed, { requestId: 'no-wait', wait: false, download: false }), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    assert.equal(f.gateway.posts, 1);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('download validation rejects uncompressed bytes before publishing a destination', async () => {
  const f = await fixture();
  const check = async (bytes: Buffer, format: string): Promise<void> => {
    await verifyNativeMeshopt(bytes, format);
  };
  try {
    await assert.rejects(
      download(
        'https://cdn.tripo3d.ai/meshopt.glb',
        f.dir,
        'bad.glb',
        'glb',
        async () => new Response(new Uint8Array(tinyGlb())),
        false,
        { validateBytes: check },
      ),
      { code: 'NATIVE_OUTPUT_REQUIREMENT_FAILED' },
    );
    await assert.rejects(access(path.join(f.dir, 'bad.glb')));
    const bytes = (await compressedFixture()).bytes;
    const saved = await download(
      'https://cdn.tripo3d.ai/model.glb',
      f.dir,
      'good.glb',
      'glb',
      async () => new Response(new Uint8Array(bytes)),
      false,
      { validateBytes: check },
    );
    assert.deepEqual(await readFile(saved.local_path), bytes);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
