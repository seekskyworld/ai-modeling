/** 镜面材质按原表面逐项保留；原引擎静默丢值不能被宽松默认值掩盖。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { array, object } from '../studio/contracts/errors.ts';
import { readFrontendDocument, validateFrontendGlb } from '../cli/artifacts/studio-assimp-normalize.ts';
import { verifyStudioFrontend } from '../cli/artifacts/studio-assimp-proof.ts';
import { frontendMaterialExtensions } from '../cli/artifacts/studio-assimp-material.ts';
import { uvFixtureChunks, uvFixtureGlb, uvImportFixture } from './uv-import-fixture.ts';

const metadata = { forward_axis: '-x', pivot_to_center_bottom: false } as const;
const extension = 'KHR_materials_specular';
const firstMaterial = (json: Record<string, unknown>) => object(array(json.materials)[0]);
function edit(bytes: Buffer, mutate: (json: Record<string, unknown>) => void): Buffer {
  const { json, binary } = uvFixtureChunks(bytes);
  mutate(json);
  return uvFixtureGlb(json, binary);
}
async function fixture(values: unknown, extra: Record<string, unknown> = {}): Promise<Buffer> {
  return edit(await uvImportFixture(false), (json) => {
    firstMaterial(json).extensions = { [extension]: values, ...extra };
    json.extensionsUsed = [extension, ...Object.keys(extra)];
    json.extensionsRequired = json.extensionsUsed;
  });
}

test('non-neutral specular strength/color and combined IOR retain their per-surface identity', async () => {
  for (const factor of [0, 0.1, 0.4, 0.75, 1]) {
    const source = await fixture(
      { specularFactor: factor, specularColorFactor: [0.2, 0.4, 0.8] },
      { KHR_materials_ior: { ior: 1.8 } },
    );
    assert.equal((await verifyStudioFrontend(source, source, metadata)).faces, 2);
    for (const [field, value] of [
      ['specularFactor', factor + 0.01],
      ['specularColorFactor', [0.2, 0.4, 0.7]],
    ] as const)
      await assert.rejects(
        verifyStudioFrontend(
          source,
          edit(source, (json) => {
            object(object(firstMaterial(json).extensions)[extension])[field] = value;
          }),
          metadata,
        ),
        { code: 'FRONTEND_EXPORT_UNVERIFIED' },
      );
  }
});

test('default specular/IOR extensions may be omitted, but lost non-neutral values remain rejected', async () => {
  const source = await fixture({});
  const explicit = edit(source, (json) => {
    firstMaterial(json).extensions = {
      [extension]: { specularFactor: 1, specularColorFactor: [1, 1, 1] },
    };
  });
  assert.equal((await verifyStudioFrontend(source, explicit, metadata)).faces, 2);
  const absent = edit(source, (json) => delete firstMaterial(json).extensions);
  assert.equal((await verifyStudioFrontend(source, absent, metadata)).faces, 2);
  assert.equal((await verifyStudioFrontend(explicit, absent, metadata)).faces, 2);
  const withDefaultIor = await fixture({}, { KHR_materials_ior: { ior: 1.5 } });
  assert.equal((await verifyStudioFrontend(withDefaultIor, absent, metadata)).faces, 2);
  for (const factor of [0, 0.1, 0.4]) {
    const original = await fixture({ specularFactor: factor });
    const dropped = edit(original, (json) => delete firstMaterial(json).extensions);
    await assert.rejects(verifyStudioFrontend(original, dropped, metadata), {
      code: 'FRONTEND_EXPORT_UNVERIFIED',
    });
  }
  const nonwhite = await fixture({ specularFactor: 1, specularColorFactor: [0.2, 0.4, 0.8] });
  await assert.rejects(verifyStudioFrontend(nonwhite, absent, metadata), {
    code: 'FRONTEND_EXPORT_UNVERIFIED',
  });
  const changedIor = await fixture({}, { KHR_materials_ior: { ior: 1.8 } });
  await assert.rejects(verifyStudioFrontend(changedIor, absent, metadata), {
    code: 'FRONTEND_EXPORT_UNVERIFIED',
  });
});

test('specular images, extra fields, malformed factors and colors fail before loader normalization', async () => {
  const invalid = [
    { specularTexture: { index: 0 } },
    { specularColorTexture: { index: 0 } },
    { unknown: 1 },
    { specularFactor: -0.01 },
    { specularFactor: 1.01 },
    { specularFactor: null },
    { specularFactor: '0.4' },
    { specularColorFactor: [0.2, 0.4] },
    { specularColorFactor: [0.2, 0.4, 0.8, 1] },
    { specularColorFactor: [0.2, null, 0.8] },
    { specularColorFactor: [-0.01, 0.4, 0.8] },
    { specularColorFactor: [0.2, 1.01, 0.8] },
    null,
    [],
    'specular',
  ];
  for (const value of invalid)
    await assert.rejects(readFrontendDocument(await fixture(value)), {
      code: 'FRONTEND_EXPORT_UNVERIFIED',
    });
});

test('specular declaration and attachment checks remain strict and FBX keeps its separate scalar range', async () => {
  const source = await fixture({ specularFactor: 0.4, specularColorFactor: [0.2, 0.4, 0.8] });
  await assert.rejects(readFrontendDocument(edit(source, (json) => delete json.extensionsUsed)), {
    code: 'FRONTEND_EXPORT_UNVERIFIED',
  });
  await assert.rejects(
    readFrontendDocument(
      edit(source, (json) => {
        object(array(json.nodes)[0]).extensions = firstMaterial(json).extensions;
        delete firstMaterial(json).extensions;
      }),
    ),
    { code: 'FRONTEND_EXPORT_UNVERIFIED' },
  );
  assert.throws(() => validateFrontendGlb(source, true, 'static-fbx-output'), {
    code: 'FRONTEND_EXPORT_UNVERIFIED',
  });
  const scalar = await fixture({ specularFactor: 0.4 });
  assert.doesNotThrow(() => validateFrontendGlb(scalar, true, 'static-fbx-output'));
});

test('shared extension signatures keep legacy defaults unless their comparator explicitly opts in', async () => {
  const source = await fixture({}, { KHR_materials_ior: { ior: 1.5 } }),
    material = (await readFrontendDocument(source)).getRoot().listMaterials()[0]!;
  assert.deepEqual(frontendMaterialExtensions(material), [
    { name: 'KHR_materials_ior', ior: 1.5 },
    { name: 'KHR_materials_specular', factor: 1, color: [1, 1, 1] },
  ]);
  assert.deepEqual(frontendMaterialExtensions(material, { specular: true }), [
    { name: 'KHR_materials_ior', ior: 1.5 },
  ]);
  assert.deepEqual(frontendMaterialExtensions(material, { ior: true }), [
    { name: 'KHR_materials_specular', factor: 1, color: [1, 1, 1] },
  ]);
  assert.deepEqual(frontendMaterialExtensions(material, { specular: true, ior: true }), []);
});
