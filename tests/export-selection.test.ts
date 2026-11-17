/** 导出过滤必须保留层级/蒙皮；无效格式在网页提交前拒绝，不能接受参数后输出整模。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Document, NodeIO } from '@gltf-transform/core';
import { selectExportParts } from '../cli/local/export-parts.ts';
import { normalize } from '../studio/contracts/schemas.ts';
import { fullToolPlan } from '../cli/compat/full-tools.ts';
import { Operations } from '../studio/api/operations.ts';
import type { StudioClient } from '../studio/api/client.ts';
import type { Job } from '../studio/contracts/types.ts';

async function model(): Promise<Buffer> {
  const doc = new Document(),
    buffer = doc.createBuffer();
  const positions = doc
    .createAccessor()
    .setType('VEC3')
    .setBuffer(buffer)
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  const joint = doc.createNode('joint'),
    skin = doc.createSkin('skin').addJoint(joint);
  const mesh = (name: string) =>
    doc.createMesh(name).addPrimitive(doc.createPrimitive().setAttribute('POSITION', positions));
  const parent = doc.createNode('body').setTranslation([10, 20, 30]).setMesh(mesh('body-mesh'));
  parent.addChild(doc.createNode('head').setMesh(mesh('head-mesh')).setSkin(skin));
  doc.createScene().addChild(parent).addChild(joint);
  return Buffer.from(await new NodeIO().writeBinary(doc));
}

test('part selection retains selected child transforms and skin while removing parent mesh', async () => {
  const source = await model();
  const io = new NodeIO(),
    result = await io.readBinary(await selectExportParts(source, 'glb', ['head']));
  const nodes = result.getRoot().listNodes(),
    head = nodes.find((n) => n.getName() === 'head')!;
  assert.equal(result.getRoot().listMeshes().length, 1);
  assert.equal(nodes.find((n) => n.getName() === 'body')!.getMesh(), null);
  assert.deepEqual(head.getWorldTranslation(), [10, 20, 30]);
  assert.equal(head.getSkin()!.listJoints()[0]!.getName(), 'joint');
  assert.equal((await io.readBinary(source)).getRoot().listMeshes().length, 2);
  assert.equal(
    (await io.readBinary(await selectExportParts(source, 'glb', ['body-mesh'])))
      .getRoot()
      .listMeshes()[0]!
      .getName(),
    'body-mesh',
  );
});

test('unknown requested parts fail rather than silently exporting all or a partial selection', async () => {
  await assert.rejects(selectExportParts(await model(), 'glb', ['head', 'missing']), {
    code: 'INVALID_PART',
  });
  assert.throws(() => normalize('export', { project_id: 'p', part_names: [] }));
});

test('official texture and part options route through GLB without sending unsupported webpage fields', async () => {
  const plan = fullToolPlan('ai_modeling_convert', {
    input: '@last',
    format: 'OBJ',
    texture_format: 'TIFF',
    part_names: ['head'],
  });
  assert.deepEqual(
    plan.steps.map((step) => step.operation),
    ['copy', 'project_edit', 'export'],
  );
  assert.deepEqual(plan.steps[1]!.exportEdits?.part_names, ['head']);
  const input = plan.steps.at(-1)!.parameters;
  assert.equal(input.texture_format, 'TIFF');
  assert.equal(input.part_names, undefined);
  const client = {
    request: async () => ({ is_owner: true, operator: { operator_id: 'op', status: 'success' } }),
  } as unknown as StudioClient;
  const request = await new Operations(client, []).build({ operation: 'export', input } as Job);
  assert.equal(request.body.format, 'gltf');
  assert.equal(request.body.texture_format, undefined);
  assert.equal(request.body.part_names, undefined);
  for (const format of ['BMP', 'DPX', 'HDR', 'JPEG', 'OPEN_EXR', 'PNG', 'TARGA', 'TIFF', 'WEBP'])
    assert.equal(
      normalize('export', { project_id: 'p', format: 'obj', texture_format: format }).texture_format,
      format,
    );
  for (const format of ['stl', '3mf'])
    assert.throws(() => normalize('export', { project_id: 'p', format, texture_format: 'PNG' }));
  assert.throws(() => normalize('export', { project_id: 'p', format: 'glb', texture_format: 'OPEN_EXR' }));
  assert.throws(() => normalize('export', { project_id: 'p', format: 'usdz', texture_format: 'WEBP' }));
});
