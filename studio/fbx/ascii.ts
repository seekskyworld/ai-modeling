/** FBX ASCII 使用流式 token，不保留整份 token 列表；数组按声明长度有界分配。 */
import { FbxBudget, type FbxDocument, type FbxNode, type FbxValue } from './structure.ts';

interface Token {
  kind: 'text' | 'number' | 'word' | 'symbol' | 'line' | 'end';
  value: string;
}

/** 网页 ASCII 解析器按制表符层级识别节点；不把更宽松的 FBX 文法冒充网页可读。 */
function validateLayout(source: string): void {
  let depth = 0;
  let continuedArray = false;
  for (const match of source.matchAll(/[^\n]+/g)) {
    const line = match[0];
    if (!line.trim() || /^\s*;/.test(line)) continue;
    const tabs = line.match(/^\t*/)![0].length;
    const body = line.slice(tabs).trimEnd();
    if (continuedArray && tabs === 0 && /^[+\-\d.]/.test(body)) {
      continuedArray = body.endsWith(',');
      continue;
    }
    if (body === '}') {
      if (continuedArray || tabs !== --depth) throw new Error('FBX ASCII closing layout is not verified.');
      continue;
    }
    if (tabs !== depth || !/^\w+:/.test(body) || body.includes('}'))
      throw new Error('FBX ASCII layout requires the webpage tab-indented node format.');
    const braces = body.match(/{/g) ?? [];
    if (braces.length) {
      if (braces.length !== 1 || !body.endsWith('{'))
        throw new Error('FBX ASCII inline blocks are not verified.');
      depth++;
    }
    continuedArray = /^a:/.test(body) && body.endsWith(',');
  }
  if (depth || continuedArray) throw new Error('FBX ASCII blocks or arrays are incomplete.');
}
class AsciiFbx {
  private offset = 0;
  private pending?: Token;
  private readonly budget = new FbxBudget();
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  private token(): Token {
    while (this.offset < this.source.length) {
      const character = this.source[this.offset]!;
      if (character === ';') {
        while (this.offset < this.source.length && this.source[this.offset] !== '\n') this.offset++;
      } else if (character === '\n') {
        this.offset++;
        return { kind: 'line', value: '\n' };
      } else if (/\s/.test(character)) this.offset++;
      else break;
    }
    if (this.offset >= this.source.length) return { kind: 'end', value: '' };
    const character = this.source[this.offset++]!;
    if ('{}:,*'.includes(character)) return { kind: 'symbol', value: character };
    if (character === '"') return this.quoted();
    const start = this.offset - 1;
    while (this.offset < this.source.length && !/[\s{}:,;*]/.test(this.source[this.offset]!)) this.offset++;
    const value = this.source.slice(start, this.offset);
    return { kind: /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) ? 'number' : 'word', value };
  }

  private quoted(): Token {
    const start = this.offset;
    while (this.offset < this.source.length && this.source[this.offset] !== '"') {
      if (this.source[this.offset] === '\n') throw new Error('FBX ASCII quoted value is incomplete.');
      this.offset++;
    }
    if (this.offset === this.source.length) throw new Error('FBX ASCII quoted value is incomplete.');
    const value = this.source.slice(start, this.offset++);
    if (value.includes('\\"')) throw new Error('FBX ASCII escaped names require webpage-specific parsing.');
    return { kind: 'text', value };
  }

  private peek(): Token {
    return (this.pending ??= this.token());
  }
  private next(): Token {
    const value = this.peek();
    this.pending = undefined;
    return value;
  }
  private lines(): void {
    while (this.peek().kind === 'line') this.next();
  }
  private expect(value: string): void {
    if (this.next().value !== value) throw new Error('FBX ASCII structure is incomplete.');
  }
  private numeric(): number {
    const token = this.next(),
      value = Number(token.value);
    if (token.kind !== 'number' || !Number.isFinite(value))
      throw new Error('FBX ASCII numeric value is invalid.');
    return value;
  }

  private array(): Float64Array {
    this.expect('*');
    const length = this.numeric();
    this.budget.array(length);
    this.lines();
    this.expect('{');
    this.lines();
    this.expect('a');
    this.expect(':');
    this.lines();
    const values = new Float64Array(length);
    for (let index = 0; index < length; index++) {
      values[index] = this.numeric();
      if (index < length - 1) this.expect(',');
      this.lines();
    }
    this.expect('}');
    return values;
  }

  private node(depth: number): FbxNode {
    this.budget.node(depth);
    const token = this.next();
    if (token.kind !== 'word' || !/^\w+$/.test(token.value))
      throw new Error('FBX ASCII node name is invalid.');
    this.expect(':');
    const node: FbxNode = { name: token.value, properties: [], children: [] };
    if (this.peek().value === '*') {
      node.properties.push(this.array());
      return node;
    }
    let continued = false;
    while (true) {
      const current = this.peek();
      if (current.kind === 'line' && continued) {
        this.lines();
        continue;
      }
      if (current.value === '{') {
        if (continued) throw new Error('FBX ASCII has a trailing property separator.');
        this.next();
        node.block = true;
        node.children = this.nodes(depth + 1, true);
        return node;
      }
      if (['line', 'end'].includes(current.kind) || current.value === '}') {
        if (continued) throw new Error('FBX ASCII has a trailing property separator.');
        return node;
      }
      if (current.value === ',') {
        if (continued || !node.properties.length) throw new Error('FBX ASCII property separator is invalid.');
        this.next();
        continued = true;
        continue;
      }
      if (!['text', 'word', 'number'].includes(current.kind))
        throw new Error('FBX ASCII property is invalid.');
      if (node.properties.length && !continued) throw new Error('FBX ASCII property separator is missing.');
      this.budget.property();
      const value: FbxValue = current.kind === 'number' ? this.numeric() : this.next().value;
      node.properties.push(value);
      continued = false;
    }
  }

  private nodes(depth: number, nested: boolean): FbxNode[] {
    const result: FbxNode[] = [];
    while (true) {
      this.lines();
      if (this.peek().value === '}' && nested) {
        this.next();
        return result;
      }
      if (this.peek().kind === 'end' && !nested) return result;
      result.push(this.node(depth));
    }
  }

  parse(): FbxDocument {
    if (!/^;\s*FBX/.test(this.source) || !/FBXVersion:\s*(\d+)/.test(this.source))
      throw new Error('FBX ASCII header is missing.');
    const version = Number(this.source.match(/FBXVersion:\s*(\d+)/)![1]);
    if (version < 7000) throw new Error('FBX ASCII version is not supported by the webpage parser.');
    validateLayout(this.source);
    return { format: 'ascii', nodes: this.nodes(0, false) };
  }
}

export function readAsciiFbx(bytes: Buffer): FbxDocument {
  return new AsciiFbx(bytes.toString('utf8').replace(/\r\n/g, '\n')).parse();
}
