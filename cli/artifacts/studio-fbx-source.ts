/** 原 FBX 只读证明：限定可独立解释的静态对象，不把未知数据交给引擎后静默丢弃。 */
import { mat4, vec3 } from 'gl-matrix';
import { readBinaryFbx } from '../../studio/fbx/binary.ts';
import { singleNode, type FbxNode, type FbxValue } from '../../studio/fbx/structure.ts';
import { frontendFail as fail } from './studio-assimp-normalize.ts';
import {
  defaultFbxMaterial,
  fbxMaterialProperties,
  readStaticFbxMaterial,
  type StaticFbxMaterial,
} from './studio-fbx-material.ts';
import { attachFbxBaseColorTexture, fbxTextureProperties } from './studio-fbx-texture.ts';
import { interpretFbxOpaqueAlphaAliases } from './studio-fbx-opaque-alpha.ts';
import { readFbxSkin, validateFbxBindPoses, type FbxSourceSkin, type FbxWeights } from './studio-fbx-skin.ts';

export type FbxPoint = [number, number, number];
export interface StaticFbxCorner {
  position: FbxPoint;
  normal: FbxPoint;
  uv?: [number, number];
  weights?: FbxWeights;
}
export interface StaticFbxMesh {
  name: string;
  matrix: mat4;
  polygons: StaticFbxCorner[][];
  material: StaticFbxMaterial;
  skin?: FbxSourceSkin;
}
export interface StaticFbxSource {
  names: string[];
  meshes: StaticFbxMesh[];
  pivot: FbxPoint;
  extent: number;
}

export function isBinaryFrontendFbx(bytes: Buffer): boolean {
  return bytes.length >= 27 && bytes.subarray(0, 23).toString('binary') === 'Kaydara FBX Binary  \0\x1a\0';
}
function number(value: FbxValue | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fail('FBX numbers must be finite.');
  return value;
}
function identifier(value: FbxValue | undefined): number {
  const result = number(value);
  if (!Number.isSafeInteger(result) || result < 0) return fail('FBX object identifiers are invalid.');
  return result;
}
function properties(node: FbxNode | undefined): Map<string, FbxValue[]> {
  const output = new Map<string, FbxValue[]>();
  for (const entry of singleNode(node?.children ?? [], 'Properties70')?.children ?? []) {
    const [name, , , flags] = entry.properties;
    if (
      entry.name !== 'P' ||
      typeof name !== 'string' ||
      output.has(name) ||
      (typeof flags === 'string' && flags.includes('U')) ||
      entry.children.length
    )
      return fail('Custom, repeated or nested FBX properties need a separate proof.');
    output.set(name, entry.properties.slice(4));
  }
  return output;
}
function equal(values: FbxValue[], expected: readonly (number | string)[]): boolean {
  return values.length === expected.length && values.every((v, i) => v === expected[i]);
}
function modelDefaults(name: string): number[] | undefined {
  if (['LookAtProperty', 'UpVectorProperty'].includes(name)) return [];
  if (name === 'DefaultAttributeIndex') return [-1];
  if (name === 'AxisLen') return [10];
  if (['Show', 'NegativePercentShapeSupport', 'Visibility', 'Visibility Inheritance'].includes(name))
    return [1];
  if (['GeometricScaling', 'ScalingMax', 'Scaling'].includes(name)) return [1, 1, 1];
  if (['Translation', 'Rotation'].includes(name)) return [0, 0, 0];
  if (
    /^(RotationOffset|RotationPivot|ScalingOffset|ScalingPivot|PreRotation|PostRotation|GeometricTranslation|GeometricRotation|TranslationMin|TranslationMax|RotationMin|RotationMax|ScalingMin)$/.test(
      name,
    )
  )
    return [0, 0, 0];
  if (
    /^(QuaternionInterpolate|RotationOrder|RotationSpaceForLimitOnly|InheritType|Freeze|LODBox|(Translation|Rotation|Scaling)Active|(Translation|Rotation|Scaling)(Min|Max)[XYZ]|RotationStiffness[XYZ]|(Min|Max)Damp(Range|Strength)[XYZ]|PreferedAngle[XYZ])$/.test(
      name,
    )
  )
    return [0];
}
function staticProperties(node: FbxNode | undefined, kind: string): Map<string, FbxValue[]> {
  const values = properties(node);
  for (const [name, value] of values) {
    if (kind === 'Model' && ['Lcl Translation', 'Lcl Rotation', 'Lcl Scaling'].includes(name)) {
      if (
        value.length !== 3 ||
        value.some((v) => typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e6)
      )
        return fail('FBX local transforms exceed the finite static TRS subset.');
      if (name === 'Lcl Scaling' && value.some((v) => number(v) <= 0))
        return fail('FBX reflected or singular scaling needs a separate winding proof.');
      continue;
    }
    if (kind === 'Model' && modelAlternateDefault(name, value)) continue;
    const defaults = propertyDefaults(kind, name);
    if (!defaults || !equal(value, defaults))
      return fail('FBX has nondefault or unverified static object properties.');
  }
  return values;
}
function modelAlternateDefault(name: string, values: FbxValue[]): boolean {
  const defaults: Record<string, number[]> = {
    InheritType: [1],
    RotationActive: [1],
    ScalingMax: [0, 0, 0],
    DefaultAttributeIndex: [0],
  };
  return Object.hasOwn(defaults, name) && equal(values, defaults[name]!);
}
function propertyDefaults(kind: string, name: string): number[] | undefined {
  if (kind === 'Model') return modelDefaults(name);
  if (name === 'Color') return [0.8, 0.8, 0.8];
  const defaults: Record<string, Record<string, number[]>> = {
    Geometry: {
      BBoxMin: [0, 0, 0],
      BBoxMax: [0, 0, 0],
      'Primary Visibility': [1],
      'Casts Shadows': [1],
      'Receive Shadows': [1],
    },
    NodeAttribute: { Size: [100], Look: [1] },
  };
  const fields = defaults[kind];
  return fields && Object.hasOwn(fields, name) ? fields[name] : undefined;
}
function templates(nodes: FbxNode[]): Map<string, Map<string, FbxValue[]>> {
  const result = new Map<string, Map<string, FbxValue[]>>();
  for (const entry of singleNode(nodes, 'Definitions')?.children ?? []) {
    if (entry.name !== 'ObjectType') continue;
    const kind = String(entry.properties[0]);
    if (
      ![
        'Model',
        'Geometry',
        'NodeAttribute',
        'GlobalSettings',
        'Material',
        'Texture',
        'Video',
        'Pose',
        'Deformer',
      ].includes(kind) ||
      result.has(kind)
    )
      return fail('FBX templates contain unverified object types.');
    const template = singleNode(entry.children, 'PropertyTemplate');
    if (kind === 'Pose' || kind === 'Deformer') {
      if (template) return fail('FBX deformer/pose templates need a separate contract.');
      result.set(kind, new Map());
      continue;
    }
    if (kind === 'Texture' || kind === 'Video') {
      if (!template || template.properties[0] !== (kind === 'Texture' ? 'FbxFileTexture' : 'FbxVideo'))
        return fail('FBX texture/video template is outside the verified embedded subset.');
      result.set(kind, fbxTextureProperties(template, kind));
      continue;
    }
    if (kind === 'Material') {
      if (!template || !['FbxSurfacePhong', 'FbxSurfaceLambert'].includes(String(template.properties[0])))
        return fail('FBX material template is outside the verified scalar subset.');
      result.set(kind, fbxMaterialProperties(template));
      continue;
    }
    if (
      template &&
      template.properties[0] !== { Model: 'FbxNode', Geometry: 'FbxMesh', NodeAttribute: 'FbxNull' }[kind]
    )
      return fail('FBX property template type is not verified.');
    result.set(kind, staticProperties(template, kind));
  }
  return result;
}
function axisSettings(nodes: FbxNode[]): void {
  const settings = singleNode(nodes, 'GlobalSettings');
  if (!settings) return fail('FBX global axes are missing.');
  const values = properties(settings);
  for (const [name, value] of Object.entries({
    UpAxis: 1,
    UpAxisSign: 1,
    FrontAxis: 2,
    FrontAxisSign: 1,
    CoordAxis: 0,
    CoordAxisSign: 1,
    UnitScaleFactor: 100,
  }))
    if (!equal(values.get(name) ?? [], [value]))
      return fail('FBX frontend proof currently requires the observed Y-up axes and unit scale.');
  for (const [name, value] of values)
    if (
      ![
        'UpAxis',
        'UpAxisSign',
        'FrontAxis',
        'FrontAxisSign',
        'CoordAxis',
        'CoordAxisSign',
        'UnitScaleFactor',
        'OriginalUpAxis',
        'OriginalUpAxisSign',
        'OriginalUnitScaleFactor',
        'AmbientColor',
        'DefaultCamera',
        'TimeMode',
        'TimeSpanStart',
        'TimeSpanStop',
        'CustomFrameRate',
        'TimeProtocol',
        'SnapOnFrameMode',
      ].includes(name) ||
      (name === 'AmbientColor' && !equal(value, [0, 0, 0]))
    )
      return fail('FBX global settings need a separate effect proof.');
}
function array(node: FbxNode, name: string): Float64Array {
  const item = singleNode(node.children, name),
    value = item?.properties[0];
  if (!item || item.properties.length !== 1 || !(value instanceof Float64Array) || item.children.length)
    return fail('FBX mesh numeric arrays are missing or ambiguous.');
  return value;
}
function layer(
  node: FbxNode,
  name: 'Normal' | 'UV',
  vertices: number,
  corners: number,
  polygons: number,
): ((vertex: number, corner: number, polygon: number) => number[]) | undefined {
  const data = singleNode(node.children, `LayerElement${name}`);
  if (!data) return undefined;
  if (!equal(data.properties, [0])) return fail('Only the first FBX normal and UV layer is verified.');
  const plural = name === 'Normal' ? 'Normals' : 'UV',
    stride = name === 'Normal' ? 3 : 2;
  if (
    data.children.some(
      (entry) =>
        ![
          'Version',
          'Name',
          'MappingInformationType',
          'ReferenceInformationType',
          plural,
          `${plural}Index`,
          ...(name === 'Normal' ? ['NormalsW'] : []),
        ].includes(entry.name),
    )
  )
    return fail('FBX vertex layers contain unverified properties.');
  const mapping = singleNode(data.children, 'MappingInformationType')?.properties[0],
    reference = singleNode(data.children, 'ReferenceInformationType')?.properties[0],
    count = layerSlot(mapping, vertices, corners, polygons, 1),
    values = array(data, plural),
    indices = reference === 'IndexToDirect' ? array(data, `${plural}Index`) : undefined;
  if (name === 'Normal') validateNormalW(data, values.length / 3);
  if (
    !count ||
    !['Direct', 'IndexToDirect'].includes(String(reference)) ||
    !values.length ||
    values.length % stride ||
    (indices ? indices.length !== count : values.length !== count * stride) ||
    (!indices && singleNode(data.children, `${plural}Index`))
  )
    return fail('FBX normal or UV mapping is not a complete direct/indexed layer.');
  return (vertex, corner, polygon) => {
    const slot = layerSlot(mapping, vertex, corner, polygon, 0),
      index = indices ? indices[slot]! : slot;
    if (!Number.isSafeInteger(index) || index < 0 || (index + 1) * stride > values.length)
      return fail('FBX normal or UV index is out of range.');
    return Array.from(values.subarray(index * stride, (index + 1) * stride));
  };
}
function validateNormalW(layer: FbxNode, count: number): void {
  if (!singleNode(layer.children, 'NormalsW')) return;
  const values = array(layer, 'NormalsW');
  if (values.length !== count || values.some((value) => value !== 1))
    return fail('FBX normal W components differ from the observed homogeneous defaults.');
}
function layerSlot(
  mapping: FbxValue | undefined,
  vertex: number,
  corner: number,
  polygon: number,
  all: number,
): number {
  switch (mapping) {
    case 'ByVertice':
    case 'ByVertex':
      return vertex;
    case 'ByPolygonVertex':
      return corner;
    case 'ByPolygon':
      return polygon;
    case 'AllSame':
      return all;
    default:
      return fail('FBX layer mapping mode is unverified.');
  }
}
function mesh(
  node: FbxNode,
  name: string,
  matrix: mat4,
  material: StaticFbxMaterial,
  skin?: FbxSourceSkin,
): StaticFbxMesh {
  if (
    node.properties[2] !== 'Mesh' ||
    node.children.some(
      (entry) =>
        ![
          'Properties70',
          'GeometryVersion',
          'Vertices',
          'PolygonVertexIndex',
          'Edges',
          'LayerElementNormal',
          'LayerElementUV',
          'LayerElementMaterial',
          'LayerElementSmoothing',
          'Layer',
        ].includes(entry.name),
    )
  )
    return fail('FBX mesh contains curves, colors, tangents, extra layers or other unverified geometry.');
  staticProperties(node, 'Geometry');
  const vertices = array(node, 'Vertices'),
    indices = array(node, 'PolygonVertexIndex');
  const polygons = readPolygons(vertices, indices),
    normals = layer(node, 'Normal', vertices.length / 3, indices.length, polygons.length),
    uv = layer(node, 'UV', vertices.length / 3, indices.length, polygons.length);
  if (!normals) return fail('Static FBX requires explicit source normals.');
  if (material.texture && !uv) return fail('Textured FBX requires one explicit UV layer.');
  validateMeshScalarLayers(node, polygons.length, material.shading !== 'default');
  validateLayers(node, Boolean(uv));
  let corner = 0;
  return {
    name,
    matrix,
    material,
    ...(skin ? { skin } : {}),
    polygons: polygons.map((polygon, face) =>
      polygon.map((vertex) => {
        const result: StaticFbxCorner = {
          position: Array.from(vertices.subarray(vertex * 3, vertex * 3 + 3)) as FbxPoint,
          normal: normals(vertex, corner, face) as FbxPoint,
          ...(skin ? { weights: skin.weights.get(vertex)! } : {}),
        };
        if (uv) {
          const value = uv(vertex, corner, face);
          result.uv = [value[0]!, 1 - value[1]!];
        }
        corner++;
        if (Math.hypot(...result.normal) < 1e-12) return fail('FBX contains a zero source normal.');
        return result;
      }),
    ),
  };
}
function readPolygons(vertices: Float64Array, indices: Float64Array): number[][] {
  if (
    !vertices.length ||
    vertices.length % 3 ||
    vertices.length > 600000 ||
    !indices.length ||
    indices.length > 300000
  )
    return fail('FBX geometry exceeds its bounded vertex/corner budget.');
  const polygons: number[][] = [],
    used = new Set<number>();
  let pending: number[] = [];
  for (const index of indices) {
    const vertex = index < 0 ? -index - 1 : index;
    if (!Number.isSafeInteger(index) || vertex < 0 || vertex >= vertices.length / 3)
      return fail('FBX polygon indices are invalid.');
    pending.push(vertex);
    used.add(vertex);
    if (pending.length > 64) return fail('FBX proof supports at most 64 corners per polygon.');
    if (index < 0) {
      if (pending.length < 3 || new Set(pending).size !== pending.length)
        return fail('FBX polygon is degenerate or repeats a vertex.');
      polygons.push(pending);
      pending = [];
    }
  }
  if (pending.length || !polygons.length || used.size !== vertices.length / 3)
    return fail('FBX polygons are unclosed or contain unused vertices.');
  return polygons;
}
function validateLayers(node: FbxNode, uv: boolean): void {
  const refs = new Set<string>();
  const expected = [
    'LayerElementNormal',
    ...(uv ? ['LayerElementUV'] : []),
    ...['LayerElementMaterial', 'LayerElementSmoothing'].filter((name) =>
      Boolean(singleNode(node.children, name)),
    ),
  ];
  const active = singleNode(node.children, 'Layer');
  for (const entry of active ? [active] : []) {
    if (!equal(entry.properties, [0])) return fail('Additional FBX geometry layers are unverified.');
    if (entry.children.some((child) => !['Version', 'LayerElement'].includes(child.name)))
      return fail('FBX active layer contains unverified declarations.');
    for (const ref of entry.children.filter((ref) => ref.name === 'LayerElement')) {
      const type = String(singleNode(ref.children, 'Type')?.properties[0]);
      if (
        ref.children.length !== 2 ||
        ref.children.some((child) => !['Type', 'TypedIndex'].includes(child.name)) ||
        !expected.includes(type) ||
        refs.has(type) ||
        singleNode(ref.children, 'TypedIndex')?.properties[0] !== 0
      )
        return fail('FBX active layer references are ambiguous or unsupported.');
      refs.add(type);
    }
  }
  if (expected.some((name) => !refs.has(name)))
    return fail('FBX source normals and UV must belong to the active layer.');
}
function validateMeshScalarLayers(node: FbxNode, polygons: number, hasMaterial: boolean): void {
  for (const [name, field, mapping, reference, count] of [
    ['LayerElementMaterial', 'Materials', 'AllSame', 'IndexToDirect', 1],
    ['LayerElementSmoothing', 'Smoothing', 'ByPolygon', 'Direct', polygons],
  ] as const) {
    const layer = singleNode(node.children, name);
    if (!layer) continue;
    if (
      !equal(layer.properties, [0]) ||
      layer.children.some(
        (entry) =>
          !['Version', 'Name', 'MappingInformationType', 'ReferenceInformationType', field].includes(
            entry.name,
          ),
      ) ||
      singleNode(layer.children, 'MappingInformationType')?.properties[0] !== mapping ||
      singleNode(layer.children, 'ReferenceInformationType')?.properties[0] !== reference
    )
      return fail('FBX scalar mesh layer is outside its verified mapping.');
    const values = array(layer, field);
    if (
      values.length !== count ||
      values.some((value) => (name === 'LayerElementMaterial' ? value !== 0 : ![0, 1].includes(value))) ||
      (name === 'LayerElementMaterial' && !hasMaterial)
    )
      return fail('FBX mesh material/smoothing indices are not complete and unambiguous.');
  }
}

export function readStaticFrontendFbx(bytes: Buffer): StaticFbxSource {
  try {
    return parse(bytes);
  } catch (error) {
    return fail(
      error instanceof Error && 'code' in error
        ? error.message
        : 'The binary FBX structure is outside the verified static subset.',
    );
  }
}
function parse(bytes: Buffer): StaticFbxSource {
  if (!isBinaryFrontendFbx(bytes) || bytes.length > 150 * 1024 * 1024)
    return fail('Frontend FBX requires a bounded binary FBX source.');
  const { nodes } = readBinaryFbx(bytes, { retainRawProperties: true });
  validateSections(nodes);
  axisSettings(nodes);
  const defaults = templates(nodes),
    { entries, parents, clusterBones, alphaMaterials } = graph(nodes),
    { names, meshes } = models(entries, parents, defaults, clusterBones, alphaMaterials);
  return { names, meshes, ...bounds(meshes) };
}
function validateSections(nodes: FbxNode[]): void {
  if (
    nodes.some(
      (node) =>
        ![
          'FBXHeaderExtension',
          'FileId',
          'CreationTime',
          'Creator',
          'GlobalSettings',
          'Documents',
          'References',
          'Definitions',
          'Objects',
          'Connections',
          'Takes',
        ].includes(node.name),
    )
  )
    return fail('FBX root has unverified sections.');
  if (
    (singleNode(nodes, 'References')?.children.length ?? 0) ||
    (singleNode(nodes, 'Takes')?.children ?? []).some(
      (node) => node.name !== 'Current' || !equal(node.properties, ['']),
    )
  )
    return fail('FBX references or animation takes are not supported by this static proof.');
}
function graph(nodes: FbxNode[]): {
  entries: Map<number, FbxNode>;
  parents: Map<number, number>;
  clusterBones: Map<number, number>;
  alphaMaterials: Set<number>;
} {
  const objects = singleNode(nodes, 'Objects'),
    connected = singleNode(nodes, 'Connections');
  if (!objects || !connected || objects.children.length > 4096)
    return fail('FBX object graph is missing or too large.');
  const {
      entries,
      links,
      materials: alphaMaterials,
    } = interpretFbxOpaqueAlphaAliases(graphEntries(objects), connected.children),
    parents = new Map<number, number>(),
    clusterBones = new Map<number, number>();
  for (const link of links) {
    const [child, parent] = connectionIds(link);
    if (link.properties[0] === 'OO' && isClusterLink(entries.get(child), entries.get(parent))) {
      if (clusterBones.has(parent)) return fail('FBX cluster links to multiple source limbs.');
      clusterBones.set(parent, child);
      continue;
    }
    if (!entries.has(child) || (parent !== 0 && !entries.has(parent)) || parents.has(child))
      return fail('FBX has missing, multiply-instanced or ambiguous object connections.');
    if ((link.properties[0] === 'OP') !== (entries.get(child)?.name === 'Texture'))
      return fail('Only an exact FBX base-color texture property connection is verified.');
    parents.set(child, parent);
  }
  if ([...entries].some(([id, node]) => (node.name === 'Pose' ? parents.has(id) : !parents.has(id))))
    return fail('Detached FBX objects cannot be excluded from verification.');
  validateConnections(entries, parents);
  return { entries, parents, clusterBones, alphaMaterials };
}
function graphEntries(objects: FbxNode): Map<number, FbxNode> {
  const entries = new Map<number, FbxNode>();
  for (const node of objects.children) {
    if (
      !['Geometry', 'Model', 'NodeAttribute', 'Material', 'Texture', 'Video', 'Pose', 'Deformer'].includes(
        node.name,
      )
    )
      return fail('FBX animation and other objects require a separate proof.');
    const id = identifier(node.properties[0]);
    if (!id || entries.has(id) || node.properties.length !== 3)
      return fail('FBX object identities are ambiguous.');
    entries.set(id, node);
  }
  return entries;
}
function connectionIds(link: FbxNode): [number, number] {
  if (
    link.name !== 'C' ||
    !(
      (link.properties.length === 3 && link.properties[0] === 'OO') ||
      (link.properties.length === 4 && link.properties[0] === 'OP' && link.properties[3] === 'DiffuseColor')
    ) ||
    link.children.length
  )
    return fail('FBX static proof requires direct object connections.');
  return [identifier(link.properties[1]), identifier(link.properties[2])];
}
function isClusterLink(child: FbxNode | undefined, parent: FbxNode | undefined): boolean {
  return (
    child?.name === 'Model' &&
    child.properties[2] === 'LimbNode' &&
    parent?.name === 'Deformer' &&
    parent.properties[2] === 'Cluster'
  );
}
function validateConnections(entries: Map<number, FbxNode>, parents: Map<number, number>): void {
  for (const [id, node] of entries) {
    if (node.name === 'Model') continue;
    if (node.name === 'Pose') continue;
    const parent = entries.get(parents.get(id)!);
    if (node.name === 'Deformer') {
      validateDeformerConnection(node, parent);
      continue;
    }
    if (node.name === 'Texture' || node.name === 'Video') {
      if (parent?.name !== (node.name === 'Texture' ? 'Material' : 'Texture'))
        return fail('FBX embedded texture/video is detached from its exact material.');
      continue;
    }
    if (
      !parent ||
      parent.name !== 'Model' ||
      (node.name === 'NodeAttribute'
        ? !['Null', 'LimbNode'].includes(String(parent.properties[2])) ||
          parent.properties[2] !== node.properties[2]
        : parent.properties[2] !== 'Mesh')
    )
      return fail('FBX geometry and null attributes must belong to their exact model type.');
  }
}
function validateDeformerConnection(node: FbxNode, parent: FbxNode | undefined): void {
  if (
    node.properties[2] === 'Skin'
      ? parent?.name !== 'Geometry' || parent.properties[2] !== 'Mesh'
      : node.properties[2] !== 'Cluster' || parent?.name !== 'Deformer' || parent.properties[2] !== 'Skin'
  )
    return fail('FBX skin and cluster must belong to their exact geometry and skin.');
}
function modelMaterials(
  entries: Map<number, FbxNode>,
  parents: Map<number, number>,
  defaults: Map<string, FbxValue[]> | undefined,
  alphaMaterials: Set<number>,
): Map<number, StaticFbxMaterial> {
  const materials = new Map<number, StaticFbxMaterial>();
  for (const [id, node] of entries)
    if (node.name === 'Material') {
      const material = readStaticFbxMaterial(node, defaults);
      attachFbxBaseColorTexture(material, id, entries, parents);
      if (alphaMaterials.has(id)) {
        if (material.texture?.mime_type !== 'image/png')
          return fail('Opaque FBX alpha alias is detached from its verified PNG material.');
        material.texture.opaque_alpha_alias = true;
      }
      if (
        [...materials.values()].some((other) => other.name === material.name) ||
        material.name === 'DefaultMaterial'
      )
        return fail('FBX material names must be unique and distinct from the default material.');
      materials.set(id, material);
    }
  return materials;
}
function models(
  entries: Map<number, FbxNode>,
  parents: Map<number, number>,
  defaults: Map<string, Map<string, FbxValue[]>>,
  clusterBones: Map<number, number>,
  alphaMaterials: Set<number>,
): { names: string[]; meshes: StaticFbxMesh[] } {
  const names: string[] = [],
    meshes: StaticFbxMesh[] = [],
    matrices = modelWorldMatrices(entries, parents, defaults.get('Model')),
    materials = modelMaterials(entries, parents, defaults.get('Material'), alphaMaterials);
  for (const [id, node] of entries) {
    if (node.name !== 'Model') continue;
    const name = node.properties[1],
      type = node.properties[2];
    if (
      typeof name !== 'string' ||
      !name ||
      name.length > 128 ||
      names.includes(name) ||
      !['Mesh', 'Null', 'LimbNode'].includes(String(type))
    )
      return fail('FBX proof requires uniquely named static Mesh/Null models.');
    names.push(name);
    const matrix = matrices.get(id)!;
    const children = [...entries]
      .filter(([child, value]) => parents.get(child) === id && value.name !== 'Model')
      .map(([, value]) => value);
    if (type === 'Null') {
      nullModel(children);
    } else if (type === 'LimbNode') {
      limbModel(children);
    } else {
      const geometry = children.filter((child) => child.name === 'Geometry'),
        assigned = children.filter((child) => child.name === 'Material');
      if (
        geometry.length !== 1 ||
        assigned.length > 1 ||
        children.length !== geometry.length + assigned.length
      )
        return fail('FBX Mesh requires one exact geometry and at most one verified material.');
      const material = assigned.length
        ? materials.get(identifier(assigned[0]!.properties[0]))!
        : defaultFbxMaterial();
      meshes.push(
        mesh(
          geometry[0]!,
          name,
          matrix,
          material,
          readFbxSkin(geometry[0]!, matrix, entries, parents, clusterBones, matrices),
        ),
      );
    }
  }
  if (
    !meshes.length ||
    names.length > 2048 ||
    entries.size !==
      names.length +
        meshes.length +
        materials.size +
        [...entries.values()].filter((node) => node.name === 'Texture' || node.name === 'Video').length +
        [...entries.values()].filter((node) => node.name === 'Pose' || node.name === 'Deformer').length +
        [...entries.values()].filter((node) => node.name === 'NodeAttribute').length
  )
    return fail('FBX contains an unverified or empty static graph.');
  verifySkinCoverage(entries, matrices, meshes);
  return { names, meshes };
}
function verifySkinCoverage(
  entries: Map<number, FbxNode>,
  matrices: Map<number, mat4>,
  meshes: StaticFbxMesh[],
): void {
  const bones = [...entries.values()].filter(
      (node) => node.name === 'Model' && node.properties[2] === 'LimbNode',
    ),
    usedBones = meshes.flatMap((mesh) => mesh.skin?.bones ?? []);
  if (
    bones.length !== usedBones.length ||
    bones.some((bone) => !usedBones.some((used) => used.name === bone.properties[1]))
  )
    return fail('Every FBX limb must belong to exactly one verified skin.');
  if (usedBones.length) validateFbxBindPoses(entries, matrices);
  else if ([...entries.values()].some((node) => node.name === 'Pose' || node.name === 'Deformer'))
    return fail('FBX contains a pose or deformer without verified skin bindings.');
}
function limbModel(children: FbxNode[]): void {
  const attribute = children[0];
  if (
    children.length !== 1 ||
    attribute?.name !== 'NodeAttribute' ||
    attribute.properties[2] !== 'LimbNode' ||
    attribute.children.some((node) => !['TypeFlags', 'Properties70'].includes(node.name)) ||
    singleNode(attribute.children, 'TypeFlags')?.properties[0] !== 'Skeleton'
  )
    return fail('FBX limb has unverified visible or attached objects.');
  for (const [name, values] of properties(attribute))
    if (
      name !== 'Size' ||
      values.length !== 1 ||
      typeof values[0] !== 'number' ||
      !Number.isFinite(values[0]) ||
      values[0] <= 0 ||
      values[0] > 1e6
    )
      return fail('FBX bone display attributes are outside the verified static subset.');
}
function modelWorldMatrices(
  entries: Map<number, FbxNode>,
  parents: Map<number, number>,
  defaults: Map<string, FbxValue[]> | undefined,
): Map<number, mat4> {
  const matrices = new Map<number, mat4>(),
    pending = new Set<number>();
  const visit = (id: number): mat4 => {
    if (matrices.has(id)) return matrices.get(id)!;
    const node = entries.get(id),
      parent = parents.get(id);
    if (!node || node.name !== 'Model' || parent === undefined || pending.has(id) || pending.size >= 64)
      return fail('FBX model hierarchy is missing, cyclic or too deep.');
    pending.add(id);
    let matrix = modelMatrix(node, defaults);
    if (parent !== 0) {
      const properties = new Map([...(defaults ?? []), ...staticProperties(node, 'Model')]);
      if (!equal(properties.get('InheritType') ?? [0], [1]))
        return fail('Nested FBX transforms require the verified RSrs inheritance mode.');
      matrix = mat4.multiply(mat4.create(), visit(parent), matrix);
    }
    pending.delete(id);
    matrices.set(id, matrix);
    return matrix;
  };
  for (const [id, node] of entries) if (node.name === 'Model') visit(id);
  return matrices;
}
function nullModel(children: FbxNode[]): void {
  if (
    children.some((child) => child.name !== 'NodeAttribute' || child.properties[2] !== 'Null') ||
    children.length > 1
  )
    return fail('FBX Null models cannot hide geometry or visible attributes.');
  for (const child of children) {
    staticProperties(child, 'NodeAttribute');
    if (
      child.children.some((entry) => !['TypeFlags', 'Properties70'].includes(entry.name)) ||
      singleNode(child.children, 'TypeFlags')?.properties[0] !== 'Null'
    )
      return fail('FBX Null attribute is not an empty helper.');
  }
}
function modelMatrix(node: FbxNode, defaults: Map<string, FbxValue[]> | undefined): mat4 {
  if (
    node.children.some(
      (entry) =>
        !['Version', 'Properties70', 'MultiLayer', 'MultiTake', 'Shading', 'Culling'].includes(entry.name),
    ) ||
    ['MultiLayer', 'MultiTake'].some((key) => {
      const value = singleNode(node.children, key);
      return value && !equal(value.properties, [0]);
    }) ||
    (singleNode(node.children, 'Culling') &&
      singleNode(node.children, 'Culling')!.properties[0] !== 'CullingOff')
  )
    return fail('FBX model display/animation settings need a separate proof.');
  const shading = singleNode(node.children, 'Shading');
  if (shading && shading.properties[0] !== true && shading.properties[0] !== 1)
    return fail('FBX nondefault model shading needs a separate effect proof.');
  const props = new Map([...(defaults ?? []), ...staticProperties(node, 'Model')]),
    translation = (props.get('Lcl Translation') ?? [0, 0, 0]) as number[],
    rotation = (props.get('Lcl Rotation') ?? [0, 0, 0]) as number[],
    scaling = (props.get('Lcl Scaling') ?? [1, 1, 1]) as number[],
    matrix = mat4.create();
  mat4.translate(matrix, matrix, translation);
  // FBX RotationOrder=0 为先 X、再 Y、再 Z；列向量合成是 T·Rz·Ry·Rx·S。
  mat4.rotateZ(matrix, matrix, (rotation[2]! * Math.PI) / 180);
  mat4.rotateY(matrix, matrix, (rotation[1]! * Math.PI) / 180);
  mat4.rotateX(matrix, matrix, (rotation[0]! * Math.PI) / 180);
  mat4.scale(matrix, matrix, scaling);
  return matrix;
}
function bounds(meshes: StaticFbxMesh[]): Pick<StaticFbxSource, 'pivot' | 'extent'> {
  const minimum = [Infinity, Infinity, Infinity],
    maximum = [-Infinity, -Infinity, -Infinity];
  let faces = 0;
  for (const mesh of meshes)
    for (const polygon of mesh.polygons) {
      faces += polygon.length - 2;
      for (const corner of polygon) {
        const point = vec3.transformMat4(vec3.create(), corner.position, mesh.matrix);
        for (let i = 0; i < 3; i++) {
          minimum[i] = Math.min(minimum[i]!, point[i]!);
          maximum[i] = Math.max(maximum[i]!, point[i]!);
        }
      }
    }
  const extent = Math.max(...maximum.map((value, i) => value - minimum[i]!));
  if (!Number.isFinite(extent) || extent <= 0 || faces > 100000)
    return fail('FBX surface extent or total triangle budget is invalid.');
  return {
    extent,
    pivot: [(minimum[0]! + maximum[0]!) / 2, minimum[1]!, (minimum[2]! + maximum[2]!) / 2],
  };
}
