/** 合成目录替换验证价格文件的输入根与FD身份；不访问凭据、网络或真实定价。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { type FileHandle } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readPriceFile } from '../studio/api/pricing-maintenance.ts';

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'ai-modeling-pricing-file-'));
  const allowed = path.join(root, 'allowed'),
    parent = path.join(allowed, 'input'),
    outside = path.join(root, 'outside');
  await fs.mkdir(parent, { recursive: true });
  await fs.mkdir(outside);
  const file = path.join(parent, 'synthetic.json');
  await fs.writeFile(file, 'SYNTHETIC_ALLOWED_BYTES');
  await fs.writeFile(path.join(outside, 'synthetic.json'), 'SYNTHETIC_OUTSIDE_BYTES');
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  });
  let swapped = false;
  const swap = async () => {
    if (swapped) return;
    swapped = true;
    await fs.rename(parent, parent + '-original');
    await fs.symlink(outside, parent);
  };
  return { root, allowed, parent, outside, file, swap };
}

test('pricing file accepts stable parent aliases inside allowed roots and a filesystem-root allowance', async (t) => {
  const f = await fixture(t);
  const alias = path.join(f.allowed, 'alias');
  await fs.symlink(f.parent, alias);
  assert.equal(
    (await readPriceFile(path.join(alias, 'synthetic.json'), [f.allowed])).toString(),
    'SYNTHETIC_ALLOWED_BYTES',
  );
  assert.equal(
    (await readPriceFile(f.file, [path.parse(f.file).root])).toString(),
    'SYNTHETIC_ALLOWED_BYTES',
  );
  await assert.rejects(readPriceFile(path.join(f.outside, 'synthetic.json'), [f.allowed]), {
    code: 'INPUT_NOT_ALLOWED',
  });
  await assert.rejects(readPriceFile(f.file + '-missing', [f.allowed]), { code: 'ENOENT' });
});

for (const phase of ['file-resolution', 'root-resolution'] as const) {
  test(`pricing input root survives a parent swap after ${phase}`, async (t) => {
    const f = await fixture(t),
      original = fs.realpath;
    let swaps = 0;
    t.mock.method(fs, 'realpath', async (...args: Parameters<typeof fs.realpath>) => {
      const resolved = await Reflect.apply(original, fs, args);
      if (!swaps && String(args[0]) === (phase === 'file-resolution' ? f.file : f.allowed)) {
        swaps++;
        await f.swap();
      }
      return resolved;
    });
    syncBuiltinESMExports();
    await assert.rejects(readPriceFile(f.file, [f.allowed]), { code: 'INVALID_PRICING' });
    assert.equal(swaps, 1);
    assert.equal(
      await fs.readFile(path.join(f.outside, 'synthetic.json'), 'utf8'),
      'SYNTHETIC_OUTSIDE_BYTES',
    );
  });
}

for (const phase of ['after-open', 'after-read'] as const) {
  test(`pricing file rechecks its parent ${phase} before returning any content`, async (t) => {
    const f = await fixture(t),
      handle = await fs.open(f.file, 'r');
    const prototype = Object.getPrototypeOf(handle),
      originalStat = handle.stat,
      originalRead = handle.read;
    await handle.close();
    let swaps = 0,
      reads = 0;
    t.mock.method(prototype, 'stat', async function (this: FileHandle, ...args: unknown[]) {
      const info = await Reflect.apply(originalStat, this, args);
      if (!swaps && phase === 'after-open') {
        swaps++;
        await f.swap();
      }
      return info;
    });
    t.mock.method(prototype, 'read', async function (this: FileHandle, ...args: unknown[]) {
      reads++;
      const result = await Reflect.apply(originalRead, this, args);
      if (!swaps && phase === 'after-read') {
        swaps++;
        await f.swap();
      }
      return result;
    });
    await assert.rejects(readPriceFile(f.file, [f.allowed]), { code: 'INVALID_PRICING' });
    assert.equal(swaps, 1);
    if (phase === 'after-open') assert.equal(reads, 0);
    assert.equal(
      await fs.readFile(path.join(f.outside, 'synthetic.json'), 'utf8'),
      'SYNTHETIC_OUTSIDE_BYTES',
    );
  });
}

test('pricing file rejects same-path replacement with a different inode before using its descriptor', async (t) => {
  const f = await fixture(t),
    original = fs.open;
  let swapped = false;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    if (!swapped && path.basename(String(args[0])) === 'synthetic.json') {
      swapped = true;
      await fs.rename(f.file, f.file + '-original');
      await fs.writeFile(f.file, 'SYNTHETIC_REPLACED_DATA');
    }
    return await Reflect.apply(original, fs, args);
  });
  syncBuiltinESMExports();
  await assert.rejects(readPriceFile(f.file, [f.allowed]), { code: 'INVALID_PRICING' });
  assert.equal(swapped, true);
});
