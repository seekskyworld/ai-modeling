/** 最终证明覆盖真实尺度、面绕序和完整场景；原生属性重算不能被误当作几何失败。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Document } from '@gltf-transform/core';
import { modelIO } from '../cli/local/gltf.ts';
import {
  inspectSmartSegmentScaleReference,
  inspectSmartSegmentScaleSource,
  verifySmartSegmentScaleOutput,
} from '../cli/artifacts/smartsegment-scale-proof.ts';
import { checkedMetadataTransform } from '../cli/artifacts/smartsegment-transform-matrix.ts';

const matrix = [1.3, 0, 0, 0, 0, 0.7, 0, 0, 0, 0, 1.1, 0, 0, 0, 0, 1];
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const rejection = { code: 'SMARTSEGMENT_TRANSFORM_UNVERIFIED' };
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

function transformedFixturePoint(p: number[], variant: string): number[] {
  const [x, y, z] = p as [number, number, number];
  if (variant === 'compound') return [-0.7 * y + 0.2, 1.3 * x - 0.3, 1.1 * z + 0.4];
  if (variant === 'rx90') return [1.2 * x + 0.11, -0.8 * z - 0.17, 1.5 * y + 0.23];
  if (variant === 'ry90') return [0.9 * z - 0.2, 1.1 * y + 0.3, -1.4 * x - 0.1];
  if (variant === 'rz45')
    return [
      Math.SQRT1_2 * (1.2 * x - 0.8 * y) + 0.1,
      Math.SQRT1_2 * (1.2 * x + 0.8 * y) - 0.2,
      1.1 * z + 0.3,
    ];
  if (variant === 'proper180') return [-1.1 * x, -0.9 * y, 1.3 * z];
  if (variant === 'translation') return [x + 0.2, y - 0.3, z + 0.4];
  return p;
}

function modelIndices(changed: string): number[] {
  const indices = [0, 1, 2, 0, 3, 1, 1, 3, 2, 2, 3, 0];
  if (changed === 'winding') indices.splice(0, 3, 0, 2, 1);
  if (changed === 'duplicate') indices.splice(9, 3, 0, 1, 2);
  if (changed === 'added') indices.push(0, 1, 2);
  if (changed === 'omitted') indices.splice(9, 3);
  if (changed === 'degenerate') indices.splice(0, 3, 0, 1, 1);
  if (changed === 'bad-index') indices[0] = 99;
  return indices;
}

async function model(scale = [1, 1, 1], changed = '', output = false): Promise<Buffer> {
  const doc = new Document(),
    buffer = doc.createBuffer(),
    scene = doc.createScene('Scene');
  const points = [
    [-0.5, -0.4, -0.3],
    [0.5, -0.4, -0.3],
    [0, 0.4, -0.3],
    [0, 0, 0.3],
  ].map((p) =>
    transformedFixturePoint(
      p.map((v, i) => v * scale[i]!),
      changed,
    ),
  );
  if (changed === 'normalized') {
    const extent = Math.max(
      ...[0, 1, 2].map((i) => Math.max(...points.map((p) => p[i]!)) - Math.min(...points.map((p) => p[i]!))),
    );
    points.forEach((p) =>
      p.forEach((v, i) => {
        p[i] = v / extent;
      }),
    );
  }
  if (changed === 'nonfinite') points[0]![0] = NaN;
  const indices = modelIndices(changed);
  const groups = output ? [indices.slice(0, 6), indices.slice(6)] : [indices];
  const accessor = (type: 'VEC3' | 'VEC2', values: number[][]) =>
    doc.createAccessor().setType(type).setArray(new Float32Array(values.flat())).setBuffer(buffer);
  for (const [index, ids] of groups.entries()) {
    const offset = output ? [0.07 * (index + 1), -0.03, 0.04] : [0, 0, 0];
    const normals = points.map(() =>
      changed === 'zero-normal' ? [0, 0, 0] : output ? [0, 1, 0] : [0, 0, 1],
    );
    const uv = points.map((_, i) => (output ? [0.17 * i, 0.31 * i] : [0.25 * i, 0.2 * i]));
    if (changed === 'incomplete-uv') uv.pop();
    const primitive = doc
      .createPrimitive()
      .setAttribute(
        'POSITION',
        accessor(
          'VEC3',
          points.map((p) => p.map((v, i) => v - offset[i]!)),
        ),
      )
      .setAttribute('NORMAL', accessor('VEC3', normals))
      .setAttribute('TEXCOORD_0', accessor('VEC2', uv))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(ids)).setBuffer(buffer))
      .setMaterial(doc.createMaterial('surface').setMetallicFactor(0.2).setRoughnessFactor(0.6));
    if (changed === 'missing-normal') primitive.setAttribute('NORMAL', null);
    if (changed === 'morph')
      primitive.addTarget(doc.createPrimitiveTarget().setAttribute('POSITION', accessor('VEC3', points)));
    const node = doc
      .createNode(changed === 'empty-name' ? '  ' : `part_${index}`)
      .setTranslation(offset as [number, number, number])
      .setMesh(doc.createMesh(`mesh_${index}`).addPrimitive(primitive));
    scene.addChild(node);
    if (changed === 'skin') node.setSkin(doc.createSkin().addJoint(node));
    if (changed === 'hierarchy') {
      scene.removeChild(node);
      scene.addChild(doc.createNode('parent').addChild(node));
    }
  }
  return Buffer.from(await (await modelIO()).writeBinary(doc));
}

function replaceJson(bytes: Buffer, change: (json: Record<string, unknown>) => void): Buffer {
  const length = bytes.readUInt32LE(12),
    json = JSON.parse(bytes.toString('utf8', 20, 20 + length));
  change(json);
  const raw = Buffer.from(JSON.stringify(json)),
    padded = Buffer.alloc(Math.ceil(raw.length / 4) * 4, 0x20);
  raw.copy(padded);
  const rest = bytes.subarray(20 + length),
    result = Buffer.alloc(20 + padded.length + rest.length);
  bytes.copy(result, 0, 0, 20);
  result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(padded.length, 12);
  padded.copy(result, 20);
  rest.copy(result, 20 + padded.length);
  return result;
}

test('scale source exposes the exact metadata node and material factors', async () => {
  const source = await model(),
    proof = await inspectSmartSegmentScaleSource(source);
  assert.equal(proof.node_name, 'part_0');
  assert.equal(proof.sha256, hash(source));
  assert.deepEqual(proof.material_factors, { metallic: 0.2, roughness: 0.6 });
  for (const variant of ['empty-name', 'degenerate'])
    await assert.rejects(inspectSmartSegmentScaleSource(await model(undefined, variant)), rejection);
});

test('native split roots retain physical scale while normals and UV may be recomputed', async () => {
  const source = await model(),
    native = await model([1.3, 0.7, 1.1], '', true),
    original = Buffer.from(native);
  const proof = await verifySmartSegmentScaleOutput(source, matrix, native);
  assert.equal(proof.matched_oriented_faces, 4);
  assert.equal(proof.sha256, hash(native));
  assert.equal(proof.source_sha256, hash(source));
  assert.equal(proof.bytes, native.length);
  assert.ok(Number(proof.maximum_position_error) < 1e-7);
  assert.deepEqual(proof.tolerance, { position: 0.00004 * 1.3 });
  assert.equal((proof.parts as unknown[]).length, 2);
  assert.equal(proof.uses_geometry_fit, false);
  assert.equal(proof.native_result_modified, false);
  assert.deepEqual(native, original);
});

for (const variant of ['winding', 'duplicate', 'added', 'omitted', 'degenerate', 'bad-index', 'normalized'])
  test(`native ${variant} geometry cannot certify the requested scale`, async () => {
    await assert.rejects(
      verifySmartSegmentScaleOutput(await model(), matrix, await model([1.3, 0.7, 1.1], variant, true)),
      rejection,
    );
  });

test('untouched original coordinates cannot satisfy nonidentity physical scale', async () => {
  const source = await model();
  await assert.rejects(verifySmartSegmentScaleOutput(source, matrix, source), rejection);
});

test('coincident source triangles stay ambiguous even if a greedy pairing could consume each once', async () => {
  const duplicated = await model(undefined, 'duplicate');
  await assert.rejects(verifySmartSegmentScaleOutput(duplicated, identity, duplicated), rejection);
});

test('the requested matrix is frozen before asynchronous decoding', async () => {
  const source = await model(),
    native = await model([1.3, 0.7, 1.1], '', true),
    requested = [...matrix];
  const pending = verifySmartSegmentScaleOutput(source, requested, native);
  requested[0] = 99;
  assert.deepEqual((await pending).transform_matrix, matrix);
});

for (const variant of [
  'missing-normal',
  'incomplete-uv',
  'zero-normal',
  'nonfinite',
  'skin',
  'morph',
  'hierarchy',
])
  test(`native ${variant} is outside the complete static contract`, async () => {
    await assert.rejects(
      verifySmartSegmentScaleOutput(await model(), matrix, await model([1.3, 0.7, 1.1], variant, true)),
      rejection,
    );
  });

test('hidden root meshes and external buffers cannot silently enter the proof', async () => {
  const source = await model(),
    native = await model([1.3, 0.7, 1.1], '', true);
  const hidden = replaceJson(native, (json) => {
    (json.scenes as Array<{ nodes: number[] }>)[0]!.nodes.pop();
  });
  await assert.rejects(verifySmartSegmentScaleOutput(source, matrix, hidden), rejection);
  const external = replaceJson(native, (json) => {
    (json.buffers as Array<{ uri?: string }>)[0]!.uri = 'https://example.invalid/mesh.bin';
  });
  await assert.rejects(verifySmartSegmentScaleOutput(source, matrix, external), { code: 'INVALID_ARTIFACT' });
});

test('raw projective or nonfinite node matrices cannot disappear through GLB TRS decomposition', async () => {
  const source = await model(),
    native = await model([1.3, 0.7, 1.1], '', true);
  for (const [index, value] of [
    [3, 0.2],
    [7, 0.3],
    [11, 0.4],
    [15, 2],
    [0, NaN],
  ]) {
    const malformed = replaceJson(native, (json) => {
      const node = (json.nodes as Record<string, unknown>[])[0]!;
      delete node.translation;
      const world = [...identity];
      world[index!] = value!;
      node.matrix = world;
    });
    await assert.rejects(verifySmartSegmentScaleOutput(source, matrix, malformed), {
      ...rejection,
      message: /finite affine/,
    });
  }
  const projectedSource = replaceJson(source, (json) => {
    const node = (json.nodes as Record<string, unknown>[])[0]!;
    delete node.translation;
    node.matrix = [...identity];
    (node.matrix as number[])[3] = 0.2;
  });
  await assert.rejects(inspectSmartSegmentScaleSource(projectedSource), rejection);
});

test('mixed matrix and TRS or incomplete TRS cannot be treated as ordinary static nodes', async () => {
  const source = await model(),
    native = await model([1.3, 0.7, 1.1], '', true);
  const mixed = replaceJson(native, (json) => {
    (json.nodes as Record<string, unknown>[])[0]!.matrix = [...identity];
  });
  await assert.rejects(verifySmartSegmentScaleOutput(source, matrix, mixed), {
    ...rejection,
    message: /combine a matrix/,
  });
  for (const [key, value] of [
    ['translation', [0, 0]],
    ['scale', [1, null, 1]],
    ['rotation', [0, 0, 1]],
  ]) {
    const malformed = replaceJson(native, (json) => {
      (json.nodes as Record<string, unknown>[])[0]![String(key)] = value;
    });
    await assert.rejects(verifySmartSegmentScaleOutput(source, matrix, malformed), {
      ...rejection,
      message: /complete finite vectors/,
    });
  }
});

test('matrix validation rejects shear, projection, reflection, singularity and range', async () => {
  const source = await model();
  for (const [index, value] of [
    [1, 0.1],
    [3, 0.1],
    [0, -1],
    [5, 0],
    [10, 101],
    [0, 0.009],
    [0, NaN],
    [15, 2],
  ]) {
    const changed = [...matrix];
    changed[index!] = value!;
    await assert.rejects(verifySmartSegmentScaleOutput(source, changed, source), rejection);
  }
  await assert.rejects(verifySmartSegmentScaleOutput(source, matrix.slice(0, 15), source), rejection);
});

const positiveTransforms: Array<{ name: string; matrix: number[] }> = [
  { name: 'compound', matrix: [0, 1.3, 0, 0, -0.7, 0, 0, 0, 0, 0, 1.1, 0, 0.2, -0.3, 0.4, 1] },
  { name: 'rx90', matrix: [1.2, 0, 0, 0, 0, 0, 1.5, 0, 0, -0.8, 0, 0, 0.11, -0.17, 0.23, 1] },
  { name: 'ry90', matrix: [0, 0, -1.4, 0, 0, 1.1, 0, 0, 0.9, 0, 0, 0, -0.2, 0.3, -0.1, 1] },
  {
    name: 'rz45',
    matrix: [
      1.2 * Math.SQRT1_2,
      1.2 * Math.SQRT1_2,
      0,
      0,
      -0.8 * Math.SQRT1_2,
      0.8 * Math.SQRT1_2,
      0,
      0,
      0,
      0,
      1.1,
      0,
      0.1,
      -0.2,
      0.3,
      1,
    ],
  },
  { name: 'proper180', matrix: [-1.1, 0, 0, 0, 0, -0.9, 0, 0, 0, 0, 1.3, 0, 0, 0, 0, 1] },
  { name: 'translation', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.2, -0.3, 0.4, 1] },
];

for (const example of positiveTransforms)
  test(`positive static TRS ${example.name} matches direct physical coordinates`, async () => {
    const source = await model(),
      native = await model(undefined, example.name, true);
    const checked = checkedMetadataTransform(example.matrix);
    assert.deepEqual(checked.matrix, example.matrix);
    const proof = await verifySmartSegmentScaleOutput(source, example.matrix, native);
    assert.equal(proof.matched_oriented_faces, 4);
    assert.ok(Number(proof.maximum_position_error) < 1e-7);
    await assert.rejects(verifySmartSegmentScaleOutput(source, example.matrix, source), rejection);
  });

test('the shared TRS predicate rejects sparse, nonnumeric and unrepresentable inputs', () => {
  const sparse = [...identity];
  delete sparse[0];
  const huge = [...identity];
  huge[12] = 1e16;
  const stringValue: unknown[] = [...identity];
  stringValue[0] = '1';
  for (const value of [null, {}, [], sparse, huge, stringValue])
    assert.throws(() => checkedMetadataTransform(value), rejection);
  const requested = [...matrix],
    frozen = checkedMetadataTransform(requested);
  requested[0] = 77;
  assert.deepEqual(frozen.matrix, matrix);
});

test('documented finite positive scale endpoints use the explicit world tolerance', async () => {
  const source = await model();
  for (const s of [0.01, 100]) {
    const m = [...identity];
    m[0] = m[5] = m[10] = s;
    const proof = await verifySmartSegmentScaleOutput(source, m, await model([s, s, s], '', true));
    assert.equal(proof.matched_oriented_faces, 4);
  }
});

test('geometric winding check catches a reversed thin face inside positional tolerance', async () => {
  const doc = new Document(),
    buffer = doc.createBuffer();
  const attribute = (type: 'VEC3' | 'VEC2', values: number[]) =>
    doc.createAccessor().setBuffer(buffer).setType(type).setArray(new Float32Array(values));
  const indices = doc
    .createAccessor()
    .setBuffer(buffer)
    .setType('SCALAR')
    .setArray(new Uint16Array([0, 1, 2]));
  const primitive = doc
    .createPrimitive()
    .setIndices(indices)
    .setAttribute('POSITION', attribute('VEC3', [-0.5, -0.000005, 0, 0.5, -0.000005, 0, 0.5, 0.000005, 0]))
    .setAttribute('NORMAL', attribute('VEC3', [0, 0, 1, 0, 0, 1, 0, 0, 1]))
    .setAttribute('TEXCOORD_0', attribute('VEC2', [0, 0, 1, 0, 1, 1]));
  doc.createScene().addChild(doc.createNode('thin').setMesh(doc.createMesh().addPrimitive(primitive)));
  const io = await modelIO(),
    source = Buffer.from(await io.writeBinary(doc));
  assert.equal((await verifySmartSegmentScaleOutput(source, identity, source)).matched_oriented_faces, 1);
  indices.setArray(new Uint16Array([0, 2, 1]));
  await assert.rejects(
    verifySmartSegmentScaleOutput(source, identity, Buffer.from(await io.writeBinary(doc))),
    rejection,
  );
});

test('single-root reference inspection preserves the complete existing inspection fingerprint', async () => {
  const source = await model();
  assert.deepEqual(
    await inspectSmartSegmentScaleReference(source),
    await inspectSmartSegmentScaleSource(source),
  );
});

test('independent reference roots freeze all original world matrices and opaque appearances', async () => {
  const source = await model(undefined, '', true),
    inspected = await inspectSmartSegmentScaleReference(source),
    roots = inspected.roots as Array<Record<string, unknown>>;
  assert.equal(inspected.version, 2);
  assert.equal(inspected.sha256, hash(source));
  assert.equal(inspected.faces, 4);
  assert.deepEqual(
    roots.map((r) => r.node_name),
    ['part_0', 'part_1'],
  );
  assert.deepEqual(
    roots.map((r) => r.faces),
    [2, 2],
  );
  assert.deepEqual(roots[0]!.world_matrix, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.07, -0.03, 0.04, 1]);
  assert.deepEqual((roots[0]!.appearance as Record<string, unknown>).texture, null);
  await assert.rejects(inspectSmartSegmentScaleSource(source), rejection);
});

test('reference output verifies all source roots in world space even when the service omits UV/materials', async () => {
  const source = await model(undefined, '', true),
    native = await model(undefined, 'compound', true),
    withoutUv = replaceJson(native, (json) => {
      for (const mesh of json.meshes as Array<{
        primitives: Array<{ attributes: Record<string, unknown>; material?: number }>;
      }>)
        for (const primitive of mesh.primitives) {
          delete primitive.attributes.TEXCOORD_0;
          delete primitive.material;
        }
      delete json.materials;
    }),
    original = Buffer.from(withoutUv),
    selected = positiveTransforms.find((t) => t.name === 'compound')!.matrix;
  const proof = await verifySmartSegmentScaleOutput(source, selected, withoutUv, 'reference');
  assert.equal(proof.matched_oriented_faces, 4);
  assert.ok(Number(proof.maximum_position_error) < 1e-7);
  assert.match(String(proof.native_attribute_scope), /omit UVs/);
  assert.deepEqual(withoutUv, original);
  await assert.rejects(verifySmartSegmentScaleOutput(source, selected, source, 'reference'), rejection);
  await assert.rejects(verifySmartSegmentScaleOutput(await model(), selected, withoutUv), rejection);
  const io = await modelIO(),
    doc = await io.readBinary(source);
  for (const node of doc.getRoot().listNodes()) {
    const position = node.getMesh()!.listPrimitives()[0]!.getAttribute('POSITION')!;
    for (let index = 0; index < position.getCount(); index++)
      position.setElement(index, transformedFixturePoint(position.getElement(index, []), 'compound'));
    node.setTranslation([0, 0, 0]);
  }
  await assert.rejects(
    verifySmartSegmentScaleOutput(source, selected, Buffer.from(await io.writeBinary(doc)), 'reference'),
    rejection,
  );
});

test('reference names, mesh ownership, appearance and source UVs stay strict before submission', async () => {
  const source = await model(undefined, '', true);
  const mutations: Array<(json: Record<string, unknown>) => void> = [
    (json) => {
      const nodes = json.nodes as Array<Record<string, unknown>>;
      nodes[1]!.name = nodes[0]!.name;
    },
    (json) => {
      (json.nodes as Array<Record<string, unknown>>)[1]!.name = ' ';
    },
    (json) => {
      (json.nodes as Array<Record<string, unknown>>)[1]!.mesh = 0;
    },
    (json) => {
      const meshes = json.meshes as Array<{ primitives: unknown[] }>;
      meshes[0]!.primitives.push(meshes[0]!.primitives[0]);
    },
    (json) => {
      const meshes = json.meshes as Array<{ primitives: Array<{ attributes: Record<string, unknown> }> }>;
      delete meshes[0]!.primitives[0]!.attributes.TEXCOORD_0;
    },
    (json) => {
      (json.materials as Array<Record<string, unknown>>)[0]!.alphaMode = 'BLEND';
    },
    (json) => {
      (json.materials as Array<Record<string, unknown>>)[0]!.extensions = { KHR_materials_unlit: {} };
    },
    (json) => {
      const node = (json.nodes as Array<Record<string, unknown>>)[0]!;
      delete node.translation;
      node.matrix = [...identity];
      (node.matrix as number[])[4] = 0.2;
    },
    (json) => {
      (json.nodes as Array<Record<string, unknown>>)[0]!.scale = [-1, 1, 1];
    },
  ];
  for (const change of mutations)
    await assert.rejects(inspectSmartSegmentScaleReference(replaceJson(source, change)), rejection);
  await assert.rejects(inspectSmartSegmentScaleReference(await model([2, 1, 1], '', true)), rejection);
  await assert.rejects(
    inspectSmartSegmentScaleReference(await model(undefined, 'duplicate', true)),
    rejection,
  );
});

test('four independent unit roots are all verified and no root may disappear from the result', async () => {
  const io = await modelIO(),
    doc = await io.readBinary(await model()),
    scene = doc.getRoot().listScenes()[0]!,
    original = doc.getRoot().listNodes()[0]!,
    mesh = original.getMesh()!,
    primitive = mesh.listPrimitives()[0]!,
    indices = [...primitive.getIndices()!.getArray()!],
    buffer = doc.getRoot().listBuffers()[0]!;
  for (let part = 0; part < 4; part++) {
    const copy = primitive.clone().setIndices(
      doc
        .createAccessor()
        .setBuffer(buffer)
        .setType('SCALAR')
        .setArray(new Uint16Array(indices.slice(part * 3, part * 3 + 3))),
    );
    scene.addChild(doc.createNode(`root_${part}`).setMesh(doc.createMesh().addPrimitive(copy)));
  }
  original.dispose();
  mesh.dispose();
  primitive.dispose();
  const source = Buffer.from(await io.writeBinary(doc)),
    inspected = await inspectSmartSegmentScaleReference(source);
  assert.equal((inspected.roots as unknown[]).length, 4);
  const changed = await io.readBinary(source),
    positions = new Set(
      changed
        .getRoot()
        .listNodes()
        .map((n) => n.getMesh()!.listPrimitives()[0]!.getAttribute('POSITION')!),
    );
  for (const position of positions)
    for (let i = 0; i < position.getCount(); i++)
      position.setElement(i, transformedFixturePoint(position.getElement(i, []), 'compound'));
  const selected = positiveTransforms.find((t) => t.name === 'compound')!.matrix;
  assert.equal(
    (
      await verifySmartSegmentScaleOutput(
        source,
        selected,
        Buffer.from(await io.writeBinary(changed)),
        'reference',
      )
    ).matched_oriented_faces,
    4,
  );
  const removed = changed.getRoot().listNodes()[0]!,
    removedMesh = removed.getMesh()!;
  removed.dispose();
  removedMesh.dispose();
  await assert.rejects(
    verifySmartSegmentScaleOutput(source, selected, Buffer.from(await io.writeBinary(changed)), 'reference'),
    rejection,
  );
});
