/** 新材料只在原GLB逐面证明内扩展；原生、FBX、纹理与切线不明确的边界分别保留。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { array, object } from '../studio/contracts/errors.ts';
import { readFrontendDocument, validateFrontendGlb } from '../cli/artifacts/studio-assimp-normalize.ts';
import { frontendMaterialExtensions } from '../cli/artifacts/studio-assimp-material.ts';
import { verifyStudioFrontend } from '../cli/artifacts/studio-assimp-proof.ts';
import { materialSnapshot } from '../cli/artifacts/material-snapshot.ts';
import { uvFixtureChunks, uvFixtureGlb, uvImportFixture } from './uv-import-fixture.ts';

const metadata = { forward_axis: '-x', pivot_to_center_bottom: false } as const,
  emissive = 'KHR_materials_emissive_strength',
  anisotropy = 'KHR_materials_anisotropy';
const material = (json: Record<string, unknown>) => object(array(json.materials)[0]);
function edit(bytes: Buffer, mutate: (json: Record<string, unknown>) => void): Buffer {
  const { json, binary } = uvFixtureChunks(bytes);
  mutate(json);
  return uvFixtureGlb(json, binary);
}
async function fixture(extensions: Record<string, unknown>): Promise<Buffer> {
  return edit(await uvImportFixture(false), (json) => {
    material(json).extensions = extensions;
    material(json).emissiveFactor = [0.1, 0.2, 0.4];
    json.extensionsUsed = Object.keys(extensions);
    json.extensionsRequired = Object.keys(extensions);
  });
}

test('emissive strength retains its exact factor independently of emissive color', async () => {
  for (const strength of [0, 0.1, 1, 2, 5]) {
    const source = await fixture({ [emissive]: { emissiveStrength: strength } });
    assert.equal((await verifyStudioFrontend(source, source, metadata)).faces, 2);
    for (const change of [
      (json: Record<string, unknown>) =>
        (object(object(material(json).extensions)[emissive]).emissiveStrength = strength + 0.1),
      (json: Record<string, unknown>) => (material(json).emissiveFactor = [0.1, 0.3, 0.4]),
    ])
      await assert.rejects(verifyStudioFrontend(source, edit(source, change), metadata), {
        code: 'FRONTEND_EXPORT_UNVERIFIED',
      });
  }
});

test('anisotropy strength and signed rotation are bound to each oriented UV surface', async () => {
  for (const strength of [0.1, 0.7, 1])
    for (const rotation of [-0.4, 0, 0.4, Math.PI]) {
      const source = await fixture({
        [anisotropy]: { anisotropyStrength: strength, anisotropyRotation: rotation },
      });
      assert.equal((await verifyStudioFrontend(source, source, metadata)).faces, 2);
      for (const [name, value] of [
        ['anisotropyStrength', strength === 1 ? 0.9 : strength + 0.1],
        ['anisotropyRotation', rotation + 0.1],
      ] as const)
        await assert.rejects(
          verifyStudioFrontend(
            source,
            edit(source, (json) => {
              object(object(material(json).extensions)[anisotropy])[name] = value;
            }),
            metadata,
          ),
          { code: 'FRONTEND_EXPORT_UNVERIFIED' },
        );
    }
});

test('only explicit new-family defaults may be omitted, while zero emissive and nonzero anisotropy remain required', async () => {
  const source = await fixture({
      [emissive]: { emissiveStrength: 1 },
      [anisotropy]: { anisotropyStrength: 0, anisotropyRotation: 0.4 },
    }),
    absent = edit(source, (json) => delete material(json).extensions);
  assert.equal((await verifyStudioFrontend(source, absent, metadata)).faces, 2);
  const loaded = (await readFrontendDocument(source)).getRoot().listMaterials()[0]!;
  assert.deepEqual(frontendMaterialExtensions(loaded), [
    { name: anisotropy, strength: 0, rotation: 0.4 },
    { name: emissive, strength: 1 },
  ]);
  assert.deepEqual(frontendMaterialExtensions(loaded, { emissiveStrength: true, anisotropy: true }), []);
  for (const extensions of [
    { [emissive]: { emissiveStrength: 0 } },
    { [emissive]: { emissiveStrength: 2 } },
    { [anisotropy]: { anisotropyStrength: 0.7, anisotropyRotation: 0.4 } },
  ]) {
    const original = await fixture(extensions);
    await assert.rejects(
      verifyStudioFrontend(
        original,
        edit(original, (json) => delete material(json).extensions),
        metadata,
      ),
      { code: 'FRONTEND_EXPORT_UNVERIFIED' },
    );
  }
});

test('new extension raw schemas reject missing declaration, malformed fields and extension images', async () => {
  for (const extensions of [
    { [emissive]: { emissiveStrength: -0.1 } },
    { [emissive]: { emissiveStrength: null } },
    { [emissive]: { emissiveStrength: '2' } },
    { [emissive]: { emissiveTexture: { index: 0 } } },
    { [emissive]: { unknown: true } },
    { [anisotropy]: { anisotropyStrength: 1.1 } },
    { [anisotropy]: { anisotropyStrength: -0.1 } },
    { [anisotropy]: { anisotropyRotation: null } },
    { [anisotropy]: { anisotropyRotation: '0.4' } },
    { [anisotropy]: { anisotropyTexture: { index: 0 } } },
    { [anisotropy]: { unknown: true } },
  ])
    await assert.rejects(readFrontendDocument(await fixture(extensions)), {
      code: 'FRONTEND_EXPORT_UNVERIFIED',
    });
  const source = await fixture({ [emissive]: { emissiveStrength: 2 } });
  await assert.rejects(readFrontendDocument(edit(source, (json) => delete json.extensionsUsed)), {
    code: 'FRONTEND_EXPORT_UNVERIFIED',
  });
});

test('anisotropy requires complete normals and nondegenerate UVs without extending explicit tangent support', async () => {
  const source = await fixture({ [anisotropy]: { anisotropyStrength: 0.7, anisotropyRotation: 0.4 } });
  for (const key of ['NORMAL', 'TEXCOORD_0']) {
    const incomplete = edit(source, (json) => {
      const primitive = object(array(object(array(json.meshes)[0]).primitives)[0]);
      delete object(primitive.attributes)[key];
    });
    await assert.rejects(verifyStudioFrontend(incomplete, incomplete, metadata), {
      code: 'FRONTEND_EXPORT_UNVERIFIED',
    });
  }
  const { json, binary } = uvFixtureChunks(source),
    view = object(array(json.bufferViews)[2]),
    changed = Buffer.from(binary);
  changed.fill(0, Number(view.byteOffset), Number(view.byteOffset) + Number(view.byteLength));
  const degenerate = uvFixtureGlb(json, changed);
  await assert.rejects(verifyStudioFrontend(degenerate, degenerate, metadata), {
    code: 'FRONTEND_EXPORT_UNVERIFIED',
  });
  const tangent = edit(source, (json) => {
    const primitive = object(array(object(array(json.meshes)[0]).primitives)[0]);
    object(primitive.attributes).TANGENT = 1;
  });
  await assert.rejects(verifyStudioFrontend(tangent, tangent, metadata), {
    code: 'FRONTEND_EXPORT_UNVERIFIED',
  });
});

test('GLB emissive and anisotropy support does not expand native or FBX material admission', async () => {
  for (const extensions of [
    { [emissive]: { emissiveStrength: 2 } },
    { [anisotropy]: { anisotropyStrength: 0.7, anisotropyRotation: 0.4 } },
  ]) {
    const source = await fixture(extensions);
    await assert.rejects(materialSnapshot(source), { code: 'UNBAKED_MATERIAL_UNSUPPORTED' });
    assert.throws(() => validateFrontendGlb(source, true, 'static-fbx-output'), {
      code: 'FRONTEND_EXPORT_UNVERIFIED',
    });
  }
  for (const extensions of [
    { KHR_materials_volume: { thicknessFactor: 0.4 } },
    { KHR_materials_iridescence: { iridescenceFactor: 0.4 } },
  ])
    await assert.rejects(readFrontendDocument(await fixture(extensions)), {
      code: 'FRONTEND_EXPORT_UNVERIFIED',
    });
});
