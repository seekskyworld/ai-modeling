/** 上传超时随请求体放宽：小文件仍是 60 秒，10 MiB 分片按最低 32 KiB/s 计，整体不超过 10 分钟。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uploadTimeoutMs } from '../studio/api/upload.ts';

test('upload timeout scales with the request body and stays bounded', () => {
  assert.equal(uploadTimeoutMs(0), 60_000);
  assert.equal(uploadTimeoutMs(32 * 1024), 61_000);
  assert.equal(uploadTimeoutMs(10 * 1024 * 1024), 60_000 + 320_000);
  assert.equal(uploadTimeoutMs(1024 * 1024 * 1024), 600_000);
});
