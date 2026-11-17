/** 多primitive链必须保原BIN、逐面材质/法线、来源身份及原始组；JSON拆分不是本地几何压缩。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fixture, quote } from './helpers.ts';
import { uvImportFixture, uvFixtureChunks as parse, uvFixtureGlb as glb } from './uv-import-fixture.ts';
import { splitUvImportSource } from '../cli/artifacts/uv-import-layout.ts';
import { verifyUvImport, inspectUvCompressionInput } from '../cli/artifacts/uv-import-proof.ts';
import { prepareUvImport } from '../cli/compat/uv-import.ts';
import { uvImportPolicyKey, assertUvImportIntent } from '../cli/core/uv-import-policy.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import { processingPlan } from '../cli/compat/planning.ts';
import { executePlan, type Application } from '../cli/compat/runtime.ts';
import type { StudioClient } from '../studio/api/client.ts';
import type { Job } from '../studio/contracts/types.ts';

const hash = (value: Buffer): string => createHash('sha256').update(value).digest('hex');
async function grouped(compressed: boolean): Promise<Buffer> {
  const source = parse(await uvImportFixture(compressed)),
    json = source.json,
    meshes = json.meshes as Array<{ name: string; primitives: Record<string, unknown>[] }>,
    materials = json.materials as unknown[];
  materials.push({
    pbrMetallicRoughness: { baseColorFactor: [0.2, 0.4, 0.7, 1], metallicFactor: 0, roughnessFactor: 0.9 },
  });
  meshes[0]!.primitives.push({ ...meshes[0]!.primitives[0]!, material: 1 });
  return glb(json, source.binary);
}
async function native(): Promise<Buffer> {
  return (await splitUvImportSource(await grouped(true))).bytes;
}

test('multi-primitive preparation changes only JSON and restores original mesh groups from native compressed bytes', async () => {
  const source = await grouped(false),
    a = parse(source),
    prepared = await splitUvImportSource(source),
    b = parse(prepared.bytes),
    imported = await native(),
    result = await verifyUvImport(source, imported),
    delivered = parse(result.bytes);
  assert.equal((await inspectUvCompressionInput(source, { discardTextures: false })).triangles, 4);
  assert.equal((b.json.nodes as unknown[]).length, 2);
  assert.ok(a.binary.equals(b.binary));
  assert.deepEqual(b.json.accessors, a.json.accessors);
  assert.deepEqual(b.json.materials, a.json.materials);
  assert.deepEqual(
    (b.json.meshes as Array<{ primitives: unknown[] }>).flatMap((mesh) => mesh.primitives),
    (a.json.meshes as Array<{ primitives: unknown[] }>)[0]!.primitives,
  );
  assert.equal(result.proof.restored_primitive_groups, true);
  assert.equal(result.proof.independent_meshes, 1);
  assert.equal(result.proof.matched_faces, 4);
  assert.ok(delivered.binary.equals(parse(imported).binary));
  assert.equal((delivered.json.nodes as unknown[]).length, 1);
  const mesh = (delivered.json.meshes as Array<{ name: string; primitives: unknown[] }>)[0]!;
  assert.equal(mesh.name, 'original-uv-mesh');
  assert.equal(mesh.primitives.length, 2);
  assert.equal((delivered.json.nodes as Array<{ name: string }>)[0]!.name, 'original-uv-node');
  assert.equal(result.proof.maximum_position_error, 0);
  assert.equal(result.proof.maximum_normal_error, 0);
});

test('primitive regrouping rejects different native coordinate bases even inside position tolerance', async () => {
  const original = await grouped(false),
    changed = parse(await native());
  (changed.json.nodes as Record<string, unknown>[])[1]!.translation = [1e-8, 0, 0];
  await assert.rejects(verifyUvImport(original, glb(changed.json, changed.binary)), {
    code: 'UV_COMPRESSION_REQUIREMENT_FAILED',
    message: /different coordinate bases/,
  });
});

test('primitive input budget applies before paid work and duplicate matching never chooses arbitrary original groups', async () => {
  const parsed = parse(await grouped(false)),
    meshes = parsed.json.meshes as Array<{ primitives: Record<string, unknown>[] }>;
  meshes[0]!.primitives = Array.from({ length: 65 }, () => meshes[0]!.primitives[0]!);
  await assert.rejects(
    inspectUvCompressionInput(glb(parsed.json, parsed.binary), { discardTextures: false }),
    {
      code: 'UV_COMPRESSION_UNSUPPORTED',
      message: /at most 64 triangle primitives/,
    },
  );
  const ambiguous = parse(await grouped(false)),
    output = parse(await native());
  (ambiguous.json.meshes as Array<{ primitives: Record<string, unknown>[] }>)[0]!.primitives[1]!.material = 0;
  for (const mesh of output.json.meshes as Array<{ primitives: Record<string, unknown>[] }>)
    mesh.primitives[0]!.material = 0;
  await assert.rejects(
    verifyUvImport(glb(ambiguous.json, ambiguous.binary), glb(output.json, output.binary)),
    {
      code: 'UV_COMPRESSION_REQUIREMENT_FAILED',
      message: /ambiguous/,
    },
  );
});

async function sourceFor(f: Awaited<ReturnType<typeof fixture>>): Promise<Job> {
  const bytes = await grouped(false),
    file = path.join(f.dir, 'multi.glb');
  await writeFile(file, bytes);
  const job = f.jobs.prepare(
    'test-account',
    'multi-source',
    'uv_commit',
    normalize('uv_commit', {
      project_id: 'source',
      current_operator_id: 'base',
      candidate_operator_id: 'candidate',
    }),
    quote,
  );
  return f.jobs.update(job.job_id, 'succeeded', {
    remote_ids: { project_id: 'source', operator_id: 'committed' },
    artifacts: [
      {
        artifact_id: 'model',
        kind: 'model',
        format: 'glb',
        index: 0,
        local_path: file,
        sha256: hash(bytes),
        bytes: bytes.length,
      },
    ],
  });
}

test('split input and original source have separate frozen hashes; retry retains bytes and tampering fails before upload', async () => {
  const f = await fixture();
  try {
    const source = await sourceFor(f),
      context = { jobs: f.jobs, gateway: f.gateway, dataDir: f.dir, account: 'test-account' },
      parameters = normalize('import_model', {
        model_path: 'upstream',
        name: 'split',
        use_original_uv: true,
      }),
      input = await prepareUvImport(context, 'split', parameters, source),
      policy = f.jobs.requestPolicy('test-account', uvImportPolicyKey('split'))!;
    assert.notEqual(policy.import_sha256, policy.source_sha256);
    assert.equal(hash(await readFile(String(input.model_path))), policy.import_sha256);
    assertUvImportIntent(f.jobs, 'test-account', 'split', 'import_model', {
      ...input,
      _input_files: { [String(input.model_path)]: policy.import_sha256 },
    });
    assert.throws(
      () =>
        assertUvImportIntent(f.jobs, 'test-account', 'split', 'import_model', {
          ...input,
          _input_files: { [String(input.model_path)]: policy.source_sha256 },
        }),
      { code: 'INPUT_CHANGED' },
    );
    await rm(source.artifacts[0]!.local_path!);
    f.gateway.artifactUrl = async () => {
      throw Error('Original private source cache required');
    };
    assert.deepEqual(await prepareUvImport(context, 'split', parameters, source), input);
    await writeFile(String(input.model_path), await native());
    await assert.rejects(f.service.submit('import_model', 'split', input, 10), { code: 'INPUT_CHANGED' });
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('complete no-download UV chain uploads split groups and recovers original grouped delivery without new submissions', async () => {
  const f = await fixture();
  try {
    const source = await sourceFor(f),
      imported = await native(),
      nativePath = path.join(f.dir, 'native.glb');
    await writeFile(nativePath, imported);
    f.gateway.submit = async (job) => {
      f.gateway.posts++;
      if (job.operation === 'import_model')
        assert.equal((parse(await readFile(String(job.input.model_path))).json.nodes as unknown[]).length, 2);
      return {
        remote_ids: {
          project_id: job.operation === 'import_model' ? 'imported' : 'source',
          operator_id: job.operation,
        },
        status: {
          state: 'succeeded',
          artifacts:
            job.operation === 'uv_generate'
              ? []
              : job.operation === 'uv_commit'
                ? source.artifacts
                : [
                    {
                      artifact_id: 'model',
                      kind: 'model',
                      format: 'glb',
                      index: 0,
                      local_path: nativePath,
                      sha256: hash(imported),
                      bytes: imported.length,
                    },
                  ],
        },
      };
    };
    const client = {
        request: async () => {
          throw Error('No network read required');
        },
      } as unknown as StudioClient,
      app = { service: f.service, studio: { client } } as Application,
      plan = processingPlan('uv', source.job_id, { param: { bake: false, compress: 'geometry' } }),
      flags = { requestId: 'full-multi-uv', wait: true, download: false };
    const result = await executePlan(app, plan, flags);
    assert.equal(result.status, 'success');
    const validation = result.uv_compression_validation as Record<string, unknown>;
    assert.equal(validation.status, 'verified');
    assert.equal(
      validation.local_processing,
      'json_primitive_split_and_verified_regrouping_with_root_transform_and_names',
    );
    const saved = await f.service.download(String(result.task_id), 'model', 'grouped.glb'),
      output = parse(await readFile(String(saved.local_path)));
    assert.equal((output.json.meshes as Array<{ primitives: unknown[] }>)[0]!.primitives.length, 2);
    assert.ok(output.binary.equals(parse(imported).binary));
    f.gateway.artifactUrl = async () => {
      throw Error('Recovery stays offline');
    };
    const again = await executePlan(app, plan, flags);
    assert.equal(again.task_id, result.task_id);
    assert.equal(f.gateway.posts, 3);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
