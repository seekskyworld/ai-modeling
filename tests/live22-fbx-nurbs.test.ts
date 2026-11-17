/** 参照完整网页 loader 的96组曲线对照；只扩展已证结构，不将未解析曲线猜成零面。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectModelFaceCount } from '../studio/model-face-count.ts';
import { asciiFbx, binaryFbx, type FbxFixtureNode } from './fixtures/fbx.ts';
import { nurbsFbxNodes } from './fixtures/fbx-nurbs.ts';

function geometry(nodes: FbxFixtureNode[]): FbxFixtureNode {
  return nodes[1]!.children!.find((node) => node.properties?.[0] === 300)!;
}
function replace(nodes: FbxFixtureNode[], name: string, value: string | number | Float64Array): void {
  geometry(nodes).children!.find((node) => node.name === name)!.properties = [value];
}
async function unverified(nodes: FbxFixtureNode[]): Promise<void> {
  for (const encode of [binaryFbx, asciiFbx]) {
    const result = await inspectModelFaceCount(encode(nodes), 'fbx');
    assert.equal(result.verified, false);
    assert.equal(result.face_count, null);
    assert.ok(result.reason);
  }
}

test('FBX valid rational Open/Closed/Periodic curves preserve original mesh polygon counts', async () => {
  for (const form of ['Open', 'Closed', 'Periodic'] as const)
    for (const order of [2, 3, 5, 16])
      for (const mesh of [false, true]) {
        const nodes = nurbsFbxNodes({ form, order, mesh });
        for (const bytes of [
          binaryFbx(nodes),
          binaryFbx(nodes, 7500),
          binaryFbx(nodes, 7400, true),
          asciiFbx(nodes),
        ]) {
          const before = Buffer.from(bytes),
            result = await inspectModelFaceCount(bytes, 'fbx');
          assert.equal(result.verified, true, result.reason);
          assert.equal(result.face_count, mesh ? 3 : 0);
          assert.deepEqual(bytes, before);
        }
      }
});

test('FBX curve instances and curve names do not overwrite mesh modelInfo counts', async () => {
  for (const name of ['mesh', '__proto__', 'part.name']) {
    const nodes = nurbsFbxNodes({ mesh: true });
    nodes[1]!.children!.push({ name: 'Model', properties: [401, name, 'NurbsCurve'], children: [] });
    nodes[2]!.children!.push(
      { name: 'C', properties: ['OO', 300, 401] },
      { name: 'C', properties: ['OO', 401, 0] },
    );
    for (const encode of [binaryFbx, asciiFbx]) {
      const result = await inspectModelFaceCount(encode(nodes), 'fbx');
      assert.equal(result.verified, true, result.reason);
      assert.equal(result.face_count, 3);
    }
  }
});

test('FBX incomplete knots, points, weights, order and unverified forms remain unverified', async () => {
  for (const [name, value] of [
    ['Order', 1],
    ['Order', 17],
    ['Order', '3.5'],
    ['Form', 'Unknown'],
    ['Points', new Float64Array([0, 0, 0, 1])],
    ['Points', new Float64Array(15).fill(1)],
    ['Points', new Float64Array(16)],
    ['KnotVector', new Float64Array([0, 0, 1, 2, 2, 2])],
    ['KnotVector', new Float64Array([0, 0, 0, 2, 1, 2, 2])],
    ['KnotVector', new Float64Array([0, 1, 2, 3, 4, 5, 6])],
    ['KnotVector', new Float64Array(7)],
  ] as const) {
    const nodes = nurbsFbxNodes({ mesh: true });
    replace(nodes, name, value);
    await unverified(nodes);
  }
  const periodic = nurbsFbxNodes({ form: 'Periodic' });
  replace(periodic, 'KnotVector', new Float64Array([0, 1, 2, 3, 3, 5, 6, 7, 8]));
  await unverified(periodic);
});

test('FBX curve model geometry and incoming connection order must remain resolvable', async () => {
  for (const mode of ['missing', 'mesh-as-curve', 'first-child-not-geometry', 'curve-as-mesh']) {
    const nodes = nurbsFbxNodes({ mesh: true }),
      links = nodes[2]!.children!;
    if (mode === 'missing') nodes[2]!.children = links.filter((node) => node.properties?.[1] !== 300);
    if (mode === 'mesh-as-curve') links.push({ name: 'C', properties: ['OO', 100, 400] });
    if (mode === 'first-child-not-geometry') links.unshift({ name: 'C', properties: ['OO', 200, 400] });
    if (mode === 'curve-as-mesh') links.push({ name: 'C', properties: ['OO', 300, 200] });
    await unverified(nodes);
  }
});

test('FBX ignores valid orphan curves but refuses malformed orphan curve evaluation', async () => {
  const nodes = nurbsFbxNodes({ mesh: true });
  nodes[1]!.children = nodes[1]!.children!.filter((node) => node.properties?.[0] !== 400);
  nodes[2]!.children = nodes[2]!.children!.filter(
    (node) => ![300, 400].includes(Number(node.properties?.[1])),
  );
  const result = await inspectModelFaceCount(binaryFbx(nodes), 'fbx');
  assert.equal(result.verified, true, result.reason);
  assert.equal(result.face_count, 3);
  replace(nodes, 'Order', 0);
  await unverified(nodes);
});

test('FBX curve control samples retain bounded work without external resource reads', async (context) => {
  let requests = 0;
  context.mock.method(globalThis, 'fetch', () => {
    requests++;
    throw new Error('Unexpected network');
  });
  const nodes = nurbsFbxNodes({ mesh: true });
  replace(nodes, 'Points', new Float64Array(100001 * 4).fill(1));
  const result = await inspectModelFaceCount(binaryFbx(nodes), 'fbx');
  assert.equal(result.verified, false);
  assert.match(result.reason!, /bounded curve/);
  assert.equal(requests, 0);
});
