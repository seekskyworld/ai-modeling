/** UV压缩的合法表面：有限数量的独立根mesh，逐primitive核对完整有向表面。 */
import { createHash } from 'node:crypto';
import type { Material, Node, Primitive } from '@gltf-transform/core';
import { mat3, vec3 } from 'gl-matrix';
import { array, object, TripoError } from '../../studio/contracts/errors.ts';
import { modelIO } from '../local/gltf.ts';

export type Triple = [number, number, number];
export type Bounds = { min: Triple; max: Triple };
type Corner = { p: Triple; uv: [number, number]; n: Triple };
export type UvFace = [Corner, Corner, Corner];
export interface UvPart {
  faces: UvFace[];
  node: Record<string, unknown>;
  mesh: Record<string, unknown>;
  nodeMatrix: number[];
  material: string;
  nodeIndex: number;
  primitiveIndex: number;
  primitive: Record<string, unknown>;
}
export interface UvSurface {
  json: Record<string, unknown>;
  binary: Buffer;
  parts: UvPart[];
  triangles: number;
  vertices: number;
  bounds: Bounds;
}
export interface UvImportSource {
  version: 1;
  source_sha256: string;
  source_bytes: number;
  triangles: number;
  vertices: number;
  bounds: Bounds;
  normalization_extent: number;
  normalization_center: Triple;
}
export const uvHash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
export const uvFail = (message: string): never => {
  throw new TripoError('UV_COMPRESSION_UNSUPPORTED', message, 'not_submitted');
};
function parse(bytes: Buffer): { json: Record<string, unknown>; binary: Buffer } {
  if (
    bytes.length < 28 ||
    bytes.length > 300 * 1024 * 1024 ||
    bytes.toString('ascii', 0, 4) !== 'glTF' ||
    bytes.readUInt32LE(4) !== 2 ||
    bytes.readUInt32LE(8) !== bytes.length ||
    bytes.readUInt32LE(16) !== 0x4e4f534a
  )
    return uvFail('UV compression requires a bounded self-contained GLB 2.0.');
  const length = bytes.readUInt32LE(12),
    next = length + 20;
  if (
    length > 16 * 1024 * 1024 ||
    next + 8 > bytes.length ||
    bytes.readUInt32LE(next + 4) !== 0x004e4942 ||
    next + 8 + bytes.readUInt32LE(next) !== bytes.length
  )
    return uvFail('UV compression requires a single embedded GLB binary chunk.');
  const json = object(JSON.parse(bytes.toString('utf8', 20, next))),
    buffers = array(json.buffers).map(object),
    declared = buffers[0]?.byteLength;
  if (
    object(json.asset).version !== '2.0' ||
    buffers.some((buffer) => buffer.uri !== undefined) ||
    !Number.isSafeInteger(declared) ||
    Number(declared) < 0 ||
    Number(declared) > bytes.readUInt32LE(next) ||
    bytes.readUInt32LE(next) - Number(declared) > 3
  )
    return uvFail('UV compression cannot fetch external model resources.');
  return { json, binary: bytes.subarray(next + 8, next + 8 + Number(declared)) };
}
type ShapeOptions = { input?: boolean; discardTextures?: boolean };
function validateRootNode(node: Record<string, unknown>, meshes: Record<string, unknown>[]): void {
  if (
    !Number.isSafeInteger(node.mesh) ||
    Number(node.mesh) < 0 ||
    Number(node.mesh) >= meshes.length ||
    array(node.children).length ||
    node.camera !== undefined ||
    node.skin !== undefined ||
    array(meshes[Number(node.mesh)]!.primitives).length < 1 ||
    node.weights !== undefined ||
    node.extensions !== undefined
  )
    uvFail(
      'Each UV root must own triangle primitives; hierarchies, instances and node extensions are unsupported.',
    );
}
function validateShape(json: Record<string, unknown>, options: ShapeOptions = {}): void {
  const scene = object(array(json.scenes)[0]),
    nodes = array(json.nodes).map(object),
    meshes = array(json.meshes).map(object),
    roots = array(scene.nodes);
  if (
    array(json.scenes).length !== 1 ||
    nodes.length < 1 ||
    nodes.length > 64 ||
    meshes.length !== nodes.length ||
    roots.length !== nodes.length ||
    new Set(roots).size !== nodes.length ||
    roots.some(
      (index) => !Number.isSafeInteger(index) || Number(index) < 0 || Number(index) >= nodes.length,
    ) ||
    new Set(nodes.map((node) => node.mesh)).size !== meshes.length
  )
    uvFail('UV compression requires one scene with 1–64 independent, uniquely owned root meshes.');
  for (const node of nodes) validateRootNode(node, meshes);
  if (meshes.reduce((sum, mesh) => sum + array(mesh.primitives).length, 0) > 64)
    uvFail('UV compression supports at most 64 triangle primitives across all root meshes.');
  validateContent(json, options);
  for (const mesh of meshes) {
    if (mesh.weights !== undefined || mesh.extensions !== undefined)
      uvFail('UV compression cannot preserve mesh extensions or morph weights.');
    for (const primitive of array(mesh.primitives)) validatePrimitive(object(primitive), options);
  }
}
function validateContent(json: Record<string, unknown>, options: ShapeOptions): void {
  if (
    array(json.skins).length ||
    array(json.animations).length ||
    (!options.discardTextures && (array(json.images).length || array(json.textures).length)) ||
    (!options.input && array(json.materials).some((material) => object(material).extensions !== undefined))
  )
    uvFail(
      'UV compression requires static geometry without skeletons, animation, image textures or material extensions.',
    );
  const allowed = new Set(['KHR_mesh_quantization', 'EXT_meshopt_compression']);
  if (
    [...array(json.extensionsUsed), ...array(json.extensionsRequired)].some(
      (extension) => !allowed.has(String(extension)),
    )
  )
    uvFail('UV compression only supports verified geometry quantization and native Meshopt extensions.');
}
function validatePrimitive(primitive: Record<string, unknown>, options: ShapeOptions): void {
  const attributes = Object.keys(object(primitive.attributes)).sort();
  if (
    (primitive.mode ?? 4) !== 4 ||
    array(primitive.targets).length ||
    primitive.extensions !== undefined ||
    (options.input
      ? !attributes.includes('POSITION') ||
        attributes.some((name) => !['NORMAL', 'POSITION', 'TEXCOORD_0'].includes(name))
      : attributes.join(',') !== 'NORMAL,POSITION,TEXCOORD_0')
  )
    uvFail('UV compression requires position, normal and one UV set on triangles without morphs or colors.');
}
const emptyBounds = (): Bounds => ({
  min: [Infinity, Infinity, Infinity],
  max: [-Infinity, -Infinity, -Infinity],
});
function addPoint(bounds: Bounds, point: readonly number[]): void {
  if (point.some((value) => !Number.isFinite(value)))
    return uvFail('UV compression requires finite source geometry.');
  for (let axis = 0; axis < 3; axis++) {
    bounds.min[axis] = Math.min(bounds.min[axis]!, point[axis]!);
    bounds.max[axis] = Math.max(bounds.max[axis]!, point[axis]!);
  }
}
function geometryCounts(primitive: Primitive): { triangles: number; vertices: number } {
  const positions = primitive.getAttribute('POSITION')!,
    indices = primitive.getIndices()?.getArray(),
    count = indices?.length ?? positions.getCount();
  if (!count || count % 3) return uvFail('UV compression requires complete nonempty triangle surfaces.');
  if (indices?.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= positions.getCount()))
    return uvFail('UV compression input has invalid triangle indices.');
  return { triangles: count / 3, vertices: positions.getCount() };
}
function assertBudget(triangles: number, vertices: number): void {
  if (triangles > 25000 || vertices > 100000)
    uvFail('UV compression supports at most 25000 triangles and 100000 vertices across all meshes.');
}
/** 首个收费UV步骤前的结构预检；UV尚待生成，bake=false允许现有贴图由网页移除。 */
export async function inspectUvCompressionInput(
  bytes: Buffer,
  options: { discardTextures: boolean },
): Promise<UvImportSource & { has_uv: boolean; discard_textures: boolean }> {
  try {
    const { json } = parse(bytes);
    validateShape(json, { input: true, discardTextures: options.discardTextures });
    if (array(json.images).some((image) => object(image).uri !== undefined))
      return uvFail('UV compression preflight requires embedded images; external resources are not fetched.');
    const document = await (await modelIO()).readBinary(bytes),
      bounds = emptyBounds();
    let triangles = 0,
      vertices = 0,
      hasUv = true;
    for (const node of document.getRoot().listNodes())
      for (const primitive of node.getMesh()!.listPrimitives()) {
        const positions = primitive.getAttribute('POSITION')!,
          count = geometryCounts(primitive),
          matrix = node.getWorldMatrix();
        triangles += count.triangles;
        vertices += count.vertices;
        assertBudget(triangles, vertices);
        hasUv &&= Boolean(primitive.getAttribute('TEXCOORD_0'));
        for (let i = 0; i < positions.getCount(); i++)
          addPoint(
            bounds,
            Array.from(vec3.transformMat4(vec3.create(), positions.getElement(i, []), matrix)),
          );
      }
    return {
      ...boundsProof(bytes, bounds, triangles, vertices),
      has_uv: hasUv,
      discard_textures: options.discardTextures,
    };
  } catch (error) {
    if (error instanceof TripoError) throw error;
    return uvFail('The UV compression input could not be completely decoded and verified.');
  }
}
function materialSignature(material: Material | null): string {
  return JSON.stringify(
    material
      ? {
          color: material.getBaseColorFactor(),
          metallic: material.getMetallicFactor(),
          roughness: material.getRoughnessFactor(),
          emissive: material.getEmissiveFactor(),
          alpha: material.getAlphaMode(),
          cutoff: material.getAlphaCutoff(),
          doubleSided: material.getDoubleSided(),
        }
      : null,
    (_key, value: unknown) => (typeof value === 'number' ? Math.round(value * 1e6) / 1e6 : value),
  );
}
function partFaces(node: Node, primitive: Primitive, bounds: Bounds): UvFace[] {
  const positions = primitive.getAttribute('POSITION')!,
    normals = primitive.getAttribute('NORMAL')!,
    uvs = primitive.getAttribute('TEXCOORD_0')!,
    // glTF未声明indices时按连续三顶点组成面；只解读来源，不向上传或交付文件补写索引。
    indices =
      primitive.getIndices()?.getArray() ??
      Uint32Array.from({ length: positions.getCount() }, (_, index) => index);
  if (uvs.getCount() !== positions.getCount() || normals.getCount() !== positions.getCount())
    return uvFail('UV compression requires complete matching position, normal and UV attributes.');
  const matrix = node.getWorldMatrix(),
    normalMatrix = mat3.normalFromMat4(mat3.create(), matrix);
  if (!normalMatrix) return uvFail('UV compression does not accept a singular source transform.');
  const corners: Corner[] = [];
  for (let i = 0; i < positions.getCount(); i++) {
    const p = Array.from(vec3.transformMat4(vec3.create(), positions.getElement(i, []), matrix)) as Triple,
      uv = uvs.getElement(i, [0, 0] as [number, number]),
      n = Array.from(
        vec3.normalize(
          vec3.create(),
          vec3.transformMat3(vec3.create(), normals.getElement(i, []), normalMatrix),
        ),
      ) as Triple;
    if ([...uv, ...n].some((value) => !Number.isFinite(value)) || uv.some((v) => v < -1e-6 || v > 1 + 1e-6))
      return uvFail('UV compression requires finite model attributes and UV coordinates inside [0,1].');
    addPoint(bounds, p);
    corners.push({ p, uv, n });
  }
  const faces: UvFace[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const face = [corners[indices[i]!], corners[indices[i + 1]!], corners[indices[i + 2]!]];
    if (face.some((corner) => !corner)) return uvFail('UV compression encountered invalid triangle indices.');
    faces.push(face as UvFace);
  }
  return faces;
}
export async function readUvSurface(bytes: Buffer): Promise<UvSurface> {
  const { json, binary } = parse(bytes);
  validateShape(json);
  const document = await (await modelIO()).readBinary(bytes),
    parts: UvPart[] = [],
    bounds = emptyBounds();
  let triangles = 0,
    vertices = 0;
  for (const [index, node] of document.getRoot().listNodes().entries())
    for (const [primitiveIndex, primitive] of node.getMesh()!.listPrimitives().entries()) {
      const count = geometryCounts(primitive);
      triangles += count.triangles;
      vertices += count.vertices;
      assertBudget(triangles, vertices);
      const rawNode = object(array(json.nodes)[index]),
        mesh = object(array(json.meshes)[Number(rawNode.mesh)]);
      parts.push({
        faces: partFaces(node, primitive, bounds),
        node: rawNode,
        mesh,
        nodeMatrix: Array.from(node.getMatrix()),
        material: materialSignature(primitive.getMaterial()),
        nodeIndex: index,
        primitiveIndex,
        primitive: object(array(mesh.primitives)[primitiveIndex]),
      });
    }
  return { json, binary, parts, triangles, vertices, bounds };
}
export function boundsProof(
  bytes: Buffer,
  bounds: Bounds,
  triangles: number,
  vertices: number,
): UvImportSource {
  const extent = Math.max(...bounds.max.map((value, axis) => value - bounds.min[axis]!));
  if (!Number.isFinite(extent) || extent < 1e-6 || extent > 1e6)
    return uvFail('UV compression requires a measurable source extent between 1e-6 and 1e6 model units.');
  return {
    version: 1,
    source_sha256: uvHash(bytes),
    source_bytes: bytes.length,
    triangles,
    vertices,
    bounds,
    normalization_extent: extent,
    normalization_center: bounds.min.map((value, axis) => (value + bounds.max[axis]!) / 2) as Triple,
  };
}
/** 明显不支持的来源必须在上传、报价或提交前被调用方拒绝。 */
export async function inspectUvImportSource(bytes: Buffer): Promise<UvImportSource> {
  try {
    const source = await readUvSurface(bytes);
    return boundsProof(bytes, source.bounds, source.triangles, source.vertices);
  } catch (error) {
    if (error instanceof TripoError) throw error;
    return uvFail('The UV compression source could not be completely decoded and verified.');
  }
}
