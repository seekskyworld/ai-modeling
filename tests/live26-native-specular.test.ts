/** 原生bake=false镜面材料验证绑定实际有向表面，不继承前端引擎的所有材料能力。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mat4 } from 'gl-matrix';
import { array, object } from '../studio/contracts/errors.ts';
import { materialSnapshot, sameMaterialSnapshot } from '../cli/artifacts/material-snapshot.ts';
import { uvFixtureChunks, uvFixtureGlb, uvImportFixture } from './uv-import-fixture.ts';

const extension = 'KHR_materials_specular';
function edit(bytes: Buffer, change: (json: Record<string, unknown>) => void): Buffer {
  const { json, binary } = uvFixtureChunks(bytes);
  change(json);
  return uvFixtureGlb(json, binary);
}
const material = (json: Record<string, unknown>) => object(array(json.materials)[0]);
async function fixture(values: unknown): Promise<{ source: Buffer; output: Buffer }> {
  const source = edit(await uvImportFixture(false), (json) => {
    material(json).extensions = { [extension]: values };
    json.extensionsUsed = [extension];
    json.extensionsRequired = [extension];
  });
  const output = edit(source, (json) => {
    const node = object(array(json.nodes)[0]),
      matrix = mat4.fromYRotation(mat4.create(), -Math.PI / 2);
    mat4.translate(matrix, matrix, node.translation as number[]);
    node.matrix = Array.from(matrix);
    delete node.translation;
  });
  return { source, output };
}

test('native specular strength and color compare per oriented source surface', async () => {
  for (const factor of [0, 0.1, 0.4, 1]) {
    const { source, output } = await fixture({
      specularFactor: factor,
      specularColorFactor: [0.2, 0.4, 0.8],
    });
    const original = await materialSnapshot(source, {}, true),
      result = await materialSnapshot(output);
    assert.equal(sameMaterialSnapshot(original, result), true);
    assert.equal(result.triangles, 2);
    for (const [key, value] of [
      ['specularFactor', factor === 0 ? 0.5 : 0],
      ['specularColorFactor', [0.2, 0.4, 0.7]],
    ] as const) {
      const changed = edit(output, (json) => {
        object(object(material(json).extensions)[extension])[key] = value;
      });
      assert.equal(sameMaterialSnapshot(original, await materialSnapshot(changed)), false);
    }
  }
});

test('native explicit neutral specular omission is equivalent while zero-strength omission is not', async () => {
  for (const factor of [0, 0.4, 1]) {
    const { source, output } = await fixture({ specularFactor: factor }),
      original = await materialSnapshot(source, {}, true),
      missing = edit(output, (json) => {
        delete material(json).extensions;
        delete json.extensionsUsed;
        delete json.extensionsRequired;
      });
    const delivered = await materialSnapshot(missing, {}, false, false, true);
    assert.equal(sameMaterialSnapshot(original, delivered), factor === 1);
  }
});

test('native scalar/color specular does not allow extension textures, unknown properties or other material families', async () => {
  for (const values of [
    { specularTexture: { index: 0 } },
    { specularColorTexture: { index: 0 } },
    { specularFactor: -0.1 },
    { specularFactor: 1.1 },
    { specularColorFactor: [0.2, 0.4] },
    { specularColorFactor: [0.2, 0.4, 1.1] },
    { unknown: 1 },
  ])
    await assert.rejects(materialSnapshot((await fixture(values)).source), {
      code: 'UNBAKED_MATERIAL_UNSUPPORTED',
    });
  const { source } = await fixture({ specularFactor: 0.4 });
  for (const [name, values] of [
    ['KHR_materials_ior', { ior: 1.5 }],
    ['KHR_materials_transmission', { transmissionFactor: 0.3 }],
    ['KHR_materials_sheen', { sheenRoughnessFactor: 0.5 }],
  ] as const)
    await assert.rejects(
      materialSnapshot(
        edit(source, (json) => {
          material(json).extensions = { [name]: values };
          json.extensionsUsed = [name];
          json.extensionsRequired = [name];
        }),
      ),
      { code: 'UNBAKED_MATERIAL_UNSUPPORTED' },
    );
});
