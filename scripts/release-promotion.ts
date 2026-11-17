/** Reconcile every verified release after queued promotion jobs are coalesced by GitHub. */
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_NAME } from '../version.ts';
import { NpmOidcChannelError, setNpmChannelWithOidc } from './npm-oidc-channel.ts';
import {
  channelPlan,
  compareVersions,
  versionFromTag,
  type CurrentChannels,
} from './release-channel-plan.ts';
import { runNpmPublication } from './npm-publication.ts';
import {
  boundedResponse,
  GitHubPublicationStore,
  npmRegistry,
  type PublicationRelease,
} from './npm-publication-remote.ts';
import { digest, parseRecord, type PublicationRecord } from './npm-publication-state.ts';

export interface PromotionCandidate {
  version: string;
  tag: string;
  draft: boolean;
  release: PublicationRelease;
  record: PublicationRecord;
}
export interface PromotionBackend {
  candidates(): Promise<PromotionCandidate[]>;
  channels(): Promise<CurrentChannels>;
  verify(candidate: PromotionCandidate): Promise<unknown>;
  publish(candidate: PromotionCandidate, verification: unknown): Promise<void>;
  npmTag(channel: 'latest' | 'next', version: string): Promise<void>;
  githubLatest(candidate: PromotionCandidate): Promise<void>;
  inventoryFailures?(): PromotionFailure[];
}
export interface PromotionFailure {
  tag: string;
  stage: string;
  reason: string;
}

function failure(tag: string, stage: string, error: unknown): PromotionFailure {
  return { tag, stage, reason: error instanceof Error ? error.message : 'Unknown operation outcome' };
}

async function verifyPlan(
  backend: PromotionBackend,
  candidates: PromotionCandidate[],
  current: CurrentChannels,
  proofs: Map<PromotionCandidate, unknown>,
  failures: PromotionFailure[],
) {
  let available = candidates;
  for (;;) {
    const pending = channelPlan(available, current).verify.filter((candidate) => !proofs.has(candidate));
    if (!pending.length) return available;
    for (const candidate of pending) {
      try {
        proofs.set(candidate, await backend.verify(candidate));
      } catch (error) {
        failures.push(failure(candidate.tag, 'public-verification', error));
        available = available.filter((item) => item !== candidate);
      }
    }
  }
}

async function advanceNpm(
  backend: PromotionBackend,
  channel: 'latest' | 'next',
  candidate: PromotionCandidate,
) {
  const current = (await backend.channels())[channel];
  if (current !== undefined && compareVersions(current, candidate.version) >= 0) return;
  let failed = false;
  let detail = '';
  try {
    await backend.npmTag(channel, candidate.version);
  } catch (error) {
    failed = true;
    if (error instanceof NpmOidcChannelError) detail = ` ${error.message}`;
  }
  const actual = (await backend.channels())[channel];
  if (actual === undefined || compareVersions(actual, candidate.version) < 0)
    throw new Error(
      `npm ${channel} promotion ${failed ? 'has an unknown outcome' : 'was not confirmed'}.${detail} Reconcile this channel; never upload the package again.`,
    );
  return { channel, version: actual };
}

async function advanceGithub(backend: PromotionBackend, candidate: PromotionCandidate) {
  const current = await backend.channels();
  if (current.githubLatest !== undefined && compareVersions(current.githubLatest, candidate.version) >= 0)
    return;
  if (current.latest === undefined || compareVersions(current.latest, candidate.version) < 0)
    throw new Error('npm latest must be confirmed before promoting GitHub Latest.');
  let failed = false;
  try {
    await backend.githubLatest(candidate);
  } catch {
    failed = true;
  }
  const actual = (await backend.channels()).githubLatest;
  if (actual === undefined || compareVersions(actual, candidate.version) < 0)
    throw new Error(
      `GitHub Latest promotion ${failed ? 'has an unknown outcome' : 'was not confirmed'}. Rerun promotion without resubmitting npm.`,
    );
  return { channel: 'githubLatest', version: actual };
}

/** Upload is deliberately absent from this interface, including failed/unknown promotions. */
export async function promoteVerifiedReleases(backend: PromotionBackend) {
  const candidates = await backend.candidates();
  const before = await backend.channels();
  const failures = backend.inventoryFailures?.() ?? [];
  const proofs = new Map<PromotionCandidate, unknown>();
  let available = await verifyPlan(backend, candidates, before, proofs, failures);
  const published: string[] = [];
  for (const candidate of channelPlan(available, before).publish) {
    try {
      await backend.publish(candidate, proofs.get(candidate));
      candidate.draft = false;
      published.push(candidate.version);
    } catch (error) {
      failures.push(failure(candidate.tag, 'release-visibility', error));
      available = available.filter((item) => item !== candidate);
    }
  }
  const current = await backend.channels();
  available = await verifyPlan(backend, available, current, proofs, failures);
  const plan = channelPlan(available, current);
  const advanced: { channel: string; version: string }[] = [];
  for (const channel of ['latest', 'next'] as const) {
    const candidate = plan[channel];
    if (!candidate) continue;
    try {
      const result = await advanceNpm(backend, channel, candidate);
      if (result) advanced.push(result);
    } catch (error) {
      failures.push(failure(candidate.tag, `npm-${channel}`, error));
    }
  }
  if (plan.githubLatest) {
    try {
      const result = await advanceGithub(backend, plan.githubLatest);
      if (result) advanced.push(result);
    } catch (error) {
      failures.push(failure(plan.githubLatest.tag, 'github-latest', error));
    }
  }
  return {
    schema_version: 1,
    scanned: candidates.length,
    verified: [...proofs.keys()].map((item) => item.version),
    published,
    advanced,
    failures,
    before,
    after: await backend.channels(),
    npm_upload_performed: false,
  };
}

export class RemotePromotionBackend implements PromotionBackend {
  repository: string;
  store: GitHubPublicationStore;
  directory: string;
  sourceDirectory: string;
  fetcher: typeof fetch;
  oidcEnvironment: NodeJS.ProcessEnv;
  failures: PromotionFailure[] = [];

  constructor(
    repository: string,
    directory: string,
    sourceDirectory: string,
    fetcher: typeof fetch = fetch,
    token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
    oidcEnvironment: NodeJS.ProcessEnv = process.env,
  ) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Use owner/repository.');
    this.repository = repository;
    this.directory = directory;
    this.sourceDirectory = sourceDirectory;
    this.fetcher = fetcher;
    this.oidcEnvironment = oidcEnvironment;
    if (!token) throw new Error('Promotion requires a GitHub token so draft releases remain visible.');
    this.store = new GitHubPublicationStore(repository, token, fetcher);
  }

  async candidates(): Promise<PromotionCandidate[]> {
    const candidates: PromotionCandidate[] = [];
    const tags = new Set<string>();
    for (let page = 1; page <= 10; page++) {
      const batch = await this.store.json(`/releases?per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error('Release backlog inventory is unavailable.');
      for (const value of batch) {
        try {
          const release = await this.store.release(value);
          const bytes = await this.store.read(release, 'npm-publication-published.json', 1024 * 1024);
          if (!bytes) continue;
          const untrusted = JSON.parse(bytes.toString('utf8')) as PublicationRecord;
          const record = parseRecord(bytes, {
            repository: this.repository,
            tag: release.tag,
            source: untrusted.identity?.source,
          });
          if (record.state !== 'published')
            throw new Error('Only persisted published receipts may enter promotion.');
          if (tags.has(release.tag)) throw new Error('Duplicate release tag in the promotion backlog.');
          tags.add(release.tag);
          candidates.push({
            version: versionFromTag(release.tag),
            tag: release.tag,
            draft: release.draft,
            release,
            record,
          });
        } catch (error) {
          this.failures.push(
            failure(
              typeof value?.tag_name === 'string' ? value.tag_name : 'unknown',
              'receipt-inventory',
              error,
            ),
          );
        }
      }
      if (batch.length < 100) return candidates;
    }
    throw new Error('Release backlog exceeds the bounded page limit.');
  }

  inventoryFailures() {
    return [...this.failures];
  }

  async channels(): Promise<CurrentChannels> {
    const response = await this.fetcher(
      `${npmRegistry}/-/package/${encodeURIComponent(PACKAGE_NAME)}/dist-tags`,
      {
        redirect: 'error',
        credentials: 'omit',
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Cannot establish current npm channels: HTTP ${response.status}.`);
    }
    const tags = JSON.parse((await boundedResponse(response, 1024 * 1024)).toString('utf8')) as Record<
      string,
      unknown
    >;
    for (const name of ['latest', 'next'])
      if (tags[name] !== undefined && typeof tags[name] !== 'string')
        throw new Error('Invalid npm channel version.');
    const latest = (await this.store.json('/releases/latest')) as { tag_name?: unknown } | undefined;
    if (latest && typeof latest.tag_name !== 'string') throw new Error('Invalid GitHub Latest release.');
    return {
      latest: tags.latest as string | undefined,
      next: tags.next as string | undefined,
      githubLatest: latest ? versionFromTag(latest.tag_name as string) : undefined,
    };
  }

  async verify(candidate: PromotionCandidate) {
    const proof = await runNpmPublication(
      {
        command: 'verify',
        repository: this.repository,
        tag: candidate.tag,
        source: candidate.record.identity.source,
        dryRun: false,
        beginSubmission: false,
        submitted: false,
      },
      { store: this.store, fetcher: this.fetcher },
    );
    if (
      proof.action !== 'published' ||
      proof.state !== 'published' ||
      proof.dry_run !== false ||
      !('registry_tarball_downloaded' in proof) ||
      proof.registry_tarball_downloaded !== true ||
      proof.release_id !== candidate.release.id ||
      proof.archive_sha256 !== candidate.record.identity.archive.sha256
    )
      throw new Error(
        'Promotion requires persisted publication and a fresh download of the original public npm archive.',
      );
    return proof;
  }

  async publish(candidate: PromotionCandidate, verification: unknown) {
    const directory = path.join(this.directory, candidate.tag);
    await mkdir(directory);
    const archive = candidate.record.identity.archive;
    const bytes = await this.store.read(candidate.release, archive.name, archive.size);
    if (!bytes || bytes.length !== archive.size || digest(bytes) !== archive.sha256)
      throw new Error('The original frozen runtime archive is unavailable for release notes.');
    const archivePath = path.join(directory, archive.name);
    const proofPath = path.join(directory, 'verification.json');
    const notesPath = path.join(directory, 'RELEASE.md');
    await writeFile(archivePath, bytes, { flag: 'wx', mode: 0o600 });
    await writeFile(proofPath, JSON.stringify(verification), { flag: 'wx', mode: 0o600 });
    let notes: string;
    try {
      await this.notes(proofPath, archivePath, notesPath);
      notes = await readFile(notesPath, 'utf8');
    } catch {
      throw new Error('Frozen release notes could not be verified; publication remains pending.');
    }
    try {
      await this.store.json(`/releases/${candidate.release.id}`, 'PATCH', {
        draft: false,
        prerelease: candidate.version.includes('-'),
        make_latest: 'false',
        body: notes,
      });
    } catch {
      // A lost response may already have made the release public; inspect before deciding.
    }
    const saved = (await this.store.json(`/releases/${candidate.release.id}`)) as {
      tag_name?: string;
      draft?: boolean;
      body?: string;
    };
    if (saved?.tag_name !== candidate.tag || saved.draft !== false || saved.body !== notes)
      throw new Error(
        'Release visibility or notes were not confirmed. Reconcile the same release without re-uploading npm.',
      );
  }

  async notes(proofPath: string, archivePath: string, notesPath: string) {
    try {
      execFileSync(
        process.execPath,
        [
          fileURLToPath(new URL('./publication-notes.ts', import.meta.url)),
          '--verification',
          proofPath,
          '--archive',
          archivePath,
          '--out',
          notesPath,
          '--source-dir',
          this.sourceDirectory,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 },
      );
    } catch {
      throw new Error('Frozen release notes could not be verified; publication remains pending.');
    }
  }

  async npmTag(channel: 'latest' | 'next', version: string) {
    await setNpmChannelWithOidc(
      { repository: this.repository, channel, version },
      { fetcher: this.fetcher, env: this.oidcEnvironment },
    );
  }

  async githubLatest(candidate: PromotionCandidate) {
    await this.store.json(`/releases/${candidate.release.id}`, 'PATCH', { make_latest: 'true' });
  }
}

async function main(args: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const name = args[index]!;
    const value = args[++index];
    if (!['--repository', '--out'].includes(name) || values.has(name) || !value || value.startsWith('-'))
      throw new Error('Usage: node scripts/release-promotion.ts --repository OWNER/REPO --out NEW.json');
    values.set(name, value);
  }
  if (values.size !== 2) throw new Error('Promotion requires --repository and --out.');
  const source = await realpath(fileURLToPath(new URL('../', import.meta.url)));
  const output = path.resolve(values.get('--out')!);
  const parent = await realpath(path.dirname(output));
  const relative = path.relative(source, parent);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)))
    throw new Error('Promotion receipts must be outside the source tree.');
  try {
    await lstat(output);
    throw new Error('Promotion output already exists.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-modeling-channel-promotion-'));
  try {
    const result = await promoteVerifiedReleases(
      new RemotePromotionBackend(values.get('--repository')!, directory, source),
    );
    await writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    process.stdout.write(JSON.stringify(result) + '\n');
    if (result.failures.length) process.exitCode = 1;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      `Release channel reconciliation failed: ${error instanceof Error ? error.message : 'unknown failure'}. Preserve verified releases and rerun promotion; never resubmit npm.\n`,
    );
    process.exitCode = 1;
  });
