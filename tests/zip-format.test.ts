/** 容器格式回归：USDZ/3MF 与普通 ZIP 保持不同后缀，损坏目录不能变成有效模型。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFormat } from '../studio/files.ts';

function archive(names: string[]): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50);
  const records = names.map((name) => {
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(Buffer.byteLength(name), 28);
    return Buffer.concat([record, Buffer.from(name)]);
  });
  const directory = Buffer.concat(records);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(header.length, 16);
  return Buffer.concat([header, directory, end]);
}

test('ZIP model packages keep their model format and reject a truncated central directory', () => {
  assert.equal(detectFormat(archive(['scene.usdc', 'textures/color.png'])), 'usdz');
  assert.equal(detectFormat(archive(['3D/3dmodel.model', '[Content_Types].xml', '_rels/.rels'])), '3mf');
  assert.equal(detectFormat(archive(['model.obj', 'model.mtl'])), 'zip');
  const broken = archive(['scene.usdc']);
  broken.writeUInt16LE(65000, 30 + 28);
  assert.throws(() => detectFormat(broken), { code: 'INVALID_ARTIFACT' });
});

test('small 3MF files using ZIP64 retain their extension', () => {
  const original = archive(['3D/3dmodel.model', '[Content_Types].xml']);
  const position = original.length - 22;
  const record = Buffer.alloc(56);
  record.writeUInt32LE(0x06064b50);
  record.writeBigUInt64LE(2n, 32);
  record.writeBigUInt64LE(30n, 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50);
  locator.writeBigUInt64LE(BigInt(position), 8);
  const end = Buffer.from(original.subarray(-22));
  end.writeUInt32LE(0xffffffff, 16);
  assert.equal(detectFormat(Buffer.concat([original.subarray(0, position), record, locator, end])), '3mf');
});
