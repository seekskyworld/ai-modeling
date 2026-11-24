/** Read downloaded bytes before accepting a Canvas result; never starts a remote operation. */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type {
  Accessor,
  AnimationChannel,
  Document,
  Node,
  Primitive,
  TextureInfo,
} from '@gltf-transform/core';
import type { Transform } from '@gltf-transform/extensions';
import { readBoundedFile, detectFormat } from '../../studio/files.ts';
import { array, object, TripoError } from '../../studio/contracts/errors.ts';
import sharp from '../runtime/sharp.ts';
import { modelIO } from './gltf.ts';

const positive = z.number().int().positive();
const expectations = z
  .object({
    kind: z.enum(['image', 'model']).optional(),
    width: positive.optional(),
    height: positive.optional(),
    min_width: positive.optional(),
    min_height: positive.optional(),
    min_triangles: z.number().int().nonnegative().optional(),
    max_triangles: z.number().int().nonnegative().optional(),
    min_meshes: positive.optional(),
    min_materials: z.number().int().nonnegative().optional(),
    textured: z.boolean().optional(),
    skinned: z.boolean().optional(),
    min_animations: z.number().int().nonnegative().optional(),
    animation_names: z.array(z.string().min(1).max(256)).max(256).optional(),
  })
  .strict()
  .refine(
    (x) =>
      x.min_triangles === undefined || x.max_triangles === undefined || x.min_triangles <= x.max_triangles,
    'min_triangles must not exceed max_triangles.',
  );
export const artifactInspectSchema = z
  .object({
    file_path: z.string().min(1).describe('Exact local image or self-contained GLB/GLTF to inspect.'),
    expected_sha256: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .optional()
      .describe('Bind inspection to the SHA-256 returned by the original download.'),
    expect: expectations
      .optional()
      .describe('Explicit measurable requirements; never a visual quality verdict.'),
  })
  .strict();

const MAX_FILE = 150 * 1024 * 1024;
const MAX_DECODED = 256 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const MAX_GEOMETRY = 4_000_000;
const images = new Set(['png', 'jpeg', 'webp']);
function invalid(message: string): never {
  throw new TripoError('INVALID_ARTIFACT', message, 'read');
}
function limit(message: string): never {
  throw new TripoError('ARTIFACT_INSPECTION_LIMIT', message, 'read');
}
function unsupported(message: string): never {
  throw new TripoError('UNSUPPORTED_ARTIFACT_FORMAT', message, 'read');
}
function supportedFormat(bytes: Buffer): string {
  let format: string;
  try {
    format = detectFormat(bytes, true);
  } catch (error) {
    const header = bytes.subarray(0, 12);
    const recognized =
      header.toString('ascii', 0, 4) === 'glTF' ||
      header.subarray(0, 4).equals(Buffer.from([137, 80, 78, 71])) ||
      (header[0] === 255 && header[1] === 216) ||
      header.toString('ascii', 8, 12) === 'WEBP' ||
      bytes.toString('utf8', 0, 32).trimStart().startsWith('{');
    if (recognized) throw error;
    return unsupported('Inspection supports PNG, JPEG, WebP and self-contained GLB/GLTF.');
  }
  if (!images.has(format) && !['glb', 'gltf'].includes(format))
    unsupported('This file format has no complete local inspector; use PNG, JPEG, WebP or GLB/GLTF.');
  return format;
}

async function inspectImage(bytes: Buffer) {
  try {
    const pipeline = sharp(bytes, { animated: true, failOn: 'error', limitInputPixels: MAX_PIXELS });
    const meta = await pipeline.metadata();
    const pages = meta.pages ?? 1;
    if (pages > 16) limit('Image inspection supports at most 16 frames.');
    const decoded = await pipeline
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const width = decoded.info.width,
      height = meta.pageHeight ?? decoded.info.height / pages;
    if (!Number.isInteger(height) || width <= 0 || height <= 0) invalid('Invalid decoded image dimensions.');
    if (width * height * pages > MAX_PIXELS) limit('Image inspection exceeds 40 million decoded pixels.');
    if (decoded.data.length !== width * height * pages * decoded.info.channels)
      invalid('The complete image frame buffer is inconsistent.');
    return {
      width,
      height,
      pages,
      channels: decoded.info.channels,
      has_alpha: meta.hasAlpha,
      orientation: meta.orientation ?? 1,
      dimensions: 'encoded_pixels_per_frame',
      decoded_pixels: width * height * pages,
      decoded_sha256: createHash('sha256').update(decoded.data).digest('hex'),
    };
  } catch (error) {
    if (error instanceof TripoError) throw error;
    invalid('The complete image could not be decoded within the supported pixel budget.');
  }
}

/** Reject unreasonable decoded allocations before invoking Meshopt or the glTF reader. */
function preflightModel(bytes: Buffer, format: string): void {
  const json = object(
    JSON.parse(
      format === 'glb' ? bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)) : bytes.toString('utf8'),
    ),
  );
  if (object(json.asset).version !== '2.0') invalid('Only glTF 2.0 can be inspected.');
  if (array(json.extensionsRequired).includes('KHR_draco_mesh_compression'))
    unsupported('Draco-compressed geometry has no configured decoder; Meshopt is supported.');
  const budgets: Record<string, number> = {
    nodes: 10000,
    meshes: 2000,
    accessors: 40000,
    images: 128,
    textures: 256,
    animations: 256,
    skins: 512,
  };
  for (const [field, maximum] of Object.entries(budgets))
    if (array(json[field]).length > maximum) limit(`Model inspection exceeds the ${field} limit.`);
  preflightAccessors(array(json.accessors));
  preflightViews(array(json.bufferViews));
  let buffers = 0;
  for (const buffer of array(json.buffers).map(object)) {
    const length = Number(buffer.byteLength);
    if (!Number.isSafeInteger(length) || length < 0) invalid('Invalid model buffer length.');
    buffers += length;
  }
  if (buffers > MAX_DECODED) limit('Model buffers exceed the 256 MiB decoded budget.');
  for (const material of array(json.materials).map(object))
    if (extensionTextures(material.extensions))
      unsupported('Additional material-extension texture slots are not yet covered by this inspector.');
  checkNodeGraph(array(json.nodes).map(object));
}

function extensionTextures(value: unknown, depth = 0): boolean {
  if (depth > 16) limit('Model material extensions exceed the inspection nesting limit.');
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, child]) => /texture$/i.test(key) || extensionTextures(child, depth + 1),
  );
}

function preflightAccessors(accessors: unknown[]): void {
  let decoded = 0;
  const sizes: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
  const components: Record<string, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  for (const raw of accessors) {
    const a = object(raw),
      count = Number(a.count),
      size = sizes[String(a.type)],
      component = components[String(a.componentType)];
    if (!Number.isSafeInteger(count) || count <= 0 || !size || !component)
      invalid('Model accessor has an invalid type or count.');
    decoded += count * size * component;
  }
  if (decoded > MAX_DECODED) limit('Model accessors exceed the 256 MiB decoded budget.');
}
function preflightViews(bufferViews: unknown[]): void {
  let views = 0;
  for (const raw of bufferViews) {
    const view = object(raw),
      length = Number(view.byteLength);
    if (!Number.isSafeInteger(length) || length < 0) invalid('Invalid model buffer view length.');
    views += length;
    const meshopt = object(object(view.extensions).EXT_meshopt_compression);
    if (Object.keys(meshopt).length) {
      const count = Number(meshopt.count),
        stride = Number(meshopt.byteStride);
      if (
        !Number.isSafeInteger(count) ||
        !Number.isSafeInteger(stride) ||
        count < 0 ||
        stride <= 0 ||
        count * stride !== length
      )
        invalid('Invalid Meshopt decoded buffer size.');
    }
  }
  if (views > MAX_DECODED) limit('Model buffer views exceed the 256 MiB decoded budget.');
}

function checkNodeGraph(nodes: Record<string, unknown>[]): void {
  const states = new Uint8Array(nodes.length),
    parents = new Uint16Array(nodes.length);
  for (const node of nodes)
    for (const child of array(node.children)) {
      if (typeof child !== 'number' || !Number.isInteger(child) || child < 0 || child >= nodes.length)
        invalid('Model hierarchy references an absent node.');
      if (++parents[child]! > 1) invalid('Model hierarchy gives a node multiple parents.');
    }
  const visit = (index: number, depth: number): void => {
    if (depth > 256) limit('Model hierarchy exceeds 256 levels.');
    if (states[index] === 1) invalid('Model hierarchy contains a cycle.');
    if (states[index] === 2) return;
    states[index] = 1;
    for (const child of array(nodes[index]!.children)) visit(child as number, depth + 1);
    states[index] = 2;
  };
  nodes.forEach((_node, index) => visit(index, 0));
}

function validateAccessors(document: Document): void {
  for (const accessor of document.getRoot().listAccessors()) {
    const values = accessor.getArray();
    if (!values || values.length !== accessor.getCount() * accessor.getElementSize())
      invalid('Model accessor cannot be completely decoded.');
    for (const value of values)
      if (!Number.isFinite(value)) invalid('Model accessor contains a non-finite value.');
  }
}

type Bounds = { min: number[]; max: number[] };
function addPoint(bounds: Bounds, point: number[]): void {
  if (!point.every(Number.isFinite)) invalid('Model has a non-finite transformed position.');
  for (let i = 0; i < 3; i++) {
    bounds.min[i] = Math.min(bounds.min[i]!, point[i]!);
    bounds.max[i] = Math.max(bounds.max[i]!, point[i]!);
  }
}
function primitiveTopology(primitive: Primitive, position: Accessor) {
  const indices = primitive.getIndices(),
    count = indices?.getCount() ?? position.getCount(),
    mode = primitive.getMode();
  if (
    indices &&
    (indices.getType() !== 'SCALAR' ||
      indices.getNormalized() ||
      ![5121, 5123, 5125].includes(indices.getComponentType()))
  )
    invalid('Model primitive has invalid indices.');
  if (!count || (mode === 4 && count % 3) || (mode === 1 && count % 2))
    invalid('Model primitive has incomplete topology.');
  if (([4, 5, 6].includes(mode) && count < 3) || ([1, 2, 3].includes(mode) && count < 2))
    invalid('Model primitive has empty topology.');
  if (count > MAX_GEOMETRY * 3 || position.getCount() > MAX_GEOMETRY)
    limit('Model primitive exceeds the geometry budget.');
  if (![0, 1, 2, 3, 4, 5, 6].includes(mode)) invalid('Unknown model primitive topology.');
  return { indices, count, mode };
}
function primitiveInfo(node: Node, primitive: Primitive, bounds: Bounds) {
  const position = primitive.getAttribute('POSITION');
  if (!position || position.getType() !== 'VEC3' || !position.getCount())
    invalid('Model primitive has no valid positions.');
  if (primitive.listAttributes().some((a) => a.getCount() !== position.getCount()))
    invalid('Model primitive attribute counts differ.');
  for (const target of primitive.listTargets())
    if (target.listAttributes().some((a) => a.getCount() !== position.getCount()))
      invalid('Morph target attribute counts differ.');
  const { indices, count, mode } = primitiveTopology(primitive, position);
  const world = node.getWorldMatrix();
  if (!world.every(Number.isFinite)) invalid('Model node has a non-finite transform.');
  for (let i = 0; i < count; i++) {
    const index = indices ? indices.getScalar(i) : i;
    if (!Number.isInteger(index) || index < 0 || index >= position.getCount())
      invalid('Model index references an absent vertex.');
    const p = position.getElement(index, []);
    addPoint(
      bounds,
      [0, 1, 2].map(
        (axis) =>
          world[axis]! * p[0]! + world[axis + 4]! * p[1]! + world[axis + 8]! * p[2]! + world[axis + 12]!,
      ),
    );
  }
  return {
    vertices: position.getCount(),
    triangles: mode === 4 ? count / 3 : [5, 6].includes(mode) ? count - 2 : 0,
    mode,
    morph_targets: primitive.listTargets().length,
  };
}

function animationChannelInfo(channel: AnimationChannel) {
  const node = channel.getTargetNode(),
    sampler = channel.getSampler();
  if (!node || !sampler) invalid('Model animation has incomplete channels.');
  const input = sampler.getInput(),
    output = sampler.getOutput();
  if (!input || !output || input.getType() !== 'SCALAR' || !input.getCount())
    invalid('Model animation has incomplete tracks.');
  const times = input.getArray()!;
  for (let i = 0; i < times.length; i++)
    if (times[i]! < 0 || (i > 0 && times[i]! <= times[i - 1]!))
      invalid('Animation times must be nonnegative and strictly increasing.');
  const interpolation = sampler.getInterpolation();
  if (!['LINEAR', 'STEP', 'CUBICSPLINE'].includes(interpolation)) invalid('Unknown animation interpolation.');
  validateAnimationOutput(channel, node, input, output, interpolation === 'CUBICSPLINE' ? 3 : 1);
  return { node, start: times[0]!, end: times[times.length - 1]! };
}
function validateAnimationOutput(
  channel: AnimationChannel,
  node: Node,
  input: Accessor,
  output: Accessor,
  multiple: number,
): void {
  const target = channel.getTargetPath();
  if (target === 'weights') {
    const targets = node.getMesh()?.listPrimitives()[0]?.listTargets().length ?? 0;
    if (
      !targets ||
      output.getType() !== 'SCALAR' ||
      output.getCount() !== input.getCount() * multiple * targets
    )
      invalid('Animation morph-weight tracks have inconsistent lengths.');
  } else if (
    !target ||
    !['translation', 'rotation', 'scale'].includes(target) ||
    output.getType() !== (target === 'rotation' ? 'VEC4' : 'VEC3') ||
    output.getCount() !== input.getCount() * multiple
  )
    invalid('Animation transform tracks have inconsistent lengths.');
}

function addAncestors(targets: Set<Node>, node: Node): void {
  let current: Node | null = node;
  while (current && !targets.has(current)) {
    targets.add(current);
    current = current.getParentNode();
  }
}
/** Only joints with positive influence on drawn vertices make their transform tracks relevant. */
function weightedJoints(node: Node): Set<Node> {
  const result = new Set<Node>(),
    skin = node.getSkin(),
    mesh = node.getMesh();
  if (!skin || !mesh) return result;
  const joints = skin.listJoints();
  for (const primitive of mesh.listPrimitives()) {
    const position = primitive.getAttribute('POSITION')!,
      indices = primitive.getIndices();
    const count = indices?.getCount() ?? position.getCount();
    const sets = primitive.listSemantics().filter((s) => s.startsWith('JOINTS_'));
    for (const semantic of sets) {
      const jointIndices = primitive.getAttribute(semantic)!,
        weights = primitive.getAttribute(semantic.replace('JOINTS_', 'WEIGHTS_'))!;
      for (let i = 0; i < count; i++) {
        const vertex = indices ? indices.getScalar(i) : i;
        const selected = jointIndices.getElement(vertex, []),
          influence = weights.getElement(vertex, []);
        for (let j = 0; j < 4; j++) if (influence[j]! > 0) result.add(joints[selected[j]!]!);
      }
    }
  }
  return result;
}
function geometryAnimationTargets(sceneNodes: Set<Node>): Set<Node> {
  const targets = new Set<Node>();
  for (const node of sceneNodes) {
    if (!node.getMesh()?.listPrimitives().length) continue;
    addAncestors(targets, node);
    for (const joint of weightedJoints(node)) addAncestors(targets, joint);
  }
  return targets;
}
function affectsGeometry(
  channel: AnimationChannel,
  node: Node,
  sceneNodes: Set<Node>,
  targets: Set<Node>,
): boolean {
  if (!sceneNodes.has(node)) return false;
  if (channel.getTargetPath() === 'weights')
    return Boolean(
      node
        .getMesh()
        ?.listPrimitives()
        .some((primitive) => primitive.listTargets().length > 0),
    );
  return targets.has(node);
}

function animationInfo(document: Document, sceneNodes: Set<Node>) {
  const targets = geometryAnimationTargets(sceneNodes);
  return document
    .getRoot()
    .listAnimations()
    .map((animation, index) => {
      let start = Infinity,
        end = -Infinity,
        active = 0,
        activeStart = Infinity,
        activeEnd = -Infinity;
      if (!animation.listChannels().length) invalid('Model animation contains no channels.');
      for (const channel of animation.listChannels()) {
        const info = animationChannelInfo(channel);
        start = Math.min(start, info.start);
        end = Math.max(end, info.end);
        if (info.end > info.start && affectsGeometry(channel, info.node, sceneNodes, targets)) {
          active++;
          activeStart = Math.min(activeStart, info.start);
          activeEnd = Math.max(activeEnd, info.end);
        }
      }
      return {
        index,
        name: animation.getName(),
        start,
        duration: end - start,
        channels: animation.listChannels().length,
        active_channels: active,
        active_start: active ? activeStart : null,
        active_duration: active ? activeEnd - activeStart : 0,
        active_channel_scope: 'time_spanning_default_scene_geometry_channels',
      };
    });
}

function textureCoordinates(info: TextureInfo): number {
  if (info.listExtensions().some((e) => e.extensionName !== 'KHR_texture_transform'))
    unsupported('This texture-coordinate extension is not supported by the inspector.');
  const transform = info.getExtension<Transform>('KHR_texture_transform');
  if (
    transform &&
    ![...transform.getOffset(), ...transform.getScale(), transform.getRotation()].every(Number.isFinite)
  )
    invalid('Texture transform contains a non-finite value.');
  return transform?.getTexCoord() ?? info.getTexCoord();
}
function validateTextureBindings(primitive: Primitive): void {
  const material = primitive.getMaterial();
  if (!material) return;
  const infos = [
    material.getBaseColorTextureInfo(),
    material.getMetallicRoughnessTextureInfo(),
    material.getNormalTextureInfo(),
    material.getOcclusionTextureInfo(),
    material.getEmissiveTextureInfo(),
  ];
  for (const info of infos) {
    if (!info) continue;
    const index = textureCoordinates(info);
    if (!Number.isInteger(index) || index < 0) invalid('Texture references an invalid UV set.');
    const uv = primitive.getAttribute(`TEXCOORD_${index}`),
      positions = primitive.getAttribute('POSITION')!;
    if (!uv || uv.getType() !== 'VEC2' || uv.getCount() !== positions.getCount())
      invalid('A bound material texture has no matching UV coordinates on its primitive.');
  }
}

function skinAttributes(node: Node, primitive: Primitive): void {
  const skin = node.getSkin();
  if (!skin) return;
  const positions = primitive.getAttribute('POSITION')!;
  if (!primitive.getAttribute('JOINTS_0') || !primitive.getAttribute('WEIGHTS_0'))
    invalid('A skinned primitive requires JOINTS_0 and WEIGHTS_0.');
  const jointCount = skin.listJoints().length,
    totals = new Float64Array(positions.getCount());
  const sets = new Set(
    primitive
      .listSemantics()
      .filter((s) => /^(JOINTS|WEIGHTS)_/.test(s))
      .map((s) => s.split('_')[1]!),
  );
  for (const set of sets) {
    const joints = primitive.getAttribute(`JOINTS_${set}`),
      weights = primitive.getAttribute(`WEIGHTS_${set}`);
    if (!joints || !weights) invalid('Skin joint and weight attributes must be paired.');
    validateSkinSet(joints, weights, positions.getCount(), jointCount, totals);
  }
  if (totals.some((weight) => !Number.isFinite(weight) || weight <= 0))
    invalid('Each skinned vertex requires a positive finite weight sum.');
}
function validateSkinSet(
  joints: Accessor,
  weights: Accessor,
  count: number,
  jointCount: number,
  totals: Float64Array,
): void {
  if (
    joints.getType() !== 'VEC4' ||
    weights.getType() !== 'VEC4' ||
    joints.getCount() !== count ||
    weights.getCount() !== count
  )
    invalid('Skin attribute shapes or counts do not match the model vertices.');
  if (joints.getNormalized() || ![5121, 5123].includes(joints.getComponentType()))
    invalid('Skin joints require unsigned integer indices.');
  for (let i = 0; i < count; i++) {
    const indices = joints.getElement(i, []),
      values = weights.getElement(i, []);
    for (let j = 0; j < 4; j++) {
      const index = indices[j]!,
        weight = values[j]!;
      if (!Number.isInteger(index) || index < 0 || index >= jointCount)
        invalid('Skin joint index is out of range.');
      if (!Number.isFinite(weight) || weight < 0) invalid('Skin weights must be finite and nonnegative.');
      totals[i] = totals[i]! + weight;
    }
  }
}
function skinInfo(document: Document) {
  return document
    .getRoot()
    .listSkins()
    .map((skin) => {
      const joints = skin.listJoints(),
        bind = skin.getInverseBindMatrices();
      if (
        !joints.length ||
        new Set(joints).size !== joints.length ||
        (bind && (bind.getType() !== 'MAT4' || bind.getCount() !== joints.length))
      )
        invalid('Model skin has an inconsistent joint or bind-matrix table.');
      return { name: skin.getName(), joints: joints.length };
    });
}
async function textureInfo(document: Document) {
  const textures = [];
  let pixels = 0;
  for (const [index, texture] of document.getRoot().listTextures().entries()) {
    const image = texture.getImage();
    if (!image) invalid('An embedded model texture has no bytes.');
    const data = Buffer.from(image),
      textureFormat = supportedFormat(data);
    if (!images.has(textureFormat)) unsupported('An embedded texture uses an unsupported image format.');
    const info = await inspectImage(data);
    pixels += info.decoded_pixels;
    if (pixels > 100_000_000) limit('Model textures exceed 100 million decoded pixels.');
    textures.push({
      index,
      name: texture.getName(),
      format: textureFormat,
      sha256: createHash('sha256').update(data).digest('hex'),
      ...info,
    });
  }
  return textures;
}

async function inspectModel(bytes: Buffer, format: string) {
  preflightModel(bytes, format);
  let document: Document;
  try {
    const io = await modelIO();
    document =
      format === 'glb'
        ? await io.readBinary(bytes)
        : await io.readJSON({ json: JSON.parse(bytes.toString('utf8')), resources: {} });
  } catch {
    invalid('The complete self-contained model could not be decoded.');
  }
  validateAccessors(document);
  const root = document.getRoot(),
    scene = root.getDefaultScene() ?? root.listScenes()[0];
  if (!scene) invalid('The model has no inspectable scene.');
  const nodes = new Set<Node>();
  scene.traverse((node) => nodes.add(node));
  const bounds: Bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const parts = [],
    materials = new Set<NonNullable<ReturnType<Primitive['getMaterial']>>>();
  let vertices = 0,
    triangles = 0,
    primitives = 0,
    skinned = false,
    morphs = false;
  for (const node of nodes) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const partsInfo = [];
    for (const primitive of mesh.listPrimitives()) {
      const info = primitiveInfo(node, primitive, bounds);
      skinAttributes(node, primitive);
      validateTextureBindings(primitive);
      vertices += info.vertices;
      triangles += info.triangles;
      primitives++;
      morphs ||= info.morph_targets > 0;
      if (vertices > MAX_GEOMETRY || triangles > MAX_GEOMETRY)
        limit('Default-scene geometry exceeds 4 million vertices or triangles.');
      if (primitive.getMaterial()) materials.add(primitive.getMaterial()!);
      partsInfo.push(info);
    }
    skinned ||= node.getSkin() !== null;
    parts.push({ node_index: root.listNodes().indexOf(node), name: node.getName(), primitives: partsInfo });
  }
  if (!vertices || !primitives) invalid('The default model scene has no geometry.');
  const textures = await textureInfo(document),
    skins = skinInfo(document);
  return {
    scene_index: root.listScenes().indexOf(scene),
    meshes: parts.length,
    primitives,
    geometry_scope: 'default_scene',
    vertices,
    triangles,
    materials: materials.size,
    textured: [...materials].some((m) =>
      Boolean(
        m.getBaseColorTexture() ||
        m.getMetallicRoughnessTexture() ||
        m.getNormalTexture() ||
        m.getOcclusionTexture() ||
        m.getEmissiveTexture(),
      ),
    ),
    skinned,
    skins,
    parts,
    textures,
    animations: animationInfo(document, nodes),
    bounds: {
      ...bounds,
      space: 'default_scene_node_transforms',
      skinning_applied: false,
      morphs_applied: false,
    },
    warnings: [
      ...(skinned ? ['Bounds do not evaluate skin deformation.'] : []),
      ...(morphs ? ['Bounds do not evaluate morph targets.'] : []),
    ],
  };
}

type Check = { requirement: string; status: 'passed' | 'failed'; expected: unknown; actual: unknown };
type ImageInfo = Awaited<ReturnType<typeof inspectImage>>;
type ModelInfo = Awaited<ReturnType<typeof inspectModel>>;
function requirementValues(kind: string, image?: ImageInfo, model?: ModelInfo): Record<string, unknown> {
  if (image)
    return {
      kind,
      width: image.width,
      height: image.height,
      min_width: image.width,
      min_height: image.height,
    };
  if (model)
    return {
      kind,
      min_triangles: model.triangles,
      max_triangles: model.triangles,
      min_meshes: model.meshes,
      min_materials: model.materials,
      textured: model.textured,
      skinned: model.skinned,
      min_animations: model.animations.filter((a) => a.active_channels > 0 && a.active_duration > 0).length,
      animation_names: model.animations
        .filter((a) => a.active_channels > 0 && a.active_duration > 0)
        .map((a) => a.name),
    };
  return { kind };
}
function expectationPassed(key: string, expected: unknown, actual: unknown): boolean {
  if (key === 'animation_names')
    return (
      Array.isArray(actual) &&
      (expected as string[]).every((name) => actual.filter((n) => n === name).length === 1)
    );
  if (key.startsWith('min_')) return typeof actual === 'number' && actual >= (expected as number);
  if (key.startsWith('max_')) return typeof actual === 'number' && actual <= (expected as number);
  return actual === expected;
}
function requirementChecks(
  request: z.infer<typeof artifactInspectSchema>,
  sha256: string,
  actual: Record<string, unknown>,
): Check[] {
  const checks: Check[] = [];
  if (request.expected_sha256)
    checks.push({
      requirement: 'expected_sha256',
      expected: request.expected_sha256.toLowerCase(),
      actual: sha256,
      status: request.expected_sha256.toLowerCase() === sha256 ? 'passed' : 'failed',
    });
  for (const [key, value] of Object.entries(request.expect ?? {}))
    checks.push({
      requirement: key,
      expected: value,
      actual: actual[key] ?? null,
      status: expectationPassed(key, value, actual[key]) ? 'passed' : 'failed',
    });
  return checks;
}
/** No expectation turns structural readability into a visual or semantic acceptance verdict. */
export async function inspectArtifact(input: unknown, roots: string[]) {
  const request = artifactInspectSchema.parse(input);
  const file = await readBoundedFile(request.file_path, roots, MAX_FILE),
    format = supportedFormat(file.bytes);
  const kind = images.has(format) ? 'image' : 'model';
  const image = kind === 'image' ? await inspectImage(file.bytes) : undefined;
  const model = kind === 'model' ? await inspectModel(file.bytes, format) : undefined;
  const checks = requirementChecks(request, file.sha256, requirementValues(kind, image, model));
  const requirements = checks.length
    ? checks.every((c) => c.status === 'passed')
      ? 'passed'
      : 'failed'
    : 'not_requested';
  return {
    schema_version: 1,
    status: requirements === 'failed' ? 'requirements_failed' : 'inspected',
    sha256: file.sha256,
    bytes: file.bytes.length,
    format,
    kind,
    content_validation: kind === 'image' ? 'complete_image_decode' : 'decoded_model_structure',
    ...(image ? { image } : {}),
    ...(model ? { model } : {}),
    checks,
    requirements_status: requirements,
    visual_review_required: true,
    visual_review: 'not_checked',
    semantic_review: 'not_checked',
  };
}
