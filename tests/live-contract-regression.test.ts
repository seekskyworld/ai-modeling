/** 真实账号发现的传输/回读差异：生成后的系统图和自包含 glTF 必须继续可处理。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NodeIO, Document } from '@gltf-transform/core';
import { canvasSaveSchema } from '../studio/api/canvas.ts';
import { canvasInputIssues } from '../studio/api/canvas-graph.ts';
import { modelUpload } from '../studio/model-upload.ts';

test('server graph null parameters, zero layout size and system result edges round-trip', () => {
  const graph = canvasSaveSchema.parse({
    canvasId: 'canvas',
    clientId: 'client',
    revision: '1',
    nodes: [
      {
        id: 'split',
        type: 'NODE_TYPE_IMAGE_SPLIT',
        params: null,
        ui: { position: { x: 0, y: 0 }, size: { width: 0, height: 0 } },
      },
      { id: 'asset', type: 'NODE_TYPE_ASSET', params: null },
    ],
    edges: [{ id: 'system', source: { nodeId: 'split', port: '' }, target: { nodeId: 'asset', port: '' } }],
  });
  assert.equal(graph.nodes.length, 2);
  assert.throws(() =>
    canvasSaveSchema.parse({
      ...graph,
      edges: [{ id: 'bad', source: { nodeId: 'asset', port: '' }, target: { nodeId: 'split', port: '' } }],
    }),
  );
  assert.deepEqual(
    canvasInputIssues(
      [
        {
          id: 'model',
          type: 'NODE_TYPE_UPLOAD_CARD',
          params: { assetType: 'model' },
          inputMount: [{ url: 'https://cdn.tripo3d.ai/model.glb' }],
        },
        { id: 'texture', type: 'NODE_TYPE_TEXTURE', params: { prompt_text: 'red metal' } },
      ],
      [
        {
          id: 'input',
          source: { nodeId: 'model', port: 'image' },
          target: { nodeId: 'texture', port: 'model' },
        },
      ],
      ['texture'],
    ),
    [],
  );
});

test('text glTF converts to an uploadable GLB while preserving mesh coordinates', async () => {
  const doc = new Document(),
    buffer = doc.createBuffer();
  const position = doc
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setBuffer(buffer);
  const mesh = doc.createMesh().addPrimitive(doc.createPrimitive().setAttribute('POSITION', position));
  doc.createScene().addChild(doc.createNode('triangle').setMesh(mesh));
  const io = new NodeIO();
  const json = await io.writeJSON(doc);
  for (const b of json.json.buffers ?? [])
    b.uri = 'data:application/octet-stream;base64,' + Buffer.from(json.resources[b.uri!]!).toString('base64');
  const converted = await modelUpload(Buffer.from(JSON.stringify(json.json)), 'gltf');
  assert.equal(converted.format, 'glb');
  const result = await io.readBinary(converted.bytes);
  assert.deepEqual([...result.getRoot().listAccessors()[0]!.getArray()!], [...position.getArray()!]);
  json.json.buffers![0]!.uri = '/private/local.bin';
  await assert.rejects(modelUpload(Buffer.from(JSON.stringify(json.json)), 'gltf'), {
    code: 'INVALID_ARTIFACT',
  });
});
