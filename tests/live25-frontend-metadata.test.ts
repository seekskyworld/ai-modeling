/** 新网页材质覆盖必须贯穿源状态、转换、授权和恢复；轴向证明仍核完整有向表面。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { mat4 } from 'gl-matrix';
import { fixture } from './helpers.ts';
import { StudioClient } from '../studio/api/client.ts';
import { frontendExportSource } from '../studio/api/frontend-export-source.ts';
import { exportFrontend, type FrontendExportRuntime } from '../cli/core/frontend-export.ts';
import { verifyStudioFrontend } from '../cli/artifacts/studio-assimp-proof.ts';
import { frontendSourceMetadataMatches } from '../cli/core/frontend-output.ts';
import { processingPlan } from '../cli/compat/planning.ts';
import { object, text } from '../studio/contracts/errors.ts';
import {
  isStudioFrontendMetadata,
  type StudioFrontendMetadata,
} from '../studio/contracts/frontend-export.ts';

const io = new NodeIO();
async function sourceBytes(): Promise<Buffer> {
  const doc = new Document(),
    buffer = doc.createBuffer(),
    scene = doc.createScene();
  doc.getRoot().setDefaultScene(scene);
  const positions = doc
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array([2, 1, 3, 4, 1, 3, 2, 5, 3]))
    .setBuffer(buffer);
  const normals = doc
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]))
    .setBuffer(buffer);
  const material = doc.createMaterial('material').setMetallicFactor(0.35).setRoughnessFactor(0.6);
  scene.addChild(
    doc
      .createNode('mesh')
      .setMesh(
        doc
          .createMesh('mesh')
          .addPrimitive(
            doc
              .createPrimitive()
              .setAttribute('POSITION', positions)
              .setAttribute('NORMAL', normals)
              .setMaterial(material),
          ),
      ),
  );
  return Buffer.from(await io.writeBinary(doc));
}
async function converted(source: Buffer, metadata: StudioFrontendMetadata) {
  const doc = await io.readBinary(source),
    node = doc.getRoot().listNodes()[0]!,
    matrix = mat4.create();
  const axes = { '+x': Math.PI, '-x': 0, '+y': Math.PI / 2, '-y': -Math.PI / 2 } as const;
  mat4.rotateY(matrix, matrix, axes[metadata.forward_axis]);
  if (metadata.pivot_to_center_bottom) mat4.translate(matrix, matrix, [-3, -1, -3]);
  node.setMatrix(Array.from(matrix) as ReturnType<typeof node.getMatrix>);
  if (metadata.material_factor)
    for (const material of doc.getRoot().listMaterials())
      material
        .setMetallicFactor(metadata.material_factor.metallic)
        .setRoughnessFactor(metadata.material_factor.roughness);
  const bytes = Buffer.from(await io.writeBinary(doc));
  return { bytes, proof: await verifyStudioFrontend(source, bytes, metadata) };
}

async function twoRoots(unnamedMeshes = false): Promise<Buffer> {
  const doc = await io.readBinary(await sourceBytes()),
    original = doc.getRoot().listMeshes()[0]!;
  const second = doc.createMesh('otherMesh').addPrimitive(original.listPrimitives()[0]!.clone());
  doc
    .getRoot()
    .listScenes()[0]!
    .addChild(doc.createNode('survivor').setMesh(second).setTranslation([10, 0, 0]));
  if (unnamedMeshes) for (const mesh of doc.getRoot().listMeshes()) mesh.setName('');
  return Buffer.from(await io.writeBinary(doc));
}

test('static world pivot is identical with absent, root-identity and child-identity metadata', async () => {
  const source = await twoRoots(),
    target = await io.readBinary(source),
    scene = target.getRoot().listScenes()[0]!;
  const children = scene.listChildren(),
    root = target.createNode('ROOT').setTranslation([-8, -1, -3]);
  for (const node of children) {
    scene.removeChild(node);
    root.addChild(node);
  }
  scene.addChild(root);
  const bytes = Buffer.from(await io.writeBinary(target)),
    identity = Array.from(mat4.create());
  for (const edit of [
    {},
    { transform_matrix: identity },
    { children_transform_matrix: { survivor: identity } },
  ]) {
    const proof = await verifyStudioFrontend(source, bytes, {
      forward_axis: '-x',
      pivot_to_center_bottom: true,
      ...edit,
    });
    assert.equal(proof.faces, 2);
    assert.deepEqual(proof.pivot_from_editor_world_bounds, [8, 1, 3]);
    assert.equal(object(proof.editor_metadata_mapping).retained_meshes, 2);
  }
});

test('explicit scene deletion verifies the original orphan mesh including unnamed mesh inputs', async () => {
  for (const unnamed of [false, true]) {
    const source = await twoRoots(unnamed),
      output = await io.readBinary(source);
    output
      .getRoot()
      .listNodes()
      .find((node) => node.getName() === 'mesh')!
      .dispose();
    const bytes = Buffer.from(await io.writeBinary(output));
    const proof = await verifyStudioFrontend(source, bytes, {
      forward_axis: '-x',
      pivot_to_center_bottom: false,
      children_deleted: ['mesh'],
    });
    assert.equal(proof.faces, 1);
    assert.equal(proof.retained_unreferenced_faces, 1);
    const retained = (proof.deleted_meshes_retained_by_webpage as Record<string, unknown>[])[0]!;
    assert.equal(retained.source_node, 'mesh');
    assert.match(text(retained.interpretation), /not removal of geometry bytes/);
    assert.equal(
      retained.matching,
      unnamed ? 'unique_complete_original_surface' : 'unique_original_mesh_name_and_complete_surface',
    );
    await assert.rejects(
      verifyStudioFrontend(source, bytes, { forward_axis: '-x', pivot_to_center_bottom: false }),
      { code: 'FRONTEND_EXPORT_UNVERIFIED' },
    );
  }
});

test('implicit glTF material matches only the exact explicit default or requested PBR factors', async () => {
  const source = await io.readBinary(await sourceBytes());
  for (const material of source.getRoot().listMaterials()) material.dispose();
  const input = Buffer.from(await io.writeBinary(source));
  for (const factor of [undefined, { metallic: 0.7, roughness: 0.2 }]) {
    const metadata: StudioFrontendMetadata = {
      forward_axis: '-x',
      pivot_to_center_bottom: false,
      ...(factor ? { material_factor: factor } : {}),
    };
    for (const change of ['none', 'color', 'metallic', 'roughness', 'double-sided', 'alpha']) {
      const target = await io.readBinary(input),
        material = target.createMaterial('webpage-default');
      if (factor) material.setMetallicFactor(factor.metallic).setRoughnessFactor(factor.roughness);
      if (change === 'color') material.setBaseColorFactor([0.7, 1, 1, 1]);
      if (change === 'metallic') material.setMetallicFactor(0.2);
      if (change === 'roughness') material.setRoughnessFactor(0.6);
      if (change === 'double-sided') material.setDoubleSided(true);
      if (change === 'alpha') material.setAlphaMode('BLEND');
      target.getRoot().listMeshes()[0]!.listPrimitives()[0]!.setMaterial(material);
      const output = Buffer.from(await io.writeBinary(target));
      if (change === 'none') assert.equal((await verifyStudioFrontend(input, output, metadata)).faces, 1);
      else
        await assert.rejects(verifyStudioFrontend(input, output, metadata), {
          code: 'FRONTEND_EXPORT_UNVERIFIED',
        });
    }
  }
});

test('scene deletion preserves implicit default materials on visible and retained orphan meshes', async () => {
  const source = await io.readBinary(await twoRoots(true));
  for (const material of source.getRoot().listMaterials()) material.dispose();
  const input = Buffer.from(await io.writeBinary(source));
  source
    .getRoot()
    .listNodes()
    .find((node) => node.getName() === 'mesh')!
    .dispose();
  const material = source.createMaterial('webpage-default');
  for (const mesh of source.getRoot().listMeshes()) mesh.listPrimitives()[0]!.setMaterial(material);
  const proof = await verifyStudioFrontend(input, Buffer.from(await io.writeBinary(source)), {
    forward_axis: '-x',
    pivot_to_center_bottom: false,
    children_deleted: ['mesh'],
  });
  assert.equal(proof.faces, 1);
  assert.equal(proof.retained_unreferenced_faces, 1);
});

test('scene deletion rejects changed, duplicated, unknown, reattached and ambiguous orphan geometry', async () => {
  const source = await twoRoots(true),
    metadata = { forward_axis: '-x', pivot_to_center_bottom: false, children_deleted: ['mesh'] } as const;
  for (const change of ['position', 'normal', 'material', 'duplicate', 'reattach']) {
    const output = await io.readBinary(source),
      removed = output
        .getRoot()
        .listNodes()
        .find((n) => n.getName() === 'mesh')!,
      mesh = removed.getMesh()!;
    removed.dispose();
    const primitive = mesh.listPrimitives()[0]!;
    if (change === 'position')
      primitive.setAttribute(
        'POSITION',
        primitive
          .getAttribute('POSITION')!
          .clone()
          .setArray(new Float32Array([9, 1, 3, 4, 1, 3, 2, 5, 3])),
      );
    if (change === 'normal')
      primitive.setAttribute(
        'NORMAL',
        primitive
          .getAttribute('NORMAL')!
          .clone()
          .setArray(new Float32Array([0, 0, -1, 0, 0, -1, 0, 0, -1])),
      );
    if (change === 'material')
      primitive.setMaterial(primitive.getMaterial()!.clone().setRoughnessFactor(0.9));
    if (change === 'duplicate') output.createMesh().addPrimitive(primitive.clone());
    if (change === 'reattach')
      output.getRoot().listScenes()[0]!.addChild(output.createNode('unexpected').setMesh(mesh));
    await assert.rejects(
      verifyStudioFrontend(source, Buffer.from(await io.writeBinary(output)), {
        ...metadata,
        children_deleted: [...metadata.children_deleted],
      }),
      { code: 'FRONTEND_EXPORT_UNVERIFIED' },
    );
  }
  const ambiguous = await io.readBinary(source),
    original = ambiguous.getRoot().listMeshes()[0]!;
  ambiguous
    .getRoot()
    .listScenes()[0]!
    .addChild(
      ambiguous
        .createNode('secondDeleted')
        .setMesh(ambiguous.createMesh().addPrimitive(original.listPrimitives()[0]!.clone())),
    );
  const input = Buffer.from(await io.writeBinary(ambiguous));
  for (const node of ambiguous.getRoot().listNodes())
    if (['mesh', 'secondDeleted'].includes(node.getName())) node.dispose();
  await assert.rejects(
    verifyStudioFrontend(input, Buffer.from(await io.writeBinary(ambiguous)), {
      forward_axis: '-x',
      pivot_to_center_bottom: false,
      children_deleted: ['mesh', 'secondDeleted'],
    }),
    { code: 'FRONTEND_EXPORT_UNVERIFIED' },
  );
});

test('four axes and explicit pivot switches preserve complete geometry and reject wrong transforms/materials', async () => {
  const source = await sourceBytes();
  for (const forward_axis of ['+x', '-x', '+y', '-y'] as const)
    for (const pivot_to_center_bottom of [false, true]) {
      const metadata = {
        forward_axis,
        pivot_to_center_bottom,
        material_factor: { metallic: 0.7, roughness: 0.2 },
      };
      const result = await converted(source, metadata);
      assert.equal(result.proof.faces, 1);
      assert.equal(object(result.proof.material_factor_mapping).applied_to_all_source_materials, true);
      assert.equal(isStudioFrontendMetadata(metadata), true);
      await assert.rejects(
        verifyStudioFrontend(source, result.bytes, {
          ...metadata,
          forward_axis: forward_axis === '-y' ? '+y' : '-y',
        }),
        { code: 'FRONTEND_EXPORT_UNVERIFIED' },
      );
      await assert.rejects(
        verifyStudioFrontend(source, result.bytes, {
          ...metadata,
          pivot_to_center_bottom: !pivot_to_center_bottom,
        }),
        { code: 'FRONTEND_EXPORT_UNVERIFIED' },
      );
      await assert.rejects(
        verifyStudioFrontend(source, result.bytes, {
          ...metadata,
          material_factor: { metallic: 0.7, roughness: 0.3 },
        }),
        { code: 'FRONTEND_EXPORT_UNVERIFIED' },
      );
      await assert.rejects(
        verifyStudioFrontend(source, result.bytes, { forward_axis, pivot_to_center_bottom }),
        { code: 'FRONTEND_EXPORT_UNVERIFIED' },
      );
    }
});

test('material schema rejects out-of-range, incomplete and extra properties', () => {
  for (const material_factor of [
    null,
    {},
    { metallic: 0.5 },
    { metallic: 0.5, roughness: NaN },
    { metallic: -0.1, roughness: 0.5 },
    { metallic: 0.5, roughness: 1.1 },
    { metallic: '0.5', roughness: 0.5 },
    { metallic: 0.5, roughness: 0.5, opacity: 0.5 },
  ])
    assert.equal(
      isStudioFrontendMetadata({ forward_axis: '-y', pivot_to_center_bottom: true, material_factor }),
      false,
    );
});

test('display names are frozen but preserve original file names under the webpage contract', async () => {
  const source = await sourceBytes(),
    metadata: StudioFrontendMetadata = {
      forward_axis: '-x',
      pivot_to_center_bottom: false,
      children_rename: { mesh: '网页显示名' },
    };
  const proof = await verifyStudioFrontend(source, source, metadata);
  assert.deepEqual(
    object(object(proof.editor_metadata_mapping).display_name_mapping).names,
    metadata.children_rename,
  );
  assert.equal(
    object(object(proof.editor_metadata_mapping).display_name_mapping).file_names,
    'original_source_names',
  );
  const changed = await io.readBinary(source);
  changed.getRoot().listNodes()[0]!.setName('网页显示名');
  await assert.rejects(verifyStudioFrontend(source, Buffer.from(await io.writeBinary(changed)), metadata), {
    code: 'FRONTEND_EXPORT_UNVERIFIED',
  });
  await assert.rejects(
    verifyStudioFrontend(source, source, { ...metadata, children_rename: { missing: 'label' } }),
    {
      code: 'FRONTEND_EXPORT_UNVERIFIED',
    },
  );
  const input = { forward_axis: '-x', pivot_to_center_bottom: false },
    frozen = {
      version: 2,
      input,
      source_is_pbr: false,
      source_metadata: { children_rename: metadata.children_rename },
      conversion: { metadata },
    };
  assert.equal(frontendSourceMetadataMatches(frozen), true);
  // 实际SQLite保存为JSON；序列化后源快照与转换metadata不会共享同一个map引用。
  const altered = JSON.parse(JSON.stringify(frozen)) as typeof frozen;
  assert.ok(altered.source_metadata.children_rename);
  altered.source_metadata.children_rename.mesh = 'different';
  assert.equal(frontendSourceMetadataMatches(altered), false);
  assert.equal(frontendSourceMetadataMatches({ ...frozen, source_metadata: {} }), false);
  assert.equal(frontendSourceMetadataMatches({ ...frozen, version: 1 }), false);
});

test('rename metadata does not expand animation support and malformed labels fail validation', async () => {
  for (const children_rename of [
    [],
    '',
    { mesh: 1 },
    { mesh: '' },
    { mesh: 'x'.repeat(101) },
    { '': 'label' },
  ])
    assert.equal(
      isStudioFrontendMetadata({ forward_axis: '-y', pivot_to_center_bottom: true, children_rename }),
      false,
    );
  const source = await io.readBinary(await sourceBytes()),
    buffer = source.getRoot().listBuffers()[0]!,
    input = source
      .createAccessor()
      .setType('SCALAR')
      .setArray(new Float32Array([0, 1]))
      .setBuffer(buffer),
    output = source
      .createAccessor()
      .setType('VEC3')
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0]))
      .setBuffer(buffer),
    sampler = source.createAnimationSampler().setInput(input).setOutput(output).setInterpolation('LINEAR'),
    channel = source
      .createAnimationChannel()
      .setSampler(sampler)
      .setTargetNode(source.getRoot().listNodes()[0]!)
      .setTargetPath('translation');
  source.createAnimation('clip').addChannel(channel).addSampler(sampler);
  const bytes = Buffer.from(await io.writeBinary(source));
  await assert.rejects(
    verifyStudioFrontend(bytes, bytes, {
      forward_axis: '-x',
      pivot_to_center_bottom: false,
      children_rename: { mesh: 'label' },
    }),
    { code: 'FRONTEND_EXPORT_UNVERIFIED' },
  );
});

async function setup(isPbr: boolean, factor = { metallic: 0.7, roughness: 0.2 }) {
  const f = await fixture(),
    source = await sourceBytes();
  const detail = {
    id: 'metadata-project',
    is_owner: true,
    project_name: 'metadata-source',
    model_url: 'https://cdn.tripo3d.ai/source.glb',
    operator: {
      operator_id: 'metadata-operator',
      status: 'success',
      is_pbr: isPbr,
      metadata: { material_factor: factor },
    },
  };
  const counts = { source: 0, read: 0, convert: 0 },
    passed: StudioFrontendMetadata[] = [];
  const client = new StudioClient(f.service.credentials, async (_url, init) => {
    assert.equal(init.method, 'GET');
    counts.source++;
    return Response.json({ code: 0, data: detail });
  });
  const input = {
    project_id: detail.id,
    operator_id: detail.operator.operator_id,
    request_id: 'live25-metadata',
    destination_path: path.join(f.dir, 'output', 'metadata.glb'),
    forward_axis: '+y' as const,
    pivot_to_center_bottom: false,
    max_credits: 10,
  };
  const runtime: FrontendExportRuntime = {
    read: async () => {
      counts.read++;
      return source;
    },
    convert: async (bytes, options) => {
      counts.convert++;
      passed.push(options.metadata);
      return converted(bytes, options.metadata);
    },
  };
  f.gateway.submit = async () => {
    f.gateway.posts++;
    return {
      remote_ids: { project_id: input.project_id, operator_id: input.operator_id },
      status: { state: 'succeeded', progress: 100, artifacts: [] },
    };
  };
  const run = () => exportFrontend(f.service, client, input, runtime);
  return { ...f, detail, client, input, runtime, run, counts, passed };
}

test('webpage is_pbr selects material overrides; successful restart restores original bytes without any source or new submission', async () => {
  for (const isPbr of [true, false]) {
    const f = await setup(isPbr);
    let restarted: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      const result = await f.run(),
        proof = f.jobs.requestPolicy('test-account', `frontend-export-proof:${f.input.request_id}`)!;
      assert.equal(proof.version, 2);
      assert.equal(proof.source_is_pbr, isPbr);
      assert.equal(frontendSourceMetadataMatches(proof), true);
      assert.deepEqual(
        f.passed[0]?.material_factor,
        isPbr ? f.detail.operator.metadata.material_factor : undefined,
      );
      const bytes = await readFile(f.input.destination_path),
        root = (await io.readBinary(bytes)).getRoot();
      assert.ok(Math.abs(root.listMaterials()[0]!.getMetallicFactor() - (isPbr ? 0.7 : 0.35)) < 1e-6);
      assert.ok(Math.abs(root.listMaterials()[0]!.getRoughnessFactor() - (isPbr ? 0.2 : 0.6)) < 1e-6);
      assert.deepEqual(f.counts, { source: 2, read: 1, convert: 1 });
      assert.equal(f.gateway.posts, 1);
      restarted = await fixture(f.dir);
      const forbidden = async (): Promise<never> => {
        throw Error('No source, conversion or remote operation during recovery');
      };
      restarted.gateway.submit = forbidden;
      restarted.gateway.status = forbidden;
      restarted.gateway.artifactUrl = forbidden;
      const destination = path.join(f.dir, 'output', 'restarted.glb');
      const recovered = await exportFrontend(
        restarted.service,
        f.client,
        { ...f.input, destination_path: destination },
        { source: forbidden, read: forbidden, convert: forbidden },
      );
      assert.equal(recovered.job_id, result.job_id);
      assert.deepEqual(await readFile(destination), bytes);
      assert.equal((await restarted.service.get(text(result.job_id))).state, 'succeeded');
      assert.equal(restarted.jobs.list('test-account').length, 1);
      const wrong = structuredClone(proof);
      wrong.source_is_pbr = !isPbr;
      assert.equal(frontendSourceMetadataMatches(wrong), false);
      const changed = structuredClone(proof);
      object(changed.input).forward_axis = '+x';
      assert.equal(frontendSourceMetadataMatches(changed), false);
    } finally {
      restarted?.jobs.close();
      f.jobs.close();
      await rm(f.dir, { recursive: true, force: true });
    }
  }
});

test('is_pbr flip or material metadata edit before authorization fails with zero upstream submissions', async () => {
  for (const changed of ['flag', 'factor']) {
    const f = await setup(true);
    try {
      const convert = f.runtime.convert!;
      f.runtime.convert = async (...args) => {
        const result = await convert(...args);
        if (changed === 'flag') f.detail.operator.is_pbr = false;
        else f.detail.operator.metadata.material_factor.roughness = 0.4;
        return result;
      };
      await assert.rejects(f.run(), { code: 'PROJECT_CHANGED' });
      assert.equal(f.gateway.posts, 0);
      assert.equal(f.jobs.list('test-account').length, 0);
    } finally {
      f.jobs.close();
      await rm(f.dir, { recursive: true, force: true });
    }
  }
});

test('malformed PBR factors cannot be masked by source selection or empty metadata', async () => {
  const f = await setup(true);
  try {
    for (const value of [null, {}, { metallic: 0.5 }, { metallic: 0.5, roughness: 4 }]) {
      (f.detail.operator.metadata as Record<string, unknown>).material_factor = value;
      await assert.rejects(
        frontendExportSource(f.client, 'test-account', f.input.project_id, f.input.operator_id),
        { code: 'FRONTEND_SOURCE_UNSUPPORTED' },
      );
    }
  } finally {
    f.jobs.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('official animated explicit convert accepts all four axis/pivot combinations without adding other processing', () => {
  for (const export_orientation of ['+x', '-x', '+y', '-y'])
    for (const pivot_to_center_bottom of [false, true]) {
      const parameters = {
        format: 'GLTF',
        export_orientation,
        pivot_to_center_bottom,
        with_animation: true,
        bake: false,
        texture_format: 'JPEG',
        texture_size: 2048,
      };
      const plan = processingPlan('convert', '@source', { param: parameters });
      assert.equal(plan.steps.length, 1);
      assert.equal(plan.steps[0]!.operation, 'export_lite');
      assert.equal(plan.steps[0]!.frontendConvert?.export_orientation, export_orientation);
      assert.equal(plan.steps[0]!.frontendConvert?.pivot_to_center_bottom, pivot_to_center_bottom);
    }
});
