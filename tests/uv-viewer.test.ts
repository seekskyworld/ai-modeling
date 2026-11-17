/** 独立几何夹具验证 UV 坐标原点、重叠岛、覆盖率、拾取和不覆盖产物；不依赖网页缓存结果。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Document } from '@gltf-transform/core';
import { writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { fixture } from './helpers.ts';
import { modelIO, loadGLB } from '../cli/local/gltf.ts';
import { uvOperations } from '../cli/local/uv.ts';
import { uvGeometry } from '../cli/local/uv-geometry.ts';

test('UV viewer preserves GLB origin and distinct overlapping islands without generating or changing source', async () => {
  const f = await fixture();
  try {
    const document = new Document(),
      buffer = document.createBuffer(),
      scene = document.createScene();
    for (let z = 0; z < 2; z++) {
      const positions = document
        .createAccessor()
        .setType('VEC3')
        .setArray(new Float32Array([0, 0, z, 1, 0, z, 0, 1, z]))
        .setBuffer(buffer);
      const uv = document
        .createAccessor()
        .setType('VEC2')
        .setArray(new Float32Array([0, 0, 1, 0, 0, 1]))
        .setBuffer(buffer);
      const indices = document
        .createAccessor()
        .setType('SCALAR')
        .setArray(new Uint16Array([0, 1, 2]))
        .setBuffer(buffer);
      scene.addChild(
        document
          .createNode('part' + z)
          .setMesh(
            document
              .createMesh()
              .addPrimitive(
                document
                  .createPrimitive()
                  .setAttribute('POSITION', positions)
                  .setAttribute('TEXCOORD_0', uv)
                  .setIndices(indices),
              ),
          ),
      );
    }
    const file = path.join(f.dir, 'uv.glb'),
      original = Buffer.from(await (await modelIO()).writeBinary(document));
    await writeFile(file, original);
    const inspect = uvOperations.find((op) => op.name === 'uv_inspect')!,
      layout = uvOperations.find((op) => op.name === 'uv_layout')!;
    const result = (await inspect.run(f.service.config, { model_path: file, pick: { u: 0.1, v: 0.9 } })) as {
      islands: unknown[];
      utilization: number;
      picked: { island: number } | null;
    };
    assert.equal(result.islands.length, 2); // UV重叠，不同3D位置不能误合并。
    assert.ok(Math.abs(result.utilization - 0.5) < 0.001);
    assert.equal(result.picked?.island, 0);
    const ray = (await inspect.run(f.service.config, {
      model_path: file,
      ray: { origin: [0.1, 0.1, 3], direction: [0, 0, -2] },
    })) as { picked: { island: number } };
    assert.equal(ray.picked.island, 1); // 最近面在 z=1，不能以面顺序选 z=0。
    await assert.rejects(
      inspect.run(f.service.config, {
        model_path: file,
        ray: { origin: [0, 0, 3], direction: [0, 0, 0] },
      }),
      { code: 'INVALID_INPUT' },
    );
    const previewFile = path.join(f.dir, 'output', 'highlight.glb');
    await uvOperations
      .find((op) => op.name === 'uv_preview')!
      .run(f.service.config, {
        model_path: file,
        destination_path: previewFile,
        island_id: 1,
      });
    const preview = await loadGLB(previewFile, []);
    assert.equal(
      preview.document
        .getRoot()
        .listNodes()
        .find((n) => n.getName() === 'part1')!
        .getMesh()!
        .listPrimitives()[0]!
        .getMaterial()!
        .getName(),
      'uv-selected-island',
    );
    assert.deepEqual((await uvGeometry(previewFile, [])).positions, (await uvGeometry(file, [])).positions);
    const target = path.join(f.dir, 'output', 'layout.png');
    await layout.run(f.service.config, { model_path: file, destination_path: target });
    const { data, info } = await sharp(target).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 1024);
    assert.equal(data[(100 * 1024 + 100) * 3], 242); // GLB左上角仍在PNG左上角，不被垂直镜像。
    assert.equal(data[(900 * 1024 + 900) * 3], 2);
    await assert.rejects(layout.run(f.service.config, { model_path: file, destination_path: target }), {
      code: 'OUTPUT_EXISTS',
    });
    await assert.rejects(
      layout.run(f.service.config, {
        model_path: file,
        destination_path: path.join(f.dir, 'output', 'bad.png'),
        highlight_island: 9,
      }),
      { code: 'INVALID_INPUT' },
    );
    await assert.rejects(uvGeometry(file, [], ['missing']), { code: 'INVALID_PART' });
    assert.deepEqual(await readFile(file), original);
    assert.equal(f.gateway.posts, 0);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('UV preview skips untextured primitives, ignores unused vertices and evaluates stored morph/skin pose', async () => {
  const f = await fixture();
  try {
    const doc = new Document(),
      buffer = doc.createBuffer(),
      scene = doc.createScene();
    const accessor = (type: 'VEC2' | 'VEC3' | 'VEC4' | 'SCALAR', values: number[]) =>
      doc.createAccessor().setBuffer(buffer).setType(type).setArray(new Float32Array(values));
    const positions = accessor('VEC3', [0, 0, 0, 1, 0, 0, 0, 1, 0, 99, 99, 99]);
    const primitive = doc
      .createPrimitive()
      .setAttribute('POSITION', positions)
      .setIndices(
        doc
          .createAccessor()
          .setBuffer(buffer)
          .setType('SCALAR')
          .setArray(new Uint16Array([0, 1, 2])),
      );
    const mesh = doc.createMesh().addPrimitive(primitive.clone());
    primitive
      .setAttribute('TEXCOORD_0', accessor('VEC2', [0, 0, 1, 0, 0, 1, 99, 99]))
      .addTarget(
        doc
          .createPrimitiveTarget()
          .setAttribute('POSITION', accessor('VEC3', [0, 0, 2, 0, 0, 2, 0, 0, 2, 0, 0, 0])),
      )
      .setAttribute(
        'JOINTS_0',
        doc.createAccessor().setBuffer(buffer).setType('VEC4').setArray(new Uint16Array(16)),
      )
      .setAttribute('WEIGHTS_0', accessor('VEC4', [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]));
    mesh.addPrimitive(primitive).setWeights([0.5]);
    const joint = doc.createNode('joint').setTranslation([2, 0, 0]);
    scene
      .addChild(joint)
      .addChild(doc.createNode('mixed').setMesh(mesh).setSkin(doc.createSkin().addJoint(joint)));
    const file = path.join(f.dir, 'mixed.glb');
    await writeFile(file, await (await modelIO()).writeBinary(doc));
    const geometry = await uvGeometry(file, []);
    assert.deepEqual(geometry.positions, [2, 0, 1, 3, 0, 1, 2, 1, 1]);
    assert.equal(geometry.meshes[0]!.vertices, 3);
    assert.deepEqual(geometry.skipped_meshes, [{ name: 'mixed', primitive_index: 0, reason: 'UV_MISSING' }]);
    const target = path.join(f.dir, 'output', 'mixed-preview.glb');
    await uvOperations
      .find((op) => op.name === 'uv_preview')!
      .run(f.service.config, {
        model_path: file,
        destination_path: target,
        island_id: 0,
      });
    const saved = await loadGLB(target, []),
      savedMesh = saved.document
        .getRoot()
        .listNodes()
        .find((n) => n.getName() === 'mixed')!
        .getMesh()!;
    assert.equal(savedMesh.listPrimitives()[0]!.getMaterial()!.getName(), 'uv-preview');
    assert.equal(savedMesh.listPrimitives()[1]!.getMaterial()!.getName(), 'uv-selected-island');
    assert.deepEqual((await uvGeometry(target, [])).positions, geometry.positions);
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
