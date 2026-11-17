/** 复现网页 FBX 二进制头及数组结构；不导入渲染器，不读取任何外部文件。 */
import { inflateSync } from 'node:zlib';
import { FbxBudget, type FbxDocument, type FbxNode, type FbxValue } from './structure.ts';

class BinaryFbx {
  private offset = 27;
  private readonly budget = new FbxBudget();
  private readonly wide: boolean;
  private readonly nullSize: number;
  private readonly data: Buffer;
  private readonly retainRawProperties: boolean;

  constructor(data: Buffer, retainRawProperties = false) {
    this.data = data;
    this.retainRawProperties = retainRawProperties;
    if (data.length < 27 || data.subarray(0, 23).toString('binary') !== 'Kaydara FBX Binary  \0\x1a\0')
      throw new Error('FBX binary header is incomplete.');
    const version = data.readUInt32LE(23);
    if (version < 6400) throw new Error('FBX binary version is not supported by the webpage parser.');
    this.wide = version >= 7500;
    this.nullSize = this.wide ? 25 : 13;
  }

  private take(length: number, end: number): Buffer {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > end)
      throw new Error('FBX property or node is truncated.');
    const value = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  private integer(end: number): number {
    const value = this.wide ? Number(this.take(8, end).readBigUInt64LE()) : this.take(4, end).readUInt32LE();
    if (!Number.isSafeInteger(value)) throw new Error('FBX offset exceeds safe integer precision.');
    return value;
  }

  private text(length: number, end: number): string {
    const value = this.take(length, end);
    const nul = value.indexOf(0);
    return value.subarray(0, nul < 0 ? value.length : nul).toString('utf8');
  }

  private numericArray(type: string, end: number): Float64Array {
    const length = this.take(4, end).readUInt32LE();
    const encoding = this.take(4, end).readUInt32LE();
    const encodedLength = this.take(4, end).readUInt32LE();
    const stride = { b: 1, c: 1, d: 8, f: 4, i: 4, l: 8 }[type];
    if (!stride || ![0, 1].includes(encoding)) throw new Error('FBX array encoding is not verified.');
    const expected = this.budget.array(length, stride);
    if (encoding === 0 && encodedLength !== expected)
      throw new Error('FBX uncompressed array length does not match its declaration.');
    const encoded = this.take(encodedLength, end);
    const bytes = encoding === 0 ? encoded : inflateSync(encoded, { maxOutputLength: Math.max(1, expected) });
    if (bytes.length !== expected)
      throw new Error('FBX decoded array length does not match its declaration.');
    const values = new Float64Array(length);
    for (let index = 0; index < length; index++) {
      const value = this.arrayValue(bytes, type, index * stride);
      if (!Number.isFinite(value) || (type === 'l' && !Number.isSafeInteger(value)))
        throw new Error('FBX numeric array contains an unverifiable value.');
      values[index] = value;
    }
    return values;
  }

  private arrayValue(bytes: Buffer, type: string, offset: number): number {
    switch (type) {
      case 'd':
        return bytes.readDoubleLE(offset);
      case 'f':
        return bytes.readFloatLE(offset);
      case 'i':
        return bytes.readInt32LE(offset);
      case 'l':
        return Number(bytes.readBigInt64LE(offset));
      default:
        return bytes[offset]! & 1;
    }
  }

  private property(end: number, raw?: Record<number, Uint8Array>, index = 0): FbxValue {
    const type = this.take(1, end).toString('ascii');
    switch (type) {
      case 'C':
        return Boolean(this.take(1, end)[0]! & 1);
      case 'D':
        return this.take(8, end).readDoubleLE();
      case 'F':
        return this.take(4, end).readFloatLE();
      case 'I':
        return this.take(4, end).readInt32LE();
      case 'L': {
        const value = Number(this.take(8, end).readBigInt64LE());
        if (!Number.isSafeInteger(value)) throw new Error('FBX object identifier exceeds safe precision.');
        return value;
      }
      case 'Y':
        return this.take(2, end).readInt16LE();
      case 'S':
        return this.text(this.take(4, end).readUInt32LE(), end);
      case 'R': {
        const bytes = this.take(this.take(4, end).readUInt32LE(), end);
        if (raw) raw[index] = bytes;
        return null;
      }
      case 'b':
      case 'c':
      case 'd':
      case 'f':
      case 'i':
      case 'l':
        return this.numericArray(type, end);
      default:
        throw new Error('FBX property type is not verified.');
    }
  }

  private node(parentEnd: number, depth: number): FbxNode | null {
    this.budget.node(depth);
    const end = this.integer(parentEnd);
    const count = this.integer(parentEnd);
    const propertyLength = this.integer(parentEnd);
    const nameLength = this.take(1, parentEnd)[0]!;
    if (end === 0) {
      if (count || propertyLength || nameLength) throw new Error('FBX null record is malformed.');
      return null;
    }
    if (end > parentEnd || end <= this.offset) throw new Error('FBX node offset is outside its parent.');
    const name = this.text(nameLength, end);
    const propertyEnd = this.offset + propertyLength;
    if (propertyEnd > end || count > propertyLength) throw new Error('FBX property extent is invalid.');
    this.budget.property(count);
    const rawProperties: Record<number, Uint8Array> = {},
      properties = Array.from({ length: count }, (_, index) =>
        this.property(propertyEnd, this.retainRawProperties ? rawProperties : undefined, index),
      );
    if (this.offset !== propertyEnd)
      throw new Error('FBX property byte count does not match its declaration.');
    const children: FbxNode[] = [];
    while (this.offset < end) {
      const child = this.node(end, depth + 1);
      if (child) children.push(child);
      else if (this.offset !== end) throw new Error('FBX node has data after its terminator.');
    }
    return {
      name,
      properties,
      ...(Object.keys(rawProperties).length ? { rawProperties } : {}),
      children,
    };
  }

  parse(): FbxDocument {
    const nodes: FbxNode[] = [];
    while (this.offset + this.nullSize <= this.data.length) {
      const node = this.node(this.data.length, 0);
      if (!node) return { format: 'binary', nodes };
      nodes.push(node);
    }
    throw new Error('FBX binary root terminator is missing.');
  }
}

export function readBinaryFbx(bytes: Buffer, options: { retainRawProperties?: boolean } = {}): FbxDocument {
  return new BinaryFbx(bytes, options.retainRawProperties).parse();
}
