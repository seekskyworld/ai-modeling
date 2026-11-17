/** DCC 分块有回执不代表已导入；失败、关联错位与未知结果不得引发重复发送。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { transferDcc, type DccMessage } from '../studio/api/dcc-bridge.ts';
function peer(messages: DccMessage[]) {
  const sent: { header: unknown; bytes?: Buffer }[] = [];
  return {
    sent,
    send: (header: unknown, bytes?: Buffer) => {
      sent.push({ header, bytes });
    },
    next: async (check: (m: DccMessage) => boolean) => {
      const index = messages.findIndex(check);
      if (index < 0) throw new Error('No matching acknowledgement');
      return messages.splice(index, 1)[0]!;
    },
  };
}
const message = (type: string, payload: Record<string, unknown>) => ({ type, payload });
test('DCC waits for the matching import terminal receipt after all binary chunks', async () => {
  const file = { bytes: Buffer.alloc(5 * 1024 * 1024 + 13, 42), id: 'asset', name: 'model', type: 'glb' };
  const remote = peer([
    message('file_loaded', { fileId: 'other', success: true }),
    message('file_loaded', { fileId: 'asset', success: true }),
    ...[0, 1].map((fileIndex) => message('file_transfer_ack', { fileId: 'asset', fileIndex, success: true })),
  ]);
  const result = await transferDcc(remote, file, 1000, true);
  assert.equal(result.imported, true);
  assert.equal(remote.sent.length, 2);
  assert.deepEqual(Buffer.concat(remote.sent.map((x) => x.bytes!)), file.bytes);
  const final = remote.sent[1]!.header as { payload: Record<string, unknown> };
  assert.equal(final.payload.chunkSize, 13);
  assert.equal(final.payload.chunkTotal, 2);
});
test('DCC preserves import failure and does not retry a rejected transfer', async () => {
  const file = { bytes: Buffer.from('data'), id: 'asset', name: 'model', type: 'glb' };
  const failed = peer([
    message('file_transfer_ack', { fileId: 'asset', fileIndex: 0, success: true }),
    message('import_complete', { fileId: 'asset', success: false, message: 'invalid model' }),
  ]);
  await assert.rejects(transferDcc(failed, file, 1000, true), { code: 'DCC_IMPORT', certainty: 'unknown' });
  assert.equal(failed.sent.length, 1);
  const rejected = peer([message('file_transfer_ack', { fileId: 'asset', fileIndex: 0, success: false })]);
  await assert.rejects(transferDcc(rejected, file, 1000, true), { code: 'DCC_TRANSFER' });
  assert.equal(rejected.sent.length, 1);
  const transferOnly = peer([message('file_transfer_ack', { fileId: 'asset', fileIndex: 0, success: true })]);
  assert.equal((await transferDcc(transferOnly, file, 1000, false)).imported, null);
});
