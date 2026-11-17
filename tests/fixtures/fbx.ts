/** 可控 FBX 格式夹具；结构中一三角、一四边形、一五边形，网页原始面数为 3。 */
import { deflateSync } from 'node:zlib';

export type FixtureValue = string | number | Float64Array | Int32Array | Buffer;
export interface FbxFixtureNode {
  name: string;
  properties?: FixtureValue[];
  children?: FbxFixtureNode[];
}

export function staticFbxNodes(names = ['mesh']): FbxFixtureNode[] {
  return [
    { name: 'FBXHeaderExtension', children: [{ name: 'FBXVersion', properties: [7400] }] },
    {
      name: 'Objects',
      children: [
        {
          name: 'Geometry',
          properties: [100, 'geometry', 'Mesh'],
          children: [
            {
              name: 'Vertices',
              properties: [new Float64Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, -1, 0.5, 0])],
            },
            {
              name: 'PolygonVertexIndex',
              properties: [new Int32Array([0, 1, -3, 0, 1, 2, -4, 0, 1, 2, 3, -5])],
            },
          ],
        },
        ...names.map((name, index) => ({
          name: 'Model',
          properties: [200 + index, name, 'Mesh'],
          children: [],
        })),
      ],
    },
    {
      name: 'Connections',
      children: names.flatMap((_, index) => [
        { name: 'C', properties: ['OO', 100, 200 + index] },
        { name: 'C', properties: ['OO', 200 + index, 0] },
      ]),
    },
    { name: 'GlobalSettings', children: [] },
  ];
}

function property(value: FixtureValue, compressed: boolean): Buffer {
  if (Buffer.isBuffer(value)) {
    const header = Buffer.alloc(5);
    header.write('R');
    header.writeUInt32LE(value.length, 1);
    return Buffer.concat([header, value]);
  }
  if (typeof value === 'string') {
    const text = Buffer.from(value),
      header = Buffer.alloc(5);
    header.write('S');
    header.writeUInt32LE(text.length, 1);
    return Buffer.concat([header, text]);
  }
  if (typeof value === 'number') {
    const bytes = Buffer.alloc(9);
    if (Number.isSafeInteger(value)) {
      bytes.write('L');
      bytes.writeBigInt64LE(BigInt(value), 1);
    } else {
      bytes.write('D');
      bytes.writeDoubleLE(value, 1);
    }
    return bytes;
  }
  const raw = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const payload = compressed ? deflateSync(raw) : raw;
  const header = Buffer.alloc(13);
  header.write(value instanceof Int32Array ? 'i' : 'd');
  header.writeUInt32LE(value.length, 1);
  header.writeUInt32LE(compressed ? 1 : 0, 5);
  header.writeUInt32LE(payload.length, 9);
  return Buffer.concat([header, payload]);
}

export function binaryFbx(nodes: FbxFixtureNode[], version = 7400, compressed = false): Buffer {
  const wide = version >= 7500,
    size = wide ? 25 : 13;
  function node(value: FbxFixtureNode, offset: number): Buffer {
    const name = Buffer.from(value.name);
    const properties = Buffer.concat((value.properties ?? []).map((item) => property(item, compressed)));
    const parts: Buffer[] = [Buffer.alloc(size), name, properties];
    let cursor = offset + size + name.length + properties.length;
    for (const child of value.children ?? []) {
      const bytes = node(child, cursor);
      parts.push(bytes);
      cursor += bytes.length;
    }
    if (value.children?.length) {
      parts.push(Buffer.alloc(size));
      cursor += size;
    }
    if (wide) {
      parts[0]!.writeBigUInt64LE(BigInt(cursor), 0);
      parts[0]!.writeBigUInt64LE(BigInt(value.properties?.length ?? 0), 8);
      parts[0]!.writeBigUInt64LE(BigInt(properties.length), 16);
    } else {
      parts[0]!.writeUInt32LE(cursor, 0);
      parts[0]!.writeUInt32LE(value.properties?.length ?? 0, 4);
      parts[0]!.writeUInt32LE(properties.length, 8);
    }
    parts[0]![size - 1] = name.length;
    return Buffer.concat(parts);
  }
  const header = Buffer.alloc(27);
  header.write('Kaydara FBX Binary  \0\x1a\0', 'binary');
  header.writeUInt32LE(version, 23);
  const parts: Buffer[] = [header];
  let offset = header.length;
  for (const value of nodes) {
    const bytes = node(value, offset);
    parts.push(bytes);
    offset += bytes.length;
  }
  return Buffer.concat([...parts, Buffer.alloc(size), Buffer.alloc(176)]);
}

export function asciiFbx(nodes: FbxFixtureNode[]): Buffer {
  function node(value: FbxFixtureNode, depth: number): string {
    const indent = '\t'.repeat(depth),
      values = value.properties ?? [];
    const array = values[0];
    if (array instanceof Float64Array || array instanceof Int32Array)
      return `${indent}${value.name}: *${array.length} {\n${indent}\ta: ${[...array].join(',')}\n${indent}}\n`;
    const properties = values
      .map((item) => (typeof item === 'string' ? JSON.stringify(item) : String(item)))
      .join(', ');
    return `${indent}${value.name}: ${properties}${value.children ? '{\n' + value.children.map((child) => node(child, depth + 1)).join('') + indent + '}' : ''}\n`;
  }
  return Buffer.from('; FBX 7.4.0 project file\n' + nodes.map((value) => node(value, 0)).join(''));
}
