/** 网页按 FBX 原多边形、实际 Mesh 连接及最终名称索引计数，不数三角化后的面。 */
import { readBinaryFbx } from './binary.ts';
import { readAsciiFbx } from './ascii.ts';
import { singleNode, type FbxDocument, type FbxNode } from './structure.ts';
import { fbxBoneModels, type FbxConnection } from './deformers.ts';
import { validateFbxCurves } from './curves.ts';

interface Model {
  id: number;
  name: string;
  type: string;
}
export interface FbxFaceCount {
  face_count: number | null;
  reason?: string;
}

function identifier(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('FBX object identifiers require nonnegative safe integers.');
  return value;
}

function objectEntries(nodes: FbxNode[], kind: string): Map<number, FbxNode> {
  // 与网页 for-in 的整数键排序一致，决定重名模型最终保留哪一项。
  const keyed: Record<string, FbxNode> = Object.create(null);
  for (const node of nodes.filter((item) => item.name === kind)) {
    const id = identifier(node.properties[0]);
    if (keyed[id]) throw new Error('FBX contains repeated object identifiers.');
    keyed[id] = node;
  }
  return new Map(Object.entries(keyed).map(([key, value]) => [Number(key), value]));
}

function models(document: FbxDocument, objects: FbxNode): Model[] {
  return [...objectEntries(objects.children, 'Model')].map(([id, node]) => {
    const [, rawName, type] = node.properties;
    if (document.format === 'ascii' && !node.block)
      throw new Error('FBX ASCII model definitions require a webpage-readable block.');
    if (typeof rawName !== 'string' || typeof type !== 'string')
      throw new Error('FBX model names and types must be strings.');
    if (type === 'Light' && !objects.children.some((child) => child.name === 'NodeAttribute'))
      throw new Error('FBX light is missing the webpage-required NodeAttribute table.');
    const name = (document.format === 'ascii' ? rawName.replace(/^\w+::/, '') : rawName)
      .replace(/\s/g, '_')
      .replace(/[[\].:/]/g, '');
    if (document.format === 'ascii' && rawName.includes(','))
      throw new Error('FBX ambiguous model names require webpage-specific parsing.');
    return { id, name, type: String(type) };
  });
}

function connections(root: FbxNode): FbxConnection[] {
  return root.children.map((node) => {
    const [kind, child, parent] = node.properties;
    if (node.name !== 'C' || !['OO', 'OP'].includes(String(kind)))
      throw new Error('FBX connection layout is not verified.');
    const relationship = node.properties[3];
    if (relationship !== undefined && typeof relationship !== 'string')
      throw new Error('FBX relationship names must be strings.');
    return { child: identifier(child), parent: identifier(parent), relationship };
  });
}

function validateHierarchy(models: Model[], links: FbxConnection[]): void {
  const ids = new Set(models.map((model) => model.id));
  const parent = new Map<number, number>();
  for (const link of links)
    if (ids.has(link.child) && ids.has(link.parent)) parent.set(link.child, link.parent);
  for (const model of models) {
    const seen = new Set<number>();
    let id: number | undefined = model.id;
    while (id !== undefined) {
      if (seen.has(id) || seen.size > 64)
        throw new Error('FBX model hierarchy is cyclic or too deep to verify.');
      seen.add(id);
      id = parent.get(id);
    }
  }
}

function numericArray(node: FbxNode, name: string): Float64Array {
  const value = singleNode(node.children, name)?.properties[0];
  if (!(value instanceof Float64Array)) throw new Error('FBX geometry is missing a numeric array.');
  return value;
}

function geometryFaces(node: FbxNode): number {
  if (node.properties[2] !== 'Mesh') throw new Error('FBX connected geometry is not a static mesh.');
  const positions = numericArray(node, 'Vertices');
  const indices = numericArray(node, 'PolygonVertexIndex');
  if (!positions.length || positions.length % 3) throw new Error('FBX vertex coordinates are incomplete.');
  const vertices = positions.length / 3;
  let faces = 0,
    corners = 0;
  for (const index of indices) {
    const vertex = index < 0 ? -index - 1 : index;
    if (!Number.isInteger(index) || index < -2147483648 || index > 2147483647 || vertex >= vertices)
      throw new Error('FBX polygon contains an unresolved vertex index.');
    corners++;
    if (index < 0) {
      if (corners < 3) throw new Error('FBX polygon has fewer than three corners.');
      faces++;
      corners = 0;
    }
  }
  if (corners || !faces) throw new Error('FBX polygons are unclosed or empty.');
  return faces;
}

function count(document: FbxDocument): number {
  const objects = singleNode(document.nodes, 'Objects');
  const connected = singleNode(document.nodes, 'Connections');
  if (!objects || !connected || !singleNode(document.nodes, 'GlobalSettings'))
    throw new Error('FBX objects, connections or global settings are missing.');
  const identifiers = new Set<number>();
  for (const node of objects.children)
    if (typeof node.properties[0] === 'number') {
      const id = identifier(node.properties[0]);
      if (identifiers.has(id)) throw new Error('FBX object identifier types collide.');
      identifiers.add(id);
    }
  const modelList = models(document, objects),
    links = connections(connected);
  validateHierarchy(modelList, links);
  const geometry = objectEntries(objects.children, 'Geometry');
  validateFbxCurves(geometry, modelList, links);
  const bones = fbxBoneModels(objects, (kind) => objectEntries(objects.children, kind), links);
  const modelIds = new Set(modelList.map((model) => model.id));
  if ([...geometry.keys()].some((id) => modelIds.has(id)))
    throw new Error('FBX object identifier types collide.');
  const counts = new Map<number, number>(),
    named = new Map<string, number>();
  const lastGeometry = new Map<number, number>();
  for (const link of links) {
    if (!geometry.has(link.child)) continue;
    if (geometry.get(link.child)!.properties[2] === 'Shape') continue;
    if (!modelIds.has(link.parent)) throw new Error('FBX geometry has an unresolved model connection.');
    lastGeometry.set(link.parent, link.child);
  }
  let rawFaces = 0;
  for (const model of modelList) {
    if (model.type !== 'Mesh' || bones.has(model.id)) continue;
    const source = lastGeometry.get(model.id);
    if (source === undefined) throw new Error('FBX mesh has no connected geometry.');
    if (!counts.has(source)) counts.set(source, geometryFaces(geometry.get(source)!));
    const faces = counts.get(source)!;
    rawFaces += faces;
    // 网页 modelInfoMap 使用普通对象；__proto__ 是原型赋值，Mi 枚举时会排除。
    if (model.name !== '__proto__') named.set(model.name, faces);
  }
  // Mi 只在存在可枚举 modelInfo 时重算，否则保留 loader 原始累加值。
  return named.size ? [...named.values()].reduce((sum, value) => sum + value, 0) : rawFaces;
}

export function inspectFbxFaces(bytes: Buffer): FbxFaceCount {
  try {
    if (bytes.length > 150 * 1024 * 1024) throw new Error('FBX exceeds the model input byte limit.');
    const document =
      bytes.subarray(0, 18).toString('ascii') === 'Kaydara FBX Binary'
        ? readBinaryFbx(bytes)
        : readAsciiFbx(bytes);
    return { face_count: count(document) };
  } catch (error) {
    return {
      face_count: null,
      reason: error instanceof Error ? error.message : 'FBX could not be verified offline.',
    };
  }
}
