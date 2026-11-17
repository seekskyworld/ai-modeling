/** 新一般仿射族须独立证明正TRS因子与固定总误差，不抢旧路由或放宽提交前边界。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  affineMatrixProduct,
  checkedSmartSegmentAffine,
  decomposeSmartSegmentAffine,
} from '../cli/artifacts/smartsegment-affine-decomposition.ts';
import { checkedMetadataTransform } from '../cli/artifacts/smartsegment-transform-matrix.ts';
import { processingPlan } from '../cli/compat/planning.ts';
import { smartSegmentAffineMatrix } from '../cli/compat/smartsegment-affine-plan.ts';
import { smartSegmentIdentity } from '../cli/compat/smartsegment-scale-plan.ts';
import { executePlan } from '../cli/compat/runtime.ts';
import { object } from '../studio/contracts/errors.ts';
import { affineFixture } from './helpers-smartsegment-affine.ts';

const identity = smartSegmentIdentity;
const compound = [1, 0, 0, 0, 0.2, 1, 0, 0, 0.1, 0, 1, 0, 0, 0, 0, 1];
const points = [
  [-0.5, -0.5, -0.5],
  [0.5, 0.5, -0.5],
  [0.5, -0.5, 0.5],
  [-0.5, 0.5, 0.5],
];
const rejected = { code: 'SMARTSEGMENT_TRANSFORM_UNVERIFIED' };
const rotation = (theta: number): number[] => [
  Math.cos(theta),
  Math.sin(theta),
  0,
  0,
  -Math.sin(theta),
  Math.cos(theta),
  0,
  0,
  0,
  0,
  1,
  0,
  0,
  0,
  0,
  1,
];

test('general positive affine has stable proper factors, original matrix and no fictitious shear k', () => {
  for (const matrix of [
    compound,
    compound.map((v, i) => (i === 12 ? 0.25 : i === 13 ? -0.1 : v)),
    affineMatrixProduct(rotation(0.31), compound),
  ]) {
    assert.deepEqual(checkedSmartSegmentAffine(matrix), { matrix, family: 'general' });
    const result = decomposeSmartSegmentAffine(matrix, points);
    assert.equal(result.family, 'general');
    assert.equal(Object.hasOwn(result, 'k'), false);
    assert.deepEqual(decomposeSmartSegmentAffine(matrix, points), result);
    checkedMetadataTransform(result.first_matrix);
    checkedMetadataTransform(result.second_matrix);
    assert(
      affineMatrixProduct(result.second_matrix, result.first_matrix).every(
        (v, i) => Math.abs(v - matrix[i]!) < 1e-12,
      ),
    );
  }
});

test('near-repeated spectral values and bounded endpoint scales keep deterministic factorization', () => {
  for (const scales of [
    [0.1, 10, 1],
    [1, 1 + 1e-6, 1],
    [1, 1 + 1e-5, 1.0001],
    [0.5, 2, 0.5],
  ]) {
    const diagonal = identity.map((v, i) =>
        i === 0 ? scales[0]! : i === 5 ? scales[1]! : i === 10 ? scales[2]! : v,
      ),
      matrix = affineMatrixProduct(rotation(0.41), affineMatrixProduct(diagonal, rotation(-0.23))),
      first = decomposeSmartSegmentAffine(matrix, points);
    assert.deepEqual(decomposeSmartSegmentAffine(matrix, points), first);
    checkedMetadataTransform(first.first_matrix);
    checkedMetadataTransform(first.second_matrix);
    assert(
      affineMatrixProduct(first.second_matrix, first.first_matrix).every(
        (v, i) => Math.abs(v - matrix[i]!) < 1e-12,
      ),
    );
  }
});

test('general preflight rejects reflection, rank loss, projection, precision and spectral overflow', () => {
  for (const [index, value] of [
    [0, -1],
    [0, 0],
    [3, 0.1],
    [15, 2],
    [12, 1e9],
    [0, 1e308],
    [0, NaN],
    [0, Infinity],
  ]) {
    const matrix = compound.map((v, i) => (i === index ? value! : v));
    assert.throws(
      () => processingPlan('smartsegment', 'owned-task', { param: { transform: matrix } }),
      rejected,
    );
  }
  const sparse = [...compound];
  delete sparse[0];
  assert.throws(() => checkedSmartSegmentAffine(sparse), rejected);
  for (const coordinates of [
    [],
    [[0, 0, 0]],
    [[0, 0]],
    [[0, Infinity, 0]],
    [Array<number>(3)],
    Array.from({ length: 75001 }, () => [0, 0, 0]),
  ])
    assert.throws(() => decomposeSmartSegmentAffine(compound, coordinates), rejected);
});

test('affine planning preserves ordinary TRS and old factors while extending the continuous bounded shear family', () => {
  for (const matrix of [identity, rotation(0.32), identity.map((v, i) => (i === 0 ? 2 : i === 12 ? 0.1 : v))])
    assert.equal(smartSegmentAffineMatrix(matrix), undefined);
  for (const k of [0.009, 1.001, -0.009, -1.001, 2, -2, 9.9, -9.9]) {
    const matrix = identity.map((v, i) => (i === 4 ? k : v));
    assert.deepEqual(smartSegmentAffineMatrix(matrix), matrix);
    assert.equal(checkedSmartSegmentAffine(matrix).family, 'general');
    const largest = (Math.hypot(k, 2) + Math.abs(k)) / 2;
    assert(largest <= 10 && 1 / largest >= 0.1);
    const result = decomposeSmartSegmentAffine(matrix, points);
    checkedMetadataTransform(result.first_matrix);
    checkedMetadataTransform(result.second_matrix);
  }
  for (const k of [9.9001, -9.9001, 10, -10])
    assert.equal(checkedSmartSegmentAffine(identity.map((v, i) => (i === 4 ? k : v))).family, 'general');
  for (const scale of [0.001, 1000])
    assert.throws(
      () =>
        decomposeSmartSegmentAffine(
          compound.map((v, i) => (i === 0 ? scale : v)),
          points,
        ),
      rejected,
    );
  for (const file of [false, true]) {
    const plan = processingPlan('smartsegment', file ? '/tmp/caller-chosen.glb' : 'owned-task', {
      param: { transform: compound },
      hint: 'two parts',
    });
    assert.deepEqual(plan.smartSegmentAffine?.matrix, compound);
    assert.deepEqual(
      plan.steps.map((entry) => entry.operation),
      ['import_model', 'project_edit', 'segment'],
    );
    assert.match(plan.warnings.join(' '), /source-derived proper rotation/);
    assert.match(plan.warnings.join(' '), /fixed 4e-5/);
  }
  assert.throws(
    () => processingPlan('smartsegment', '/tmp/unsupported.obj', { param: { transform: compound } }),
    { code: 'STUDIO_CAPABILITY_UNAVAILABLE' },
  );
});

for (const file of [false, true])
  test(`general affine ${file ? 'file' : 'task'} binds all native steps and recovers without resubmission`, async () => {
    const f = await affineFixture({ matrix: compound, file });
    try {
      const result = await executePlan(f.app, f.plan(), f.flags);
      assert.equal(result.status, 'success', JSON.stringify(result));
      assert.equal(f.gateway.posts, 7);
      const prepared = object(f.sourcePolicy().preparation);
      assert.equal(prepared.kind, 'general_affine_two_native_trs');
      assert.equal(prepared.family, 'general');
      assert.equal(Object.hasOwn(prepared, 'k'), false);
      assert.equal(object(result.smartsegment_affine_validation).status, 'verified');
      assert.deepEqual(object(result.smartsegment_affine_validation).transform_matrix, compound);
      f.service.config.outputDir = '';
      const resumed = await executePlan(f.app, f.plan(), {
        ...f.flags,
        download: true,
        out: path.join(f.dir, 'general-resume'),
      });
      assert.equal(resumed.status, 'success', JSON.stringify(resumed));
      assert.equal(resumed.download_error, undefined);
      assert.equal(resumed.task_id, result.task_id);
      assert.equal(f.gateway.posts, 7);
    } finally {
      await f.close();
    }
  });
