/** metadata 导出验真实几何、资源和版本边界，避免用彩色预览或最新版本替换原模型。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Document } from '@gltf-transform/core';
import { modelIO } from '../cli/local/gltf.ts';
import { applyModelMetadata } from '../cli/local/model-metadata.ts';
import { prepareExportEdits } from '../cli/compat/export-edits.ts';
import { Operations } from '../studio/api/operations.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import type { StudioClient } from '../studio/api/client.ts';
import type { Job } from '../studio/contracts/types.ts';

async function source(): Promise<Buffer> {
  const d = new Document(),
    buffer = d.createBuffer();
  const position = d
    .createAccessor()
    .setType('VEC3')
    .setBuffer(buffer)
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  const material = d.createMaterial('original').setBaseColorFactor([0.1, 0.2, 0.8, 1]);
  const mesh = d
    .createMesh('original-mesh')
    .addPrimitive(d.createPrimitive().setAttribute('POSITION', position).setMaterial(material));
  d.createScene()
    .addChild(d.createNode('parent').setTranslation([10, 0, 0]).addChild(d.createNode('part').setMesh(mesh)))
    .addChild(d.createNode('hidden').setMesh(mesh));
  return Buffer.from(await (await modelIO()).writeBinary(d));
}
const delta = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0.3, 0.1, 0, 1];
test('frontend metadata keeps local geometry and original materials while applying named edits', async () => {
  const bytes = await source(),
    io = await modelIO();
  const output = await io.readBinary(
    await applyModelMetadata(bytes, 'glb', {
      children_deleted: ['hidden'],
      children_rename: { part: 'renamed' },
      children_transform_matrix: { part: delta },
      material_factor: { metallic: 0.8, roughness: 0.2 },
    }),
  );
  const node = output
    .getRoot()
    .listNodes()
    .find((n) => n.getName() === 'renamed')!;
  assert.ok(Math.abs(node.getWorldTranslation()[0] - 10.3) < 1e-5);
  assert.deepEqual(node.getScale(), [2, 2, 2]);
  const primitive = node.getMesh()!.listPrimitives()[0]!;
  assert.deepEqual(Array.from(primitive.getAttribute('POSITION')!.getArray()!), [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  assert.deepEqual(primitive.getMaterial()!.getBaseColorFactor(), [0.1, 0.2, 0.8, 1]);
  assert.equal(primitive.getMaterial()!.getMetallicFactor(), 0.8);
  const visible: string[] = [];
  output
    .getRoot()
    .listScenes()[0]!
    .traverse((n) => {
      if (n.getMesh()) visible.push(n.getName());
    });
  assert.deepEqual(visible, ['renamed']);
  assert.ok(
    (await io.readBinary(bytes))
      .getRoot()
      .listNodes()
      .some((n) => n.getName() === 'part'),
  );
  await assert.rejects(applyModelMetadata(bytes, 'glb', { children_deleted: ['parent', 'hidden'] }), {
    code: 'EMPTY_MODEL',
  });
});

test('native export copy inherits exact historical metadata, validates current target and keeps scale-only support', async () => {
  const bytes = await source(),
    paths: string[] = [];
  let current = 'target-op';
  const client = {
    credentials: { load: () => ({ accountRef: 'test' }) },
    forAccount: () => client,
    request: async (_method: string, path: string) => {
      paths.push(path);
      if (path.includes('source')) {
        assert.ok(path.endsWith('?operator_id=old-op'));
        return {
          id: 'source',
          is_owner: true,
          operator: {
            operator_id: 'old-op',
            metadata: { children_rename: { part: 'alias' }, children_transform_matrix: { part: delta } },
          },
        };
      }
      return {
        id: 'target',
        is_owner: true,
        model_url: 'https://cdn.tripo3d.ai/source.glb',
        operator: {
          operator_id: current,
          status: 'success',
          model_url: 'https://cdn.tripo3d.ai/source.glb',
          metadata: {},
        },
      };
    },
  } as unknown as StudioClient;
  const prepared = await prepareExportEdits(
    client,
    { project_id: 'target', expected_operator_id: 'target-op' },
    { part_names: ['alias'], scale_factor: 2 },
    { project_id: 'source', operator_id: 'old-op' },
    async () => new Response(new Uint8Array(bytes)),
  );
  assert.deepEqual(prepared.children_deleted, ['hidden']);
  assert.deepEqual(prepared.children_rename, { part: 'alias' });
  assert.deepEqual(prepared.expected_metadata, {
    children_deleted: [],
    children_transform_matrix: {},
    children_rename: {},
    material_factor: {},
  });
  const result = prepared.children_transform_matrix as Record<string, number[]>;
  assert.equal(result.part![0], 4);
  assert.ok(Math.abs(result.part![12]! - 0.6) < 1e-6);
  assert.ok(paths.includes('/v2/studio/project/detail/v3/target'));
  current = 'other';
  await assert.rejects(
    prepareExportEdits(client, { project_id: 'target', expected_operator_id: 'target-op' }, {}),
    { code: 'PROJECT_CHANGED' },
  );
  const exporter = new Operations(
    {
      request: async () => ({
        is_owner: true,
        operator: { status: 'success', metadata: { children_transform_matrix: { part: delta } } },
      }),
    } as unknown as StudioClient,
    [],
  );
  await assert.rejects(
    exporter.build({ operation: 'export', input: normalize('export', { project_id: 'p' }) } as Job),
    { code: 'NATIVE_EXPORT_TRANSLATION' },
  );
});
