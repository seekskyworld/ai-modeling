/** 网页编辑的验证副本：真实转换仍接收原文件；此处仅构造独立的预期世界表面。 */
import type { Accessor, Document, Mesh, Node, Primitive } from '@gltf-transform/core';
import { mat3, mat4, vec3 } from 'gl-matrix';
import { frontendFail as fail, readFrontendDocument } from './studio-assimp-normalize.ts';
import { TripoError } from '../../studio/contracts/errors.ts';

export interface FrontendEditorMetadata {
  transform_matrix?: unknown;
  children_transform_matrix?: unknown;
  children_deleted?: unknown;
  children_rename?: unknown;
}
export interface FrontendEditedBounds {
  min: number[];
  max: number[];
  pivot: number[];
  extent: number;
}
export interface PreparedFrontendEdits {
  document: Document;
  bounds: FrontendEditedBounds;
  proof: Record<string, unknown>;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) return fail(`${name} must be an object.`);
  return value as Record<string, unknown>;
}

export function validateFrontendPositiveTrs(value: unknown, name: string): mat4 {
  if (value === undefined || value === null || (Array.isArray(value) && value.length === 0))
    return mat4.create();
  if (
    !Array.isArray(value) ||
    value.length !== 16 ||
    value.some((v) => typeof v !== 'number' || !Number.isFinite(v)) ||
    value[3] !== 0 ||
    value[7] !== 0 ||
    value[11] !== 0 ||
    value[15] !== 1
  )
    return fail(`${name} must be a finite column-major affine matrix.`);
  const lengths = [0, 4, 8].map((i) => Math.hypot(value[i], value[i + 1], value[i + 2]));
  if (lengths.some((v) => v < 0.0001 || v > 10000))
    return fail(`${name} requires positive bounded TRS scales.`);
  for (const [a, b] of [
    [0, 1],
    [0, 2],
    [1, 2],
  ]) {
    const dot = [0, 1, 2].reduce((sum, i) => sum + value[a! * 4 + i] * value[b! * 4 + i], 0);
    if (Math.abs(dot / (lengths[a!]! * lengths[b!]!)) > 1e-6)
      return fail(`${name} contains an unverified shear.`);
  }
  const matrix = mat4.fromValues(
    ...(value as [
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
    ]),
  );
  if (!Number.isFinite(mat4.determinant(matrix)) || mat4.determinant(matrix) <= 0)
    return fail(`${name} contains an unverified reflection or singular transform.`);
  return matrix;
}

function sourceAttributes(primitive: Primitive): { positions: Accessor; normals: Accessor | null } {
  const positions = primitive.getAttribute('POSITION'),
    normals = primitive.getAttribute('NORMAL');
  if (
    !positions ||
    positions.getType() !== 'VEC3' ||
    positions.getNormalized() ||
    (normals && (normals.getType() !== 'VEC3' || normals.getCount() !== positions.getCount()))
  )
    return fail(
      'Edited frontend sources require complete nonnormalized VEC3 positions and matching normals.',
    );
  return { positions, normals };
}

function sourceMesh(node: Node): Mesh {
  const mesh = node.getMesh();
  if (
    node.listChildren().length ||
    node.getSkin() ||
    !mesh ||
    mesh.listPrimitives().length !== 1 ||
    mesh.listPrimitives()[0]!.listTargets().length
  )
    return fail('Edited frontend sources require a static primitive on each independent root.');
  sourceAttributes(mesh.listPrimitives()[0]!);
  return mesh;
}

function roots(document: Document): Map<string, Node> {
  const root = document.getRoot(),
    scenes = root.listScenes(),
    nodes = root.listNodes();
  if (scenes.length !== 1 || root.listSkins().length || root.listAnimations().length)
    return fail('Edited frontend sources require one static scene without skeletons or animation.');
  const sceneNodes = scenes[0]!.listChildren();
  if (!nodes.length || nodes.length > 256 || sceneNodes.length !== nodes.length)
    return fail('Edited frontend sources require independent mesh roots without a hierarchy.');
  const names = new Map<string, Node>(),
    meshes = new Set();
  for (const node of nodes) {
    const name = node.getName(),
      mesh = sourceMesh(node);
    if (
      !/^[A-Za-z0-9_-]+$/.test(name) ||
      ['__proto__', 'constructor', 'prototype'].includes(name) ||
      name === scenes[0]!.getName() ||
      names.has(name) ||
      !sceneNodes.includes(node) ||
      meshes.has(mesh)
    )
      return fail(
        'Edited frontend sources require unique unambiguous mesh names and one primitive per root.',
      );
    validateFrontendPositiveTrs(Array.from(node.getWorldMatrix()), `Source node ${name}`);
    names.set(name, node);
    meshes.add(mesh);
  }
  if (root.listMeshes().some((mesh) => !meshes.has(mesh)))
    return fail('Edited frontend sources cannot contain detached meshes.');
  for (const [name, node] of names)
    for (const other of nodes)
      if (other !== node && other.getMesh()?.getName() === name)
        return fail('A source node name collides with another mesh name.');
  return names;
}

/** 无编辑静态源也必须按已有节点的世界坐标求pivot；复杂/动画源仍由原证明处理。 */
export function supportsStaticFrontendWorld(document: Document): boolean {
  try {
    roots(document);
    return true;
  } catch (error) {
    if (error instanceof TripoError && error.code === 'FRONTEND_EXPORT_UNVERIFIED') return false;
    throw error;
  }
}

function transformedNormals(normals: Accessor | null, matrix: mat3): Float32Array<ArrayBuffer> | undefined {
  if (!normals) return undefined;
  const values = new Float32Array(normals.getCount() * 3);
  for (let index = 0; index < normals.getCount(); index++) {
    const normal = vec3.transformMat3(vec3.create(), normals.getElement(index, []), matrix);
    if (Array.from(normal).some((v) => !Number.isFinite(v)) || vec3.length(normal) < 1e-12)
      return fail('The edited source contains invalid normals.');
    values.set(vec3.normalize(normal, normal), index * 3);
  }
  return values;
}

function expectedNode(
  document: Document,
  node: Node,
  transform: mat4,
  min: number[],
  max: number[],
  remainingVertices: number,
): number {
  const normalMatrix = mat3.normalFromMat4(mat3.create(), transform);
  if (!normalMatrix) return fail('The combined edit has no finite normal transform.');
  const primitive = node.getMesh()!.listPrimitives()[0]!,
    { positions, normals } = sourceAttributes(primitive);
  if (positions.getCount() > remainingVertices)
    return fail('Edited frontend proof exceeds 200000 source vertices.');
  const values = new Float32Array(positions.getCount() * 3);
  for (let index = 0; index < positions.getCount(); index++) {
    const point = vec3.transformMat4(vec3.create(), positions.getElement(index, []), transform);
    if (Array.from(point).some((v) => !Number.isFinite(v)))
      return fail('The edited source contains nonfinite world positions.');
    values.set(point, index * 3);
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis]!, point[axis]!);
      max[axis] = Math.max(max[axis]!, point[axis]!);
    }
  }
  const normalValues = transformedNormals(normals, normalMatrix);
  // 新accessor避免共享数组被污染；该副本只参加证明，永远不序列化交付。
  primitive.setAttribute(
    'POSITION',
    document.createAccessor().setType('VEC3').setArray(values).setBuffer(positions.getBuffer()),
  );
  if (normals && normalValues)
    primitive.setAttribute(
      'NORMAL',
      document.createAccessor().setType('VEC3').setArray(normalValues).setBuffer(normals.getBuffer()),
    );
  node.setTranslation([0, 0, 0]).setRotation([0, 0, 0, 1]).setScale([1, 1, 1]);
  return positions.getCount();
}

function displayNames(value: unknown, nodes: Map<string, Node>): Record<string, string> {
  const names = record(value, 'children_rename');
  for (const [name, label] of Object.entries(names))
    if (!nodes.has(name) || typeof label !== 'string' || label.length < 1 || label.length > 100)
      return fail('Display names require exact source nodes and labels of 1–100 characters.');
  // 固定网页引擎解析此映射但不应用到导出文件；不改验证副本的名称，并在结果中披露。
  return { ...names } as Record<string, string>;
}

export async function prepareFrontendEdits(
  sourceBytes: Buffer,
  metadata: FrontendEditorMetadata,
): Promise<PreparedFrontendEdits> {
  // 从原字节独立读取，避免依赖已移除的Document.clone或重新编码一个待验证的模型。
  const document = await readFrontendDocument(sourceBytes);
  const original = roots(document),
    rootMatrix = validateFrontendPositiveTrs(metadata.transform_matrix, 'transform_matrix'),
    names = displayNames(metadata.children_rename, original);
  const childValues = record(metadata.children_transform_matrix, 'children_transform_matrix');
  const childMatrices = new Map<string, mat4>();
  for (const [name, value] of Object.entries(childValues)) {
    if (!original.has(name)) return fail('A child transform does not name an exact verified source mesh.');
    childMatrices.set(name, validateFrontendPositiveTrs(value, `children_transform_matrix.${name}`));
  }
  const deletedValue = metadata.children_deleted ?? [];
  if (!Array.isArray(deletedValue) || deletedValue.some((v) => typeof v !== 'string'))
    return fail('children_deleted must contain exact source node names.');
  const deleted = new Set<string>(deletedValue);
  if (deleted.size !== deletedValue.length || [...deleted].some((name) => !original.has(name)))
    return fail('Deleted source names must be unique and unambiguous.');
  if (deleted.size === original.size) return fail('The edited export must retain a mesh.');
  const cloned = original;
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  let vertices = 0;
  for (const [name, node] of cloned) {
    const mesh = node.getMesh()!;
    if (deleted.has(name)) {
      node.dispose();
      mesh.dispose();
      continue;
    }
    const originalNode = original.get(name)!;
    const child = childMatrices.get(name) ?? mat4.create();
    // 单root时引擎不插入合成ROOT，部件变换后乘到同一root上；多root则作用于合成ROOT之下。
    // 原结构决定顺序，不能用删除后的数量选择，也不能用pivot抵消后的结果反推矩阵。
    const transform =
      original.size === 1
        ? mat4.multiply(
            mat4.create(),
            child,
            mat4.multiply(mat4.create(), rootMatrix, originalNode.getWorldMatrix()),
          )
        : mat4.multiply(
            mat4.create(),
            rootMatrix,
            mat4.multiply(mat4.create(), child, originalNode.getWorldMatrix()),
          );
    vertices += expectedNode(document, node, transform, min, max, 200000 - vertices);
  }
  const extent = Math.max(...max.map((value, index) => value - min[index]!));
  if (!Number.isFinite(extent) || extent <= 0) return fail('The edited source has no finite spatial extent.');
  const bounds = { min, max, pivot: [(min[0]! + max[0]!) / 2, min[1]!, (min[2]! + max[2]!) / 2], extent };
  return {
    document,
    bounds,
    proof: {
      kind: 'static_webpage_editor_metadata',
      verification_copy_only: true,
      source_nodes: original.size,
      retained_meshes: original.size - deleted.size,
      deleted_names: [...deleted],
      transformed_names: [...childMatrices.keys()],
      ...(Object.keys(names).length
        ? {
            display_name_mapping: {
              names,
              file_names: 'original_source_names',
              interpretation:
                'The fixed webpage engine reads display aliases but does not apply them. Retained source node names are preserved; the exporter may assign generated scene or mesh names.',
            },
          }
        : {}),
      root_matrix: Array.from(rootMatrix),
      composition:
        original.size === 1
          ? 'child × root × original world; single source root, pivot from retained edited world positions'
          : 'root × child × original world; pivot from retained edited world positions',
      normal_mapping: 'inverse transpose of the same combined transform',
      vertices,
      bounds,
    },
  };
}
