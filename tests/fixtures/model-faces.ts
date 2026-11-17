/** 面数验证夹具只包含内嵌几何；可独立改变实例、名称、场景与 primitive 布局。 */
import { staticFbxNodes, type FbxFixtureNode } from './fbx.ts';

export function faceGlb(
  options: {
    faces?: number[][];
    modes?: number[][];
    meshNames?: string[];
    nodes?: Record<string, unknown>[];
    scenes?: Record<string, unknown>[];
    scene?: number;
    extra?: Record<string, unknown>;
  } = {},
): Buffer {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  const chunks: Buffer[] = [Buffer.from(positions.buffer)];
  const views: Record<string, unknown>[] = [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }];
  const accessors: Record<string, unknown>[] = [
    { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
  ];
  let bytes = positions.byteLength;
  const meshes = (options.faces ?? [[1]]).map((counts, mesh) => ({
    name: options.meshNames?.[mesh] ?? `geometry_${mesh}`,
    primitives: counts.map((faces, primitive) => {
      const mode = options.modes?.[mesh]?.[primitive] ?? 4;
      const indices = Uint16Array.from(
        { length: mode === 4 ? faces * 3 : faces + 2 },
        (_, index) => index % 4,
      );
      const chunk = Buffer.alloc(Math.ceil(indices.byteLength / 4) * 4);
      Buffer.from(indices.buffer).copy(chunk);
      views.push({ buffer: 0, byteOffset: bytes, byteLength: indices.byteLength });
      accessors.push({
        bufferView: views.length - 1,
        componentType: 5123,
        count: indices.length,
        type: 'SCALAR',
      });
      bytes += chunk.length;
      chunks.push(chunk);
      return { attributes: { POSITION: 0 }, indices: accessors.length - 1, mode };
    }),
  }));
  const nodes = options.nodes ?? [{ name: 'part', mesh: 0 }];
  const json = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bytes }],
    bufferViews: views,
    accessors,
    meshes,
    nodes,
    scenes: options.scenes ?? [{ name: 'selected', nodes: nodes.map((_, index) => index) }],
    scene: options.scene ?? 0,
    ...options.extra,
  };
  const text = Buffer.from(JSON.stringify(json)),
    padded = Buffer.alloc(Math.ceil(text.length / 4) * 4, 0x20);
  text.copy(padded);
  const buffer = Buffer.alloc(28 + padded.length + bytes);
  buffer.write('glTF');
  buffer.writeUInt32LE(2, 4);
  buffer.writeUInt32LE(buffer.length, 8);
  buffer.writeUInt32LE(padded.length, 12);
  buffer.writeUInt32LE(0x4e4f534a, 16);
  padded.copy(buffer, 20);
  buffer.writeUInt32LE(bytes, 20 + padded.length);
  buffer.writeUInt32LE(0x004e4942, 24 + padded.length);
  Buffer.concat(chunks).copy(buffer, 28 + padded.length);
  return buffer;
}

export function skinnedFbxNodes(names = ['mesh']): FbxFixtureNode[] {
  const nodes = staticFbxNodes(names);
  const identity = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  nodes[1]!.children!.push(
    { name: 'Model', properties: [400, 'bone', 'LimbNode'], children: [] },
    { name: 'Deformer', properties: [300, 'skin', 'Skin'], children: [] },
    {
      name: 'Deformer',
      properties: [301, 'cluster', 'Cluster'],
      children: [
        { name: 'Indexes', properties: [new Int32Array([0, 1, 2, 3, 4])] },
        { name: 'Weights', properties: [new Float64Array([1, 1, 1, 1, 1])] },
        { name: 'Transform', properties: [identity] },
        { name: 'TransformLink', properties: [identity] },
      ],
    },
    {
      name: 'Pose',
      properties: [500, 'pose', 'BindPose'],
      children: [
        { name: 'NbPoseNodes', properties: [names.length + 1] },
        ...[...names.map((_, i) => 200 + i), 400].map((id) => ({
          name: 'PoseNode',
          children: [
            { name: 'Node', properties: [id] },
            { name: 'Matrix', properties: [identity] },
          ],
        })),
      ],
    },
  );
  nodes[2]!.children!.push(
    { name: 'C', properties: ['OO', 300, 100] },
    { name: 'C', properties: ['OO', 301, 300] },
    { name: 'C', properties: ['OO', 400, 301] },
    { name: 'C', properties: ['OO', 400, 0] },
  );
  return nodes;
}

export function morphedFbxNodes(): FbxFixtureNode[] {
  const nodes = staticFbxNodes();
  nodes[1]!.children!.push(
    {
      name: 'Geometry',
      properties: [101, 'target', 'Shape'],
      children: [
        { name: 'Indexes', properties: [new Int32Array([0, 1])] },
        { name: 'Vertices', properties: [new Float64Array([0, 0, 1, 0, 0, 1])] },
      ],
    },
    { name: 'Deformer', properties: [300, 'morph', 'BlendShape'], children: [] },
    {
      name: 'Deformer',
      properties: [301, 'channel', 'BlendShapeChannel'],
      children: [
        { name: 'DeformPercent', properties: [0] },
        { name: 'FullWeights', properties: [new Float64Array([100])] },
      ],
    },
  );
  nodes[2]!.children!.push(
    { name: 'C', properties: ['OO', 300, 100] },
    { name: 'C', properties: ['OO', 301, 300] },
    { name: 'C', properties: ['OO', 101, 301] },
  );
  return nodes;
}
