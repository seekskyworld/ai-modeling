/** Explicit, digest-checked price updates. Evidence is read as data and never executed. */
import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, rename, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { priceSchema, type PriceSnapshot } from './pricing.ts';
import { reviewedPrices } from './reviewed-prices.ts';
import { networkFetch, type Fetcher } from './client.ts';
import { TripoError } from '../contracts/errors.ts';
import type { UnquotedOperation } from '../contracts/unquoted-pricing.ts';

const snapshotLimit = 1024 * 1024;
const evidenceLimit = 6 * 1024 * 1024;
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export interface PricingSnapshotStatus {
  state: 'current' | 'expiring' | 'expired' | 'invalid';
  usable: boolean;
  reviewed_at?: string;
  expires_at?: string;
  expires_in_seconds?: number;
  source?: string;
  evidence_count: number;
  refresh_required: boolean;
  canonical_sha256?: string;
  price_key_count?: number;
  unquoted_operations?: UnquotedOperation[];
}

export function pricingSnapshotStatus(snapshot: unknown, nowMs = Date.now()): PricingSnapshotStatus {
  const parsed = priceSchema.safeParse(snapshot);
  if (!parsed.success || !Number.isFinite(nowMs))
    return { state: 'invalid', usable: false, evidence_count: 0, refresh_required: true };
  const data = parsed.data;
  const reviewed = Date.parse(data.reviewed_at),
    expires = Date.parse(data.expires_at);
  const invalid = reviewed > nowMs || expires <= reviewed || data.evidence.length === 0;
  const usable = !invalid && expires > nowMs;
  const expiring = expires - nowMs < 72 * 3600 * 1000;
  return {
    state: invalid ? 'invalid' : !usable ? 'expired' : expiring ? 'expiring' : 'current',
    usable,
    reviewed_at: data.reviewed_at,
    expires_at: data.expires_at,
    expires_in_seconds: Math.max(0, Math.floor((expires - nowMs) / 1000)),
    source: data.source,
    evidence_count: data.evidence.length,
    refresh_required: !usable || expiring,
    canonical_sha256: digest(Buffer.from(JSON.stringify(data))),
    price_key_count: Object.keys(data.credits).length,
    unquoted_operations: data.unquoted_operations ?? [],
  };
}

export async function pricingStatus(dataDir: string, nowMs = Date.now()) {
  let selected: unknown = reviewedPrices;
  let origin: 'bundled' | 'local' = 'bundled';
  let fileDigest: string | undefined;
  try {
    const bytes = await readPriceFile(path.join(dataDir, 'pricing.json'));
    origin = 'local';
    fileDigest = digest(bytes);
    selected = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      origin = 'local';
      selected = null;
    }
  }
  return {
    ...pricingSnapshotStatus(selected, nowMs),
    ...(fileDigest ? { sha256: fileDigest } : {}),
    origin,
    evidence_verified_online: false,
    network_used: false,
    next: 'Use pricing verify FILE --network, then pricing import FILE --sha256 SHA256. Obtain the reviewed snapshot and digest from a trusted maintainer.',
  };
}

interface PriceDirectory {
  requested: string;
  actual: string;
  info: BigIntStats;
}

function changedPriceFile(): never {
  throw new TripoError('INVALID_PRICING', 'Pricing file or its directory changed while being read.');
}

function regularPriceFile(info: BigIntStats): void {
  if (!info.isFile() || info.size > BigInt(snapshotLimit))
    throw new TripoError('INVALID_PRICING', 'Use a regular pricing JSON file no larger than 1 MiB.');
}

function samePriceFile(expected: BigIntStats, actual: BigIntStats): void {
  regularPriceFile(actual);
  if (
    expected.dev !== actual.dev ||
    expected.ino !== actual.ino ||
    expected.size !== actual.size ||
    expected.mtimeNs !== actual.mtimeNs ||
    expected.ctimeNs !== actual.ctimeNs
  )
    changedPriceFile();
}

async function priceDirectory(directory: string): Promise<PriceDirectory> {
  const requested = path.resolve(directory),
    actual = await realpath(requested);
  const info = await lstat(actual, { bigint: true });
  if (!info.isDirectory()) changedPriceFile();
  return { requested, actual, info };
}

async function checkPriceDirectory(directory: PriceDirectory): Promise<void> {
  const info = await lstat(directory.actual, { bigint: true });
  if (
    !info.isDirectory() ||
    info.dev !== directory.info.dev ||
    info.ino !== directory.info.ino ||
    (await realpath(directory.requested)) !== directory.actual
  )
    changedPriceFile();
}

/** Freeze the allowed file and parent identities, then read and recheck the same bounded descriptor. */
export async function readPriceFile(filename: string, inputRoots: string[] = []): Promise<Buffer> {
  const requested = path.resolve(filename),
    entry = await lstat(requested, { bigint: true });
  regularPriceFile(entry);
  const actual = await realpath(requested),
    parent = await priceDirectory(path.dirname(requested));
  if (actual !== path.join(parent.actual, path.basename(requested))) changedPriceFile();
  samePriceFile(entry, await lstat(actual, { bigint: true }));
  const roots = await Promise.all(inputRoots.map(priceDirectory));
  if (
    roots.length &&
    !roots.some((root) => {
      const relative = path.relative(root.actual, actual);
      return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    })
  )
    throw new TripoError('INPUT_NOT_ALLOWED', 'Pricing file is outside the configured input roots.');
  const check = async () => {
    await checkPriceDirectory(parent);
    for (const root of roots) await checkPriceDirectory(root);
    if ((await realpath(requested)) !== actual) changedPriceFile();
    samePriceFile(entry, await lstat(requested, { bigint: true }));
    samePriceFile(entry, await lstat(actual, { bigint: true }));
  };
  await check();
  const handle = await open(
    actual,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    samePriceFile(entry, await handle.stat({ bigint: true }));
    await check();
    const bytes = Buffer.alloc(snapshotLimit + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, null);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    samePriceFile(entry, await handle.stat({ bigint: true }));
    await check();
    if (count > snapshotLimit || BigInt(count) !== entry.size) changedPriceFile();
    return bytes.subarray(0, count);
  } finally {
    await handle.close();
  }
}

function checkedUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new TripoError('INVALID_INPUT', 'Use a direct HTTPS URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new TripoError('INVALID_INPUT', 'Use an HTTPS URL without credentials or a fragment.');
  return url;
}

async function downloadBytes(url: string, limit: number, fetcher: Fetcher): Promise<Buffer> {
  const source = checkedUrl(url);
  const headers: Record<string, string> = {
    'user-agent': 'ai-modeling (+https://github.com/seekskyworld/ai-modeling)',
    accept: source.origin === 'https://tripo-webapp-assets.tripo3d.ai' ? '*/*' : 'application/json',
  };
  // The public Studio CDN requires its normal page origin, without account credentials.
  if (source.origin === 'https://tripo-webapp-assets.tripo3d.ai') {
    headers.origin = 'https://studio.tripo3d.ai';
    headers.referer = 'https://studio.tripo3d.ai/';
  }
  const response = await fetcher(url, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new TripoError('PRICING_DOWNLOAD_FAILED', 'Pricing source could not be read.', 'read', {
      http_status: response.status,
    });
  }
  if (!response.body) throw new TripoError('PRICING_DOWNLOAD_FAILED', 'Pricing source returned no data.');
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > limit) throw new TripoError('INVALID_PRICING', 'Pricing source exceeds its size limit.');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

export async function verifyPricingBytes(
  bytes: Buffer,
  options: { sha256?: string; network?: boolean; nowMs?: number; fetcher?: Fetcher } = {},
) {
  if (bytes.length > snapshotLimit)
    throw new TripoError('INVALID_PRICING', 'Pricing snapshot exceeds 1 MiB.');
  const sha256 = digest(bytes);
  if (
    options.sha256 !== undefined &&
    (!/^[a-f0-9]{64}$/i.test(options.sha256) || sha256 !== options.sha256.toLowerCase())
  )
    throw new TripoError('PRICING_INTEGRITY', 'Pricing snapshot does not match the expected SHA-256.');
  let snapshot: PriceSnapshot;
  try {
    snapshot = priceSchema.parse(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw new TripoError('INVALID_PRICING', 'Pricing snapshot does not match the public schema.');
  }
  const status = pricingSnapshotStatus(snapshot, options.nowMs);
  if (!status.usable)
    throw new TripoError('PRICE_UNKNOWN', 'Pricing review is expired, future-dated or invalid.');
  if (!snapshot.evidence.length)
    throw new TripoError('INVALID_PRICING', 'A reviewed snapshot must include its source evidence.');
  for (const evidence of snapshot.evidence) {
    const url = checkedUrl(evidence.url);
    if (
      url.origin !== 'https://tripo-webapp-assets.tripo3d.ai' ||
      !url.pathname.startsWith('/studio-prod/_nuxt/') ||
      url.search ||
      !url.pathname.endsWith('.js')
    )
      throw new TripoError(
        'INVALID_PRICING',
        'Evidence must refer to a public official Studio JavaScript bundle.',
      );
    if (options.network) {
      const source = await downloadBytes(url.href, evidenceLimit, options.fetcher ?? networkFetch);
      if (digest(source) !== evidence.sha256)
        throw new TripoError(
          'PRICING_EVIDENCE_CHANGED',
          'Official evidence differs from the reviewed SHA-256.',
        );
    }
  }
  return {
    snapshot,
    result: {
      ...status,
      sha256,
      evidence_verified_online: Boolean(options.network),
      network_used: Boolean(options.network),
    },
  };
}

export async function installPricingSnapshot(
  dataDir: string,
  bytes: Buffer,
  options: Parameters<typeof verifyPricingBytes>[1] = {},
) {
  const verified = await verifyPricingBytes(bytes, options);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const destination = path.join(dataDir, 'pricing.json');
  const unlock = await lockfile.lock(destination, {
    realpath: false,
    retries: { retries: 15, minTimeout: 50, maxTimeout: 200 },
    stale: 30000,
  });
  const temporary = path.join(dataDir, `.pricing-${randomUUID()}.tmp`);
  try {
    let previous: PriceSnapshot = reviewedPrices;
    try {
      previous = priceSchema.parse(JSON.parse((await readPriceFile(destination)).toString('utf8')));
    } catch {
      // A validated explicit import can repair a missing or invalid local snapshot.
    }
    if (Date.parse(previous.reviewed_at) > Date.parse(verified.snapshot.reviewed_at))
      throw new TripoError('PRICING_ROLLBACK', 'A newer reviewed price snapshot is already available.');
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
    return { ...verified.result, pricing_imported: true };
  } finally {
    await rm(temporary, { force: true });
    await unlock();
  }
}

export async function updatePricingSnapshot(
  dataDir: string,
  url: string,
  sha256: string,
  fetcher: Fetcher = networkFetch,
) {
  if (!/^[a-f0-9]{64}$/i.test(sha256))
    throw new TripoError('INVALID_INPUT', 'A trusted SHA-256 is required for a remote pricing update.');
  const bytes = await downloadBytes(url, snapshotLimit, fetcher);
  return await installPricingSnapshot(dataDir, bytes, { sha256, network: true, fetcher });
}
