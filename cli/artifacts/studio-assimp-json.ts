/** glTF writer会省略接近默认的TRS；按源JSON恢复字段，避免把微小但有效的变换当作零。 */
import { array, object, TripoError } from '../../studio/contracts/errors.ts';
import { validateGlb } from '../../studio/files.ts';

/** 网页原文件的来源标识不是几何扩展；仅接受已见完整字段，并保留原字符串而不重写JSON。 */
export function studioAigcExtras(value: unknown): boolean {
  const extras = object(value),
    raw = extras.AIGC;
  if (Object.keys(extras).length !== 1 || typeof raw !== 'string' || raw.length > 16384) return false;
  try {
    const data = object(JSON.parse(raw)),
      keys = [
        'Label',
        'ContentProducer',
        'ProduceID',
        'ReservedCode1',
        'ContentPropagator',
        'PropagateID',
        'ReservedCode2',
      ];
    return (
      Object.keys(data).length === keys.length &&
      data.Label === '1' &&
      keys.every((key) => typeof data[key] === 'string' && String(data[key]).length <= 2048)
    );
  } catch {
    return false;
  }
}
export function frontendAssetAigc(bytes: Buffer): string | undefined {
  const json = validateGlb(bytes),
    extras = object(json.asset).extras;
  if (extras === undefined || JSON.stringify(extras) === '{}') return;
  if (!studioAigcExtras(extras))
    throw new TripoError('FRONTEND_EXPORT_UNVERIFIED', 'Unverified source asset metadata.', 'not_submitted');
  return String(object(extras).AIGC);
}
export function preserveFrontendAssetAigc(source: Buffer, target: Buffer): Buffer {
  const original = frontendAssetAigc(source),
    current = frontendAssetAigc(target);
  if (original === current) return target;
  if (current !== undefined || original === undefined)
    throw new TripoError(
      'FRONTEND_EXPORT_UNVERIFIED',
      'The engine changed the AIGC source attribution.',
      'not_submitted',
    );
  const output = validateGlb(target);
  object(output.asset).extras = { AIGC: original };
  return writeJson(target, output);
}
function writeJson(target: Buffer, output: Record<string, unknown>): Buffer {
  const json = Buffer.from(JSON.stringify(output)),
    padding = (4 - (json.length % 4)) % 4,
    binary = target.subarray(20 + target.readUInt32LE(12)),
    header = Buffer.from(target.subarray(0, 20));
  header.writeUInt32LE(20 + json.length + padding + binary.length, 8);
  header.writeUInt32LE(json.length + padding, 12);
  return Buffer.concat([header, json, Buffer.alloc(padding, 0x20), binary]);
}

export function preserveSourceNodeTrs(source: Buffer, target: Buffer): Buffer {
  const original = validateGlb(source),
    output = validateGlb(target),
    named = new Map<string, Record<string, unknown>>();
  for (const raw of array(original.nodes)) {
    const node = object(raw);
    if (typeof node.name !== 'string' || !node.name || named.has(node.name))
      throw new TripoError(
        'FRONTEND_EXPORT_UNVERIFIED',
        'Source node names must be unique.',
        'not_submitted',
      );
    named.set(node.name, node);
  }
  for (const raw of array(output.nodes)) {
    const node = object(raw),
      from = named.get(String(node.name));
    if (!from) continue;
    for (const key of ['translation', 'rotation', 'scale', 'matrix']) {
      if (from[key] === undefined) delete node[key];
      else node[key] = from[key];
    }
  }
  return writeJson(target, output);
}
