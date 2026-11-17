/** Coordinate immutable publication evidence; the workflow alone invokes npm publish. */
import { lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_NAME } from '../version.ts';
import { preparePublicationIdentity } from './npm-publication-candidate.ts';
import {
  GitHubPublicationStore,
  publicMetadata,
  verifyPublicArchive,
  type PublicationRelease,
  type PublicationStore,
} from './npm-publication-remote.ts';
import {
  assertFreshReadiness,
  digest,
  identityDigest,
  jsonBytes,
  makeRecord,
  parseRecord,
  publicationStates,
  publicationVersion,
  recordName,
  type PublicationContext,
  type PublicationRecord,
} from './npm-publication-state.ts';

export interface NpmPublicationOptions extends PublicationContext {
  command: 'prepare' | 'check' | 'verify';
  out?: string;
  distribution?: string;
  candidate?: string;
  restore?: string;
  dryRun: boolean;
  beginSubmission: boolean;
  submitted: boolean;
  runId?: string;
  outcome?: 'accepted' | 'unknown';
}
export const npmPublicationHelp = `Usage:
  node scripts/npm-publication.ts check --repository OWNER/REPO --tag vVERSION --source FULL_SHA --out NEW.json [--restore NEW_DIR]
  node scripts/npm-publication.ts prepare [identity options] --distribution DIR --candidate DIR --out NEW.json [--dry-run]
  node scripts/npm-publication.ts check [identity options] --begin-submission --run-id RUN.ATTEMPT --restore NEW_DIR --out NEW.json
  node scripts/npm-publication.ts check [identity options] --submitted --run-id RUN.ATTEMPT --outcome accepted|unknown --out NEW.json
  node scripts/npm-publication.ts verify [identity options] --out NEW.json [--dry-run]

All commands accept --dry-run, which prohibits remote writes. check normally reads
only; --begin-submission atomically creates and reads back the immutable GitHub
submitting receipt before returning should_publish=true. Only that invocation may
call npm publish once. Re-entry, including the same run ID, never reauthorizes it.
An accepted or uncertain npm call is recorded with --submitted; an unsuccessful
receipt write leaves the submitting claim intact. Never retry npm on HTTP 404.
prepare requires the standard six-file export and complete same-TGZ three-platform
candidate. It freezes originals in the matching draft Release. --restore creates
NEW_DIR/distribution and NEW_DIR/candidate. Existing releases without these records
require explicit import of prior submission facts, never automatic publication.
verify checks exact public metadata AND downloaded original TGZ bytes. It does not
publish the GitHub Release. No command invokes npm, rebuilds, tags, or changes a version.
GITHUB_TOKEN (or GH_TOKEN) is used only for GitHub API access, never sent to npm.
`;

export function parseNpmPublicationArgs(args: string[]): NpmPublicationOptions | undefined {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) return;
  const [command, ...rest] = args;
  if (!['prepare', 'check', 'verify'].includes(command ?? '')) throw new Error(npmPublicationHelp);
  const flags = new Set(['--dry-run', '--begin-submission', '--submitted']);
  const values = new Set([
    '--repository',
    '--tag',
    '--source',
    '--out',
    '--distribution',
    '--candidate',
    '--restore',
    '--run-id',
    '--outcome',
  ]);
  const found = new Map<string, string>();
  for (let index = 0; index < rest.length; index++) {
    const key = rest[index]!;
    if (found.has(key)) throw new Error(`Duplicate publication argument: ${key}`);
    if (flags.has(key)) found.set(key, 'true');
    else if (values.has(key)) {
      const value = rest[++index];
      if (!value?.trim() || value.startsWith('-')) throw new Error(`Missing publication argument: ${key}`);
      found.set(key, value);
    } else throw new Error(`Unknown publication argument: ${key}`);
  }
  for (const key of ['--repository', '--tag', '--source', '--out'])
    if (!found.has(key)) throw new Error(`Publication requires ${key}.`);
  const options: NpmPublicationOptions = {
    command: command as NpmPublicationOptions['command'],
    repository: found.get('--repository')!,
    tag: found.get('--tag')!,
    source: found.get('--source')!,
    out: found.get('--out'),
    distribution: found.get('--distribution'),
    candidate: found.get('--candidate'),
    restore: found.get('--restore'),
    runId: found.get('--run-id'),
    outcome: found.get('--outcome') as NpmPublicationOptions['outcome'],
    dryRun: found.has('--dry-run'),
    beginSubmission: found.has('--begin-submission'),
    submitted: found.has('--submitted'),
  };
  validateOptions(options);
  return options;
}

function validateOptions(options: NpmPublicationOptions) {
  publicationVersion(options);
  if (options.command === 'prepare' && (!options.distribution || !options.candidate))
    throw new Error('prepare requires --distribution and --candidate.');
  if (options.command !== 'prepare' && (options.distribution || options.candidate))
    throw new Error('Distribution and candidate inputs are only accepted by prepare.');
  if (
    options.command !== 'check' &&
    (options.beginSubmission || options.submitted || options.restore || options.runId || options.outcome)
  )
    throw new Error('Submission and restore options are only accepted by check.');
  validateSubmissionOptions(options);
}

function validateSubmissionOptions(options: NpmPublicationOptions) {
  if (options.beginSubmission && (options.submitted || !options.restore || !options.runId))
    throw new Error('--begin-submission requires --restore and --run-id and cannot record a result.');
  if (options.submitted && (!options.runId || !['accepted', 'unknown'].includes(options.outcome ?? '')))
    throw new Error('--submitted requires --run-id and --outcome accepted|unknown.');
  if (options.outcome && !options.submitted) throw new Error('--outcome requires --submitted.');
  if (options.runId && !options.beginSubmission && !options.submitted)
    throw new Error('--run-id requires --begin-submission or --submitted.');
  if (options.runId && !/^[A-Za-z0-9._-]{1,160}$/.test(options.runId))
    throw new Error(
      'Use a non-secret run identity containing only letters, digits, dot, underscore or hyphen.',
    );
}

interface StoredRecord {
  record: PublicationRecord;
  bytes: Buffer;
}
interface RemoteState {
  release?: PublicationRelease;
  frozen?: StoredRecord;
  current?: StoredRecord;
}

async function loadState(context: PublicationContext, store: PublicationStore): Promise<RemoteState> {
  const release = await store.load(context);
  if (!release) return {};
  if (release.tag !== context.tag) throw new Error('GitHub returned another release tag.');
  const frozenBytes = await store.read(release, 'npm-publication-frozen.json', 1024 * 1024);
  const frozen = frozenBytes ? { record: parseRecord(frozenBytes, context), bytes: frozenBytes } : undefined;
  if (frozen && (frozen.record.state !== 'prepared' || frozen.record.previous_sha256 !== null))
    throw new Error('Invalid frozen publication identity marker.');
  let current: StoredRecord | undefined;
  for (const state of publicationStates) {
    const bytes = await store.read(release, recordName(state), 1024 * 1024);
    if (!bytes) continue;
    const record = parseRecord(bytes, context);
    if (record.state !== state) throw new Error('Receipt filename and state differ.');
    const anchor = current ?? frozen;
    if (anchor && record.identity_sha256 !== anchor.record.identity_sha256)
      throw new Error('A publication receipt changes the frozen archive or source identity.');
    validatePredecessor(record, current);
    current = { record, bytes };
  }
  return { release, frozen, current };
}

function validatePredecessor(record: PublicationRecord, previous?: StoredRecord) {
  if (!previous) {
    if (
      record.previous_sha256 !== null ||
      (record.state !== 'prepared' && record.origin !== 'imported_submission')
    )
      throw new Error('Publication receipt is missing its durable predecessor.');
    return;
  }
  if (record.previous_sha256 !== digest(previous.bytes))
    throw new Error('Publication receipt predecessor changed.');
  if (record.state === 'submitted' && previous.record.state !== 'submitting')
    throw new Error('Submission result requires a prior durable submitting claim.');
  if (record.state === 'submitting' && previous.record.state !== 'prepared')
    throw new Error('Submission claim requires a prior prepared candidate.');
}

async function persist(
  context: PublicationContext,
  store: PublicationStore,
  release: PublicationRelease,
  name: string,
  bytes: Buffer,
) {
  // This create is deliberately never retried. A missing response is an unknown write.
  await store.put(release, name, bytes);
  const refreshed = await store.load(context);
  if (!refreshed || refreshed.id !== release.id)
    throw new Error('Release identity changed after persistence.');
  const saved = await store.read(refreshed, name, bytes.length);
  if (!saved?.equals(bytes))
    throw new Error('Durable receipt read-back did not match; publication is not authorized.');
}

function report(options: NpmPublicationOptions, remote: RemoteState, action: string, extra: object = {}) {
  const identity = remote.current?.record.identity ?? remote.frozen?.record.identity;
  return {
    schema_version: 1,
    name: PACKAGE_NAME,
    version: publicationVersion(options),
    tag: options.tag,
    source: options.source,
    repository: options.repository,
    action,
    state: remote.current?.record.state ?? null,
    frozen: Boolean(identity),
    should_publish: false,
    dry_run: options.dryRun,
    release_id: remote.release?.id ?? null,
    archive_sha256: identity?.archive.sha256 ?? null,
    archive_sha512: identity?.archive.sha512 ?? null,
    ...extra,
  };
}

async function restoreIdentity(options: NpmPublicationOptions, remote: RemoteState, store: PublicationStore) {
  if (!options.restore || !remote.current || !remote.release) return {};
  const identity = remote.current.record.identity;
  const directory = path.resolve(options.restore);
  await mkdir(directory);
  try {
    const distribution = path.join(directory, 'distribution');
    const candidate = path.join(directory, 'candidate');
    await mkdir(distribution);
    await mkdir(candidate);
    for (const item of [...identity.distribution, ...identity.candidate]) {
      const bytes = await store.read(remote.release, item.name, item.size);
      if (!bytes || bytes.length !== item.size || digest(bytes) !== item.sha256)
        throw new Error(
          'Frozen release asset is missing or has different bytes; never rebuild it automatically.',
        );
      const isCandidate = identity.candidate.includes(item);
      const filename = isCandidate ? item.name.replace(/^candidate-/, '') : item.name;
      await writeFile(path.join(isCandidate ? candidate : distribution, filename), bytes, { flag: 'wx' });
    }
    return {
      distribution_path: distribution,
      candidate_path: candidate,
      archive_path: path.join(distribution, identity.archive.name),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function prepare(
  options: NpmPublicationOptions,
  remote: RemoteState,
  store: PublicationStore,
  now: () => number,
) {
  if (remote.current)
    return report(options, remote, 'wait', { reason: 'existing_frozen_publication_use_check_or_verify' });
  if (remote.release && !remote.frozen)
    return report(options, remote, 'import_required', {
      reason: 'existing_release_has_no_publication_receipt',
    });
  const candidate = await preparePublicationIdentity(
    options,
    options.distribution!,
    options.candidate!,
    now(),
  );
  if (remote.frozen && remote.frozen.record.identity_sha256 !== identityDigest(candidate.identity))
    throw new Error('An interrupted freeze cannot change the original archive or readiness evidence.');
  if (options.dryRun) return report(options, remote, 'preview', { candidate_identity: candidate.identity });
  const release = remote.release ?? (await store.create(options));
  const frozen = remote.frozen?.record ?? makeRecord('prepared', candidate.identity, now());
  if (!remote.frozen)
    await persist(options, store, release, 'npm-publication-frozen.json', jsonBytes(frozen));
  for (const [name, bytes] of candidate.files) {
    const refreshed = await store.load(options);
    if (!refreshed || refreshed.id !== release.id) throw new Error('Frozen release disappeared.');
    const existing = await store.read(refreshed, name, bytes.length);
    if (existing) {
      if (!existing.equals(bytes))
        throw new Error('Existing frozen asset differs; overwriting is forbidden.');
    } else await persist(options, store, release, name, bytes);
  }
  const prepared = makeRecord('prepared', candidate.identity, now());
  await persist(options, store, release, recordName('prepared'), jsonBytes(prepared));
  return report(options, await loadState(options, store), 'submit');
}

async function beginSubmission(
  options: NpmPublicationOptions,
  remote: RemoteState,
  store: PublicationStore,
  now: () => number,
) {
  const previous = remote.current!;
  if (previous.record.state !== 'prepared')
    return report(options, remote, 'wait', {
      ...(await restoreIdentity(options, remote, store)),
      reason: 'submission_already_attempted',
    });
  assertFreshReadiness(previous.record.identity, now());
  const paths = await restoreIdentity(options, remote, store);
  if (!paths.distribution_path || !paths.candidate_path)
    throw new Error('Submission requires restored frozen files.');
  const candidate = await preparePublicationIdentity(
    options,
    paths.distribution_path,
    paths.candidate_path,
    now(),
  );
  if (identityDigest(candidate.identity) !== previous.record.identity_sha256)
    throw new Error('Restored candidate identity changed.');
  if (options.dryRun)
    return report(options, remote, 'preview', { ...paths, reason: 'would_persist_submitting_before_npm' });
  const claim = makeRecord('submitting', previous.record.identity, now(), previous, {
    run_id: options.runId,
  });
  await persist(options, store, remote.release!, recordName('submitting'), jsonBytes(claim));
  return report(options, { ...remote, current: { record: claim, bytes: jsonBytes(claim) } }, 'publish', {
    ...paths,
    should_publish: true,
    run_id: options.runId,
  });
}

async function recordSubmitted(
  options: NpmPublicationOptions,
  remote: RemoteState,
  store: PublicationStore,
  now: () => number,
) {
  const previous = remote.current;
  if (!previous || !remote.release) throw new Error('There is no durable submitting claim.');
  if (previous.record.state === 'submitted' || previous.record.state === 'published')
    return report(options, remote, 'wait', { reason: 'submission_result_already_preserved' });
  if (previous.record.state !== 'submitting' || previous.record.run_id !== options.runId)
    throw new Error('Submission result does not belong to this durable run claim.');
  if (options.dryRun) return report(options, remote, 'preview');
  const submitted = makeRecord('submitted', previous.record.identity, now(), previous, {
    run_id: options.runId,
    outcome: options.outcome,
  });
  await persist(options, store, remote.release, recordName('submitted'), jsonBytes(submitted));
  return report(options, await loadState(options, store), 'wait', { outcome: options.outcome });
}

export async function runNpmPublication(
  options: NpmPublicationOptions,
  dependencies: {
    store?: PublicationStore;
    fetcher?: typeof fetch;
    now?: () => number;
  } = {},
) {
  validateOptions(options);
  const store =
    dependencies.store ??
    new GitHubPublicationStore(options.repository, process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN);
  const fetcher = dependencies.fetcher ?? fetch;
  const now = dependencies.now ?? Date.now;
  await store.assertTag(options);
  const remote = await loadState(options, store);
  if (options.submitted) return recordSubmitted(options, remote, store, now);
  if (options.command === 'verify') return verify(options, remote, store, fetcher, now);
  const metadata = await publicMetadata(publicationVersion(options), fetcher);
  if (metadata)
    return report(options, remote, remote.current ? 'verify' : 'import_required', {
      ...(await restoreIdentity(options, remote, store)),
      reason: 'exact_npm_version_already_exists',
    });
  if (options.command === 'prepare') return prepare(options, remote, store, now);
  if (!remote.current) {
    const action = remote.frozen ? 'wait' : remote.release ? 'import_required' : 'prepare';
    return report(options, remote, action, {
      reason: remote.frozen ? 'freeze_incomplete_preserve_original_bytes' : 'no_publication_receipt',
    });
  }
  if (options.beginSubmission) return beginSubmission(options, remote, store, now);
  const paths = await restoreIdentity(options, remote, store);
  return report(options, remote, remote.current.record.state === 'prepared' ? 'submit' : 'wait', {
    ...paths,
    reason:
      remote.current.record.state === 'prepared'
        ? 'candidate_frozen_not_submitted'
        : 'registry_missing_after_submission_no_retry',
  });
}

async function verify(
  options: NpmPublicationOptions,
  remote: RemoteState,
  store: PublicationStore,
  fetcher: typeof fetch,
  now: () => number,
) {
  if (!remote.current || !remote.release)
    return report(options, remote, remote.frozen ? 'wait' : 'import_required', {
      reason: 'verification_requires_frozen_identity',
    });
  const proof = await verifyPublicArchive(remote.current.record.identity, fetcher, now());
  if (!proof)
    return report(options, remote, 'wait', { reason: 'registry_missing_preserve_original_submission' });
  if (!options.dryRun && remote.current.record.state !== 'published') {
    const published = makeRecord('published', remote.current.record.identity, now(), remote.current, {
      verification: proof,
    });
    await persist(options, store, remote.release, recordName('published'), jsonBytes(published));
  }
  return report(options, options.dryRun ? remote : await loadState(options, store), 'published', {
    verification: proof,
    registry_tarball_downloaded: true,
  });
}

async function externalNewPath(filename: string, root: string) {
  const parent = await realpath(path.dirname(path.resolve(filename)));
  const relative = path.relative(await realpath(root), parent);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)))
    throw new Error('Publication outputs must be outside the source tree.');
  try {
    await lstat(filename);
    throw new Error('Publication output already exists.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    const options = parseNpmPublicationArgs(process.argv.slice(2));
    if (!options) process.stdout.write(npmPublicationHelp);
    else {
      const root = fileURLToPath(new URL('../', import.meta.url));
      await externalNewPath(options.out!, root);
      if (options.restore) await externalNewPath(options.restore, root);
      const result = await runNpmPublication(options);
      const bytes = jsonBytes(result);
      await writeFile(path.resolve(options.out!), bytes, { flag: 'wx', mode: 0o600 });
      process.stdout.write(bytes);
    }
  } catch (error) {
    process.stderr.write(`npm publication: ${error instanceof Error ? error.message : 'operation failed'}\n`);
    process.exitCode = 1;
  }
}
