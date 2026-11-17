/** FBX 证明同时约束几何效果与恢复来源；夹具不依赖本机账号、浏览器或付费引擎。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crc32 } from 'node:zlib';
import { Document, NodeIO } from '@gltf-transform/core';
import { KHRMaterialsIOR, KHRMaterialsSpecular } from '@gltf-transform/extensions';
import sharp from 'sharp';
import { binaryFbx, staticFbxNodes, type FbxFixtureNode } from './fixtures/fbx.ts';
import { readStaticFrontendFbx } from '../cli/artifacts/studio-fbx-source.ts';
import { verifyStaticFrontendFbx } from '../cli/artifacts/studio-fbx-proof.ts';
import { validateFrontendGlb } from '../cli/artifacts/studio-assimp-normalize.ts';

const metadata = { forward_axis: '-y' as const, pivot_to_center_bottom: true as const };
const property = (name: string, ...values: number[]): FbxFixtureNode => ({
  name: 'P',
  properties: [name, 'Vector3D', '', '', ...values],
});
function nodes(): FbxFixtureNode[] {
  const result = staticFbxNodes(),
    geometry = result[1]!.children![0]!;
  result[3]!.children = [
    {
      name: 'Properties70',
      children: Object.entries({
        UpAxis: 1,
        UpAxisSign: 1,
        FrontAxis: 2,
        FrontAxisSign: 1,
        CoordAxis: 0,
        CoordAxisSign: 1,
        UnitScaleFactor: 100,
      }).map(([name, value]) => property(name, value)),
    },
  ];
  const layer = (kind: string, field: string, stride: number, values: number[]): FbxFixtureNode => ({
    name: kind,
    properties: [0],
    children: [
      { name: 'MappingInformationType', properties: ['ByVertice'] },
      { name: 'ReferenceInformationType', properties: ['Direct'] },
      {
        name: field,
        properties: [
          new Float64Array(stride === 3 ? Array.from({ length: 5 }, () => values).flat() : values),
        ],
      },
    ],
  });
  geometry.children!.push(
    layer('LayerElementNormal', 'Normals', 3, [0, 0, 1]),
    layer('LayerElementUV', 'UV', 2, [0, 0, 1, 0, 1, 1, 0, 1, -1, 0.5]),
    {
      name: 'Layer',
      properties: [0],
      children: ['LayerElementNormal', 'LayerElementUV'].map((name) => ({
        name: 'LayerElement',
        children: [
          { name: 'Type', properties: [name] },
          { name: 'TypedIndex', properties: [0] },
        ],
      })),
    },
  );
  return result;
}
async function output(rotate = false): Promise<Document> {
  const document = new Document(),
    buffer = document.createBuffer(),
    scene = document.createScene(),
    node = document.createNode('mesh'),
    mesh = document.createMesh('mesh');
  document.getRoot().setDefaultScene(scene);
  scene.addChild(node.setMesh(mesh));
  const xy = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [-1, 0.5],
    ],
    floats = (type: 'VEC3' | 'VEC2', values: number[]) =>
      document.createAccessor().setType(type).setArray(new Float32Array(values)).setBuffer(buffer);
  mesh.addPrimitive(
    document
      .createPrimitive()
      .setAttribute(
        'POSITION',
        floats(
          'VEC3',
          xy.flatMap(([x, y]) => (rotate ? [0, x! + 1, -y! + 0.5] : [0, y!, x!])),
        ),
      )
      .setAttribute(
        'NORMAL',
        floats(
          'VEC3',
          xy.flatMap(() => [-1, 0, 0]),
        ),
      )
      .setAttribute(
        'TEXCOORD_0',
        floats(
          'VEC2',
          xy.flatMap(([x, y]) => [x!, 1 - y!]),
        ),
      )
      .setIndices(
        document
          .createAccessor()
          .setType('SCALAR')
          .setArray(new Uint16Array([0, 1, 2, 0, 1, 2, 0, 2, 3, 0, 1, 2, 0, 2, 3, 0, 3, 4]))
          .setBuffer(buffer),
      )
      .setMaterial(
        document
          .createMaterial('DefaultMaterial')
          .setBaseColorFactor([0.8, 0.8, 0.8, 1])
          .setMetallicFactor(0)
          .setRoughnessFactor(1),
      ),
  );
  return document;
}
const encode = async (document: Document) =>
  Buffer.from(
    await new NodeIO().registerExtensions([KHRMaterialsIOR, KHRMaterialsSpecular]).writeBinary(document),
  );
const rejects = async (source: Buffer, document: Document) =>
  await assert.rejects(verifyStaticFrontendFbx(source, await encode(document), metadata), {
    code: 'FRONTEND_EXPORT_UNVERIFIED',
    certainty: 'not_submitted',
  });

test('静态FBX独立证明三/四/五边形覆盖、UV翻转及默认材质，而非只数面', async () => {
  const source = binaryFbx(nodes()),
    proof = await verifyStaticFrontendFbx(source, await encode(await output()), metadata);
  assert.equal(proof.faces, 6);
  assert.equal(proof.source_format, 'fbx');
  assert.deepEqual(proof.clips, []);
  const rotated = nodes();
  rotated[1]!.children![1]!.children = [
    { name: 'Properties70', children: [property('Lcl Rotation', 0, 0, 90)] },
  ];
  assert.equal(
    (await verifyStaticFrontendFbx(binaryFbx(rotated), await encode(await output(true)), metadata)).faces,
    6,
  );
});

test('GLB显示名映射不扩大FBX前端导出范围', async () => {
  await assert.rejects(
    verifyStaticFrontendFbx(binaryFbx(nodes()), await encode(await output()), {
      ...metadata,
      children_rename: { mesh: 'display-name' },
    }),
    { code: 'FRONTEND_EXPORT_UNVERIFIED' },
  );
});

test('FBX拒绝错误面覆盖、翻面、位移、UV/法线/材质更改与额外动画', async () => {
  const source = binaryFbx(nodes());
  for (const mutation of [
    'duplicate',
    'reverse',
    'position',
    'uv',
    'normal',
    'material',
    'alpha',
    'animation',
    'extra-mesh',
  ]) {
    const doc = await output(),
      primitive = doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
    if (mutation === 'duplicate') {
      primitive.getIndices()!.setElement(16, [1]);
      primitive.getIndices()!.setElement(17, [2]);
    }
    if (mutation === 'reverse') {
      primitive.getIndices()!.setElement(1, [2]);
      primitive.getIndices()!.setElement(2, [1]);
    }
    if (mutation === 'position') primitive.getAttribute('POSITION')!.setElement(0, [0.01, 0, 0]);
    if (mutation === 'uv') primitive.getAttribute('TEXCOORD_0')!.setElement(0, [0.01, 1]);
    if (mutation === 'normal') primitive.getAttribute('NORMAL')!.setElement(0, [0, 0, 1]);
    if (mutation === 'material') primitive.getMaterial()!.setMetallicFactor(0.5);
    if (mutation === 'alpha') primitive.getMaterial()!.setAlphaMode('BLEND');
    if (mutation === 'animation') {
      const sampler = doc
        .createAnimationSampler()
        .setInput(
          doc
            .createAccessor()
            .setType('SCALAR')
            .setArray(new Float32Array([0]))
            .setBuffer(doc.getRoot().listBuffers()[0]!),
        )
        .setOutput(
          doc
            .createAccessor()
            .setType('VEC3')
            .setArray(new Float32Array([0, 0, 0]))
            .setBuffer(doc.getRoot().listBuffers()[0]!),
        );
      doc
        .createAnimation('added')
        .addSampler(sampler)
        .addChannel(
          doc
            .createAnimationChannel()
            .setSampler(sampler)
            .setTargetNode(doc.getRoot().listNodes()[0]!)
            .setTargetPath('translation'),
        );
    }
    if (mutation === 'extra-mesh')
      doc
        .getRoot()
        .listScenes()[0]!
        .addChild(
          doc.createNode('injected').setMesh(doc.createMesh('extra').addPrimitive(primitive.clone())),
        );
    await rejects(source, doc);
  }
});

test('FBX原始材质/图片/骨骼/动画/曲线/层级及未验证轴向在引擎前拒绝', () => {
  for (const kind of ['Material', 'Texture', 'Video', 'Deformer', 'AnimationStack', 'Constraint']) {
    const raw = nodes();
    raw[1]!.children!.push({ name: kind, properties: [999, 'unsupported', ''] });
    assert.throws(() => readStaticFrontendFbx(binaryFbx(raw)), { code: 'FRONTEND_EXPORT_UNVERIFIED' });
  }
  const variants = [
    (raw: FbxFixtureNode[]) => {
      raw[1]!.children![0]!.properties![2] = 'NurbsCurve';
    },
    (raw: FbxFixtureNode[]) => {
      raw[2]!.children![1]!.properties![2] = 200;
    },
    (raw: FbxFixtureNode[]) => {
      raw[3]!.children![0]!.children![0]!.properties![4] = 2;
    },
    (raw: FbxFixtureNode[]) => {
      raw[1]!.children![1]!.children = [
        { name: 'Properties70', children: [property('GeometricTranslation', 1, 0, 0)] },
      ];
    },
    (raw: FbxFixtureNode[]) => {
      raw[1]!.children![0]!.children!.push({ name: 'LayerElementColor', properties: [0] });
    },
    (raw: FbxFixtureNode[]) => {
      raw[1]!.children!.push({ name: 'NodeAttribute', properties: [999, 'detached', 'Null'] });
      raw[2]!.children!.push({ name: 'C', properties: ['OO', 999, 0] });
    },
  ];
  for (const mutate of variants) {
    const raw = nodes();
    mutate(raw);
    assert.throws(() => readStaticFrontendFbx(binaryFbx(raw)), { code: 'FRONTEND_EXPORT_UNVERIFIED' });
  }
});

test('未证明的非平面/非仿射UV/变化法线不会因原引擎成功而放行', async () => {
  for (const kind of ['nonplanar', 'uv', 'normal']) {
    const raw = nodes(),
      geometry = raw[1]!.children![0]!;
    if (kind === 'nonplanar') (geometry.children![0]!.properties![0] as Float64Array)[11] = 0.1;
    if (kind === 'uv')
      (
        geometry.children!.find((x) => x.name === 'LayerElementUV')!.children![2]!
          .properties![0] as Float64Array
      )[8] = -0.5;
    if (kind === 'normal')
      (
        geometry.children!.find((x) => x.name === 'LayerElementNormal')!.children![2]!
          .properties![0] as Float64Array
      )[12] = 0.5;
    await rejects(binaryFbx(raw), await output());
  }
});

function patchJson(bytes: Buffer, edit: (json: Record<string, unknown>) => void): Buffer {
  const json = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12))) as Record<string, unknown>;
  edit(json);
  const data = Buffer.from(JSON.stringify(json)),
    padding = (4 - (data.length % 4)) % 4,
    binary = bytes.subarray(20 + bytes.readUInt32LE(12)),
    header = Buffer.from(bytes.subarray(0, 20));
  header.writeUInt32LE(20 + data.length + padding + binary.length, 8);
  header.writeUInt32LE(data.length + padding, 12);
  return Buffer.concat([header, data, Buffer.alloc(padding, 0x20), binary]);
}
test('原FBX标记仅在FBX输出证明准入；非空扩展与自定义extras不放宽普通GLB', async () => {
  const source = binaryFbx(nodes()),
    valid = patchJson(await encode(await output()), (json) => {
      json.extensionsUsed = ['FB_ngon_encoding'];
      const primitive = (
        (json.meshes as Record<string, unknown>[])[0]!.primitives as Record<string, unknown>[]
      )[0]!;
      primitive.extensions = { FB_ngon_encoding: {} };
      (json.nodes as Record<string, unknown>[])[0]!.extras = {
        UserProperties: '',
        IsNull: false,
        DefaultAttributeIndex: 0,
        InheritType: 1,
      };
    });
  await verifyStaticFrontendFbx(source, valid, metadata);
  assert.throws(() => validateFrontendGlb(valid, true), { code: 'FRONTEND_EXPORT_UNVERIFIED' });
  for (const kind of ['extension', 'extras', 'null']) {
    const invalid = patchJson(valid, (json) => {
      if (kind === 'extension')
        (
          ((json.meshes as Record<string, unknown>[])[0]!.primitives as Record<string, unknown>[])[0]!
            .extensions as Record<string, unknown>
        ).FB_ngon_encoding = { custom: true };
      else
        ((json.nodes as Record<string, unknown>[])[0]!.extras as Record<string, unknown>)[
          kind === 'null' ? 'IsNull' : 'custom'
        ] = true;
    });
    await assert.rejects(verifyStaticFrontendFbx(source, invalid, metadata), {
      code: 'FRONTEND_EXPORT_UNVERIFIED',
    });
  }
});

function quadNodes(shader?: 'Phong' | 'Lambert', nested = false): FbxFixtureNode[] {
  const raw = nodes(),
    geometry = raw[1]!.children![0]!,
    model = raw[1]!.children![1]!;
  geometry.children![0]!.properties = [new Float64Array([0, 0, 0, 1, 0, 0, 1, 1, 0.5, 0, 1, 0])];
  geometry.children![1]!.properties = [new Int32Array([0, 1, 2, -4])];
  const normals = geometry.children!.find((node) => node.name === 'LayerElementNormal')!;
  normals.children![2]!.properties = [new Float64Array([0, 0, 1, 0, 0, 1, 0.1, 0, 1, 0, 0, 1])];
  normals.children!.push({ name: 'NormalsW', properties: [new Float64Array([1, 1, 1, 1])] });
  geometry.children!.find((node) => node.name === 'LayerElementUV')!.children![2]!.properties = [
    new Float64Array([0, 0, 1, 0, 0.8, 1, 0, 1]),
  ];
  model.children = [
    {
      name: 'Properties70',
      children: [property('InheritType', 1), property('RotationActive', 1), property('ScalingMax', 0, 0, 0)],
    },
  ];
  if (shader) {
    const values = [
      property('DiffuseColor', 0.2, 0.4, 0.6),
      property('Opacity', 0.5),
      property('EmissiveColor', 0.25, 0.5, 1),
      property('EmissiveFactor', 0.4),
    ];
    if (shader === 'Phong') values.push(property('Shininess', 25), property('ShininessExponent', 25));
    raw[1]!.children!.push({
      name: 'Material',
      properties: [300, 'surface', ''],
      children: [
        { name: 'ShadingModel', properties: [shader] },
        { name: 'Properties70', children: values },
      ],
    });
    raw[2]!.children!.push({ name: 'C', properties: ['OO', 300, 200] });
    geometry.children!.push({
      name: 'LayerElementMaterial',
      properties: [0],
      children: [
        { name: 'MappingInformationType', properties: ['AllSame'] },
        { name: 'ReferenceInformationType', properties: ['IndexToDirect'] },
        { name: 'Materials', properties: [new Int32Array([0])] },
      ],
    });
    geometry
      .children!.find((node) => node.name === 'Layer')!
      .children!.push({
        name: 'LayerElement',
        children: [
          { name: 'Type', properties: ['LayerElementMaterial'] },
          { name: 'TypedIndex', properties: [0] },
        ],
      });
  }
  if (nested) {
    model.children[0]!.children!.push(property('Lcl Translation', 1, 0, 0));
    raw[1]!.children!.push({
      name: 'Model',
      properties: [400, 'parent', 'Null'],
      children: [
        {
          name: 'Properties70',
          children: [property('Lcl Translation', 0, 2, 0), property('Lcl Rotation', 0, 0, 90)],
        },
      ],
    });
    raw[2]!.children![1]!.properties![2] = 400;
    raw[2]!.children!.push({ name: 'C', properties: ['OO', 400, 0] });
  }
  return raw;
}
async function quadOutput(
  options: { alternate?: boolean; shader?: 'Phong' | 'Lambert'; nested?: boolean } = {},
): Promise<Document> {
  const doc = new Document(),
    buffer = doc.createBuffer(),
    scene = doc.createScene(),
    mesh = doc.createMesh('mesh');
  doc.getRoot().setDefaultScene(scene);
  scene.addChild(doc.createNode('mesh').setMesh(mesh));
  if (options.nested) scene.addChild(doc.createNode('parent'));
  const vertices = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0.5],
      [0, 1, 0],
    ],
    normalVectors = [
      [0, 0, 1],
      [0, 0, 1],
      [0.1, 0, 1],
      [0, 0, 1],
    ],
    floats = (type: 'VEC3' | 'VEC2', values: number[]) =>
      doc.createAccessor().setType(type).setArray(new Float32Array(values)).setBuffer(buffer),
    material = doc
      .createMaterial(options.shader ? 'surface' : 'DefaultMaterial')
      .setMetallicFactor(0)
      .setRoughnessFactor(options.shader === 'Phong' ? 0.5 : 1);
  if (options.shader)
    material
      .setBaseColorFactor([0.2, 0.4, 0.6, 0.5])
      .setEmissiveFactor([0.1, 0.2, 0.4])
      .setAlphaMode('BLEND');
  else material.setBaseColorFactor([0.8, 0.8, 0.8, 1]);
  mesh.addPrimitive(
    doc
      .createPrimitive()
      .setAttribute(
        'POSITION',
        floats(
          'VEC3',
          vertices.flatMap(([x, y, z]) =>
            options.nested ? [0.25 - z!, x!, 0.5 - y!] : [0.25 - z!, y!, x! - 0.5],
          ),
        ),
      )
      .setAttribute(
        'NORMAL',
        floats(
          'VEC3',
          normalVectors.flatMap(([x, y, z]) => (options.nested ? [-z!, x!, y!] : [-z!, y!, x!])),
        ),
      )
      .setAttribute('TEXCOORD_0', floats('VEC2', [0, 1, 1, 1, 0.8, 0, 0, 0]))
      .setIndices(
        doc
          .createAccessor()
          .setType('SCALAR')
          .setArray(new Uint16Array(options.alternate ? [0, 1, 3, 1, 2, 3] : [0, 1, 2, 0, 2, 3]))
          .setBuffer(buffer),
      )
      .setMaterial(material),
  );
  return doc;
}

test('非共面四边形保网页合法对角线及逐角属性，不伪称预览曲面相等', async () => {
  const source = binaryFbx(quadNodes());
  for (const alternate of [false, true]) {
    const proof = await verifyStaticFrontendFbx(
      source,
      await encode(await quadOutput({ alternate })),
      metadata,
    );
    assert.equal(proof.faces, 2);
    assert.equal((proof.surfaces as { nonplanar_quadrilaterals: number }[])[0]!.nonplanar_quadrilaterals, 1);
    assert.match(String(proof.triangulation_basis), /differ from the Three preview surface/);
  }
  const duplicated = await quadOutput(),
    index = duplicated.getRoot().listMeshes()[0]!.listPrimitives()[0]!.getIndices()!;
  index.setElement(3, [0]);
  index.setElement(4, [1]);
  index.setElement(5, [2]);
  await rejects(source, duplicated);
  const reversed = await quadOutput();
  reversed.getRoot().listMeshes()[0]!.listPrimitives()[0]!.getIndices()!.setElement(4, [3]);
  await rejects(source, reversed);
});

test('原网页Lambert/Phong标量与RSrs静态层级可证明，颜色/粗糙度/alpha/发光更改拒绝', async () => {
  for (const shader of ['Lambert', 'Phong'] as const) {
    const source = binaryFbx(quadNodes(shader, true)),
      good = await quadOutput({ shader, nested: true });
    const proof = await verifyStaticFrontendFbx(source, await encode(good), metadata);
    assert.equal(proof.source_nodes_preserved, 2);
    for (const field of ['color', 'roughness', 'alpha', 'emissive']) {
      const doc = await quadOutput({ shader, nested: true }),
        material = doc.getRoot().listMaterials()[0]!;
      if (field === 'color') material.setBaseColorFactor([1, 0, 0, 0.5]);
      if (field === 'roughness') material.setRoughnessFactor(0.1);
      if (field === 'alpha') material.setAlphaMode('OPAQUE');
      if (field === 'emissive') material.setEmissiveFactor([0, 0, 0]);
      await rejects(source, doc);
    }
  }
});

test('静态扩展仍拒绝越界镜面、位移、透明颜色、未知材质、坏NormalsW与不支持的继承模式', () => {
  for (const [name, values] of [
    ['SpecularColor', [2, 0, 0]],
    ['SpecularFactor', [2]],
    ['DisplacementColor', [1, 0, 0]],
    ['TransparentColor', [1, 1, 1]],
    ['customMaterial', [1]],
  ] as const) {
    const raw = quadNodes('Phong'),
      material = raw[1]!.children!.find((node) => node.name === 'Material')!;
    material
      .children!.find((node) => node.name === 'Properties70')!
      .children!.push(property(name, ...values));
    assert.throws(() => readStaticFrontendFbx(binaryFbx(raw)), { code: 'FRONTEND_EXPORT_UNVERIFIED' });
  }
  const normalW = quadNodes();
  (
    normalW[1]!
      .children![0]!.children!.find((node) => node.name === 'LayerElementNormal')!
      .children!.find((node) => node.name === 'NormalsW')!.properties![0] as Float64Array
  )[0] = 0;
  assert.throws(() => readStaticFrontendFbx(binaryFbx(normalW)), { code: 'FRONTEND_EXPORT_UNVERIFIED' });
  const inheritance = quadNodes('Lambert', true);
  inheritance[1]!.children![1]!.children![0]!.children![0]!.properties![4] = 0;
  assert.throws(() => readStaticFrontendFbx(binaryFbx(inheritance)), { code: 'FRONTEND_EXPORT_UNVERIFIED' });
});

test('Phong按原网页镜面强度映射并披露色相丢失，扩展缺失或改值仍拒绝', async () => {
  // 期望值来自独立原引擎探针，覆盖默认、低强度specular和高强度IOR及饱和。
  for (const [factor, extension, value] of [
    [0, 'specular', 0],
    [0.1, 'specular', 0.4000000059604645],
    [0.24999999, 'specular', 0.9999999403953552],
    [0.25, 'default', 1],
    [0.25000001, 'default', 1],
    [0.3, 'ior', 1.5611114501953125],
    [0.5, 'ior', 1.7887883186340332],
    [1, 'ior', 1.7887883186340332],
  ] as const) {
    const raw = quadNodes('Phong'),
      material = raw[1]!.children!.find((node) => node.name === 'Material')!;
    material
      .children!.find((node) => node.name === 'Properties70')!
      .children!.push(property('SpecularColor', 1, 0, 0), property('SpecularFactor', factor));
    const source = binaryFbx(raw),
      doc = await quadOutput({ shader: 'Phong' }),
      target = doc.getRoot().listMaterials()[0]!;
    if (extension === 'specular')
      target.setExtension(
        'KHR_materials_specular',
        doc.createExtension(KHRMaterialsSpecular).createSpecular().setSpecularFactor(value),
      );
    if (extension === 'ior')
      target.setExtension(
        'KHR_materials_ior',
        doc.createExtension(KHRMaterialsIOR).createIOR().setIOR(value),
      );
    const bytes = await encode(doc),
      proof = await verifyStaticFrontendFbx(source, bytes, metadata);
    assert.match(
      String((proof.surfaces as Record<string, unknown>[])[0]!.material_mapping),
      /SpecularColor RGB is ignored/,
    );
    assert.deepEqual(
      readStaticFrontendFbx(source).meshes[0]!.material.source_properties.SpecularColor,
      [1, 0, 0],
    );
    if (extension === 'default') continue;
    if (extension === 'specular')
      // GLB现在也逐面核镜面标量；FBX下方仍按原Phong映射核完整效果，不能只凭语法准入。
      assert.doesNotThrow(() => validateFrontendGlb(bytes, true));
    const altered = patchJson(bytes, (json) => {
      const ext = (json.materials as Record<string, unknown>[])[0]!.extensions as Record<
        string,
        Record<string, unknown>
      >;
      if (extension === 'specular') ext.KHR_materials_specular!.specularFactor = value === 0 ? 0.5 : 0;
      else ext.KHR_materials_ior!.ior = 2;
    });
    await assert.rejects(verifyStaticFrontendFbx(source, altered, metadata), {
      code: 'FRONTEND_EXPORT_UNVERIFIED',
    });
    const missing = patchJson(bytes, (json) => {
      delete (json.materials as Record<string, unknown>[])[0]!.extensions;
    });
    await assert.rejects(verifyStaticFrontendFbx(source, missing, metadata), {
      code: 'FRONTEND_EXPORT_UNVERIFIED',
    });
    if (extension === 'specular') {
      const invalid = patchJson(bytes, (json) => {
        const ext = (json.materials as Record<string, unknown>[])[0]!.extensions as Record<
          string,
          Record<string, unknown>
        >;
        ext.KHR_materials_specular!.specularColorFactor = [1, 0, 0];
      });
      await assert.rejects(verifyStaticFrontendFbx(source, invalid, metadata), {
        code: 'FRONTEND_EXPORT_UNVERIFIED',
      });
    }
  }
});

test('任意原n边形保网页组合三角化及每角属性，原共线三角显式披露', async () => {
  const raw = nodes(),
    vertices = raw[1]!.children![0]!.children![0]!.properties![0] as Float64Array;
  vertices[8] = 0.5;
  const document = await output(),
    positions = document.getRoot().listMeshes()[0]!.listPrimitives()[0]!.getAttribute('POSITION')!;
  for (let i = 0; i < 5; i++)
    positions.setElement(i, [0.25 - vertices[i * 3 + 2]!, vertices[i * 3 + 1]!, vertices[i * 3]!]);
  const proof = await verifyStaticFrontendFbx(binaryFbx(raw), await encode(document), metadata);
  assert.equal(proof.faces, 6);
  assert.equal((proof.surfaces as { nonplanar_polygons: number }[])[0]!.nonplanar_polygons, 2);
  const reversed = await output();
  reversed.getRoot().listMeshes()[0]!.listPrimitives()[0]!.getIndices()!.setElement(10, [3]);
  await rejects(binaryFbx(raw), reversed);

  const collinear = nodes(),
    points = collinear[1]!.children![0]!.children![0]!.properties![0] as Float64Array;
  points[6] = 2;
  points[7] = 0;
  const retained = await output(),
    retainedPositions = retained.getRoot().listMeshes()[0]!.listPrimitives()[0]!.getAttribute('POSITION')!;
  for (let i = 0; i < 5; i++) retainedPositions.setElement(i, [0, points[i * 3 + 1]!, points[i * 3]! - 0.5]);
  const degenerateProof = await verifyStaticFrontendFbx(
    binaryFbx(collinear),
    await encode(retained),
    metadata,
  );
  assert.equal(
    (degenerateProof.surfaces as { source_collinear_triangle_triplets_retained: number }[])[0]!
      .source_collinear_triangle_triplets_retained,
    3,
  );
  retainedPositions.setElement(1, [0, 0, -0.5]);
  await rejects(binaryFbx(collinear), retained);
});

test('嵌入FBX JPEG逐字节/完整解码/UV采样验证，外部路径、换图和额外变换拒绝', async () => {
  const image = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#345678' } })
      .jpeg()
      .toBuffer(),
    raw = quadNodes('Phong');
  const properties = raw[1]!
    .children!.find((node) => node.name === 'Material')!
    .children!.find((node) => node.name === 'Properties70')!.children!;
  for (const p of properties) {
    const name = p.properties![0];
    if (name === 'DiffuseColor') p.properties!.splice(4, 3, 0.8, 0.8, 0.8);
    if (name === 'Opacity') p.properties![4] = 1;
    if (name === 'EmissiveColor') p.properties!.splice(4, 3, 0, 0, 0);
  }
  raw[1]!.children!.push(
    {
      name: 'Texture',
      properties: [600, 'base', ''],
      children: [{ name: 'Type', properties: ['TextureVideoClip'] }],
    },
    {
      name: 'Video',
      properties: [700, 'original.jpg', 'Clip'],
      children: [
        { name: 'Type', properties: ['Clip'] },
        { name: 'Filename', properties: ['/must/not/read/image.jpg'] },
        { name: 'Content', properties: [image] },
      ],
    },
  );
  raw[2]!.children!.push(
    { name: 'C', properties: ['OP', 600, 300, 'DiffuseColor'] },
    { name: 'C', properties: ['OO', 700, 600] },
  );
  const make = async () => {
    const doc = await quadOutput({ shader: 'Phong' }),
      material = doc.getRoot().listMaterials()[0]!;
    material.setBaseColorFactor([1, 1, 1, 1]).setEmissiveFactor([0, 0, 0]).setAlphaMode('OPAQUE');
    material.setBaseColorTexture(doc.createTexture('export.jpg').setImage(image).setMimeType('image/jpeg'));
    return doc;
  };
  const proof = await verifyStaticFrontendFbx(binaryFbx(raw), await encode(await make()), metadata);
  assert.equal(proof.faces, 2);
  const changed = await make();
  changed
    .getRoot()
    .listTextures()[0]!
    .setImage(await sharp(image).negate().jpeg().toBuffer());
  await rejects(binaryFbx(raw), changed);
  const sampler = await make();
  sampler.getRoot().listMaterials()[0]!.getBaseColorTextureInfo()!.setWrapS(33071);
  await rejects(binaryFbx(raw), sampler);
  raw[1]!.children!.find((node) => node.name === 'Video')!.children!.pop();
  assert.throws(() => readStaticFrontendFbx(binaryFbx(raw)), { code: 'FRONTEND_EXPORT_UNVERIFIED' });
});

async function pngFixture(image: Buffer, alias = false, mime = 'image/png') {
  const raw = quadNodes('Phong'),
    material = raw[1]!.children!.find((node) => node.name === 'Material')!,
    values = material.children!.find((node) => node.name === 'Properties70')!.children!;
  for (const p of values) {
    if (p.properties![0] === 'DiffuseColor') p.properties!.splice(4, 3, 0.8, 0.8, 0.8);
    if (p.properties![0] === 'Opacity') p.properties![4] = 1;
    if (p.properties![0] === 'EmissiveColor') p.properties!.splice(4, 3, 0, 0, 0);
  }
  raw[1]!.children!.push({
    name: 'Video',
    properties: [700, 'embedded.png', 'Clip'],
    children: [
      { name: 'Type', properties: ['Clip'] },
      { name: 'Content', properties: [image] },
    ],
  });
  for (const [id, channel] of [[600, 'DiffuseColor'], ...(alias ? [[601, 'TransparencyFactor']] : [])]) {
    raw[1]!.children!.push({
      name: 'Texture',
      properties: [id as number, 'base', ''],
      children: [{ name: 'Type', properties: ['TextureVideoClip'] }],
    });
    raw[2]!.children!.push(
      { name: 'C', properties: ['OP', id as number, 300, channel as string] },
      { name: 'C', properties: ['OO', 700, id as number] },
    );
  }
  const doc = await quadOutput({ shader: 'Phong' });
  doc
    .getRoot()
    .listMaterials()[0]!
    .setBaseColorFactor([1, 1, 1, 1])
    .setEmissiveFactor([0, 0, 0])
    .setAlphaMode('OPAQUE')
    .setBaseColorTexture(doc.createTexture('original.png').setImage(image).setMimeType(mime));
  return { raw, doc };
}
const opaquePng = (channels: 3 | 4 = 4) =>
  sharp({ create: { width: 4, height: 4, channels, background: '#345678' } })
    .png()
    .toBuffer();

for (const channels of [3, 4] as const)
  for (const alias of [false, true]) {
    test(`完整不透明 ${channels} 通道 PNG ${alias ? '同Video别名' : '底图'} 保原字节、材质与UV`, async () => {
      const { raw, doc } = await pngFixture(await opaquePng(channels), alias),
        proof = await verifyStaticFrontendFbx(binaryFbx(raw), await encode(doc), metadata),
        surfaces = proof.surfaces as { material: { texture: Record<string, unknown> } }[],
        texture = surfaces[0]!.material.texture;
      assert.equal(proof.faces, 2);
      assert.equal(texture.mime_type, 'image/png');
      assert.equal(texture.decoded_alpha, 'all_pixels_255');
      assert.equal(texture.opaque_alpha_alias, alias ? 'same_video_identical_default_sampling' : undefined);
      assert.equal(doc.getRoot().listMaterials()[0]!.getAlphaMode(), 'OPAQUE');
    });
  }

test('同Video别名以外的透明图连接、采样及对象歧义全部拒绝', async () => {
  const image = await opaquePng(),
    mutations: ((raw: FbxFixtureNode[]) => void)[] = [
      (raw) => {
        const video = structuredClone(raw[1]!.children!.find((node) => node.properties?.[0] === 700)!);
        video.properties![0] = 701;
        video.children!.find((node) => node.name === 'Content')!.properties = [image];
        raw[1]!.children!.push(video);
        raw[2]!.children!.find(
          (node) => node.properties?.[0] === 'OO' && node.properties[2] === 601,
        )!.properties![1] = 701;
      },
      (raw) =>
        raw[1]!
          .children!.find((node) => node.properties?.[0] === 601)!
          .children!.push({ name: 'Properties70', children: [property('UseMaterial', 1)] }),
      (raw) =>
        raw[1]!
          .children!.find((node) => node.properties?.[0] === 601)!
          .children!.push({ name: 'Properties70', children: [property('Rotation', 0, 1, 0)] }),
      (raw) => raw[2]!.children!.push({ name: 'C', properties: ['OO', 700, 601] }),
      (raw) => raw[2]!.children!.push({ name: 'C', properties: ['OP', 601, 300, 'TransparencyFactor'] }),
      (raw) => raw[2]!.children!.push({ name: 'C', properties: ['OO', 601, 0] }),
      (raw) => raw[1]!.children!.push({ name: 'Texture', properties: [601, 'duplicate', ''], children: [] }),
      (raw) => {
        raw[2]!.children = raw[2]!.children!.filter((node) => node.properties?.[1] !== 600);
      },
      (raw) => {
        raw[2]!.children!.find((node) => node.properties?.[3] === 'TransparencyFactor')!.properties![2] = 200;
      },
      (raw) => {
        raw[2]!
          .children!.find((node) => node.properties?.[3] === 'TransparencyFactor')!
          .properties!.push('extra');
      },
    ];
  for (const mutate of mutations) {
    const { raw, doc } = await pngFixture(image, true);
    mutate(raw);
    await rejects(binaryFbx(raw), doc);
  }
  const jpeg = await pngFixture(await sharp(image).jpeg().toBuffer(), true, 'image/jpeg');
  await rejects(binaryFbx(jpeg.raw), jpeg.doc);
});

function pngTestChunk(type: string, data: Buffer): Buffer {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length);
  bytes.write(type, 4, 'ascii');
  data.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
  return bytes;
}
test('PNG证明拒绝任一透明像素、损坏流、额外profile、调色板和动画', async () => {
  const original = await opaquePng(),
    rgba = await sharp(original).ensureAlpha().raw().toBuffer(),
    alteredHeader = Buffer.from(original);
  rgba[3] = 254;
  alteredHeader[28] = 1;
  alteredHeader.writeUInt32BE(crc32(alteredHeader.subarray(12, 29)), 29);
  const badCrc = Buffer.from(original);
  badCrc[29] = badCrc[29]! ^ 1;
  const inputs = [
    await sharp(rgba, { raw: { width: 4, height: 4, channels: 4 } })
      .png()
      .toBuffer(),
    await sharp(original).png({ palette: true }).toBuffer(),
    original.subarray(0, -10),
    Buffer.concat([original, Buffer.from([0])]),
    badCrc,
    alteredHeader,
    ...['tRNS', 'iCCP', 'acTL', 'tEXt'].map((kind) =>
      Buffer.concat([original.subarray(0, 33), pngTestChunk(kind, Buffer.alloc(8)), original.subarray(33)]),
    ),
  ];
  for (const image of inputs) {
    const { raw, doc } = await pngFixture(image, true);
    await rejects(binaryFbx(raw), doc);
  }
});

test('PNG底图输出换图、伪造MIME或改变透明模式时证明失败', async () => {
  const image = await opaquePng();
  for (const change of ['bytes', 'mime', 'blend', 'mask']) {
    const { raw, doc } = await pngFixture(image, true),
      texture = doc.getRoot().listTextures()[0]!;
    if (change === 'bytes') texture.setImage(await sharp(image).negate().png().toBuffer());
    else if (change === 'mime') texture.setMimeType('image/jpeg');
    else
      doc
        .getRoot()
        .listMaterials()[0]!
        .setAlphaMode(change === 'blend' ? 'BLEND' : 'MASK');
    await rejects(binaryFbx(raw), doc);
  }
});

test('静态FBX绑定逐一核原BindPose、骨层级、权重、inverseBind及实际蒙皮rest', async () => {
  const raw = quadNodes('Phong'),
    identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    matrix = (name: string): FbxFixtureNode => ({ name, properties: [new Float64Array(identity)] });
  raw[1]!.children!.push(
    { name: 'Model', properties: [400, 'bone', 'LimbNode'] },
    {
      name: 'NodeAttribute',
      properties: [401, 'bone', 'LimbNode'],
      children: [
        { name: 'TypeFlags', properties: ['Skeleton'] },
        { name: 'Properties70', children: [property('Size', 1)] },
      ],
    },
    { name: 'Deformer', properties: [500, 'skin', 'Skin'] },
    {
      name: 'Deformer',
      properties: [501, 'bone', 'Cluster'],
      children: [
        { name: 'Indexes', properties: [new Int32Array([0, 1, 2, 3])] },
        { name: 'Weights', properties: [new Float64Array([1, 1, 1, 1])] },
        matrix('Transform'),
        matrix('TransformLink'),
        matrix('TransformAssociateModel'),
      ],
    },
    {
      name: 'Pose',
      properties: [600, 'rest', 'BindPose'],
      children: [
        { name: 'Type', properties: ['BindPose'] },
        { name: 'NbPoseNodes', properties: [2] },
        ...[200, 400].map((id) => ({
          name: 'PoseNode',
          children: [{ name: 'Node', properties: [id] }, matrix('Matrix')],
        })),
      ],
    },
  );
  for (const [child, parent] of [
    [400, 0],
    [401, 400],
    [500, 100],
    [501, 500],
    [400, 501],
  ])
    raw[2]!.children!.push({ name: 'C', properties: ['OO', child!, parent!] });
  const make = async () => {
    const doc = await quadOutput({ shader: 'Phong' }),
      buffer = doc.getRoot().listBuffers()[0]!,
      meshNode = doc.getRoot().listNodes()[0]!,
      primitive = meshNode.getMesh()!.listPrimitives()[0]!,
      global: [
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
      ] = [0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0.25, 0, -0.5, 1],
      bone = doc.createNode('bone').setMatrix(global),
      skin = doc
        .createSkin('skin')
        .addJoint(bone)
        .setInverseBindMatrices(
          doc.createAccessor().setType('MAT4').setArray(new Float32Array(identity)).setBuffer(buffer),
        );
    doc.getRoot().listScenes()[0]!.addChild(bone);
    meshNode.setMatrix(global).setSkin(skin);
    primitive.getAttribute('POSITION')!.setArray(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0.5, 0, 1, 0]));
    primitive.getAttribute('NORMAL')!.setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0.1, 0, 1, 0, 0, 1]));
    primitive.setAttribute(
      'JOINTS_0',
      doc.createAccessor().setType('VEC4').setArray(new Uint16Array(16)).setBuffer(buffer),
    );
    primitive.setAttribute(
      'WEIGHTS_0',
      doc
        .createAccessor()
        .setType('VEC4')
        .setArray(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]))
        .setBuffer(buffer),
    );
    return doc;
  };
  const source = binaryFbx(raw),
    proof = await verifyStaticFrontendFbx(source, await encode(await make()), metadata),
    surfaces = proof.surfaces as {
      skin: { joints: number; weighted_source_vertices: number; maximum_rest_position_error: number };
    }[];
  assert.equal(surfaces[0]!.skin.joints, 1);
  assert.equal(surfaces[0]!.skin.weighted_source_vertices, 4);
  assert.ok(surfaces[0]!.skin.maximum_rest_position_error < 1e-6);
  for (const kind of ['bone', 'inverse', 'weight']) {
    const doc = await make(),
      skin = doc.getRoot().listSkins()[0]!;
    if (kind === 'bone') skin.listJoints()[0]!.setTranslation([0.26, 0, -0.5]);
    if (kind === 'inverse') {
      const values = [...identity];
      values[12] = 0.01;
      skin.getInverseBindMatrices()!.setElement(0, values);
    }
    if (kind === 'weight')
      doc
        .getRoot()
        .listMeshes()[0]!
        .listPrimitives()[0]!
        .getAttribute('WEIGHTS_0')!
        .setElement(0, [0.9, 0, 0, 0]);
    await rejects(source, doc);
  }
  const cluster = raw[1]!.children!.find((node) => node.properties?.[0] === 501)!;
  (cluster.children!.find((node) => node.name === 'Weights')!.properties![0] as Float64Array)[0] = 0.9;
  assert.throws(() => readStaticFrontendFbx(binaryFbx(raw)), { code: 'FRONTEND_EXPORT_UNVERIFIED' });

  const tinyWeights = new Float64Array([5e-7, 5e-7, 5e-7, 5e-7]),
    largeWeights = cluster.children!.find((node) => node.name === 'Weights')!.properties![0] as Float64Array;
  largeWeights.fill(1 - 5e-7);
  raw[1]!.children!.push(
    { name: 'Model', properties: [410, 'tiny', 'LimbNode'] },
    {
      name: 'NodeAttribute',
      properties: [411, 'tiny', 'LimbNode'],
      children: [{ name: 'TypeFlags', properties: ['Skeleton'] }],
    },
    {
      name: 'Deformer',
      properties: [511, 'tiny', 'Cluster'],
      children: [
        { name: 'Indexes', properties: [new Int32Array([0, 1, 2, 3])] },
        { name: 'Weights', properties: [tinyWeights] },
        matrix('Transform'),
        matrix('TransformLink'),
        matrix('TransformAssociateModel'),
      ],
    },
  );
  for (const [child, parent] of [
    [410, 0],
    [411, 410],
    [511, 500],
    [410, 511],
  ])
    raw[2]!.children!.push({ name: 'C', properties: ['OO', child!, parent!] });
  const pose = raw[1]!.children!.find((node) => node.name === 'Pose')!;
  pose.children!.find((node) => node.name === 'NbPoseNodes')!.properties![0] = 3;
  pose.children!.push({
    name: 'PoseNode',
    children: [{ name: 'Node', properties: [410] }, matrix('Matrix')],
  });
  const pruned = await make(),
    bone = pruned.createNode('tiny').setMatrix(pruned.getRoot().listSkins()[0]!.listJoints()[0]!.getMatrix());
  pruned.getRoot().listScenes()[0]!.addChild(bone);
  const prunedSkin = pruned.getRoot().listSkins()[0]!;
  prunedSkin
    .addJoint(bone)
    .getInverseBindMatrices()!
    .setArray(new Float32Array([...identity, ...identity]));
  const mapped = await verifyStaticFrontendFbx(binaryFbx(raw), await encode(pruned), metadata);
  assert.equal(
    (mapped.surfaces as { skin: { source_vertices_with_pruned_weights: number } }[])[0]!.skin
      .source_vertices_with_pruned_weights,
    4,
  );
  tinyWeights.fill(1.001e-6);
  largeWeights.fill(1 - 1.001e-6);
  await rejects(binaryFbx(raw), pruned);
});
