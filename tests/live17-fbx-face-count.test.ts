/** 原始多边形、实例/名称与畸形输入直接影响 Canvas 上限，不能退化成渲染三角形计数。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectModelFaceCount } from '../studio/model-face-count.ts';
import { FbxBudget } from '../studio/fbx/structure.ts';
import { asciiFbx, binaryFbx, staticFbxNodes, type FbxFixtureNode } from './fixtures/fbx.ts';

async function count(bytes: Buffer): Promise<number> {
  const result = await inspectModelFaceCount(bytes, 'fbx');
  assert.equal(result.verified, true, result.reason);
  return result.face_count!;
}

async function unverified(bytes: Buffer): Promise<void> {
  const result = await inspectModelFaceCount(bytes, 'fbx');
  assert.equal(result.verified, false);
  assert.equal(result.face_count, null);
  assert.ok(result.reason);
}

test('FBX 32/64-bit headers and compressed arrays count original polygons instead of triangulated faces', async () => {
  for (const version of [7400, 7500])
    for (const compressed of [false, true]) {
      const bytes = binaryFbx(staticFbxNodes(), version, compressed);
      const before = Buffer.from(bytes);
      assert.equal(await count(bytes), 3);
      assert.deepEqual(bytes, before);
    }
  assert.equal(await count(asciiFbx(staticFbxNodes())), 3);
});

test('FBX counts connected instances but preserves webpage sanitized-name overwrite semantics', async () => {
  for (const [names, expected] of [
    [['a', 'b'], 6],
    [['same', 'same'], 3],
    [['part.name', 'partname'], 3],
    [['part 1', 'part_1'], 3],
    [['part_1', 'part', 'part'], 6],
    [['', ''], 3],
  ] as const)
    for (const encode of [binaryFbx, asciiFbx])
      assert.equal(await count(encode(staticFbxNodes([...names]))), expected);
  assert.equal(await count(binaryFbx(staticFbxNodes(['mesh', '__proto__']))), 3);
  assert.equal(await count(binaryFbx(staticFbxNodes(['__proto__', '__proto__']))), 6);
});

test('FBX ignores disconnected geometry and uses the last connected geometry for each Mesh', async () => {
  const nodes = staticFbxNodes();
  const geometry = structuredClone(nodes[1]!.children![0]!) as FbxFixtureNode;
  geometry.properties![0] = 101;
  geometry.children![1]!.properties = [new Int32Array([0, 1, -3])];
  nodes[1]!.children!.push(geometry);
  assert.equal(await count(binaryFbx(nodes)), 3);
  nodes[2]!.children!.push({ name: 'C', properties: ['OO', 101, 200] });
  assert.equal(await count(binaryFbx(nodes)), 1);
  assert.equal(await count(asciiFbx(nodes)), 1);
  nodes[2]!.children!.push({ name: 'C', properties: ['OO', 100, 200] });
  assert.equal(await count(binaryFbx(nodes)), 3);
});

test('FBX malformed deformer/pose and polygon structures remain explicitly unverified', async () => {
  for (const name of ['Deformer', 'Pose']) {
    const nodes = staticFbxNodes();
    nodes[1]!.children!.push({
      name,
      properties: [300, 'unsupported', name === 'Pose' ? 'BindPose' : 'Skin'],
    });
    await unverified(binaryFbx(nodes));
  }
  for (const indices of [[0, -2], [0, 1, 2], [0, 1, -99], [0, 1, -2.5], []]) {
    const nodes = staticFbxNodes();
    nodes[1]!.children![0]!.children![1]!.properties = [new Float64Array(indices)];
    await unverified(binaryFbx(nodes));
    await unverified(asciiFbx(nodes));
  }
  const nodes = staticFbxNodes();
  nodes[1]!.children![1]!.properties![2] = 'LimbNode';
  assert.equal(await count(binaryFbx(nodes)), 0);
  const disconnectedParent = staticFbxNodes();
  disconnectedParent[2]!.children!.unshift({ name: 'C', properties: ['OO', 100, 999] });
  await unverified(binaryFbx(disconnectedParent));
});

test('FBX ASCII only verifies the actual webpage tab layout and complete property/array separators', async () => {
  const text = asciiFbx(staticFbxNodes()).toString();
  for (const invalid of [
    text.replace('200, "mesh", "Mesh"', '200 "mesh" "Mesh"'),
    text.replace('200, "mesh", "Mesh"', '200,, "mesh", "Mesh"'),
    text.replace('200, "mesh", "Mesh"', '200, "mesh", "Mesh",'),
    text.replaceAll('\t', '  '),
    text.replace('*15 {\n\t\t\ta: ', '*15 { a: '),
    text.replace('0,1,-3,0,1,2,-4,0,1,2,3,-5', '0,1,-3,0,1,2,-4,0,1,2,3,-5,'),
  ])
    await unverified(Buffer.from(invalid));
  const continued = text.replace('a: 0,1,-3,0,1,2,-4,0,1,2,3,-5', 'a: 0,1,-3,\n0,1,2,-4,\n0,1,2,3,-5');
  assert.equal(await count(Buffer.from(continued)), 3);
});

test('FBX binary validates safe offsets, truncation and declared/decompressed array lengths', async () => {
  const source = binaryFbx(staticFbxNodes(), 7500, true);
  const oversizedOffset = Buffer.from(source);
  oversizedOffset.writeBigUInt64LE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 27);
  await unverified(oversizedOffset);
  await unverified(source.subarray(0, source.length - 250));
  const marker = Buffer.from('Vertices');
  const propertyOffset = source.indexOf(marker) + marker.length;
  for (const length of [0, 1, 14, 16, 0xffffffff]) {
    const bad = Buffer.from(source);
    bad.writeUInt32LE(length, propertyOffset + 1);
    await unverified(bad);
  }
  const invalidEncoding = Buffer.from(source);
  invalidEncoding.writeUInt32LE(2, propertyOffset + 5);
  await unverified(invalidEncoding);
  const brokenPayload = Buffer.from(source);
  brokenPayload[propertyOffset + 13] = brokenPayload[propertyOffset + 13]! ^ 0xff;
  await unverified(brokenPayload);
  const raw = binaryFbx(staticFbxNodes());
  const rawOffset = raw.indexOf(marker) + marker.length;
  raw.writeUInt32LE(1, rawOffset + 9);
  await unverified(raw);
});

test('FBX cumulative allocation, nesting and cyclic model graphs fail without a guessed count', async () => {
  const budget = new FbxBudget();
  budget.array(20_000_000, 1);
  assert.throws(() => budget.array(20_000_000, 1), /cumulative/);
  const root: FbxFixtureNode = { name: 'Root', children: [] };
  let current = root;
  for (let index = 0; index < 66; index++) {
    const child = { name: 'Next', children: [] };
    current.children!.push(child);
    current = child;
  }
  await unverified(binaryFbx([root]));
  const nodes = staticFbxNodes(['a', 'b']);
  nodes[2]!.children!.push(
    { name: 'C', properties: ['OO', 200, 201] },
    { name: 'C', properties: ['OO', 201, 200] },
  );
  await unverified(binaryFbx(nodes));
});

test('FBX embedded or external texture metadata cannot trigger local/network reads', async (context) => {
  let requests = 0;
  context.mock.method(globalThis, 'fetch', () => {
    requests++;
    throw new Error('Unexpected network');
  });
  const nodes = staticFbxNodes();
  nodes[1]!.children!.push({
    name: 'Video',
    properties: [300, 'image', 'Clip'],
    children: [
      { name: 'Filename', properties: ['https://example.com/secret.png'] },
      { name: 'RelativeFilename', properties: ['/private/do-not-read.png'] },
    ],
  });
  assert.equal(await count(binaryFbx(nodes)), 3);
  assert.equal(await count(asciiFbx(nodes)), 3);
  assert.equal(requests, 0);
});
