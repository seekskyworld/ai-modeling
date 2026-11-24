import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  installPricingSnapshot,
  pricingSnapshotStatus,
  pricingStatus,
  readPriceFile,
  updatePricingSnapshot,
  verifyPricingBytes,
} from '../studio/api/pricing-maintenance.ts';
import { PricingService } from '../studio/api/pricing.ts';
import type { PriceSnapshot } from '../studio/api/pricing.ts';

const now = Date.parse('2035-01-10T12:00:00Z');
const source = Buffer.from('export const publicPrice = 10;');
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const evidenceUrl = 'https://tripo-webapp-assets.tripo3d.ai/studio-prod/_nuxt/reviewed.js';
function snapshot(clock = now): PriceSnapshot {
  return {
    reviewed_at: new Date(clock - 86400000).toISOString(),
    expires_at: new Date(clock + 7 * 86400000).toISOString(),
    source: 'Synthetic reviewed pricing fixture',
    credits: { GenerateBase: 10 },
    evidence: [{ url: evidenceUrl, sha256: digest(source) }],
  };
}
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
async function temporary(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-modeling-pricing-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('price status distinguishes current, expiring, expired and invalid reviews', () => {
  const current = snapshot();
  assert.equal(pricingSnapshotStatus(current, now).state, 'current');
  assert.equal(
    pricingSnapshotStatus({ ...current, expires_at: new Date(now + 3600000).toISOString() }, now).state,
    'expiring',
  );
  assert.equal(pricingSnapshotStatus(current, now + 8 * 86400000).state, 'expired');
  assert.equal(pricingSnapshotStatus(current, now - 2 * 86400000).state, 'invalid');
  assert.equal(pricingSnapshotStatus({ ...current, evidence: [] }, now).usable, false);
});

test('price status has no filesystem side effect and a broken local review is not silently replaced', async (t) => {
  const root = await temporary(t),
    absent = path.join(root, 'absent');
  const result = await pricingStatus(absent, now);
  assert.equal(result.origin, 'bundled');
  assert.equal(result.network_used, false);
  await assert.rejects(stat(absent), { code: 'ENOENT' });
  await writeFile(path.join(root, 'pricing.json'), '{broken');
  assert.equal((await pricingStatus(root, now)).state, 'invalid');
});

test('price verification binds file and official evidence digests without executing source', async () => {
  const bytes = encode(snapshot());
  const calls: string[] = [];
  const verified = await verifyPricingBytes(bytes, {
    sha256: digest(bytes),
    network: true,
    nowMs: now,
    fetcher: async (url, init) => {
      calls.push(String(url));
      assert.equal(init?.redirect, 'error');
      return new Response(source);
    },
  });
  assert.deepEqual(calls, [evidenceUrl]);
  assert.equal(verified.result.evidence_verified_online, true);
  await assert.rejects(verifyPricingBytes(bytes, { sha256: '0'.repeat(64), nowMs: now }), {
    code: 'PRICING_INTEGRITY',
  });
  await assert.rejects(
    verifyPricingBytes(bytes, { network: true, nowMs: now, fetcher: async () => new Response('changed') }),
    { code: 'PRICING_EVIDENCE_CHANGED' },
  );
});

test('untrusted evidence URLs and oversized snapshots are rejected before network access', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return new Response(source);
  };
  for (const url of [
    'https://example.com/price.js',
    evidenceUrl + '?token=secret',
    'http://tripo-webapp-assets.tripo3d.ai/studio-prod/_nuxt/x.js',
  ]) {
    await assert.rejects(
      verifyPricingBytes(encode({ ...snapshot(), evidence: [{ url, sha256: digest(source) }] }), {
        nowMs: now,
        network: true,
        fetcher,
      }),
    );
  }
  await assert.rejects(
    verifyPricingBytes(Buffer.alloc(1024 * 1024 + 1), { nowMs: now, network: true, fetcher }),
    { code: 'INVALID_PRICING' },
  );
  assert.equal(calls, 0);
});

test('failed evidence verification cannot create or replace local pricing', async (t) => {
  const root = await temporary(t),
    absent = path.join(root, 'absent');
  const options = { nowMs: now, network: true, fetcher: async () => new Response('wrong evidence') };
  await assert.rejects(installPricingSnapshot(absent, encode(snapshot()), options), {
    code: 'PRICING_EVIDENCE_CHANGED',
  });
  await assert.rejects(stat(absent), { code: 'ENOENT' });
  await writeFile(path.join(root, 'pricing.json'), 'previous bytes');
  await assert.rejects(installPricingSnapshot(root, encode(snapshot()), options));
  assert.equal(await readFile(path.join(root, 'pricing.json'), 'utf8'), 'previous bytes');
});

test('validated price import installs atomically, rejects rollback and leaves no lock or temporary file', async (t) => {
  const root = await temporary(t);
  const bytes = Buffer.from(JSON.stringify(snapshot(), null, 4) + '\n');
  const imported = await installPricingSnapshot(root, bytes, { nowMs: now });
  const installed = await readFile(path.join(root, 'pricing.json'));
  assert.deepEqual(JSON.parse(installed.toString()), snapshot());
  assert.equal(imported.sha256, digest(installed));
  const status = await pricingStatus(root, now);
  assert.equal(status.sha256, digest(installed));
  await verifyPricingBytes(installed, { sha256: status.sha256, nowMs: now });
  assert.notEqual(status.canonical_sha256, status.sha256);
  const older = { ...snapshot(), reviewed_at: new Date(now - 2 * 86400000).toISOString() };
  await assert.rejects(installPricingSnapshot(root, encode(older), { nowMs: now }), {
    code: 'PRICING_ROLLBACK',
  });
  assert.deepEqual(await readFile(path.join(root, 'pricing.json')), installed);
  assert.deepEqual(await readdir(root), ['pricing.json']);
  if (process.platform !== 'win32')
    assert.equal((await stat(path.join(root, 'pricing.json'))).mode & 0o777, 0o600);
});

test('price file import enforces input roots and rejects symbolic links and large files', async (t) => {
  const root = await temporary(t),
    file = path.join(root, 'price.json');
  await writeFile(file, encode(snapshot()));
  assert.deepEqual(await readPriceFile(file, [root]), encode(snapshot()));
  await assert.rejects(readPriceFile(file, [path.join(root, '..', 'unavailable-root')]));
  await symlink(file, path.join(root, 'link.json'));
  await assert.rejects(readPriceFile(path.join(root, 'link.json')), { code: 'INVALID_PRICING' });
  await writeFile(file, Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(readPriceFile(file), { code: 'INVALID_PRICING' });
});

test('remote price update requires an independent digest and verifies evidence before installing', async (t) => {
  const root = await temporary(t),
    now = Date.now(),
    bytes = encode({ ...snapshot(now), reviewed_at: new Date(now).toISOString() });
  let calls = 0;
  const fetcher = async (url: string, init: RequestInit) => {
    calls++;
    const headers = new Headers(init.headers);
    assert.equal(headers.has('authorization'), false);
    assert.equal(headers.has('cookie'), false);
    if (url === evidenceUrl) {
      assert.equal(headers.get('origin'), 'https://studio.tripo3d.ai');
      assert.equal(headers.get('referer'), 'https://studio.tripo3d.ai/');
      assert.match(headers.get('user-agent') ?? '', /ai-modeling/);
    } else {
      assert.equal(headers.has('origin'), false);
      assert.equal(headers.has('referer'), false);
    }
    return new Response(url === evidenceUrl ? source : bytes);
  };
  await assert.rejects(updatePricingSnapshot(root, 'https://example.com/prices.json', '', fetcher), {
    code: 'INVALID_INPUT',
  });
  assert.equal(calls, 0);
  const result = await updatePricingSnapshot(root, 'https://example.com/prices.json', digest(bytes), fetcher);
  assert.equal(result.pricing_imported, true);
  assert.equal(calls, 2);
  assert.equal((await pricingStatus(root)).origin, 'local');
});

test('expired reviews still cannot authorize a model quote', async (t) => {
  const root = await temporary(t),
    file = path.join(root, 'pricing.json');
  await writeFile(file, encode(snapshot(Date.now() - 10 * 86400000)));
  const quote = await new PricingService(file).quote('model', { texture: false });
  assert.equal(quote.known, false);
  assert.equal(quote.credits, undefined);
  // 报错要说清何时过期、怎么恢复，而不是只说“过期或未来日期”。
  assert.match(quote.explanation, /^Pricing review expired at \d{4}-\d{2}-\d{2}T/);
  assert.match(quote.explanation, /ai-modeling pricing update/);
});
