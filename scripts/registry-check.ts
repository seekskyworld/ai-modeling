/** Read public npm metadata only; never read npm credentials or publish a package. */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_NAME, VERSION } from '../version.ts';
import { archiveEntries, snapshotArchive } from './archive-input.ts';

const registry = 'https://registry.npmjs.org';
const help =
  'Usage: npm run package:registry-check -- [--archive FILE.tgz] [--report NEW.json] [--require-published]\nQueries public metadata for the current ai-modeling version. An optional archive is compared with the registry digest; the remote tarball is not downloaded. No npm credentials or publication.\n';

export function parseRegistryArgs(args: string[]) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) return;
  const options: { archive?: string; report?: string; requirePublished: boolean } = {
    requirePublished: false,
  };
  for (let index = 0; index < args.length; index++) {
    const key = args[index]!;
    if (key === '--require-published' && !options.requirePublished) options.requirePublished = true;
    else if (
      (key === '--archive' || key === '--report') &&
      options[key.slice(2) as 'archive' | 'report'] === undefined
    ) {
      const value = args[++index];
      if (!value || value.startsWith('-')) throw new Error(`Missing value for ${key}.`);
      options[key.slice(2) as 'archive' | 'report'] = value;
    } else throw new Error(`Unknown or repeated registry-check argument: ${key}`);
  }
  return options;
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error('The npm registry returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 1024 * 1024) {
        await reader.cancel();
        throw new Error('The npm registry metadata exceeds 1 MiB.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid npm registry metadata.');
  return value;
}

type ArchiveDigest = { sha256: string; sha512: string; sha1: string };

async function localArchiveDigest(archive: string): Promise<ArchiveDigest> {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-registry-check-'));
  try {
    const snapshot = await snapshotArchive(archive, directory);
    const bytes = await readFile(snapshot.filename);
    const metadataBytes = archiveEntries(bytes).find((item) => item.path === 'package.json')?.bytes;
    const metadata = metadataBytes && JSON.parse(metadataBytes.toString('utf8'));
    if (metadata?.name !== PACKAGE_NAME || metadata.version !== VERSION)
      throw new Error('The archive must contain the current ai-modeling package version.');
    return {
      sha256: snapshot.sha256,
      sha512: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      sha1: createHash('sha1').update(bytes).digest('hex'),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function registryDigestMatches(metadata: Record<string, unknown>, local?: ArchiveDigest): boolean | null {
  const dist = metadata.dist as { integrity?: unknown; shasum?: unknown } | undefined;
  const integrity = typeof dist?.integrity === 'string' ? dist.integrity.split(/\s+/) : [];
  const sha512 = integrity.filter((item) => /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(item));
  const shasum =
    typeof dist?.shasum === 'string' && /^[a-f0-9]{40}$/.test(dist.shasum) ? dist.shasum : undefined;
  if (!sha512.length && !shasum)
    throw new Error('The npm registry metadata has no supported package digest.');
  return local ? (sha512.length ? sha512.includes(local.sha512) : shasum === local.sha1) : null;
}

export async function checkRegistry(archive?: string, fetcher: typeof fetch = fetch) {
  const local = archive ? await localArchiveDigest(archive) : undefined;
  const response = await fetcher(
    `${registry}/${encodeURIComponent(PACKAGE_NAME)}/${encodeURIComponent(VERSION)}`,
    {
      redirect: 'error',
      credentials: 'omit',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    },
  );
  const base = {
    schema_version: 1,
    name: PACKAGE_NAME,
    version: VERSION,
    registry,
    checked_at: new Date().toISOString(),
    archive_sha256: local?.sha256 ?? null,
    registry_tarball_downloaded: false,
    package_ownership_verified: false,
    publication_performed: false,
  };
  if (response.status === 404) {
    await response.body?.cancel();
    return { ...base, published: false, archive_matches_registry_digest: null };
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Public npm registry check failed with HTTP ${response.status}.`);
  }
  const metadata = await boundedJson(response);
  if (metadata.name !== PACKAGE_NAME || metadata.version !== VERSION)
    throw new Error('The npm registry returned another package or version.');
  const matches = registryDigestMatches(metadata, local);
  return { ...base, published: true, archive_matches_registry_digest: matches };
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const options = parseRegistryArgs(process.argv.slice(2));
  if (!options) process.stdout.write(help);
  else {
    const report = await checkRegistry(options.archive);
    const json = JSON.stringify(report, null, 2) + '\n';
    if (options.report) await writeFile(path.resolve(options.report), json, { flag: 'wx' });
    process.stdout.write(json);
    if (report.archive_matches_registry_digest === false || (options.requirePublished && !report.published))
      process.exitCode = 1;
  }
}
