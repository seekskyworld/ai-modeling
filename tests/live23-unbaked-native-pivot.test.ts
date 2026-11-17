/** 显式原生底部中心与默认/false分别冻结；新匹配保留角属性，旧快照逐字兼容。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { materialSnapshot, sameMaterialSnapshot } from '../cli/artifacts/material-snapshot.ts';
import { sameOrientedMaterialSurfaces } from '../cli/artifacts/material-surface-match.ts';
import { freezeUnbakedSource } from '../cli/artifacts/unbaked-material.ts';
import { readUnbakedSource, unbakedSourceKey } from '../cli/core/unbaked-material-policy.ts';
import { processingPlan } from '../cli/compat/planning.ts';
import { nativeUnbakedPivot, needsExportTransform } from '../studio/contracts/export-options.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import { Operations } from '../studio/api/operations.ts';
import type { StudioClient } from '../studio/api/client.ts';
import { object, array, TripoError } from '../studio/contracts/errors.ts';
import type { Artifact, Job } from '../studio/contracts/types.ts';
import { fixture, quote } from './helpers.ts';
import { uvFixtureChunks, uvFixtureGlb, uvImportFixture } from './uv-import-fixture.ts';

const unlit = { KHR_materials_unlit: {} };
const clearcoat = { KHR_materials_clearcoat: { clearcoatFactor: 0.75, clearcoatRoughnessFactor: 0.3 } };
function edit(bytes: Buffer, update: (json: Record<string, unknown>) => void): Buffer {
  const { json, binary } = uvFixtureChunks(bytes);
  update(json);
  return uvFixtureGlb(json, binary);
}
async function pair(extensions?: Record<string, unknown>) {
  const source = edit(await uvImportFixture(false), (json) => {
    if (extensions) {
      object(array(json.materials)[0]).extensions = extensions;
      json.extensionsUsed = Object.keys(extensions);
    }
  });
  const output = edit(source, (json) => {
    const node = object(array(json.nodes)[0]);
    delete node.translation;
    node.matrix = [0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, -1, 1];
  });
  return { source, output };
}
const intent = (pivot?: boolean) =>
  normalize('export', {
    project_id: 'project',
    expected_operator_id: 'source',
    bake: false,
    ...(pivot === undefined ? {} : { pivot_to_center_bottom: pivot }),
  });

test('ordinary basic PBR snapshot fingerprints remain identical to the pre-change format', async () => {
  const source = await uvImportFixture(false);
  const ordinary = await materialSnapshot(source),
    oriented = await materialSnapshot(source, {}, true);
  assert.equal(ordinary.signature, 'cb4027f8a12ca492f19871d7299168924305b51e9fe3c4190fa5a040d314e840');
  assert.equal(oriented.signature, '68e7d75816a34724b2eafd2d16033179b19b98cfc4275d6e8af9e9e36a08b9f2');
  assert.equal(
    ordinary.material_signature,
    '0dc8b1dd87fdf6d2f029628b8750a00d5e1f0ba6d077e993234a2cf692c92e50',
  );
  assert.equal(ordinary.source_projection, undefined);
  assert.equal(ordinary.surface_encoding, undefined);
});

test('explicit native pivot uses only source bounds and never accepts that placement for false or omitted', async () => {
  for (const extensions of [undefined, unlit, clearcoat]) {
    const { source, output } = await pair(extensions);
    const expected = await materialSnapshot(source, {}, true, true),
      actual = await materialSnapshot(output, {}, false, false, true);
    assert.deepEqual(expected.source_projection, {
      forward_axis: '-y',
      pivot_to_center_bottom: true,
      pivot: [3, 3, 4],
    });
    assert.equal(sameMaterialSnapshot(expected, actual), true);
    assert.equal(sameMaterialSnapshot(await materialSnapshot(source, {}, true), actual), false);
    const changed = edit(output, (json) => {
      const node = object(array(json.nodes)[0]),
        matrix = node.matrix as number[];
      matrix[13] = 0.01;
    });
    assert.equal(
      sameMaterialSnapshot(expected, await materialSnapshot(changed, {}, false, false, true)),
      false,
    );
  }
});

test('oriented correspondence keeps cyclic corner attributes together and refuses flips or ambiguous faces', () => {
  const a: [string, number[], string[]] = [
    'material-and-attributes',
    [0, 0, 0, 1, 0, 0, 0, 1, 0],
    ['a', 'b', 'c'],
  ];
  const cycle: typeof a = [a[0], [1 + 1e-7, 0, 0, 0, 1, 0, 0, 0, 0], ['b', 'c', 'a']];
  assert.equal(sameOrientedMaterialSurfaces([a], [cycle]), true);
  assert.equal(sameOrientedMaterialSurfaces([a], [[a[0], cycle[1], a[2]]]), false);
  assert.equal(
    sameOrientedMaterialSurfaces([a], [[a[0], [0, 0, 0, 0, 1, 0, 1, 0, 0], ['a', 'c', 'b']]]),
    false,
  );
  assert.equal(sameOrientedMaterialSurfaces([a, a], [cycle, cycle]), false);
  const plain: typeof a = [a[0], a[1], ['same', 'same', 'same']];
  assert.equal(sameOrientedMaterialSurfaces([plain], [[plain[0], cycle[1], plain[2]]]), true);
  assert.equal(
    sameOrientedMaterialSurfaces([plain], [[plain[0], [0, 0, 0, 1.0001, 0, 0, 0, 1, 0], plain[2]]]),
    false,
  );
});

test('only the explicit static native combination avoids local conversion and ordinary true still requests it', () => {
  const plan = processingPlan('convert', '@source', {
    param: { bake: false, format: 'GLTF', pivot_to_center_bottom: true, with_animation: false },
  });
  assert.equal(plan.steps.length, 1);
  const parameters = plan.steps[0]!.parameters;
  assert.equal(parameters.pivot_to_center_bottom, true);
  assert.equal(parameters.bake, false);
  assert.equal(plan.steps[0]!.operation, 'export');
  assert.equal(needsExportTransform(parameters), false);
  assert.equal(nativeUnbakedPivot(parameters), true);
  for (const pivot of [undefined, false]) {
    const raw = intent(pivot);
    assert.equal(nativeUnbakedPivot(raw), false);
    assert.equal(raw.pivot_to_center_bottom, pivot);
  }
  assert.equal(needsExportTransform({ pivot_to_center_bottom: true }), true);
  for (const param of [
    { format: 'FBX' },
    { texture_format: 'PNG' },
    { scale_factor: 2 },
    { flatten_bottom: true },
    { pack_uv: true },
    { export_orientation: '+x' },
  ])
    assert.throws(() =>
      processingPlan('convert', '@source', {
        param: { bake: false, format: 'GLTF', pivot_to_center_bottom: true, ...param },
      }),
    );
});

test('native pivot intent keeps the observed export request and never invents upstream bake or pivot fields', async () => {
  const client = {
    request: async () => ({
      id: 'project',
      is_owner: true,
      operator: { operator_id: 'source', status: 'success' },
    }),
  } as unknown as StudioClient;
  const request = await new Operations(client, []).build({ operation: 'export', input: intent(true) } as Job);
  assert.equal(request.route, '/v2/studio/operation/export');
  assert.equal(request.body.format, 'gltf');
  assert.equal(request.body.export_orientation, '-y');
  assert.equal(request.body.with_animation, false);
  assert.equal(request.body.bake, undefined);
  assert.equal(request.body.pivot_to_center_bottom, undefined);
});

test('static native material validation never inherits unverified frontend extensions, textures or skins', async () => {
  for (const extensions of [
    { KHR_materials_ior: { ior: 1.8 } },
    { KHR_materials_transmission: { transmissionFactor: 0.6 } },
    { KHR_materials_sheen: { sheenRoughnessFactor: 0.4 } },
    { KHR_materials_clearcoat: { clearcoatTexture: { index: 0 } } },
    { KHR_materials_unlit: { unknown: true } },
  ]) {
    await assert.rejects(materialSnapshot((await pair(extensions)).source), {
      code: 'UNBAKED_MATERIAL_UNSUPPORTED',
    });
  }
  const { source } = await pair(unlit);
  await assert.rejects(
    materialSnapshot(
      edit(source, (json) => {
        json.skins = [{ joints: [0] }];
      }),
    ),
    { code: 'UNBAKED_MATERIAL_UNSUPPORTED' },
  );
  await assert.rejects(
    materialSnapshot(
      edit(source, (json) => {
        delete object(array(json.materials)[0]).extensions;
        object(array(json.nodes)[0]).extensions = unlit;
      }),
    ),
    { code: 'UNBAKED_MATERIAL_UNSUPPORTED' },
  );
});

test('explicit source projection and native material proof survive restart and refuse changed intent without resubmission', async () => {
  const f = await fixture();
  let closed = false;
  try {
    const { source, output } = await pair(clearcoat),
      raw = intent(true),
      job = f.jobs.prepare('test-account', 'explicit-native-pivot', 'export', raw, quote);
    const gateway = Object.assign(f.gateway, {
      materialSource: async () => ({ url: 'https://cdn.tripo3d.ai/source.glb', material_factors: {} }),
    });
    await freezeUnbakedSource(job, f.jobs, f.dir, gateway, async () => source);
    assert.deepEqual(readUnbakedSource(f.jobs, job).snapshot.source_projection!.pivot, [3, 3, 4]);
    const file = path.join(f.dir, 'native.glb');
    await writeFile(file, output);
    const artifact: Artifact = {
      artifact_id: 'model',
      kind: 'model',
      format: 'glb',
      index: 0,
      local_path: file,
      sha256: createHash('sha256').update(output).digest('hex'),
      bytes: output.length,
    };
    f.jobs.claim(job.job_id);
    f.jobs.update(job.job_id, 'submitted', {
      remote_ids: { project_id: 'project', operator_id: 'original-native-export' },
    });
    f.jobs.update(job.job_id, 'succeeded', { artifacts: [artifact] });
    assert.equal((await f.service.get(job.job_id)).state, 'succeeded');
    f.jobs.close();
    closed = true;
    const reopened = await fixture(f.dir);
    try {
      assert.equal((await reopened.service.get(job.job_id)).state, 'succeeded');
      reopened.gateway.artifactUrl = async () => {
        throw new TripoError('NETWORK_ERROR', 'controlled expired URL');
      };
      const downloaded = await reopened.service.download(job.job_id, 'model', 'restored.glb');
      assert.equal(downloaded.restored_from_cache, true);
      assert.deepEqual(await readFile(String(downloaded.local_path)), output);
      await assert.rejects(reopened.service.submit('export', job.request_id, intent(false), 0), {
        code: 'IDEMPOTENCY_CONFLICT',
      });
      assert.equal(reopened.gateway.posts, 0);
      const load = reopened.jobs.requestPolicy.bind(reopened.jobs);
      reopened.jobs.requestPolicy = (account, key) => {
        const result = load(account, key);
        if (key === unbakedSourceKey(job) && result) {
          const altered = structuredClone(result);
          delete object(altered.snapshot).source_projection;
          return altered;
        }
        return result;
      };
      assert.throws(() => readUnbakedSource(reopened.jobs, reopened.jobs.get(job.job_id)), {
        code: 'UNBAKED_SOURCE_UNVERIFIED',
      });
      assert.equal((await reopened.service.get(job.job_id)).state, 'needs_attention');
      assert.equal(reopened.gateway.posts, 0);
    } finally {
      reopened.jobs.close();
    }
  } finally {
    if (!closed) f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
