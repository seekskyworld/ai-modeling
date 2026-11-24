/** Artifact inspection must prove decoded bytes, not merely recognize file headers or task status. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Document, NodeIO, type Node } from '@gltf-transform/core';
import sharp from 'sharp';
import { artifactInspectSchema, inspectArtifact } from '../cli/local/artifact-inspect.ts';
import { uvImportFixture, uvFixtureChunks, uvFixtureGlb } from './uv-import-fixture.ts';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function withFile(bytes: Buffer, action: (file: string, directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-artifact-inspect-'));
  try {
    const file = path.join(directory, 'artifact.bin');
    await writeFile(file, bytes);
    await action(file, directory);
    assert.deepEqual(await readFile(file), bytes, 'inspection must leave source bytes unchanged');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
async function picture(format: 'png' | 'jpeg' | 'webp' = 'png') {
  return await sharp({
    create: { width: 11, height: 7, channels: 4, background: { r: 220, g: 20, b: 80, alpha: 0.5 } },
  })
    .toFormat(format)
    .toBuffer();
}
async function model(
  options: {
    invalidIndex?: boolean;
    nan?: boolean;
    texture?: Buffer;
    animated?: boolean;
    skin?: boolean;
  } = {},
) {
  const doc = new Document(),
    buffer = doc.createBuffer();
  const accessor = (type: 'VEC3' | 'VEC4' | 'SCALAR' | 'MAT4', values: number[]) =>
    doc.createAccessor().setBuffer(buffer).setType(type).setArray(new Float32Array(values));
  const primitive = doc
    .createPrimitive()
    .setAttribute('POSITION', accessor('VEC3', [options.nan ? NaN : 0, 0, 0, 2, 0, 0, 0, 3, 0]))
    .setIndices(
      doc
        .createAccessor()
        .setBuffer(buffer)
        .setType('SCALAR')
        .setArray(new Uint16Array([0, 1, options.invalidIndex ? 8 : 2])),
    );
  const material = doc.createMaterial('surface');
  if (options.texture)
    material.setBaseColorTexture(
      doc.createTexture('color').setImage(options.texture).setMimeType('image/png'),
    );
  if (options.texture)
    primitive.setAttribute(
      'TEXCOORD_0',
      doc
        .createAccessor()
        .setBuffer(buffer)
        .setType('VEC2')
        .setArray(new Float32Array([0, 0, 1, 0, 0, 1])),
    );
  primitive.setMaterial(material);
  const node = doc
    .createNode('subject')
    .setTranslation([10, 20, 30])
    .setMesh(doc.createMesh().addPrimitive(primitive));
  const scene = doc.createScene().addChild(node);
  doc.getRoot().setDefaultScene(scene);
  if (options.skin) {
    const joint = doc.createNode('joint');
    scene.addChild(joint);
    const skin = doc
      .createSkin('rig')
      .addJoint(joint)
      .setInverseBindMatrices(accessor('MAT4', [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
    node.setSkin(skin);
    primitive.setAttribute(
      'JOINTS_0',
      doc.createAccessor().setBuffer(buffer).setType('VEC4').setArray(new Uint8Array(12)),
    );
    primitive.setAttribute('WEIGHTS_0', accessor('VEC4', [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]));
  }
  if (options.animated) {
    const sampler = doc
      .createAnimationSampler()
      .setInput(accessor('SCALAR', [0, 2]))
      .setOutput(accessor('VEC3', [10, 20, 30, 11, 20, 30]));
    doc
      .createAnimation('move')
      .addSampler(sampler)
      .addChannel(
        doc.createAnimationChannel().setSampler(sampler).setTargetNode(node).setTargetPath('translation'),
      );
  }
  return Buffer.from(await new NodeIO().writeBinary(doc));
}

test('images are fully decoded with exact checksum and dimensions, without claiming visual acceptance', async () => {
  for (const format of ['png', 'jpeg', 'webp'] as const) {
    const bytes = await picture(format);
    await withFile(bytes, async (file, directory) => {
      const result = await inspectArtifact(
        {
          file_path: file,
          expected_sha256: sha(bytes),
          expect: { kind: 'image', width: 11, height: 7, min_width: 10 },
        },
        [directory],
      );
      assert.equal(result.format, format);
      assert.equal(result.bytes, bytes.length);
      assert.equal(result.content_validation, 'complete_image_decode');
      assert.equal(result.requirements_status, 'passed');
      assert.equal(result.status, 'inspected');
      assert.equal(result.visual_review, 'not_checked');
      assert.equal(result.semantic_review, 'not_checked');
      assert.equal(result.visual_review_required, true);
      assert.equal(result.image?.pages, 1);
      assert.equal(result.image?.decoded_pixels, 77);
      assert.equal(result.image?.decoded_sha256.length, 64);
    });
  }
});

test('unmet and inapplicable requirements remain failed; no requirements is not an acceptance pass', async () => {
  await withFile(await picture(), async (file) => {
    const untouched = await inspectArtifact({ file_path: file }, []);
    assert.equal(untouched.requirements_status, 'not_requested');
    const result = await inspectArtifact(
      {
        file_path: file,
        expected_sha256: '0'.repeat(64),
        expect: { width: 50, kind: 'model', min_triangles: 0, textured: false },
      },
      [],
    );
    assert.equal(result.status, 'requirements_failed');
    assert.equal(result.checks.length, 5);
    assert.equal(
      result.checks.every((check) => check.status === 'failed'),
      true,
    );
    assert.equal(result.checks.find((check) => check.requirement === 'min_triangles')?.actual, null);
  });
  assert.equal(
    artifactInspectSchema.safeParse({ file_path: 'file', expect: { min_triangles: 20, max_triangles: 2 } })
      .success,
    false,
  );
  assert.equal(
    artifactInspectSchema.safeParse({ file_path: 'file', expected_sha256: 'incorrect' }).success,
    false,
  );
});

test('valid PNG framing with invalid compressed content does not pass image inspection', async () => {
  const bytes = Buffer.from(await picture());
  const index = bytes.indexOf(Buffer.from('IDAT'));
  assert.ok(index > 0);
  bytes[index + 5] = bytes[index + 5]! ^ 0xff;
  await withFile(bytes, async (file) => {
    await assert.rejects(inspectArtifact({ file_path: file }, []), { code: 'INVALID_ARTIFACT' });
  });
});

test('default-scene model geometry, active materials, textures, rig and animation are inspected', async () => {
  const bytes = await model({ texture: await picture(), animated: true, skin: true });
  await withFile(bytes, async (file) => {
    const result = await inspectArtifact(
      {
        file_path: file,
        expected_sha256: sha(bytes),
        expect: {
          kind: 'model',
          min_triangles: 1,
          max_triangles: 1,
          min_meshes: 1,
          min_materials: 1,
          textured: true,
          skinned: true,
          min_animations: 1,
          animation_names: ['move'],
        },
      },
      [],
    );
    assert.equal(result.requirements_status, 'passed');
    assert.equal(result.content_validation, 'decoded_model_structure');
    assert.equal(result.model?.triangles, 1);
    assert.equal(result.model?.vertices, 3);
    assert.deepEqual(result.model?.bounds.min, [10, 20, 30]);
    assert.deepEqual(result.model?.bounds.max, [12, 23, 30]);
    assert.equal(result.model?.bounds.skinning_applied, false);
    assert.equal(result.model?.textures[0]?.width, 11);
    assert.equal(result.model?.textures[0]?.height, 7);
    assert.equal(result.model?.skins[0]?.joints, 1);
    assert.equal(result.model?.animations[0]?.duration, 2);
    const failed = await inspectArtifact(
      { file_path: file, expect: { max_triangles: 0, animation_names: ['missing'] } },
      [],
    );
    assert.equal(failed.requirements_status, 'failed');
  });
});

test('Meshopt is actually decoded and self-contained textual glTF is accepted', async () => {
  const bytes = await uvImportFixture(true);
  await withFile(bytes, async (file) => {
    const result = await inspectArtifact({ file_path: file }, []);
    assert.equal(result.model?.triangles, 2);
    assert.equal(result.model?.vertices, 4);
    assert.deepEqual(result.model?.bounds.min, [-0.5, -0.5, 0]);
  });
  const io = new NodeIO(),
    doc = await io.readBinary(await model()),
    json = await io.writeJSON(doc);
  for (const b of json.json.buffers ?? [])
    b.uri = 'data:application/octet-stream;base64,' + Buffer.from(json.resources[b.uri!]!).toString('base64');
  await withFile(Buffer.from(JSON.stringify(json.json)), async (file) => {
    const result = await inspectArtifact({ file_path: file }, []);
    assert.equal(result.format, 'gltf');
    assert.equal(result.model?.triangles, 1);
  });
});

test('non-finite coordinates and out-of-range indices fail after actual model decoding', async () => {
  for (const options of [{ invalidIndex: true }, { nan: true }])
    await withFile(await model(options), async (file) => {
      await assert.rejects(inspectArtifact({ file_path: file }, []), { code: 'INVALID_ARTIFACT' });
    });
});

test('untrusted model dependencies, impossible allocations, cycles and empty scenes are rejected', async () => {
  const original = uvFixtureChunks(await model());
  for (const [edit, code] of [
    [
      (json: Record<string, unknown>) => {
        (json.buffers as Record<string, unknown>[])[0]!.uri = 'https://example.invalid/private';
      },
      'INVALID_ARTIFACT',
    ],
    [
      (json: Record<string, unknown>) => {
        (json.accessors as Record<string, unknown>[])[0]!.count = 1_000_000_000;
      },
      'ARTIFACT_INSPECTION_LIMIT',
    ],
    [
      (json: Record<string, unknown>) => {
        (json.nodes as Record<string, unknown>[])[0]!.children = [0];
      },
      'INVALID_ARTIFACT',
    ],
    [
      (json: Record<string, unknown>) => {
        (json.scenes as Record<string, unknown>[])[0]!.nodes = [];
      },
      'INVALID_ARTIFACT',
    ],
  ] as const) {
    const json = structuredClone(original.json);
    edit(json);
    await withFile(uvFixtureGlb(json, original.binary), async (file) => {
      await assert.rejects(inspectArtifact({ file_path: file }, []), { code });
    });
  }
});

test('an embedded texture must fully decode; existing input root restrictions are preserved', async () => {
  const texture = Buffer.from(await picture());
  const offset = texture.indexOf(Buffer.from('IDAT')) + 5;
  texture[offset] = texture[offset]! ^ 0xff;
  await withFile(await model({ texture }), async (file) => {
    await assert.rejects(inspectArtifact({ file_path: file }, []), { code: 'INVALID_ARTIFACT' });
  });
  await withFile(await picture(), async (file, directory) => {
    const allowed = path.join(directory, 'allowed');
    await mkdir(allowed);
    await assert.rejects(inspectArtifact({ file_path: file }, [allowed]), { code: 'INPUT_PATH_DENIED' });
  });
});

test('unsupported formats are explicit, rather than reported as successful or corrupt GLB', async () => {
  await withFile(Buffer.from('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'), async (file) => {
    await assert.rejects(inspectArtifact({ file_path: file }, []), { code: 'UNSUPPORTED_ARTIFACT_FORMAT' });
  });
});

test('skin presence cannot pass inspection without valid vertex influences', async () => {
  const original = await model({ skin: true }),
    io = new NodeIO();
  for (const mutation of ['missing', 'joint', 'zero', 'negative'] as const) {
    const doc = await io.readBinary(original),
      primitive = doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
    if (mutation === 'missing') primitive.setAttribute('WEIGHTS_0', null);
    else if (mutation === 'joint')
      primitive.getAttribute('JOINTS_0')!.setArray(new Uint8Array([9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    else
      primitive
        .getAttribute('WEIGHTS_0')!
        .setArray(
          new Float32Array(
            mutation === 'zero' ? new Array<number>(12).fill(0) : [-1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
          ),
        );
    await withFile(Buffer.from(await io.writeBinary(doc)), async (file) => {
      await assert.rejects(inspectArtifact({ file_path: file, expect: { skinned: true } }, []), {
        code: 'INVALID_ARTIFACT',
      });
    });
  }
});

test('textures require their real UV channel, including texture-transform overrides', async () => {
  const chunks = uvFixtureChunks(await model({ texture: await picture() }));
  const edit = (uv1: boolean) => {
    const json = structuredClone(chunks.json),
      meshes = json.meshes as { primitives: { attributes: Record<string, number> }[] }[];
    const attributes = meshes[0]!.primitives[0]!.attributes;
    if (uv1) attributes.TEXCOORD_1 = attributes.TEXCOORD_0!;
    const materials = json.materials as {
      pbrMetallicRoughness: { baseColorTexture: Record<string, unknown> };
    }[];
    materials[0]!.pbrMetallicRoughness.baseColorTexture.extensions = {
      KHR_texture_transform: { texCoord: 1 },
    };
    json.extensionsUsed = ['KHR_texture_transform'];
    return uvFixtureGlb(json, chunks.binary);
  };
  await withFile(edit(false), async (file) => {
    await assert.rejects(inspectArtifact({ file_path: file }, []), { code: 'INVALID_ARTIFACT' });
  });
  await withFile(edit(true), async (file) => {
    assert.equal(
      (await inspectArtifact({ file_path: file, expect: { textured: true } }, [])).requirements_status,
      'passed',
    );
  });
  const noUv = structuredClone(chunks.json);
  delete (noUv.meshes as { primitives: { attributes: Record<string, number> }[] }[])[0]!.primitives[0]!
    .attributes.TEXCOORD_0;
  await withFile(uvFixtureGlb(noUv, chunks.binary), async (file) => {
    await assert.rejects(inspectArtifact({ file_path: file }, []), { code: 'INVALID_ARTIFACT' });
  });
});

test('an unused textured material cannot satisfy the active-scene textured requirement', async () => {
  const io = new NodeIO(),
    doc = await io.readBinary(await model());
  doc.createMaterial('unused').setBaseColorTexture(
    doc
      .createTexture()
      .setImage(await picture())
      .setMimeType('image/png'),
  );
  await withFile(Buffer.from(await io.writeBinary(doc)), async (file) => {
    const result = await inspectArtifact({ file_path: file, expect: { textured: true } }, []);
    assert.equal(result.model?.textured, false);
    assert.equal(result.requirements_status, 'failed');
  });
});

function addTranslation(doc: Document, target: Node, name: string, times = [0, 1]) {
  const buffer = doc.getRoot().listBuffers()[0]!;
  const sampler = doc
    .createAnimationSampler()
    .setInput(doc.createAccessor().setBuffer(buffer).setType('SCALAR').setArray(new Float32Array(times)))
    .setOutput(
      doc
        .createAccessor()
        .setBuffer(buffer)
        .setType('VEC3')
        .setArray(new Float32Array(times.flatMap((time) => [time, 0, 0]))),
    );
  const clip =
    doc
      .getRoot()
      .listAnimations()
      .find((a) => a.getName() === name) ?? doc.createAnimation(name);
  clip
    .addSampler(sampler)
    .addChannel(
      doc.createAnimationChannel().setSampler(sampler).setTargetNode(target).setTargetPath('translation'),
    );
}

test('empty-node tracks and unrelated long tracks cannot satisfy a model-animation requirement', async () => {
  const io = new NodeIO();
  for (const singleMeshKey of [false, true]) {
    const doc = await io.readBinary(await model()),
      scene = doc.getRoot().getDefaultScene()!;
    const dummy = doc.createNode('unrelated marker');
    scene.addChild(dummy);
    addTranslation(doc, dummy, 'unused', [0, 10]);
    if (singleMeshKey)
      addTranslation(
        doc,
        doc
          .getRoot()
          .listNodes()
          .find((n) => n.getMesh())!,
        'unused',
        [0],
      );
    await withFile(Buffer.from(await io.writeBinary(doc)), async (file) => {
      const result = await inspectArtifact(
        { file_path: file, expect: { min_animations: 1, animation_names: ['unused'] } },
        [],
      );
      assert.equal(result.requirements_status, 'failed');
      assert.equal(result.model?.animations[0]?.duration, 10);
      assert.equal(result.model?.animations[0]?.active_channels, 0);
      assert.equal(result.model?.animations[0]?.active_duration, 0);
    });
  }
});

test('mesh ancestors and actual weighted joints or their ancestors count as geometry animation targets', async () => {
  const io = new NodeIO();
  for (const targetKind of ['mesh-parent', 'joint', 'joint-parent'] as const) {
    const doc = await io.readBinary(await model({ skin: targetKind !== 'mesh-parent' }));
    const scene = doc.getRoot().getDefaultScene()!;
    const target =
      targetKind === 'mesh-parent'
        ? doc
            .getRoot()
            .listNodes()
            .find((n) => n.getMesh())!
        : doc.getRoot().listSkins()[0]!.listJoints()[0]!;
    let animated = target;
    if (targetKind !== 'joint') {
      const parent = doc.createNode('animated parent');
      scene.removeChild(target).addChild(parent);
      parent.addChild(target);
      animated = parent;
    }
    addTranslation(doc, animated, 'valid', [2, 4]);
    const marker = doc.createNode('unrelated long marker');
    scene.addChild(marker);
    addTranslation(doc, marker, 'valid', [0, 100]);
    await withFile(Buffer.from(await io.writeBinary(doc)), async (file) => {
      const result = await inspectArtifact(
        { file_path: file, expect: { min_animations: 1, animation_names: ['valid'] } },
        [],
      );
      assert.equal(result.requirements_status, 'passed');
      assert.equal(result.model?.animations[0]?.duration, 100);
      assert.equal(result.model?.animations[0]?.active_start, 2);
      assert.equal(result.model?.animations[0]?.active_duration, 2);
      assert.equal(result.model?.animations[0]?.active_channels, 1);
    });
  }
});

test('a declared but unweighted skin joint does not establish model animation', async () => {
  const io = new NodeIO(),
    doc = await io.readBinary(await model({ skin: true }));
  const unused = doc.createNode('unused joint');
  doc.getRoot().getDefaultScene()!.addChild(unused);
  doc.getRoot().listSkins()[0]!.addJoint(unused).setInverseBindMatrices(null);
  addTranslation(doc, unused, 'unused joint clip');
  await withFile(Buffer.from(await io.writeBinary(doc)), async (file) => {
    const result = await inspectArtifact(
      { file_path: file, expect: { min_animations: 1, animation_names: ['unused joint clip'] } },
      [],
    );
    assert.equal(result.requirements_status, 'failed');
    assert.equal(result.model?.animations[0]?.active_channels, 0);
  });
});

test('real morph-weight tracks count, without requiring a semantic movement or nonconstant pose', async () => {
  const io = new NodeIO(),
    doc = await io.readBinary(await model());
  const node = doc
      .getRoot()
      .listNodes()
      .find((n) => n.getMesh())!,
    buffer = doc.getRoot().listBuffers()[0]!;
  node
    .getMesh()!
    .listPrimitives()[0]!
    .addTarget(
      doc.createPrimitiveTarget().setAttribute(
        'POSITION',
        doc
          .createAccessor()
          .setBuffer(buffer)
          .setType('VEC3')
          .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 0])),
      ),
    );
  node.getMesh()!.setWeights([0]);
  const sampler = doc
    .createAnimationSampler()
    .setInput(
      doc
        .createAccessor()
        .setBuffer(buffer)
        .setType('SCALAR')
        .setArray(new Float32Array([0, 1])),
    )
    .setOutput(
      doc
        .createAccessor()
        .setBuffer(buffer)
        .setType('SCALAR')
        .setArray(new Float32Array([0.5, 0.5])),
    );
  doc
    .createAnimation('held morph')
    .addSampler(sampler)
    .addChannel(
      doc.createAnimationChannel().setSampler(sampler).setTargetNode(node).setTargetPath('weights'),
    );
  await withFile(Buffer.from(await io.writeBinary(doc)), async (file) => {
    const result = await inspectArtifact(
      { file_path: file, expect: { min_animations: 1, animation_names: ['held morph'] } },
      [],
    );
    assert.equal(result.requirements_status, 'passed');
    assert.equal(result.model?.animations[0]?.active_channels, 1);
    assert.equal(result.semantic_review, 'not_checked');
  });
});
