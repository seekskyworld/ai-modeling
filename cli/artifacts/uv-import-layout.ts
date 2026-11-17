/** 原生导入会改写多primitive法线；只拆JSON布局再核实重组，绝不本地编码或修补几何。 */
import { mat4 } from 'gl-matrix';
import { array, object } from '../../studio/contracts/errors.ts';
import { readUvSurface, uvFail, uvHash, type UvSurface } from './uv-import-surface.ts';

export function writeUvGlb(json: Record<string, unknown>, binary: Buffer): Buffer {
  const raw = Buffer.from(JSON.stringify(json)),
    jp = (4 - (raw.length % 4)) % 4,
    bp = (4 - (binary.length % 4)) % 4,
    header = Buffer.alloc(20),
    binaryHeader = Buffer.alloc(8);
  header.write('glTF');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(28 + raw.length + jp + binary.length + bp, 8);
  header.writeUInt32LE(raw.length + jp, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  binaryHeader.writeUInt32LE(binary.length + bp);
  binaryHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, raw, Buffer.alloc(jp, 0x20), binaryHeader, binary, Buffer.alloc(bp)]);
}

export async function splitUvImportSource(bytes: Buffer): Promise<{
  bytes: Buffer;
  proof?: Record<string, unknown>;
}> {
  const surface = await readUvSurface(bytes);
  if (surface.parts.length === array(surface.json.nodes).length) return { bytes };
  const json = surface.json;
  json.nodes = surface.parts.map((part, index) => ({
    ...part.node,
    name: `uv_part_${part.nodeIndex}_${part.primitiveIndex}`,
    mesh: index,
  }));
  json.meshes = surface.parts.map((part) => ({
    ...part.mesh,
    name: `uv_part_${part.nodeIndex}_${part.primitiveIndex}`,
    primitives: [part.primitive],
  }));
  object(array(json.scenes)[0]).nodes = surface.parts.map((_, index) => index);
  const output = writeUvGlb(json, surface.binary);
  return {
    bytes: output,
    proof: {
      version: 1,
      source_sha256: uvHash(bytes),
      import_sha256: uvHash(output),
      import_bytes: output.length,
      primitives: surface.parts.length,
      binary_sha256: uvHash(surface.binary),
      method:
        'Split root mesh primitives in JSON; preserve original attributes, indices, materials and binary.',
    },
  };
}

type Correspondence = Array<{ source: number; imported: number }>;

/** 同一原mesh的所有原生部件须有完全相同的坐标基；否则不能在不改压缩字节时重组。 */
export function restoreUvPrimitiveGroups(
  source: UvSurface,
  imported: UvSurface,
  mapping: Correspondence,
  delta: mat4,
): void {
  const nodes = array(source.json.nodes).map(object),
    targetBySource = new Map(mapping.map((entry) => [entry.source, imported.parts[entry.imported]!])),
    restoredNodes: Record<string, unknown>[] = [],
    restoredMeshes: Record<string, unknown>[] = [];
  for (const [nodeIndex, node] of nodes.entries()) {
    const parts = source.parts.flatMap((part, index) =>
        part.nodeIndex === nodeIndex ? [{ source: part, target: targetBySource.get(index)! }] : [],
      ),
      base = parts[0]!.target.nodeMatrix;
    if (parts.some(({ target }) => target.nodeMatrix.some((value, index) => value !== base[index])))
      uvFail(
        'Native primitives use different coordinate bases; recombination would change compressed geometry.',
      );
    const restored: Record<string, unknown> = {
      ...node,
      matrix: Array.from(mat4.multiply(mat4.create(), delta, base)),
    };
    for (const key of ['translation', 'rotation', 'scale']) delete restored[key];
    restoredNodes.push(restored);
    restoredMeshes[Number(node.mesh)] = {
      ...parts[0]!.source.mesh,
      primitives: parts.map(({ target }) => target.primitive),
    };
  }
  imported.json.nodes = restoredNodes;
  imported.json.meshes = restoredMeshes;
  imported.json.scenes = structuredClone(source.json.scenes);
  imported.json.scene = source.json.scene ?? 0;
}
