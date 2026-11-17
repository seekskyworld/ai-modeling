/** Immutable publication identity and receipts. No npm upload is implemented here. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { PACKAGE_NAME } from '../version.ts';

export const publicationStates = ['prepared', 'submitting', 'submitted', 'published'] as const;
export type PublicationState = (typeof publicationStates)[number];
export interface PublicationContext {
  repository: string;
  tag: string;
  source: string;
}
export interface PublicationArtifact {
  name: string;
  size: number;
  sha256: string;
}
export interface PublicationIdentity extends PublicationContext {
  name: string;
  version: string;
  archive: PublicationArtifact & { sha512: string; integrity: string; shasum: string };
  distribution: PublicationArtifact[];
  candidate: PublicationArtifact[];
  readiness: { checked_at: string; pricing_expires_at: string; minimum_remaining_hours: number } | null;
}
export interface RegistryProof {
  checked_at: string;
  metadata_url: string;
  tarball_url: string;
  size: number;
  sha256: string;
  sha512: string;
  integrity: string;
  shasum: string;
}
export interface PublicationRecord {
  schema_version: 1;
  state: PublicationState;
  identity: PublicationIdentity;
  identity_sha256: string;
  previous_sha256: string | null;
  created_at: string;
  origin: 'coordinator' | 'imported_submission';
  run_id?: string;
  outcome?: 'accepted' | 'unknown';
  verification?: RegistryProof;
}

export const recordName = (state: PublicationState) => `npm-publication-${state}.json`;
export const digest = (bytes: Uint8Array, algorithm = 'sha256') =>
  createHash(algorithm).update(bytes).digest('hex');
export const jsonBytes = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export const identityDigest = (identity: PublicationIdentity) => digest(Buffer.from(canonical(identity)));

export function publicationVersion(context: PublicationContext): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(context.repository))
    throw new Error('Use the GitHub repository in owner/repository form.');
  if (!/^[a-f0-9]{40,64}$/.test(context.source)) throw new Error('Use the full source commit SHA.');
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[\da-zA-Z.-]+)?$/.test(context.tag))
    throw new Error('Use an exact vMAJOR.MINOR.PATCH tag, optionally with a prerelease suffix.');
  return context.tag.slice(1);
}

export function distributionNames(version: string): string[] {
  return [
    `ai-modeling-${version}.tgz`,
    `ai-modeling-skill-${version}.zip`,
    'mcp.json',
    'INSTALL.md',
    'manifest.json',
    'SHA256SUMS',
  ];
}

function assertArtifact(value: PublicationArtifact) {
  if (
    !value ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.name) ||
    !Number.isSafeInteger(value.size) ||
    value.size < 1 ||
    value.size > 256 * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  )
    throw new Error('Invalid frozen publication artifact.');
}

export function assertIdentity(identity: PublicationIdentity, context: PublicationContext) {
  const version = publicationVersion(context);
  if (
    !identity ||
    identity.name !== PACKAGE_NAME ||
    identity.version !== version ||
    identity.repository !== context.repository ||
    identity.tag !== context.tag ||
    identity.source !== context.source
  )
    throw new Error('Publication identity does not match the package, tag, repository or source commit.');
  assertArtifact(identity.archive);
  if (
    identity.archive.name !== `ai-modeling-${version}.tgz` ||
    !/^[a-f0-9]{128}$/.test(identity.archive.sha512) ||
    identity.archive.integrity !==
      `sha512-${Buffer.from(identity.archive.sha512, 'hex').toString('base64')}` ||
    !/^[a-f0-9]{40}$/.test(identity.archive.shasum)
  )
    throw new Error('Invalid frozen archive SHA-512/SHA-1 identity.');
  if (!Array.isArray(identity.distribution) || !Array.isArray(identity.candidate))
    throw new Error('Missing frozen artifact inventory.');
  const names = identity.distribution.map((item) => item.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(distributionNames(version).sort()))
    throw new Error('Publication requires the six standard all-target export files.');
  const all = [...identity.distribution, ...identity.candidate];
  all.forEach(assertArtifact);
  if (new Set(all.map((item) => item.name)).size !== all.length)
    throw new Error('Duplicate frozen artifact names.');
  const archive = identity.distribution.find((item) => item.name === identity.archive.name)!;
  if (archive.sha256 !== identity.archive.sha256 || archive.size !== identity.archive.size)
    throw new Error('Archive and distribution identities differ.');
}

export function assertFreshReadiness(identity: PublicationIdentity, nowMs: number) {
  const ready = identity.readiness;
  if (
    !ready ||
    !Number.isFinite(Date.parse(ready.checked_at)) ||
    Date.parse(ready.checked_at) > nowMs + 60000 ||
    !Number.isFinite(ready.minimum_remaining_hours) ||
    ready.minimum_remaining_hours < 1 ||
    !Number.isFinite(Date.parse(ready.pricing_expires_at)) ||
    Date.parse(ready.pricing_expires_at) - nowMs < ready.minimum_remaining_hours * 3600000
  )
    throw new Error('New submission requires current, ready three-platform candidate evidence.');
}

export function parseRecord(bytes: Buffer, context: PublicationContext): PublicationRecord {
  const record = JSON.parse(bytes.toString('utf8')) as PublicationRecord;
  if (
    record?.schema_version !== 1 ||
    !publicationStates.includes(record.state) ||
    !['coordinator', 'imported_submission'].includes(record.origin) ||
    !Number.isFinite(Date.parse(record.created_at))
  )
    throw new Error('Invalid publication receipt schema.');
  assertIdentity(record.identity, context);
  if (record.identity_sha256 !== identityDigest(record.identity))
    throw new Error('Publication receipt identity digest mismatch.');
  if (record.previous_sha256 !== null && !/^[a-f0-9]{64}$/.test(record.previous_sha256))
    throw new Error('Invalid publication receipt predecessor digest.');
  if (record.origin === 'imported_submission' && !['submitted', 'published'].includes(record.state))
    throw new Error('Imported submission facts can never authorize a new submission.');
  if (
    ['submitting', 'submitted'].includes(record.state) &&
    !/^[A-Za-z0-9._-]{1,160}$/.test(record.run_id ?? '')
  )
    throw new Error('Submission receipts require a non-secret run identity.');
  if (record.state === 'submitted' && !['accepted', 'unknown'].includes(record.outcome ?? ''))
    throw new Error('Submitted receipts require accepted or unknown outcome.');
  if (record.state === 'published') assertProof(record.identity, record.verification);
  return record;
}

export function assertProof(identity: PublicationIdentity, proof?: RegistryProof) {
  if (
    !proof ||
    !Number.isFinite(Date.parse(proof.checked_at)) ||
    proof.size !== identity.archive.size ||
    proof.sha256 !== identity.archive.sha256 ||
    proof.sha512 !== identity.archive.sha512 ||
    proof.integrity !== identity.archive.integrity ||
    proof.shasum !== identity.archive.shasum
  )
    throw new Error('Publication requires a complete matching public archive proof.');
}

export function makeRecord(
  state: PublicationState,
  identity: PublicationIdentity,
  nowMs: number,
  previous?: { record: PublicationRecord; bytes: Buffer },
  extra: Pick<PublicationRecord, 'run_id' | 'outcome' | 'verification'> = {},
): PublicationRecord {
  return {
    schema_version: 1,
    state,
    identity,
    identity_sha256: identityDigest(identity),
    previous_sha256: previous ? digest(previous.bytes) : null,
    created_at: new Date(nowMs).toISOString(),
    origin: previous?.record.origin ?? 'coordinator',
    ...extra,
  };
}

/** Bounded no-follow read binds validation to the bytes used for remote persistence. */
export async function publicationFile(filename: string, maximumBytes = 256 * 1024 * 1024): Promise<Buffer> {
  const before = await lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximumBytes)
    throw new Error(`Publication input must be a bounded regular file: ${path.basename(filename)}`);
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
      throw new Error('Publication input changed before reading.');
    const bytes = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await handle.stat();
    if (length !== opened.size || after.mtimeMs !== opened.mtimeMs || after.size !== opened.size)
      throw new Error('Publication input changed while reading.');
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}
