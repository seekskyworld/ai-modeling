/** 精确来源的网页 Mesh 分流回归；不连接账号、不提交远端任务。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Document } from '@gltf-transform/core';
import { modelIO } from '../cli/local/gltf.ts';
import { inspectSegmentEntityCount } from '../cli/artifacts/segment-entity-count.ts';
import { fingerprint } from '../cli/core/fingerprint.ts';
import {
  segmentResourceFingerprint,
  type SegmentEntitySnapshot,
} from '../studio/api/segment-entity-snapshot.ts';
import {
  prepareSegmentEntitySource,
  assertSegmentEntitySource,
  segmentEntityMetadata,
  type SegmentEntitySource,
} from '../cli/artifacts/segment-entity-source.ts';

const identity = { account_ref: 'test-account', project_id: 'project-1', operator_id: 'operator-1' };
async function model(
  options: { primitives?: number; shared?: boolean; nested?: boolean; modes?: (0 | 1 | 4 | 5 | 6)[] } = {},
): Promise<Buffer> {
  const doc = new Document(),
    buffer = doc.createBuffer(),
    scene = doc.createScene('scene'),
    positions = doc
      .createAccessor()
      .setType('VEC3')
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
      .setBuffer(buffer),
    mesh = doc.createMesh('geometry');
  for (const mode of options.modes ?? Array<4>(options.primitives ?? 1).fill(4))
    mesh.addPrimitive(doc.createPrimitive().setMode(mode).setAttribute('POSITION', positions));
  const first = doc.createNode('first').setMesh(mesh);
  if (options.nested) scene.addChild(doc.createNode('container').addChild(first));
  else scene.addChild(first);
  if (options.shared) scene.addChild(doc.createNode('second').setMesh(mesh));
  return Buffer.from(await (await modelIO()).writeBinary(doc));
}
function changeJson(bytes: Buffer, change: (json: Record<string, unknown>) => void): Buffer {
  const length = bytes.readUInt32LE(12),
    json = JSON.parse(bytes.toString('utf8', 20, 20 + length));
  change(json);
  const text = Buffer.from(JSON.stringify(json)),
    padded = Buffer.alloc(Math.ceil(text.length / 4) * 4, 0x20);
  text.copy(padded);
  const result = Buffer.concat([bytes.subarray(0, 20), padded, bytes.subarray(20 + length)]);
  result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(padded.length, 12);
  return result;
}

test('one root with two primitives is multiple Mesh entities; shared mesh nodes count independently', async () => {
  const single = await inspectSegmentEntityCount(await model({ primitives: 2 })),
    shared = await inspectSegmentEntityCount(await model({ primitives: 2, shared: true }));
  assert.equal(single.entity_count, 2);
  assert.equal(shared.entity_count, 4);
  assert.deepEqual(
    shared.instances.map((i) => [i.name, i.primitive]),
    [
      ['first', 0],
      ['first', 1],
      ['second', 0],
      ['second', 1],
    ],
  );
  const proof = await prepareSegmentEntitySource(await model({ primitives: 2 }), identity, {});
  assert.equal(proof.strategy, 'resegment');
});
test('nested group deletion removes its complete subtree before counting; display rename does not select originals', async () => {
  const bytes = await model({ nested: true, shared: true, primitives: 2 }),
    proof = await prepareSegmentEntitySource(bytes, identity, {
      children_deleted: ['container'],
      children_rename: { second: 'display-name' },
    });
  assert.equal(proof.inspection.before_deletions, 4);
  assert.equal(proof.inspection.entity_count, 2);
  assert.deepEqual(
    proof.inspection.instances.filter((i) => i.deleted).map((i) => i.name),
    ['first', 'first'],
  );
  const otherOrder = await inspectSegmentEntityCount(bytes, ['first', 'container']);
  const parentFirst = await inspectSegmentEntityCount(bytes, ['container', 'first']);
  assert.deepEqual(otherOrder, parentFirst);
  const displayOnly = await prepareSegmentEntitySource(bytes, identity, {
    children_deleted: ['display-name'],
    children_rename: { first: 'display-name' },
  });
  assert.equal(displayOnly.inspection.entity_count, 4);
  assert.equal(
    displayOnly.inspection.instances.some((item) => item.deleted),
    false,
  );
});
test('proven absent prior deletion names preserve original entities and remain bound in complete metadata', async () => {
  for (const shared of [false, true]) {
    const bytes = await model({ shared }),
      metadata = { children_deleted: ['old_part_9'], children_rename: { first: 'friendly' } },
      proof = await prepareSegmentEntitySource(bytes, identity, metadata),
      withoutDeletion = await inspectSegmentEntityCount(bytes);
    assert.deepEqual(proof.inspection, withoutDeletion);
    assert.equal(proof.strategy, shared ? 'resegment' : 'ordinary');
    assert.deepEqual(proof.metadata.children_deleted, ['old_part_9']);
    assertSegmentEntitySource(proof, identity, metadata, bytes);
    assert.throws(
      () => assertSegmentEntitySource(proof, identity, { ...metadata, children_deleted: [] }, bytes),
      { code: 'SEGMENT_ENTITY_SOURCE_CHANGED' },
    );
  }
  const mixed = await inspectSegmentEntityCount(await model({ shared: true }), ['first', 'old_part_9']);
  assert.equal(mixed.entity_count, 1);
  assert.deepEqual(
    mixed.instances.filter((item) => item.deleted).map((item) => item.name),
    ['first'],
  );
});
test('raw-absent selectors that may belong to generated primitive, instance, node or scene names stay unsupported', async () => {
  const bytes = await model({ primitives: 2, shared: true });
  for (const selector of [
    'geometry',
    'geometry_1',
    'geometry_1_instance_0',
    'scene',
    'scene_1',
    'first_1',
    '_instance_0',
    'unsafe.name',
  ])
    await assert.rejects(inspectSegmentEntityCount(bytes, [selector]), {
      code: 'SEGMENT_ENTITY_UNSUPPORTED',
    });
  for (const [originalName, selector] of [
    ['Part One', 'Part_One'],
    ['scene', 'scene_1'],
  ]) {
    const changed = changeJson(bytes, (json) => {
      (json.nodes as Record<string, unknown>[])[0]!.name = originalName;
    });
    await assert.rejects(inspectSegmentEntityCount(changed, [selector!]), {
      code: 'SEGMENT_ENTITY_UNSUPPORTED',
    });
  }
});
test('one remaining Mesh uses ordinary regardless of sticky flags or unrelated material/visibility data', async () => {
  const bytes = await model({ shared: true }),
    metadata = {
      children_deleted: ['first'],
      is_segmented: true,
      visible: false,
      material_factor: { roughness: 0 },
    };
  const proof = await prepareSegmentEntitySource(bytes, identity, metadata);
  assert.equal(proof.strategy, 'ordinary');
  assert.equal(proof.inspection.entity_count, 1);
  assertSegmentEntitySource(proof, identity, metadata, bytes);
  assert.equal(proof.metadata.is_segmented, true);
  const untouched = await prepareSegmentEntitySource(await model(), identity, { is_segmented: true });
  assert.equal(untouched.strategy, 'ordinary');
});
test('Points and Line primitives are not Mesh, while triangle strips and fans each are one Mesh', async () => {
  const result = await inspectSegmentEntityCount(await model({ modes: [0, 1, 4, 5, 6] }));
  assert.deepEqual(
    result.instances.map((i) => i.primitive),
    [2, 3, 4],
  );
  await assert.rejects(prepareSegmentEntitySource(await model({ modes: [0] }), identity, {}), {
    code: 'SEGMENT_ENTITY_EMPTY',
  });
});
test('unused mesh nodes do not become active entities', async () => {
  const bytes = changeJson(await model(), (json) => {
    (json.nodes as unknown[]).push({ name: 'unused', mesh: 0 });
  });
  assert.equal((await inspectSegmentEntityCount(bytes)).entity_count, 1);
});
test('metadata deletion that empties the bound scene cannot be passed to submission', async () => {
  await assert.rejects(
    prepareSegmentEntitySource(await model({ nested: true }), identity, { children_deleted: ['container'] }),
    { code: 'SEGMENT_ENTITY_EMPTY' },
  );
});
test('ambiguous or sanitized deletion selectors are explicitly unsupported rather than guessed', async () => {
  for (const name of ['geometry', 'geometry_7', 'unsafe.name', 'scene', '__proto__']) {
    const bytes = changeJson(await model(), (json) => {
      (json.nodes as Record<string, unknown>[])[0]!.name = name;
    });
    await assert.rejects(inspectSegmentEntityCount(bytes, [name]), { code: 'SEGMENT_ENTITY_UNSUPPORTED' });
    assert.equal((await inspectSegmentEntityCount(bytes)).entity_count, 1);
  }
  const duplicate = changeJson(await model({ shared: true }), (json) => {
    (json.nodes as Record<string, unknown>[])[1]!.name = 'first';
  });
  await assert.rejects(inspectSegmentEntityCount(duplicate, ['first']), {
    code: 'SEGMENT_ENTITY_UNSUPPORTED',
  });
});
test('GPU instancing and other unsupported scene branches are distinct from malformed GLB data', async () => {
  const bytes = await model();
  for (const change of [
    (j: Record<string, unknown>) => {
      (j.nodes as Record<string, unknown>[])[0]!.extensions = { EXT_mesh_gpu_instancing: { attributes: {} } };
    },
    (j: Record<string, unknown>) => {
      j.scenes = [...(j.scenes as unknown[]), { nodes: [] }];
    },
    (j: Record<string, unknown>) => {
      j.animations = [{ channels: [], samplers: [] }];
    },
  ])
    await assert.rejects(inspectSegmentEntityCount(changeJson(bytes, change)), {
      code: 'SEGMENT_ENTITY_UNSUPPORTED',
    });
  await assert.rejects(inspectSegmentEntityCount(bytes.subarray(0, bytes.length - 1)), {
    code: 'INVALID_ARTIFACT',
  });
  await assert.rejects(
    inspectSegmentEntityCount(
      changeJson(bytes, (j) => {
        (j.nodes as Record<string, unknown>[])[0]!.mesh = 99;
      }),
    ),
    { code: 'SEGMENT_ENTITY_INVALID' },
  );
  await assert.rejects(
    inspectSegmentEntityCount(
      changeJson(bytes, (j) => {
        (j.nodes as Record<string, unknown>[])[0]!.children = [0];
      }),
    ),
    { code: 'SEGMENT_ENTITY_INVALID' },
  );
  await assert.rejects(
    inspectSegmentEntityCount(
      changeJson(bytes, (j) => {
        (j.accessors as Record<string, unknown>[])[0]!.count = 99;
      }),
    ),
    (error: unknown) => (error as { code?: string }).code !== 'SEGMENT_ENTITY_UNSUPPORTED',
  );
});
test('unknown extensions cannot downgrade directly readable nonfinite position or invalid index data', async () => {
  const original = await model();
  for (const required of [false, true]) {
    const bytes = changeJson(original, (json) => {
      json.extensionsUsed = ['VENDOR_unverified_entity'];
      if (required) json.extensionsRequired = ['VENDOR_unverified_entity'];
    });
    await assert.rejects(inspectSegmentEntityCount(bytes), { code: 'SEGMENT_ENTITY_UNSUPPORTED' });
    const corruptPosition = Buffer.from(bytes),
      binaryOffset = 20 + bytes.readUInt32LE(12) + 8;
    corruptPosition.writeFloatLE(Number.NaN, binaryOffset);
    await assert.rejects(inspectSegmentEntityCount(corruptPosition), { code: 'SEGMENT_ENTITY_INVALID' });
    const corruptIndex = changeJson(bytes, (json) => {
      const accessors = json.accessors as Record<string, unknown>[],
        primitive = (
          (json.meshes as Record<string, unknown>[])[0]!.primitives as Record<string, unknown>[]
        )[0]!;
      primitive.indices = accessors.length;
      accessors.push({ ...accessors[0], type: 'SCALAR', count: 3, componentType: 5125 });
    });
    corruptIndex.writeUInt32LE(99, 20 + corruptIndex.readUInt32LE(12) + 8);
    await assert.rejects(inspectSegmentEntityCount(corruptIndex), { code: 'SEGMENT_ENTITY_INVALID' });
  }
});
test('all source identity and full metadata fields stay bound, including fields irrelevant to entity count', async () => {
  const bytes = await model(),
    metadata = { extra: { token_free_state: 1 }, children_rename: { first: 'friendly' } },
    proof = await prepareSegmentEntitySource(bytes, identity, metadata);
  for (const key of ['account_ref', 'project_id', 'operator_id'] as const)
    assert.throws(() => assertSegmentEntitySource(proof, { ...identity, [key]: 'changed' }, metadata), {
      code: 'SEGMENT_ENTITY_SOURCE_CHANGED',
    });
  assert.throws(
    () => assertSegmentEntitySource(proof, identity, { ...metadata, extra: { token_free_state: 2 } }),
    { code: 'SEGMENT_ENTITY_SOURCE_CHANGED' },
  );
  for (const change of [
    (p: SegmentEntitySource) => {
      p.strategy = 'resegment';
    },
    (p: SegmentEntitySource) => {
      p.inspection.entity_count = 2;
    },
    (p: SegmentEntitySource) => {
      p.metadata.children_rename = {};
    },
  ]) {
    const changed = structuredClone(proof);
    change(changed);
    assert.throws(() => assertSegmentEntitySource(changed, identity, metadata), {
      code: 'SEGMENT_ENTITY_SOURCE_CHANGED',
    });
  }
  const changed = Buffer.from(bytes);
  changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
  assert.throws(() => assertSegmentEntitySource(proof, identity, metadata, changed), {
    code: 'SEGMENT_ENTITY_SOURCE_CHANGED',
  });
});
test('complete source snapshots persist no signed URL and retain one proof when its signature renews', async () => {
  const bytes = await model(),
    metadata = { viewer_revision: 1 },
    urls = [
      'https://cdn.example/model.glb?part=original&X-Amz-Date=old&X-Amz-Signature=first',
      'https://cdn.example/model.glb?part=original&X-Amz-Date=new&X-Amz-Signature=renewed',
    ],
    snapshots: SegmentEntitySnapshot[] = urls.map((url) => ({
      ...identity,
      url,
      resource_fingerprint: segmentResourceFingerprint(url),
      format: 'glb',
      metadata,
    })),
    proofs = await Promise.all(
      snapshots.map((snapshot) => prepareSegmentEntitySource(bytes, snapshot, snapshot.metadata)),
    ),
    canonical = await prepareSegmentEntitySource(bytes, identity, metadata);
  assert.equal(snapshots[0]!.resource_fingerprint, snapshots[1]!.resource_fingerprint);
  for (const proof of proofs) {
    assert.deepEqual(proof, canonical);
    assert.equal(fingerprint(proof), fingerprint(canonical));
    assert.equal(Object.hasOwn(proof, 'url'), false);
    assert.equal(Object.hasOwn(proof, 'resource_fingerprint'), false);
    assert.doesNotMatch(JSON.stringify(proof), /https?:\/\/|X-Amz-/);
    assertSegmentEntitySource(proof, snapshots[1]!, metadata, bytes);
  }
});
test('preparation freezes caller identity/metadata before await and rejects changed model bytes', async () => {
  const bytes = await model({ shared: true }),
    metadata = { children_deleted: ['first'] },
    mutableIdentity = { ...identity },
    pending = prepareSegmentEntitySource(bytes, mutableIdentity, metadata);
  metadata.children_deleted.length = 0;
  mutableIdentity.operator_id = 'different';
  const proof = await pending;
  assert.equal(proof.operator_id, identity.operator_id);
  assert.equal(proof.inspection.entity_count, 1);
  const changed = Buffer.from(bytes),
    operation = prepareSegmentEntitySource(changed, identity, {});
  changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
  await assert.rejects(operation);
});
test('metadata values are complete JSON and retain global transforms without hiding malformed fields', () => {
  assert.deepEqual(segmentEntityMetadata({}), {
    children_deleted: [],
    children_rename: {},
    children_transform_matrix: {},
    material_factor: {},
  });
  for (const value of [
    { children_deleted: [null] },
    { children_transform_matrix: { first: [1] } },
    { extra: undefined },
    { extra: Infinity },
    { transform_matrix: [1] },
  ])
    assert.throws(() => segmentEntityMetadata(value));
});
