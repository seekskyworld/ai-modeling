/** 双TRS的每段只读证明与原始A(P)总义务；不以末段通过或累计容差替代完整效果。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Document } from '@gltf-transform/core';
import { modelIO } from '../cli/local/gltf.ts';
import {
  affineMatrixProduct,
  checkedSmartSegmentAffine,
  decomposeSmartSegmentAffine,
} from '../cli/artifacts/smartsegment-affine-decomposition.ts';
import {
  prepareSmartSegmentAffine,
  prepareSmartSegmentAffineMerge,
  verifySmartSegmentAffineMerge,
  verifySmartSegmentAffineOutput,
} from '../cli/artifacts/smartsegment-affine-proof.ts';
import {
  readSmartSegmentGeometry,
  verifySmartSegmentScaleOutput,
} from '../cli/artifacts/smartsegment-scale-proof.ts';
import { checkedMetadataTransform } from '../cli/artifacts/smartsegment-transform-matrix.ts';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const reject = { code: 'SMARTSEGMENT_TRANSFORM_UNVERIFIED' };
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const shear = (k = 0.2): number[] => identity.map((value, index) => (index === 4 ? k : value));
const points = [
  [-0.5, -0.4, -0.3],
  [0.5, -0.4, -0.3],
  [0, 0.4, -0.3],
  [0, 0, 0.3],
].map((point) => point.map(Math.fround));
const indices = [0, 1, 2, 0, 3, 1, 1, 3, 2, 2, 3, 0];
const apply = (point: number[], matrix: number[]): number[] =>
  [0, 1, 2].map(
    (i) => matrix[i]! * point[0]! + matrix[4 + i]! * point[1]! + matrix[8 + i]! * point[2]! + matrix[12 + i]!,
  );
type ModelOptions = {
  positions?: number[][];
  indices?: number[];
  split?: boolean;
  names?: string[];
  world?: number[];
  uv?: 'missing' | 'incomplete' | 'nonfinite';
  normal?: 'missing' | 'zero' | 'nonfinite';
  alpha?: boolean;
  roughness?: number;
};
async function model(options: ModelOptions = {}): Promise<Buffer> {
  const doc = new Document(),
    buffer = doc.createBuffer(),
    scene = doc.createScene(),
    values = options.positions ?? points,
    ids = options.indices ?? indices,
    groups = options.split ? [ids.slice(0, 6), ids.slice(6)] : [ids];
  const accessor = (type: 'VEC3' | 'VEC2', data: number[][]) =>
    doc.createAccessor().setType(type).setArray(new Float32Array(data.flat())).setBuffer(buffer);
  for (const [index, group] of groups.entries()) {
    const normals = values.map(() => (options.normal === 'zero' ? [0, 0, 0] : [0, 0, 1])),
      uv = values.map((_, at) => [at * 0.17, at * 0.23]);
    if (options.normal === 'nonfinite') normals[0]![0] = Infinity;
    if (options.uv === 'incomplete') uv.pop();
    if (options.uv === 'nonfinite') uv[0]![0] = Infinity;
    const primitive = doc
      .createPrimitive()
      .setAttribute('POSITION', accessor('VEC3', values))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(group)).setBuffer(buffer))
      .setMaterial(
        doc
          .createMaterial()
          .setMetallicFactor(0)
          .setRoughnessFactor(options.roughness ?? 0.5)
          .setAlphaMode(options.alpha ? 'BLEND' : 'OPAQUE'),
      );
    if (options.normal !== 'missing') primitive.setAttribute('NORMAL', accessor('VEC3', normals));
    if (options.uv !== 'missing') primitive.setAttribute('TEXCOORD_0', accessor('VEC2', uv));
    const node = doc
      .createNode(options.names?.[index] ?? `part_${index}`)
      .setMesh(doc.createMesh().addPrimitive(primitive));
    if (options.world) node.setMatrix(options.world as Parameters<typeof node.setMatrix>[0]);
    scene.addChild(node);
  }
  return Buffer.from(await (await modelIO()).writeBinary(doc));
}
async function fixture(k = 0.2, sourceOptions: ModelOptions = {}, matrix = shear(k)) {
  const original = await model(sourceOptions),
    preparation = await prepareSmartSegmentAffine(original, matrix),
    worldPoints = (sourceOptions.positions ?? points).map((p) => apply(p, sourceOptions.world ?? identity)),
    firstPoints = worldPoints.map((p) => apply(p, preparation.first_matrix)),
    finalPoints = worldPoints.map((p) => apply(p, matrix)),
    first = await model({ positions: firstPoints, indices: sourceOptions.indices, split: true }),
    merge = await prepareSmartSegmentAffineMerge(original, preparation, first),
    merged = await model({
      positions: firstPoints,
      indices: sourceOptions.indices,
      names: [String(merge.merge_name)],
    }),
    final = await model({ positions: finalPoints, indices: sourceOptions.indices, split: true });
  return { matrix, original, preparation, firstPoints, finalPoints, first, merge, merged, final };
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

for (const k of [-1, -0.2, -0.01, 0.01, 0.2, 1]) {
  test(`pure XY shear ${k} factors into exact positive TRS without fitted output coordinates`, () => {
    const factors = decomposeSmartSegmentAffine(shear(k), points);
    checkedMetadataTransform(factors.first_matrix);
    checkedMetadataTransform(factors.second_matrix);
    assert.ok(
      affineMatrixProduct(factors.second_matrix, factors.first_matrix).every(
        (v, i) => Math.abs(v - shear(k)[i]!) < 1e-14,
      ),
    );
    const rotated = points.map((p) => apply(p, factors.first_matrix)),
      min = [0, 1, 2].map((i) => Math.min(...rotated.map((p) => p[i]!))),
      max = [0, 1, 2].map((i) => Math.max(...rotated.map((p) => p[i]!)));
    assert.ok(min.every((v, i) => Math.abs(v + max[i]!) < 1e-14));
    assert.ok(Math.abs(Math.max(...max.map((v, i) => v - min[i]!)) - 1) < 1e-14);
    assert.deepEqual(decomposeSmartSegmentAffine(shear(k), [...points].reverse()), factors);
  });
  test(`native XY shear ${k} binds source, both intermediates and final original bytes`, async () => {
    const f = await fixture(k),
      hashes = [f.original, f.first, f.merged, f.final].map(hash),
      proof = await verifySmartSegmentAffineOutput(f.original, f.matrix, f.first, f.merged, f.final);
    assert.equal(f.preparation.kind, 'xy_shear_two_native_trs');
    assert.equal(Object.hasOwn(f.preparation, 'family'), false);
    assert.equal(proof.matched_oriented_faces, 4);
    assert.ok(Number(proof.maximum_position_error) < 1e-7);
    assert.deepEqual(proof.tolerance, { position: 0.00004 });
    assert.deepEqual([proof.source_sha256, proof.first_sha256, proof.merged_sha256, proof.sha256], hashes);
    assert.deepEqual([f.original, f.first, f.merged, f.final].map(hash), hashes);
    assert.equal(proof.uses_geometry_fit, false);
    assert.equal(proof.native_result_modified, false);
    assert.equal(proof.accumulated_tolerance_used, false);
    assert.match(String(proof.native_attribute_scope), /recalculate normals, repack or omit UVs/);
    assert.deepEqual(f.merge.part_indices, { part_0: [0, 0], part_1: [0, 0] });
    assert.deepEqual(f.merge.part_indices_name, { '0': 'ai_modeling_affine_stage1' });
  });
}

const newAxes = [
  { family: 'xz', target: 0, input: 2, index: 8 },
  { family: 'yx', target: 1, input: 0, index: 1 },
  { family: 'yz', target: 1, input: 2, index: 9 },
  { family: 'zx', target: 2, input: 0, index: 2 },
  { family: 'zy', target: 2, input: 1, index: 6 },
];
const axisMatrix = (index: number, k = 0.2): number[] =>
  identity.map((value, at) => (at === index ? k : value));

for (const axis of newAxes)
  for (const k of [-1, -0.2, -0.01, 0.01, 0.2, 1])
    test(`native ${axis.family.toUpperCase()} shear ${k} proves every original oriented face at fixed tolerance`, async () => {
      const matrix = axisMatrix(axis.index, k),
        f = await fixture(k, {}, matrix),
        analytic = points.map((point) =>
          point.map((value, at) => (at === axis.target ? value + k * point[axis.input]! : value)),
        ),
        final = await model({ positions: analytic, split: true }),
        hashes = [f.original, f.first, f.merged, final].map(hash),
        proof = await verifySmartSegmentAffineOutput(f.original, matrix, f.first, f.merged, final);
      assert.equal(f.preparation.kind, 'axis_shear_two_native_trs');
      assert.equal(f.preparation.family, axis.family);
      assert.deepEqual(f.preparation.transform_matrix, matrix);
      assert.deepEqual(f.finalPoints, analytic);
      assert.equal(proof.matched_oriented_faces, 4);
      assert.ok(Number(proof.maximum_position_error) < 1e-7);
      assert.deepEqual(proof.tolerance, { position: 0.00004 });
      assert.deepEqual([proof.source_sha256, proof.first_sha256, proof.merged_sha256, proof.sha256], hashes);
      assert.deepEqual([f.original, f.first, f.merged, final].map(hash), hashes);
      assert.equal(proof.uses_geometry_fit, false);
      assert.equal(proof.native_result_modified, false);
      assert.equal(proof.accumulated_tolerance_used, false);
      assert.match(String(proof.native_attribute_scope), /does not claim source appearance/);
    });

for (const axis of newAxes)
  test(`${axis.family.toUpperCase()} preparation cannot change axis, sign, family or factor across a native stage`, async () => {
    const matrix = axisMatrix(axis.index),
      f = await fixture(0.2, {}, matrix);
    for (const changed of [
      { ...f.preparation, kind: 'xy_shear_two_native_trs' },
      { ...f.preparation, family: 'xy' },
      { ...f.preparation, family: undefined },
      { ...f.preparation, transform_matrix: shear() },
      { ...f.preparation, transform_matrix: axisMatrix(axis.index, -0.2) },
      { ...f.preparation, first_matrix: identity },
      { ...f.preparation, second_matrix: identity },
      { ...f.preparation, tolerance: { position: 0.00008 } },
    ])
      await assert.rejects(prepareSmartSegmentAffineMerge(f.original, changed, f.first), reject);
    const wrongAxis = await model({ positions: points.map((point) => apply(point, shear())), split: true });
    await assert.rejects(
      verifySmartSegmentAffineOutput(f.original, matrix, f.first, f.merged, wrongAxis),
      reject,
    );
  });

test('affine request rejects singular, reflected, projective, sparse and out-of-range matrices', () => {
  const sparse = shear();
  delete sparse[0];
  for (const value of [
    undefined,
    {},
    'shear',
    sparse,
    shear().slice(0, 15),
    [...shear(), 0],
    ...[0, -0, NaN, Infinity].map(shear),
  ])
    assert.throws(() => checkedSmartSegmentAffine(value), reject);
  for (const [index, value] of [
    [0, 0],
    [3, 0.1],
    [5, -1],
    [12, 1e9],
    [15, 2],
  ]) {
    const matrix = shear();
    matrix[index!] = value!;
    assert.throws(() => checkedSmartSegmentAffine(matrix), reject);
  }
  for (const invalid of [
    [],
    [[0, 0, 0]],
    [
      [0, 0],
      [1, 1, 1],
    ],
    [
      [0, 0, Infinity],
      [1, 1, 1],
    ],
    [Array<number>(3), [1, 1, 1]],
    Array.from({ length: 75001 }, () => [0, 0, 0]),
  ])
    assert.throws(() => decomposeSmartSegmentAffine(shear(), invalid), reject);
});

const compound = identity.map((value, index) => (index === 4 ? 0.2 : index === 8 ? 0.1 : value));
const generalMatrices = [
  ...[0.001, -0.001, 0.00999999999, -0.00999999999, 1.00000000001, -1.00000000001, 2, -2, 10, -10].map(
    (k) => ({
      name: `single shear ${k} outside the unchanged legacy decomposition branch`,
      matrix: shear(k),
    }),
  ),
  { name: 'two simultaneous shear components', matrix: compound },
  { name: 'opposing off-diagonal components', matrix: shear().map((v, i) => (i === 1 ? -0.15 : v)) },
  {
    name: 'translation, scale and shear',
    matrix: [1.2, 0, 0, 0, 0.2, 0.8, 0, 0, -0.1, 0, 0.9, 0, 0.05, -0.08, 0.03, 1],
  },
  {
    name: 'proper rotation followed by compound shear',
    matrix: affineMatrixProduct([0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], compound),
  },
  {
    name: 'a repeated singular value with nonorthogonal columns',
    matrix: [
      Math.SQRT1_2,
      0,
      -1.3 * Math.SQRT1_2,
      0,
      0,
      1,
      0,
      0,
      Math.SQRT1_2,
      0,
      1.3 * Math.SQRT1_2,
      0,
      0,
      0,
      0,
      1,
    ],
  },
];
for (const item of generalMatrices)
  test(`bounded general affine ${item.name} keeps the complete original geometry obligation`, async () => {
    const f = await fixture(0.2, {}, item.matrix),
      originalHashes = [f.original, f.first, f.merged, f.final].map(hash),
      proof = await verifySmartSegmentAffineOutput(f.original, item.matrix, f.first, f.merged, f.final);
    assert.equal(f.preparation.kind, 'general_affine_two_native_trs');
    assert.equal(f.preparation.family, 'general');
    assert.equal(Object.hasOwn(f.preparation, 'k'), false);
    assert.deepEqual(f.preparation.transform_matrix, item.matrix);
    assert.equal(proof.matched_oriented_faces, 4);
    assert.ok(Number(proof.maximum_position_error) <= 0.00004);
    assert.deepEqual(proof.tolerance, { position: 0.00004 });
    assert.equal(proof.accumulated_tolerance_used, false);
    assert.equal(proof.uses_geometry_fit, false);
    assert.equal(proof.native_result_modified, false);
    assert.deepEqual(
      [proof.source_sha256, proof.first_sha256, proof.merged_sha256, proof.sha256],
      originalHashes,
    );
    assert.deepEqual([f.original, f.first, f.merged, f.final].map(hash), originalHashes);
    for (const changed of [
      { ...f.preparation, k: 0.2 },
      { ...f.preparation, kind: 'axis_shear_two_native_trs' },
      { ...f.preparation, family: 'xz' },
      { ...f.preparation, first_matrix: f.preparation.second_matrix },
      { ...f.preparation, second_matrix: identity },
      { ...f.preparation, tolerance: { position: 0.00008 } },
    ])
      await assert.rejects(prepareSmartSegmentAffineMerge(f.original, changed, f.first), reject);
    await assert.rejects(
      verifySmartSegmentAffineOutput(f.original, item.matrix, f.first, f.merged, f.original),
      reject,
    );
  });

test('general affine snapshots the request before awaits and retains every original intermediate restriction', async () => {
  const f = await fixture(0.2, {}, compound),
    requested = [...compound],
    pending = prepareSmartSegmentAffine(f.original, requested);
  requested[8] = -0.4;
  assert.deepEqual((await pending).transform_matrix, compound);
  await assert.rejects(
    prepareSmartSegmentAffineMerge(
      f.original,
      f.preparation,
      await model({ positions: f.firstPoints, uv: 'missing', split: true }),
    ),
    reject,
  );
  await assert.rejects(
    verifySmartSegmentAffineMerge(
      f.original,
      f.preparation,
      f.first,
      await model({ positions: f.firstPoints, names: ['wrong-merge-name'] }),
    ),
    reject,
  );
  for (const extra of [
    { normal: 'zero' },
    { uv: 'nonfinite' },
    { alpha: true },
    { indices: indices.slice(0, 9) },
  ] as ModelOptions[])
    await assert.rejects(
      verifySmartSegmentAffineOutput(
        f.original,
        compound,
        f.first,
        f.merged,
        await model({ positions: f.finalPoints, ...extra }),
      ),
      reject,
    );
  const altered = Buffer.from(f.merged),
    finalPending = verifySmartSegmentAffineOutput(f.original, compound, f.first, altered, f.final);
  altered[altered.length - 1] = altered[altered.length - 1]! ^ 1;
  await assert.rejects(finalPending);
});

test('general affine source-dependent scale limits reject before any native stage', async () => {
  const original = await model();
  for (const scale of [1000, 0.001]) {
    const matrix = compound.map((value, index) => (index === 0 ? scale : value));
    assert.equal(checkedSmartSegmentAffine(matrix).family, 'general');
    await assert.rejects(prepareSmartSegmentAffine(original, matrix), reject);
  }
});

test('affine source uses its original proper world matrix; raw shear cannot be silently decomposed', async () => {
  const rotation = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    f = await fixture(0.2, { world: rotation }),
    data = await readSmartSegmentGeometry(f.original),
    proof = await verifySmartSegmentAffineOutput(f.original, f.matrix, f.first, f.merged, f.final);
  assert.equal(proof.matched_oriented_faces, 4);
  assert.deepEqual(
    f.preparation.first_matrix,
    decomposeSmartSegmentAffine(f.matrix, data.faces.flat()).first_matrix,
  );
  const malformed = replaceJson(f.original, (json) => {
    const node = (json.nodes as Record<string, unknown>[])[0]!;
    delete node.rotation;
    node.matrix = shear();
  });
  await assert.rejects(prepareSmartSegmentAffine(malformed, f.matrix), reject);
});

test('request matrix freezes synchronously and changed preparation or source is rejected', async () => {
  const f = await fixture(),
    requested = shear(),
    pending = prepareSmartSegmentAffine(f.original, requested);
  requested[4] = 0.5;
  assert.deepEqual((await pending).transform_matrix, f.matrix);
  for (const changed of [
    { ...f.preparation, source_sha256: '0'.repeat(64) },
    { ...f.preparation, first_matrix: identity },
    { ...f.preparation, second_matrix: identity },
    { ...f.preparation, tolerance: { position: 0.00008 } },
    { ...f.preparation, transform_matrix: shear(-0.2) },
  ])
    await assert.rejects(prepareSmartSegmentAffineMerge(f.original, changed, f.first), reject);
  const changedSource = await model({ roughness: 0.7 });
  await assert.rejects(prepareSmartSegmentAffineMerge(changedSource, f.preparation, f.first), reject);
});

test('native all-face merge uses a fresh exact mesh name', async () => {
  const f = await fixture(0.2, { names: ['ai_modeling_affine_stage1'] }),
    name = String(f.merge.merge_name);
  assert.match(name, /^ai_modeling_affine_stage1_[a-f0-9]{12}_0$/);
  assert.equal(
    (await verifySmartSegmentAffineMerge(f.original, f.preparation, f.first, f.merged)).merge_name,
    name,
  );
  await assert.rejects(
    verifySmartSegmentAffineMerge(
      f.original,
      f.preparation,
      f.first,
      await model({ positions: f.firstPoints, names: ['renamed'] }),
    ),
    reject,
  );
});

for (const changed of ['winding', 'omitted', 'duplicate', 'added'] as const)
  test(`native ${changed} faces cannot pass either the first stage or final original obligation`, async () => {
    const f = await fixture(),
      changedIndices = [...indices];
    if (changed === 'winding') changedIndices.splice(0, 3, 0, 2, 1);
    if (changed === 'omitted') changedIndices.splice(9, 3);
    if (changed === 'duplicate') changedIndices.splice(9, 3, 0, 1, 2);
    if (changed === 'added') changedIndices.push(0, 1, 2);
    await assert.rejects(
      prepareSmartSegmentAffineMerge(
        f.original,
        f.preparation,
        await model({ positions: f.firstPoints, indices: changedIndices }),
      ),
      reject,
    );
    await assert.rejects(
      verifySmartSegmentAffineOutput(
        f.original,
        f.matrix,
        f.first,
        f.merged,
        await model({ positions: f.finalPoints, indices: changedIndices }),
      ),
      reject,
    );
  });

test('final affine verification accepts disclosed UV/material changes but requires valid finite normals', async () => {
  const f = await fixture(),
    output = { positions: f.finalPoints, split: true };
  const proof = await verifySmartSegmentAffineOutput(
    f.original,
    f.matrix,
    f.first,
    f.merged,
    await model({ ...output, uv: 'missing', roughness: 0.2 }),
  );
  assert.equal(proof.matched_oriented_faces, 4);
  for (const extra of [
    { uv: 'incomplete' },
    { uv: 'nonfinite' },
    { normal: 'missing' },
    { normal: 'zero' },
    { normal: 'nonfinite' },
    { alpha: true },
  ] as ModelOptions[])
    await assert.rejects(
      verifySmartSegmentAffineOutput(
        f.original,
        f.matrix,
        f.first,
        f.merged,
        await model({ ...output, ...extra }),
      ),
      reject,
    );
});

test('first stage and merge require complete UV and centered unit opaque geometry', async () => {
  const f = await fixture();
  for (const extra of [
    { uv: 'missing' },
    { alpha: true },
    { positions: f.firstPoints.map((p) => p.map((v) => v * 1.1)) },
  ] as ModelOptions[]) {
    await assert.rejects(
      prepareSmartSegmentAffineMerge(
        f.original,
        f.preparation,
        await model({ positions: f.firstPoints, ...extra, split: true }),
      ),
      reject,
    );
    await assert.rejects(
      verifySmartSegmentAffineMerge(
        f.original,
        f.preparation,
        f.first,
        await model({ positions: f.firstPoints, names: [String(f.merge.merge_name)], ...extra }),
      ),
      reject,
    );
  }
});

for (const axis of [{ family: 'xy', index: 4 }, ...newAxes, { family: 'general', index: -1 }])
  test(`${axis.family.toUpperCase()} last M2 proof cannot replace the original A(P) proof or accumulate tolerances`, async () => {
    const f = await fixture(0.2, {}, axis.index < 0 ? compound : axisMatrix(axis.index)),
      delta = 0.00003,
      drifted = f.firstPoints.map((p) => p.map((v, i) => v + (i === 0 ? delta : 0))),
      first = await model({ positions: drifted, split: true }),
      merge = await prepareSmartSegmentAffineMerge(f.original, f.preparation, first),
      merged = await model({ positions: drifted, names: [String(merge.merge_name)] }),
      direction = apply([1, 0, 0], [...f.preparation.second_matrix.slice(0, 12), 0, 0, 0, 1]),
      length = Math.hypot(...direction),
      finalPoints = drifted.map((p) =>
        apply(p, f.preparation.second_matrix).map((v, i) => v + (direction[i]! / length) * delta),
      ),
      final = await model({ positions: finalPoints, split: true });
    await verifySmartSegmentAffineMerge(f.original, f.preparation, first, merged);
    const lastOnly = await verifySmartSegmentScaleOutput(
      merged,
      f.preparation.second_matrix,
      final,
      'reference',
    );
    assert.ok(Number(lastOnly.maximum_position_error) < 0.00004);
    await assert.rejects(verifySmartSegmentAffineOutput(f.original, f.matrix, first, merged, final), reject);
  });

test('all byte inputs remain bound across asynchronous final verification', async () => {
  const f = await fixture();
  for (const at of [0, 1, 2, 3]) {
    const buffers = [f.original, f.first, f.merged, f.final].map((value) => Buffer.from(value)),
      pending = verifySmartSegmentAffineOutput(buffers[0]!, f.matrix, buffers[1]!, buffers[2]!, buffers[3]!);
    const target = buffers[at]!,
      index = target.length - 1;
    target[index] = target[index]! ^ 1;
    await assert.rejects(pending);
  }
});

test('general merge preflights final coordinates without pretending to be an actual final result', async () => {
  const matrix = compound.map((value, index) => (index < 12 ? value * 0.5 : value)),
    sourcePoints = [...points, [0.08, 0.07, 0.02]],
    sourceIndices = [...indices, 0, 1, 4, 1, 2, 4, 2, 0, 4],
    f = await fixture(0.2, { positions: sourcePoints, indices: sourceIndices }, matrix),
    lengths = [0, 1, 2].map((axis) =>
      Math.hypot(...f.preparation.second_matrix.slice(axis * 4, axis * 4 + 3)),
    ),
    axis = lengths.indexOf(Math.min(...lengths)),
    displaced = (amount: number) =>
      f.firstPoints.map((p, i) => p.map((v, j) => v + (i === 4 && j === axis ? amount : 0))),
    first = await model({ positions: displaced(2.5e-5), indices: sourceIndices, split: true }),
    merge = await prepareSmartSegmentAffineMerge(f.original, f.preparation, first),
    merged = await model({
      positions: displaced(5e-5),
      indices: sourceIndices,
      names: [String(merge.merge_name)],
    }),
    hashes = [f.original, first, merged].map(hash),
    proof = await verifySmartSegmentAffineMerge(f.original, f.preparation, first, merged),
    projected = proof.projected_final_geometry as Record<string, unknown>;
  assert.equal(proof.kind, 'general_affine_merge_projected_preflight');
  assert.equal(Object.hasOwn(proof, 'maximum_position_error'), false);
  assert.equal(Object.hasOwn(proof, 'transform_matrix'), false);
  assert.equal(projected.actual_final_output_verified, false);
  assert.equal(projected.kind, 'projected_final_preflight');
  assert.deepEqual(projected.transform_matrix, matrix);
  assert.deepEqual(projected.second_matrix, f.preparation.second_matrix);
  assert.equal(projected.expected_corner_sha256, f.preparation.final_expected_corner_sha256);
  assert.equal(projected.matched_oriented_faces, 7);
  assert.ok(Number(projected.maximum_position_error) < 4e-5);
  assert.equal(projected.native_result_modified, false);
  assert.equal(proof.merged_sha256, hash(merged));
  await assert.rejects(verifySmartSegmentScaleOutput(f.original, f.preparation.first_matrix, merged), reject);
  // A true final can still pass both obligations; a further legal local-stage error cannot
  // borrow any error allowance from the projected preflight.
  const exactFinal = await model({ positions: f.finalPoints, indices: sourceIndices });
  assert.equal(
    (await verifySmartSegmentAffineOutput(f.original, matrix, first, merged, exactFinal))
      .matched_oriented_faces,
    7,
  );
  const native = await readSmartSegmentGeometry(merged),
    direction = f.preparation.second_matrix.slice(axis * 4, axis * 4 + 3).map((v) => v / lengths[axis]!),
    wrongPoints = displaced(5e-5).map((p, i) =>
      apply(p, f.preparation.second_matrix).map((v, j) => v + (i === 4 ? direction[j]! * 3e-5 : 0)),
    ),
    wrong = await model({ positions: wrongPoints, indices: sourceIndices });
  assert.equal(native.faces.length, 7);
  await verifySmartSegmentScaleOutput(merged, f.preparation.second_matrix, wrong);
  await assert.rejects(verifySmartSegmentAffineOutput(f.original, matrix, first, merged, wrong), reject);
  await assert.rejects(
    verifySmartSegmentAffineMerge(
      f.original,
      f.preparation,
      first,
      await model({ positions: displaced(8e-5), indices: sourceIndices, names: [String(merge.merge_name)] }),
    ),
    reject,
  );
  assert.deepEqual([f.original, first, merged].map(hash), hashes);
});

test('general final-coordinate preflight rejects an amplified error even when actual merge preservation passes', async () => {
  const matrix = compound.map((value, index) => (index < 12 ? value * 3 : value)),
    sourcePoints = [...points, [0.08, 0.07, 0.02]],
    sourceIndices = [...indices, 0, 1, 4, 1, 2, 4, 2, 0, 4],
    f = await fixture(0.2, { positions: sourcePoints, indices: sourceIndices }, matrix),
    lengths = [0, 1, 2].map((axis) =>
      Math.hypot(...f.preparation.second_matrix.slice(axis * 4, axis * 4 + 3)),
    ),
    axis = lengths.indexOf(Math.max(...lengths)),
    merged = await model({
      positions: f.firstPoints.map((p, i) => p.map((v, j) => v + (i === 4 && j === axis ? 3e-5 : 0))),
      indices: sourceIndices,
      names: [String(f.merge.merge_name)],
    });
  await verifySmartSegmentScaleOutput(f.first, identity, merged, 'reference');
  await assert.rejects(verifySmartSegmentAffineMerge(f.original, f.preparation, f.first, merged), reject);
});
