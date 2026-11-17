/** 网页按绑定树中的 Three.Mesh 计数；根节点、mesh 定义及材质组数量均不能代替实例数。 */
import { createHash } from 'node:crypto';
import type { Primitive } from '@gltf-transform/core';
import { validateGlb } from '../../studio/files.ts';
import { TripoError } from '../../studio/contracts/errors.ts';
import { modelIO } from '../local/gltf.ts';

export interface SegmentEntityCount {
  version: 1;
  scene: 0;
  before_deletions: number;
  entity_count: number;
  instances: { node: number; name: string; mesh: number; primitive: number; deleted: boolean }[];
}
const invalid = (message: string): never => {
  throw new TripoError('SEGMENT_ENTITY_INVALID', message, 'not_submitted');
};
const unsupported = (message: string): never => {
  throw new TripoError('SEGMENT_ENTITY_UNSUPPORTED', message, 'not_submitted');
};
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Invalid GLB object.');
  return value as Record<string, unknown>;
};
function list(value: unknown, optional = false): unknown[] {
  if (value === undefined && optional) return [];
  if (!Array.isArray(value)) return invalid('Invalid GLB array.');
  return value;
}
function index(value: unknown, length: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= length)
    return invalid('A GLB index does not identify its original object.');
  return Number(value);
}
function vector(value: unknown, length: number): void {
  if (value === undefined) return;
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    value.some((v) => typeof v !== 'number' || !Number.isFinite(v))
  )
    invalid('A GLB node transform is malformed.');
}
function validatePrimitive(
  primitive: Record<string, unknown>,
  accessors: Record<string, unknown>[],
  materials: number,
): void {
  const mode = primitive.mode ?? 4;
  if (!Number.isInteger(mode) || Number(mode) < 0 || Number(mode) > 6) invalid('Invalid GLB primitive mode.');
  const attributes = record(primitive.attributes),
    position = accessors[index(attributes.POSITION, accessors.length)]!;
  if (position.type !== 'VEC3' || !Number.isSafeInteger(position.count) || Number(position.count) <= 0)
    invalid('A GLB primitive requires a complete position accessor.');
  for (const value of Object.values(attributes)) index(value, accessors.length);
  if (primitive.indices !== undefined) index(primitive.indices, accessors.length);
  if (primitive.material !== undefined) index(primitive.material, materials);
}
function validateAccessorRanges(json: Record<string, unknown>, accessors: Record<string, unknown>[]): void {
  const views = list(json.bufferViews).map(record),
    sizes: Record<string, number> = { '5120': 1, '5121': 1, '5122': 2, '5123': 2, '5125': 4, '5126': 4 },
    shapes: Record<string, number[]> = {
      SCALAR: [1, 1],
      VEC2: [2, 1],
      VEC3: [3, 1],
      VEC4: [4, 1],
      MAT2: [2, 2],
      MAT3: [3, 3],
      MAT4: [4, 4],
    };
  for (const accessor of accessors) {
    const size = sizes[String(accessor.componentType)],
      shape = shapes[String(accessor.type)],
      count = Number(accessor.count);
    if (!size || !shape || !Number.isSafeInteger(accessor.count) || count <= 0)
      invalid('A GLB accessor declaration is invalid.');
    if (accessor.bufferView === undefined) {
      if (accessor.sparse === undefined) invalid('A GLB accessor has neither original data nor sparse data.');
      continue;
    }
    const view = views[index(accessor.bufferView, views.length)]!,
      offset = accessor.byteOffset ?? 0,
      element = shape![1]! > 1 ? Math.ceil((shape![0]! * size!) / 4) * 4 * shape![1]! : shape![0]! * size!,
      stride = view.byteStride ?? element;
    if (
      !Number.isSafeInteger(offset) ||
      Number(offset) < 0 ||
      !Number.isSafeInteger(stride) ||
      Number(stride) < element ||
      !Number.isSafeInteger(view.byteLength) ||
      Number(view.byteLength) < 0 ||
      Number(offset) + (count - 1) * Number(stride) + element > Number(view.byteLength)
    )
      invalid('A GLB accessor exceeds its original buffer view.');
  }
}
function validateDecodedPrimitive(primitive: Primitive): void {
  const positions = primitive.getAttribute('POSITION'),
    indices = primitive.getIndices();
  if (!positions || positions.getType() !== 'VEC3' || !positions.getArray())
    return invalid('The original GLB position data could not be decoded.');
  for (const value of positions.getArray()!)
    if (!Number.isFinite(value)) invalid('Nonfinite GLB position data.');
  if (indices) {
    if (indices.getType() !== 'SCALAR' || !indices.getArray()) invalid('Invalid GLB index data.');
    for (const value of indices.getArray()!)
      if (!Number.isSafeInteger(value) || value < 0 || value >= positions.getCount())
        invalid('A GLB index is outside its position data.');
  }
  const count = indices?.getCount() ?? positions.getCount(),
    mode = primitive.getMode();
  if ((mode === 4 && count % 3 !== 0) || ((mode === 5 || mode === 6) && count < 3))
    invalid('The GLB triangle primitive is incomplete.');
}
function safeDeletionNames(
  nodes: Record<string, unknown>[],
  meshes: Record<string, unknown>[],
  scene: Record<string, unknown>,
  active: number[],
  deleted: string[],
): void {
  if (!deleted.length) return;
  const safe = (name: unknown): name is string =>
    typeof name === 'string' &&
    /^[A-Za-z0-9_-]{1,256}$/.test(name) &&
    !['__proto__', 'constructor', 'prototype'].includes(name);
  const names = active.map((n) => nodes[n]!.name);
  // GLTFLoader 先为 node/scene 分配唯一名，随后为每个 primitive 分配 mesh 名；碰撞会改名。
  // 只接纳不会被这套命名规则改写的 node 选择器；不猜测异步生成的 primitive 名。
  if (names.some((name) => !safe(name)) || new Set(names).size !== names.length)
    unsupported('Metadata deletion requires unique loader-safe original node names.');
  const meshNames = meshes.map((mesh, i) => mesh.name || `mesh_${i}`);
  if (meshNames.some((name) => !safe(name)))
    unsupported('Metadata deletion cannot infer sanitized mesh names.');
  const collides = (name: unknown): boolean =>
    meshNames.some(
      (base) =>
        name === base ||
        (String(name).startsWith(`${base}_`) && /^\d+$/.test(String(name).slice(String(base).length + 1))),
    );
  if (names.some(collides) || (scene.name !== undefined && (!safe(scene.name) || names.includes(scene.name))))
    unsupported('Metadata deletion cannot use names that collide with loader-generated objects.');
  // 旧 metadata 可保留上一模型的删除名；网页 getObjectByName 未命中时不删除任何对象。
  // 不能只查原 node：primitive、共享 mesh 实例和 scene 的唯一名也可能命中。此前的
  // 安全字符/无碰撞条件使 sanitize 为恒等；下面用所有基名及任意下划线后缀的保守闭包
  // 覆盖数字去重和 _instance_N，不依赖异步 mesh 完成顺序。只有闭包外的名才证明无效果。
  const loaderBases = [...names, ...meshNames, scene.name].filter(
    (name): name is string => typeof name === 'string' && name.length > 0,
  );
  if (
    deleted.some(
      (name) =>
        !names.includes(name) &&
        (!safe(name) ||
          name.startsWith('_instance_') ||
          loaderBases.some((base) => name === base || name.startsWith(`${base}_`))),
    )
  )
    unsupported(
      'Metadata deletion requires an exact original node name or a name proven absent from the loader namespace.',
    );
}

function readShape(bytes: Buffer) {
  const json = validateGlb(bytes),
    nodes = list(json.nodes).map(record),
    meshes = list(json.meshes).map(record),
    scenes = list(json.scenes).map(record),
    accessors = list(json.accessors).map(record),
    materials = list(json.materials, true).length;
  if (record(json.asset).version !== '2.0') invalid('Entity counting requires a valid GLB 2.0 asset.');
  validateAccessorRanges(json, accessors);
  for (const item of [...nodes, ...meshes, ...scenes])
    if (item.name !== undefined && typeof item.name !== 'string') invalid('A GLB object name is malformed.');
  if (!scenes.length) invalid('The GLB has no scene to bind.');
  const selected = index(json.scene ?? 0, scenes.length);
  for (const mesh of meshes) {
    const primitives = list(mesh.primitives).map(record);
    if (!primitives.length) invalid('An original mesh has no primitive.');
    for (const primitive of primitives) validatePrimitive(primitive, accessors, materials);
  }
  for (const node of nodes) {
    if (node.mesh !== undefined) index(node.mesh, meshes.length);
    for (const child of list(node.children, true)) index(child, nodes.length);
    vector(node.matrix, 16);
    vector(node.translation, 3);
    vector(node.rotation, 4);
    vector(node.scale, 3);
    if (
      node.matrix !== undefined &&
      [node.translation, node.rotation, node.scale].some((v) => v !== undefined)
    )
      invalid('A GLB node cannot contain both matrix and TRS transforms.');
  }
  return { json, nodes, meshes, scenes, accessors, selected };
}
type EntityShape = ReturnType<typeof readShape>;
function validateCorePrimitiveData(bytes: Buffer, { json, meshes, accessors }: EntityShape): void {
  // 未知扩展不应掩盖可直接确认的核心数据损坏，否则上层会把坏原件降级到旧路由。
  // 稀疏/扩展编码仍交给原解码器；这里不猜测其表示，也不改写原件或扩展声明。
  if (bytes.length > 150 * 1024 * 1024) return;
  const views = list(json.bufferViews).map(record),
    buffers = list(json.buffers).map(record),
    readers: Record<number, { size: number; read: (data: Buffer, offset: number) => number }> = {
      5120: { size: 1, read: (b, o) => b.readInt8(o) },
      5121: { size: 1, read: (b, o) => b.readUInt8(o) },
      5122: { size: 2, read: (b, o) => b.readInt16LE(o) },
      5123: { size: 2, read: (b, o) => b.readUInt16LE(o) },
      5125: { size: 4, read: (b, o) => b.readUInt32LE(o) },
      5126: { size: 4, read: (b, o) => b.readFloatLE(o) },
    };
  let binary: Buffer | undefined;
  for (let offset = 12; offset < bytes.length; offset += 8 + bytes.readUInt32LE(offset))
    if (bytes.readUInt32LE(offset + 4) === 0x004e4942)
      binary = bytes.subarray(offset + 8, offset + 8 + bytes.readUInt32LE(offset));
  const inspect = (value: unknown, components: number, valid: (value: number) => boolean): void => {
    const accessor = accessors[index(value, accessors.length)]!;
    if (
      accessor.sparse !== undefined ||
      accessor.extensions !== undefined ||
      accessor.bufferView === undefined
    )
      return;
    const view = views[index(accessor.bufferView, views.length)]!;
    if (view.extensions !== undefined || Number(accessor.count) > 2_000_000) return;
    const bufferIndex = index(view.buffer, buffers.length),
      buffer = buffers[bufferIndex]!,
      data = bufferIndex === 0 && buffer.uri === undefined ? binary : undefined;
    if (!data) return;
    const reader = readers[Number(accessor.componentType)]!,
      start = Number(view.byteOffset ?? 0) + Number(accessor.byteOffset ?? 0),
      stride = Number(view.byteStride ?? components * reader.size),
      end = start + (Number(accessor.count) - 1) * stride + components * reader.size;
    if (!Number.isSafeInteger(start) || start < 0 || end > data.length)
      invalid('A core GLB accessor exceeds the original binary data.');
    for (let element = 0; element < Number(accessor.count); element++)
      for (let component = 0; component < components; component++)
        if (!valid(reader.read(data, start + element * stride + component * reader.size)))
          invalid('The original core GLB position or index data is invalid.');
  };
  for (const mesh of meshes)
    for (const raw of list(mesh.primitives)) {
      const primitive = record(raw),
        position = record(primitive.attributes).POSITION,
        count = Number(accessors[index(position, accessors.length)]!.count);
      inspect(position, 3, Number.isFinite);
      if (primitive.indices !== undefined) {
        const indices = accessors[index(primitive.indices, accessors.length)]!;
        if (indices.type !== 'SCALAR') invalid('The original GLB index accessor is not scalar.');
        inspect(primitive.indices, 1, (v) => Number.isSafeInteger(v) && v >= 0 && v < count);
      }
    }
}
function activeGraph({ nodes, scenes, selected }: EntityShape) {
  const active: number[] = [],
    visited = new Set<number>(),
    parents = new Map<number, number>();
  const visit = (value: unknown, parent: number, depth: number): void => {
    const id = index(value, nodes.length);
    if (visited.has(id)) invalid('The active GLB node graph is cyclic or reparents the same node.');
    if (depth > 128) unsupported('The GLB hierarchy exceeds the bounded entity proof.');
    visited.add(id);
    active.push(id);
    parents.set(id, parent);
    for (const child of list(nodes[id]!.children, true)) visit(child, id, depth + 1);
  };
  for (const root of list(scenes[selected]!.nodes, true)) visit(root, -1, 0);
  return { active, parents };
}
function assertSupportedShape(bytes: Buffer, shape: EntityShape): void {
  const { json, nodes, meshes, scenes, accessors, selected } = shape;
  if (
    bytes.length > 150 * 1024 * 1024 ||
    nodes.length > 2048 ||
    meshes.length > 2048 ||
    accessors.some((a) => Number(a.count) > 2_000_000)
  )
    unsupported('The GLB exceeds the bounded entity proof.');
  if (
    scenes.length !== 1 ||
    selected !== 0 ||
    list(json.skins, true).length ||
    list(json.animations, true).length ||
    list(json.cameras, true).length
  )
    unsupported('Entity proof currently supports one static scene without skins, animation or cameras.');
  const extensions = [...list(json.extensionsUsed, true), ...list(json.extensionsRequired, true)];
  if (
    extensions.some((name) => !['KHR_mesh_quantization', 'EXT_meshopt_compression'].includes(String(name))) ||
    json.extensions !== undefined
  )
    unsupported('The GLB uses an extension outside the verified entity-count loader branch.');
  if (
    nodes.some(
      (n) =>
        n.extensions !== undefined ||
        n.skin !== undefined ||
        n.weights !== undefined ||
        n.camera !== undefined,
    ) ||
    scenes.some((s) => s.extensions !== undefined) ||
    meshes.some(
      (m) =>
        m.extensions !== undefined ||
        m.weights !== undefined ||
        list(m.primitives).some((p) => record(p).extensions !== undefined || record(p).targets !== undefined),
    )
  )
    unsupported('GPU instances, attachments and morph meshes require a separate loader proof.');
}
async function validateDecodedSource(bytes: Buffer, accessors: Record<string, unknown>[]): Promise<void> {
  // 必须解码原字节；JSON 中宣称的 primitive 数不能使截断/损坏的几何获得分流证明。
  const document = await (await modelIO()).readBinary(bytes);
  const decodedAccessors = document.getRoot().listAccessors();
  if (
    decodedAccessors.length !== accessors.length ||
    accessors.some((accessor, i) => decodedAccessors[i]!.getCount() !== accessor.count)
  )
    invalid('The decoded accessor data does not match the declared original GLB count.');
  for (const mesh of document.getRoot().listMeshes())
    for (const primitive of mesh.listPrimitives()) validateDecodedPrimitive(primitive);
}
function countInstances(
  shape: EntityShape,
  graph: ReturnType<typeof activeGraph>,
  deleted: string[],
): SegmentEntityCount {
  const { nodes, meshes } = shape,
    { active, parents } = graph;
  const removed = new Set<number>(),
    selectors = new Set(deleted);
  for (const id of active)
    if (selectors.has(String(nodes[id]!.name)) || removed.has(parents.get(id)!)) removed.add(id);
  const instances: SegmentEntityCount['instances'] = [];
  for (const id of active) {
    const node = nodes[id]!;
    if (node.mesh === undefined) continue;
    const mesh = Number(node.mesh);
    list(meshes[mesh]!.primitives).forEach((value, primitive) => {
      // Mesh/SkinnedMesh 包含三角形、strip、fan；Points/Line 不属于网页的 instanceof Mesh。
      if ([4, 5, 6].includes(Number(record(value).mode ?? 4)))
        instances.push({
          node: id,
          name: String(node.name ?? ''),
          mesh,
          primitive,
          deleted: removed.has(id),
        });
    });
  }
  if (instances.length > 4096)
    unsupported('The GLB has too many Mesh instances for the bounded entity proof.');
  return {
    version: 1,
    scene: 0,
    before_deletions: instances.length,
    entity_count: instances.filter((i) => !i.deleted).length,
    instances,
  };
}

/** 仅已证的静态自包含 GLB；超范围显式区分，解析错误不得作为 legacy fallback 的理由。 */
export async function inspectSegmentEntityCount(
  bytes: Buffer,
  childrenDeleted: readonly string[] = [],
): Promise<SegmentEntityCount> {
  const originalHash = createHash('sha256').update(bytes).digest('hex'),
    shape = readShape(bytes),
    graph = activeGraph(shape);
  if (!Array.isArray(childrenDeleted) || childrenDeleted.some((name) => typeof name !== 'string' || !name))
    invalid('The exact metadata deletion list is malformed.');
  const deleted = [...childrenDeleted];
  validateCorePrimitiveData(bytes, shape);
  assertSupportedShape(bytes, shape);
  safeDeletionNames(shape.nodes, shape.meshes, shape.scenes[0]!, graph.active, deleted);
  await validateDecodedSource(bytes, shape.accessors);
  if (createHash('sha256').update(bytes).digest('hex') !== originalHash)
    invalid('The original GLB bytes changed during entity inspection.');
  return countInstances(shape, graph, deleted);
}
