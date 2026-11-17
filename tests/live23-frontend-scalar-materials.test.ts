/** 标量材质扩大准入后仍逐面保身份；未理解的原始键不能由loader丢弃后“相等”。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mat4 } from 'gl-matrix';
import { array, object } from '../studio/contracts/errors.ts';
import { readFrontendDocument } from '../cli/artifacts/studio-assimp-normalize.ts';
import { verifyStudioFrontend } from '../cli/artifacts/studio-assimp-proof.ts';
import { uvFixtureChunks, uvFixtureGlb, uvImportFixture } from './uv-import-fixture.ts';

const metadata = { forward_axis: '-y', pivot_to_center_bottom: true } as const;
const unlit = { KHR_materials_unlit: {} };
const clearcoat = { KHR_materials_clearcoat: { clearcoatFactor: 0.75, clearcoatRoughnessFactor: 0.3 } };
const ior = { KHR_materials_ior: { ior: 1.8 } };
const transmission = { KHR_materials_transmission: { transmissionFactor: 0.6 } };
const sheen = { KHR_materials_sheen: { sheenColorFactor: [0.6, 0.2, 0.1], sheenRoughnessFactor: 0.4 } };
const supported = [unlit, clearcoat, ior, transmission, sheen];
function edit(bytes: Buffer, mutate: (json: Record<string, unknown>) => void): Buffer {
  const { json, binary } = uvFixtureChunks(bytes);
  mutate(json);
  return uvFixtureGlb(json, binary);
}
const firstMaterial = (json: Record<string, unknown>): Record<string, unknown> =>
  object(array(json.materials)[0]);
async function fixture(extensions: Record<string, unknown>) {
  const source = edit(await uvImportFixture(false), (json) => {
    delete object(array(json.nodes)[0]).translation;
    firstMaterial(json).extensions = extensions;
    json.extensionsUsed = Object.keys(extensions);
    json.extensionsRequired = Object.keys(extensions);
  });
  const transform = mat4.create();
  mat4.rotateY(transform, transform, -Math.PI / 2);
  mat4.translate(transform, transform, [-1, 0, 0]);
  const target = edit(source, (json) => {
    object(array(json.nodes)[0]).matrix = Array.from(transform);
  });
  return { source, target };
}

test('verified scalar extensions preserve material assignment and exact transformed surfaces', async () => {
  for (const extensions of [...supported, Object.assign({}, ...supported)]) {
    const { source, target } = await fixture(extensions);
    const proof = await verifyStudioFrontend(source, target, metadata);
    assert.equal(proof.faces, 2);
    assert.equal(proof.source_nodes_preserved, 1);
    const material = (await readFrontendDocument(target)).getRoot().listMaterials()[0]!;
    assert.deepEqual(
      material
        .listExtensions()
        .map((value) => value.extensionName)
        .sort(),
      Object.keys(extensions).sort(),
    );
  }
});

test('missing or changed scalar material effects fail even when geometry and base PBR remain identical', async () => {
  for (const extensions of supported) {
    const { source, target } = await fixture(extensions);
    await assert.rejects(
      verifyStudioFrontend(
        source,
        edit(target, (json) => delete firstMaterial(json).extensions),
        metadata,
      ),
      { code: 'FRONTEND_EXPORT_UNVERIFIED' },
    );
  }
  const { source, target } = await fixture(clearcoat);
  for (const changed of [0, 0.5, 0.75001, 1])
    await assert.rejects(
      verifyStudioFrontend(
        source,
        edit(target, (json) => {
          object(object(firstMaterial(json).extensions).KHR_materials_clearcoat).clearcoatFactor = changed;
        }),
        metadata,
      ),
      { code: 'FRONTEND_EXPORT_UNVERIFIED' },
    );
});

test('clearcoat omitted scalar defaults and explicit zeros have the same verified effect', async () => {
  const { source, target } = await fixture({ KHR_materials_clearcoat: {} });
  const explicit = edit(target, (json) => {
    firstMaterial(json).extensions = {
      KHR_materials_clearcoat: { clearcoatFactor: 0, clearcoatRoughnessFactor: 0 },
    };
  });
  assert.equal((await verifyStudioFrontend(source, explicit, metadata)).faces, 2);
});

test('IOR, transmission and sheen defaults retain their exact schema meanings', async () => {
  for (const [name, values] of [
    ['KHR_materials_ior', { ior: 1.5 }],
    ['KHR_materials_transmission', { transmissionFactor: 0 }],
    ['KHR_materials_sheen', { sheenColorFactor: [0, 0, 0], sheenRoughnessFactor: 0 }],
  ] as const) {
    const { source, target } = await fixture({ [name]: {} });
    const explicit = edit(target, (json) => {
      firstMaterial(json).extensions = { [name]: values };
    });
    assert.equal((await verifyStudioFrontend(source, explicit, metadata)).faces, 2);
  }
  for (const value of [0, 1, 1.5, 2.4]) {
    const { source, target } = await fixture({ KHR_materials_ior: { ior: value } });
    assert.equal((await verifyStudioFrontend(source, target, metadata)).faces, 2);
  }
});

test('a changed IOR, transmission factor, sheen color component or roughness invalidates preservation', async () => {
  for (const [extensions, name, field, value] of [
    [ior, 'KHR_materials_ior', 'ior', 1.5],
    [transmission, 'KHR_materials_transmission', 'transmissionFactor', 0.5],
    [sheen, 'KHR_materials_sheen', 'sheenColorFactor', [0.6, 0.2, 0.10001]],
    [sheen, 'KHR_materials_sheen', 'sheenRoughnessFactor', 0.3],
  ] as const) {
    const { source, target } = await fixture(extensions);
    await assert.rejects(
      verifyStudioFrontend(
        source,
        edit(target, (json) => {
          object(object(firstMaterial(json).extensions)[name])[field] = value;
        }),
        metadata,
      ),
      { code: 'FRONTEND_EXPORT_UNVERIFIED' },
    );
  }
});

test('material extension assignments cannot be swapped between distinct oriented surfaces', async () => {
  const { source, target } = await fixture(ior);
  const split = (json: Record<string, unknown>) => {
    const accessors = array(json.accessors),
      index = object(accessors[3]);
    index.count = 3;
    accessors.push({ ...index, byteOffset: 6 });
    const primitives = array(object(array(json.meshes)[0]).primitives);
    primitives.push({ ...object(primitives[0]), indices: 4, material: 1 });
    array(json.materials).push({ ...firstMaterial(json), extensions: transmission });
    json.extensionsUsed = ['KHR_materials_ior', 'KHR_materials_transmission'];
    json.extensionsRequired = json.extensionsUsed;
  };
  const splitSource = edit(source, split),
    splitTarget = edit(target, split);
  assert.equal((await verifyStudioFrontend(splitSource, splitTarget, metadata)).faces, 2);
  await assert.rejects(
    verifyStudioFrontend(
      splitSource,
      edit(splitTarget, (json) => {
        const primitives = array(object(array(json.meshes)[0]).primitives);
        object(primitives[0]).material = 1;
        object(primitives[1]).material = 0;
      }),
      metadata,
    ),
    { code: 'FRONTEND_EXPORT_UNVERIFIED' },
  );
});

test('raw extension texture references and unknown fields are refused before loader normalization', async () => {
  const extras = [
    { KHR_materials_unlit: { ignored: true } },
    { KHR_materials_clearcoat: { clearcoatTexture: { index: 0 } } },
    { KHR_materials_clearcoat: { clearcoatRoughnessTexture: { index: 0 } } },
    { KHR_materials_clearcoat: { clearcoatNormalTexture: { index: 0 } } },
    { KHR_materials_clearcoat: { unknown: 0 } },
    { KHR_materials_ior: { ior: 1.8, unknown: 1 } },
    { KHR_materials_transmission: { transmissionTexture: { index: 0 } } },
    { KHR_materials_sheen: { sheenColorTexture: { index: 0 } } },
    { KHR_materials_sheen: { sheenRoughnessTexture: { index: 0 } } },
    { KHR_materials_volume: { thicknessFactor: 0.6 } },
    Object.fromEntries([['__proto__', {}]]),
  ];
  for (const extensions of extras) {
    const { source } = await fixture(extensions);
    await assert.rejects(readFrontendDocument(source), { code: 'FRONTEND_EXPORT_UNVERIFIED' });
  }
});

test('non-object or out-of-domain scalar material values are never accepted as defaults', async () => {
  for (const value of [null, [], 1, 'clearcoat']) {
    const { source } = await fixture({ KHR_materials_clearcoat: value });
    await assert.rejects(readFrontendDocument(source), { code: 'FRONTEND_EXPORT_UNVERIFIED' });
  }
  for (const value of [-0.001, 1.001, null, '0.3', [0.3], { value: 0.3 }]) {
    const { source } = await fixture({ KHR_materials_clearcoat: { clearcoatFactor: value } });
    await assert.rejects(readFrontendDocument(source), { code: 'FRONTEND_EXPORT_UNVERIFIED' });
  }
  for (const value of [-1, 0.5, 0.999999, null, '1.8', [1.8], {}]) {
    const { source } = await fixture({ KHR_materials_ior: { ior: value } });
    await assert.rejects(readFrontendDocument(source), { code: 'FRONTEND_EXPORT_UNVERIFIED' });
  }
  for (const value of [null, [0, 0], [0, 0, 0, 0], [-0.01, 0, 0], [0, 1.01, 0], [0, null, 0]]) {
    const { source } = await fixture({ KHR_materials_sheen: { sheenColorFactor: value } });
    await assert.rejects(readFrontendDocument(source), { code: 'FRONTEND_EXPORT_UNVERIFIED' });
  }
});

test('material extensions require declarations and cannot be attached to unrelated glTF objects', async () => {
  const { source } = await fixture(unlit);
  await assert.rejects(readFrontendDocument(edit(source, (json) => delete json.extensionsUsed)), {
    code: 'FRONTEND_EXPORT_UNVERIFIED',
  });
  for (const key of ['asset', 'node', 'mesh', 'primitive']) {
    const wrong = edit(source, (json) => {
      delete firstMaterial(json).extensions;
      const mesh = object(array(json.meshes)[0]);
      const target =
        key === 'asset'
          ? object(json.asset)
          : key === 'node'
            ? object(array(json.nodes)[0])
            : key === 'mesh'
              ? mesh
              : object(array(mesh.primitives)[0]);
      target.extensions = unlit;
    });
    await assert.rejects(readFrontendDocument(wrong), { code: 'FRONTEND_EXPORT_UNVERIFIED' });
  }
});
