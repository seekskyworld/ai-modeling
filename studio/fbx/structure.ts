/** FBX 面数只读取内嵌结构；共用限额约束深度、节点及累计解码内存。 */
export type FbxValue = string | number | boolean | Float64Array | null;
export interface FbxNode {
  name: string;
  properties: FbxValue[];
  /** 仅显式请求时保留原 R 属性切片；普通面数解析不持有图片数据。 */
  rawProperties?: Record<number, Uint8Array>;
  children: FbxNode[];
  block?: boolean;
}
export interface FbxDocument {
  format: 'binary' | 'ascii';
  nodes: FbxNode[];
}

export class FbxBudget {
  private nodes = 0;
  private properties = 0;
  private decoded = 0;

  node(depth: number): void {
    if (depth > 64 || ++this.nodes > 100_000) throw new Error('FBX structure exceeds the bounded parser.');
  }

  property(count = 1): void {
    this.properties += count;
    if (this.properties > 1_000_000) throw new Error('FBX has too many properties to verify offline.');
  }

  array(count: number, stride = 8): number {
    if (!Number.isSafeInteger(count) || count < 0)
      throw new Error('FBX array length is not a nonnegative safe integer.');
    const bytes = count * stride;
    this.decoded += count * Math.max(8, stride);
    if (!Number.isSafeInteger(bytes) || this.decoded > 256 * 1024 * 1024)
      throw new Error('FBX cumulative decoded arrays exceed the offline inspection limit.');
    return bytes;
  }
}

export function singleNode(nodes: FbxNode[], name: string): FbxNode | undefined {
  const matching = nodes.filter((node) => node.name === name);
  if (matching.length > 1) throw new Error('FBX contains duplicate structural nodes.');
  return matching[0];
}
