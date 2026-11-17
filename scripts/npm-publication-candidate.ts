/** Reuse standard export and three-platform readiness validators over frozen snapshots. */
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PACKAGE_NAME } from '../version.ts';
import type { dependencyProvenance } from './dependency-lock.ts';
import {
  assertFreshReadiness,
  assertIdentity,
  digest,
  distributionNames,
  publicationFile,
  publicationVersion,
  type PublicationArtifact,
  type PublicationContext,
  type PublicationIdentity,
} from './npm-publication-state.ts';

const platforms = ['linux', 'darwin', 'win32'];
const reports = platforms.flatMap((platform) => [`smoke-${platform}.json`, `consumer-${platform}.json`]);
const candidateNames = ['readiness.json', 'RELEASE.md', 'SHA256SUMS', ...reports];
interface CandidateReadiness {
  schema_version: number;
  name: string;
  version: string;
  scope: string;
  ready: boolean;
  repository: string;
  blockers: unknown[];
  consumer_dependency_drift: unknown[];
  checked_at: string;
  provenance: Awaited<ReturnType<typeof dependencyProvenance>>;
  installation: {
    archive_sha256: string;
    verified_platforms: string[];
    consumer_verified_platforms: string[];
    consumer_locked_platforms: string[];
  };
  pricing: { expires_at: string; minimum_remaining_hours: number };
}

async function readInventory(directory: string, names: string[]) {
  const entries = await readdir(directory);
  if (JSON.stringify(entries.sort()) !== JSON.stringify([...names].sort()))
    throw new Error('Publication input inventory differs from the standard export/candidate files.');
  const files = new Map<string, Buffer>();
  for (const name of names) files.set(name, await publicationFile(path.join(directory, name)));
  return files;
}

function verifyCandidateSums(files: Map<string, Buffer>) {
  const expected =
    [...files]
      .filter(([name]) => name !== 'SHA256SUMS')
      .map(([name, bytes]) => `${digest(bytes)}  ${name}`)
      .sort()
      .join('\n') + '\n';
  if (files.get('SHA256SUMS')!.toString('utf8') !== expected)
    throw new Error('Candidate SHA256SUMS does not match the supplied evidence.');
}

function artifact(name: string, bytes: Buffer): PublicationArtifact {
  return { name, size: bytes.length, sha256: digest(bytes) };
}

function validateReadiness(readiness: CandidateReadiness, context: PublicationContext) {
  if (
    readiness.schema_version !== 1 ||
    readiness.name !== PACKAGE_NAME ||
    readiness.version !== publicationVersion(context) ||
    readiness.scope !== 'candidate' ||
    readiness.ready !== true ||
    !Array.isArray(readiness.blockers) ||
    readiness.blockers.length !== 0 ||
    !Array.isArray(readiness.consumer_dependency_drift) ||
    readiness.consumer_dependency_drift.length !== 0 ||
    readiness.repository !== `https://github.com/${context.repository}`
  )
    throw new Error('New npm publication requires a ready candidate for this repository and version.');
  if (
    readiness.provenance?.source_commit !== context.source ||
    readiness.provenance?.source_dirty !== false ||
    readiness.provenance?.source_tracked !== true
  )
    throw new Error('Candidate source must be clean, tracked and bound to the tagged commit.');
}

async function validateSnapshots(
  files: Map<string, Buffer>,
  evidence: Map<string, Buffer>,
  readiness: CandidateReadiness,
) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'ai-modeling-publication-candidate-'));
  try {
    const distDirectory = path.join(temporary, 'distribution');
    const smokeDirectory = path.join(temporary, 'smoke');
    await mkdir(distDirectory);
    await mkdir(smokeDirectory);
    for (const [name, bytes] of files) await writeFile(path.join(distDirectory, name), bytes, { flag: 'wx' });
    for (const name of reports)
      await writeFile(path.join(smokeDirectory, name), evidence.get(name)!, { flag: 'wx' });
    const { verifyDistribution, readSmokeReports } = await import('./release.ts');
    const verified = await verifyDistribution(distDirectory, readiness.version, readiness.provenance);
    const smoke = await readSmokeReports(
      smokeDirectory,
      readiness.version,
      verified.archive_sha256,
      readiness.provenance.production_lock_sha256,
    );
    for (const verifiedPlatforms of [smoke.verified, smoke.consumerVerified, smoke.consumerLocked])
      if (!platforms.every((platform) => verifiedPlatforms.includes(platform)))
        throw new Error('The same TGZ must pass locked and consumer installation on all three platforms.');
    if (readiness.installation?.archive_sha256 !== verified.archive_sha256)
      throw new Error('Readiness does not bind the frozen archive SHA-256.');
    for (const field of [
      'verified_platforms',
      'consumer_verified_platforms',
      'consumer_locked_platforms',
    ] as const)
      if (
        !Array.isArray(readiness.installation[field]) ||
        !platforms.every((p) => readiness.installation[field].includes(p))
      )
        throw new Error('Readiness is missing same-archive three-platform reports.');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function archiveIdentity(version: string, files: Map<string, Buffer>) {
  const archiveName = `ai-modeling-${version}.tgz`;
  const archive = files.get(archiveName)!;
  const { archiveEntries } = await import('./archive-input.ts');
  const metadataBytes = archiveEntries(archive).find((entry) => entry.path === 'package.json')?.bytes;
  const metadata = metadataBytes && JSON.parse(metadataBytes.toString('utf8'));
  if (metadata?.name !== PACKAGE_NAME || metadata.version !== version)
    throw new Error('The frozen archive package metadata differs from the release tag.');
  const sha512 = digest(archive, 'sha512');
  return {
    ...artifact(archiveName, archive),
    sha512,
    integrity: `sha512-${Buffer.from(sha512, 'hex').toString('base64')}`,
    shasum: digest(archive, 'sha1'),
  };
}

export async function preparePublicationIdentity(
  context: PublicationContext,
  distribution: string,
  candidate: string,
  nowMs = Date.now(),
) {
  const version = publicationVersion(context);
  const files = await readInventory(distribution, distributionNames(version));
  const evidence = await readInventory(candidate, candidateNames);
  verifyCandidateSums(evidence);
  const readiness = JSON.parse(evidence.get('readiness.json')!.toString('utf8')) as CandidateReadiness;
  validateReadiness(readiness, context);
  await validateSnapshots(files, evidence, readiness);
  const identity: PublicationIdentity = {
    repository: context.repository,
    tag: context.tag,
    source: context.source,
    name: PACKAGE_NAME,
    version,
    archive: await archiveIdentity(version, files),
    distribution: [...files].map(([name, bytes]) => artifact(name, bytes)),
    candidate: [...evidence].map(([name, bytes]) => artifact(`candidate-${name}`, bytes)),
    readiness: {
      checked_at: readiness.checked_at,
      pricing_expires_at: readiness.pricing?.expires_at,
      minimum_remaining_hours: readiness.pricing?.minimum_remaining_hours,
    },
  };
  assertIdentity(identity, context);
  assertFreshReadiness(identity, nowMs);
  for (const [name, bytes] of evidence) files.set(`candidate-${name}`, bytes);
  return { identity, files };
}
